//! What a model call carries: the system prompt, the chat's earlier turns within the model's budget, and this turn's steps.
use std::sync::Arc;

use saturn_domain::context::{
    COMPACTION_PROMPT, budget_start, compact_actions, compaction_start, context_tokens_for,
    estimate_tokens, history_budget_chars,
};
use saturn_domain::js;
use saturn_domain::prompt::{
    PromptInput, RunMode, build_system_prompt, explain_run_error, number_of,
};
use saturn_domain::skill_files::skills_prompt;
use saturn_domain::time::{iso_time, now_millis};
use saturn_llm::{
    CallContext, ChatMessage, ChatToolCall, Completion, CompletionInput, ImagePart, Replay, Role,
    ToolDef,
};
use saturn_telemetry::network::{SendNoted, client_builder};
use serde_json::{Value, json};

use crate::builtins::GENERAL_SKILLS_ID;
use crate::records::{by_id, by_id_mut, strings, text};
use crate::rules::{project_rules, stored_rules_only};
use crate::run_images::load_images;
use crate::skill_files::list_skills;
use crate::{CoreError, Kernel, log};

const CONTINUE_AFTER_TOOLS: &str = "Continue from the tool results above: use more tools if the task needs them, otherwise give your answer.";
/// A call the turn never ran (it paused for approval or a wait first): providers need a result for every call.
const NOT_RUN: &str = r#"{"status":"not_run","reason":"Not run: the turn paused before this call. Call it again if it is still needed."}"#;

/// Screenshots, and computer-use actions that return the screen after acting.
fn carries_image(action: &Value) -> bool {
    let tool = text(action, "toolId");
    tool.contains("screenshot") || tool.starts_with("computer_")
}

/// The images in steps' results, the latest two.
fn extract_screenshots(actions: &[Value]) -> Vec<ImagePart> {
    let mut images = Vec::new();
    for action in actions.iter().filter(|action| carries_image(action)) {
        let Some(result) = action.get("result") else {
            continue;
        };
        let raw = ["image", "screenshot", "base64"].iter().find_map(|key| {
            result
                .get(*key)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
        });
        let Some(raw) = raw else {
            continue;
        };
        if let Some(rest) = raw.strip_prefix("data:") {
            if let Some((mime, data)) = rest.split_once(";base64,")
                && !mime.is_empty()
                && !data.is_empty()
            {
                images.push(ImagePart {
                    mime_type: mime.to_owned(),
                    base64: data.to_owned(),
                });
            }
        } else if raw.len() > 200 && !raw.contains([' ', '\n']) {
            images.push(ImagePart {
                mime_type: "image/jpeg".to_owned(),
                base64: raw.to_owned(),
            });
        }
    }
    let start = images.len().saturating_sub(2);
    images.split_off(start)
}

/// Steps with their pixels replaced by a placeholder, so trimming never clips base64.
fn sanitize_actions(actions: &[Value]) -> Vec<Value> {
    actions
        .iter()
        .map(|action| {
            let mut clean = action.clone();
            if carries_image(action)
                && let Some(result) = clean.get_mut("result").and_then(Value::as_object_mut)
                && ["image", "screenshot", "base64"].iter().any(|key| {
                    result
                        .get(*key)
                        .is_some_and(|value| js::truthy(Some(value)))
                })
            {
                result.insert(
                    "image".to_owned(),
                    "[screenshot attached as multimodal image input]".into(),
                );
                result.shift_remove("screenshot");
                result.shift_remove("base64");
            }
            clean
        })
        .collect()
}

/// The turn's tool rounds as native messages: each model reply's calls, then one result per call (status, result or reason),
/// compacted like the text format. The latest two screenshots go with their results as images.
pub fn tool_turns(rounds: &[Value], actions: &[Value]) -> Vec<ChatMessage> {
    let compacted = compact_actions(&sanitize_actions(actions));
    let with_images: Vec<&str> = {
        let shown: Vec<&Value> = actions
            .iter()
            .filter(|action| !extract_screenshots(std::slice::from_ref(action)).is_empty())
            .collect();
        shown[shown.len().saturating_sub(2)..]
            .iter()
            .map(|action| text(action, "id"))
            .collect()
    };
    let mut messages = Vec::new();
    for round in rounds {
        let calls: Vec<ChatToolCall> = round
            .get("calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|call| serde_json::from_value(call.clone()).ok())
            .collect();
        let mut assistant = ChatMessage::new(Role::Assistant, text(round, "text"));
        assistant.reasoning = round
            .get("thinking")
            .and_then(Value::as_str)
            .map(str::to_owned);
        assistant.replay = round
            .get("replay")
            .and_then(|replay| serde_json::from_value::<Replay>(replay.clone()).ok());
        assistant.tool_calls = calls.clone();
        messages.push(assistant);
        for call in calls {
            let index = compacted
                .iter()
                .position(|action| text(action, "callId") == call.id);
            let mut message = ChatMessage::new(Role::Tool, NOT_RUN);
            if let Some(index) = index {
                let step = &compacted[index];
                let mut body = json!({ "status": text(step, "status") });
                if let Some(result) = step.get("result") {
                    body["result"] = result.clone();
                }
                if let Some(reason) = step
                    .get("reason")
                    .and_then(Value::as_str)
                    .filter(|reason| !reason.is_empty())
                {
                    body["reason"] = reason.into();
                }
                message.content = body.to_string();
                message.failed = matches!(text(step, "status"), "failed" | "denied");
                if with_images.contains(&text(step, "id")) {
                    message.images = extract_screenshots(std::slice::from_ref(&actions[index]));
                }
            }
            message.tool_call_id = Some(call.id);
            message.tool_name = Some(call.name);
            messages.push(message);
        }
    }
    messages
}

/// One run as the user and assistant turns it adds to a chat.
fn turn_messages(turns: &[Value]) -> Vec<ChatMessage> {
    let mut messages = Vec::new();
    for turn in turns {
        let images = turn
            .get("inputImages")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        let attached = match images {
            0 => String::new(),
            1 => "\n[1 image was attached to this message]".to_owned(),
            count => format!("\n[{count} images were attached to this message]"),
        };
        messages.push(ChatMessage::new(
            Role::User,
            format!("{}{attached}", text(turn, "input")),
        ));
        let output = text(turn, "output");
        if !output.is_empty() {
            let mut answer = ChatMessage::new(Role::Assistant, output);
            answer.reasoning = turn
                .get("thinking")
                .and_then(Value::as_str)
                .filter(|thinking| !thinking.is_empty())
                .map(str::to_owned);
            messages.push(answer);
        }
    }
    messages
}

/// The characters a turn takes in a request.
fn turn_chars(turn: &Value) -> usize {
    turn_messages(std::slice::from_ref(turn))
        .iter()
        .map(|message| js::length(&message.content))
        .sum()
}

fn finished(run: &Value) -> bool {
    matches!(text(run, "status"), "completed" | "failed" | "cancelled")
}

/// The turns a chat's summary does not cover yet, oldest first. A summarized turn that was removed (an edit, a restore) leaves
/// the summary standing, and every turn left is newer.
fn after_summary(turns: Vec<Value>, summary: Option<&Value>) -> Vec<Value> {
    let Some(summary) = summary else {
        return turns;
    };
    match turns
        .iter()
        .position(|item| text(item, "id") == text(summary, "throughRunId"))
    {
        Some(index) => turns[index + 1..].to_vec(),
        None => turns,
    }
}

fn summary_message(summary: &Value) -> ChatMessage {
    let turns = summary.get("turns").and_then(Value::as_u64).unwrap_or(0);
    ChatMessage::new(
        Role::User,
        format!(
            "[Summary of the earlier conversation, {turns} {}, written by the assistant to continue it]\n{}",
            if turns == 1 { "turn" } else { "turns" },
            text(summary, "text")
        ),
    )
}

fn window_of(model: &Value) -> Option<f64> {
    model.get("contextTokens").and_then(Value::as_f64)
}

fn budget_of(model: &Value) -> usize {
    history_budget_chars(
        text(model, "provider"),
        text(model, "model"),
        window_of(model),
    )
}

impl Kernel {
    /// The finished turns before `run_id` in its chat (or, outside a chat, the agent's), oldest first.
    fn prior_turns(&self, agent_id: &str, run_id: &str) -> Vec<Value> {
        self.store.read(|state| {
            let Some(current) = by_id(&state.runs, run_id) else {
                return Vec::new();
            };
            // A group turn carries the transcript in its input, and a sub-agent run has a fresh context.
            if !text(current, "groupId").is_empty() || !text(current, "parentRunId").is_empty() {
                return Vec::new();
            }
            let thread = text(current, "threadId");
            let turns: Vec<&Value> = state
                .runs
                .iter()
                .filter(|item| {
                    text(item, "agentId") == agent_id
                        && text(item, "parentRunId").is_empty()
                        && (thread.is_empty() || text(item, "threadId") == thread)
                })
                .collect();
            let index = turns.iter().position(|item| text(item, "id") == run_id);
            index.map_or_else(Vec::new, |index| {
                turns[index + 1..]
                    .iter()
                    .filter(|item| finished(item))
                    .rev()
                    .map(|item| (*item).clone())
                    .collect()
            })
        })
    }

    /// The earlier turns a request carries: the chat's summary and the turns after it. When they exceed the model's budget, the
    /// oldest turns are folded into the summary first, by the same model; if that fails the oldest are left out.
    async fn history_for(
        &self,
        agent: &Value,
        model: &Value,
        run_id: &str,
    ) -> Result<Vec<ChatMessage>, CoreError> {
        let run = self.find_run(run_id);
        let thread = run
            .as_ref()
            .and_then(|run| self.find_thread(text(run, "threadId")));
        let all = self.prior_turns(text(agent, "id"), run_id);
        let mut summary = thread
            .as_ref()
            .and_then(|thread| thread.get("summary"))
            .filter(|summary| !summary.is_null())
            .cloned();
        let mut turns = after_summary(all, summary.as_ref());
        let budget = budget_of(model);
        let summary_chars = |summary: &Option<Value>| {
            summary
                .as_ref()
                .map_or(0, |item| js::length(text(item, "text")))
        };
        let total: usize = turns.iter().map(turn_chars).sum::<usize>() + summary_chars(&summary);
        if let Some(thread) = &thread
            && total > budget
            && turns.len() > 1
        {
            let sizes: Vec<usize> = turns.iter().map(turn_chars).collect();
            let start = compaction_start(&sizes, budget / 2);
            if start > 0 {
                let old = &turns[..start];
                match self
                    .summarize(
                        agent,
                        model,
                        run_id,
                        summary.as_ref().map(|item| text(item, "text")),
                        old,
                    )
                    .await
                {
                    Ok(body) => {
                        let at = iso_time(now_millis());
                        let earlier = summary
                            .as_ref()
                            .and_then(|item| item.get("turns"))
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                        let next = json!({ "text": body, "throughRunId": text(&old[old.len() - 1], "id"), "turns": earlier + start as u64, "createdAt": at });
                        let (saved, thread_id) = (next.clone(), text(thread, "id"));
                        self.store
                            .update(|state| {
                                if let Some(current) = by_id_mut(&mut state.threads, thread_id) {
                                    current["summary"] = saved;
                                }
                                if let Some(active) = by_id_mut(&mut state.runs, run_id) {
                                    active["compacted"] = json!({ "turns": start, "at": at });
                                }
                            })
                            .await?;
                        log(
                            "agent",
                            "info",
                            &format!(
                                "{}: {start} earlier turns of the chat folded into its summary ({} tokens)",
                                text(agent, "name"),
                                estimate_tokens(text(&next, "text"))
                            ),
                        );
                        summary = Some(next);
                        turns = turns[start..].to_vec();
                    }
                    Err(error) => log(
                        "agent",
                        "warning",
                        &format!(
                            "Could not summarize the chat's earlier turns: {}; the oldest are left out instead",
                            explain_run_error(&error.message)
                        ),
                    ),
                }
            }
        }
        let messages = turn_messages(&turns);
        let sized: Vec<(bool, usize)> = messages
            .iter()
            .map(|message| (message.role == Role::User, js::length(&message.content)))
            .collect();
        let kept_from = budget_start(
            &sized,
            budget.saturating_sub(summary_chars(&summary)).max(1),
        );
        let mut history = Vec::new();
        if let Some(summary) = &summary {
            history.push(summary_message(summary));
        }
        if kept_from > 0 {
            history.push(ChatMessage::new(Role::User, format!("[{kept_from} earlier messages in this conversation are omitted to save context.]")));
        }
        history.extend(messages.into_iter().skip(kept_from));
        Ok(history)
    }

    /// One model call that writes the summary of `turns` (folding in `previous` when there is one).
    async fn summarize(
        &self,
        agent: &Value,
        model: &Value,
        run_id: &str,
        previous: Option<&str>,
        turns: &[Value],
    ) -> Result<String, CoreError> {
        let mut messages = vec![ChatMessage::new(Role::System, COMPACTION_PROMPT)];
        if let Some(previous) = previous {
            messages.push(ChatMessage::new(
                Role::User,
                format!("Earlier summary:\n{previous}"),
            ));
        }
        messages.extend(turn_messages(turns));
        messages.push(ChatMessage::new(Role::User, "Write the summary now."));
        let body = self
            .call_model(
                model,
                CompletionInput {
                    context: CallContext {
                        agent_id: text(agent, "id").to_owned(),
                        agent_name: text(agent, "name").to_owned(),
                        run_id: Some(run_id.to_owned()),
                        purpose: "compaction",
                    },
                    temperature: Some(0.0),
                    max_output: Some(1500),
                    low_thinking: true,
                    messages,
                    tools: Vec::new(),
                },
            )
            .await?;
        let written = js::trim(&body.content);
        if written.is_empty() {
            return Err(CoreError::new(400, "the model returned no summary"));
        }
        Ok(written.to_owned())
    }

    /// A chat's finished turns, oldest first.
    fn finished_turns(&self, thread_id: &str) -> Vec<Value> {
        self.store.read(|state| {
            state
                .runs
                .iter()
                .filter(|item| {
                    text(item, "threadId") == thread_id
                        && text(item, "parentRunId").is_empty()
                        && finished(item)
                })
                .rev()
                .cloned()
                .collect()
        })
    }

    /// How full the chat's context is for its agent's model, and what its summary covers.
    pub fn context_usage(&self, thread_id: &str) -> Result<Value, CoreError> {
        let thread = self
            .find_thread(thread_id)
            .ok_or_else(|| CoreError::new(404, "Chat not found"))?;
        let agent = self.get_agent(text(&thread, "agentId"))?;
        let model = self.model_of(&agent);
        let summary = thread.get("summary").filter(|summary| !summary.is_null());
        let turns = after_summary(self.finished_turns(thread_id), summary);
        let chars: usize = turns.iter().map(turn_chars).sum::<usize>()
            + summary.map_or(0, |item| js::length(text(item, "text")));
        let budget = model
            .as_ref()
            .map_or(saturn_domain::context::HISTORY_CHARS, budget_of);
        let percent = ((chars as f64 / budget as f64) * 100.0).round().min(100.0) as u64;
        Ok(json!({
            "usedTokens": chars.div_ceil(saturn_domain::context::CHARS_PER_TOKEN),
            "budgetTokens": budget.div_ceil(saturn_domain::context::CHARS_PER_TOKEN),
            "windowTokens": model.as_ref().map_or(0, |model| context_tokens_for(text(model, "provider"), text(model, "model"), window_of(model))),
            "percent": percent,
            "turns": turns.len(),
            "summary": summary.map_or(Value::Null, |item| json!({ "turns": item.get("turns"), "createdAt": item.get("createdAt") })),
        }))
    }

    /// Folds every finished turn of the chat into its summary now (the "/compact" command).
    pub async fn compact_thread(self: &Arc<Self>, thread_id: &str) -> Result<Value, CoreError> {
        let thread = self
            .find_thread(thread_id)
            .ok_or_else(|| CoreError::new(404, "Chat not found"))?;
        let agent = self.get_agent(text(&thread, "agentId"))?;
        let model = self
            .model_of(&agent)
            .ok_or_else(|| CoreError::new(409, "This agent has no model connection"))?;
        if saturn_domain::llm::runs_on_plan(text(&model, "provider")) {
            return Err(CoreError::new(
                409,
                format!(
                    "{} runs in its own program, which manages its own context; there is nothing for Saturn to compact.",
                    text(&model, "name")
                ),
            ));
        }
        let finished = self.finished_turns(thread_id);
        let summary = thread.get("summary").filter(|summary| !summary.is_null());
        let turns = after_summary(finished.clone(), summary);
        let (Some(last), Some(latest)) = (turns.last(), finished.last()) else {
            return Err(CoreError::new(
                409,
                if summary.is_some() {
                    "Every turn is in the summary already"
                } else {
                    "Nothing to compact yet"
                },
            ));
        };
        let body = self
            .summarize(
                &agent,
                &model,
                text(latest, "id"),
                summary.map(|item| text(item, "text")),
                &turns,
            )
            .await?;
        let earlier = summary
            .and_then(|item| item.get("turns"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let next = json!({ "text": body, "throughRunId": text(last, "id"), "turns": earlier + turns.len() as u64, "createdAt": iso_time(now_millis()) });
        let saved = next.clone();
        self.store
            .update(|state| {
                if let Some(current) = by_id_mut(&mut state.threads, thread_id) {
                    current["summary"] = saved;
                }
            })
            .await?;
        log(
            "agent",
            "info",
            &format!(
                "{}: the chat was compacted on request ({} turns folded)",
                text(&agent, "name"),
                turns.len()
            ),
        );
        Ok(json!({ "summary": next, "folded": turns.len() }))
    }

    /// What the knowledge sources say about a message. An error page is not knowledge, so it is left out.
    pub(crate) async fn rag_context(
        &self,
        agent: &Value,
        query: &str,
    ) -> Result<String, CoreError> {
        self.guard(text(agent, "id"))?;
        let chosen = strings(agent, "ragConnectionIds");
        let servers: Vec<Value> = self.store.read(|state| {
            state
                .rag
                .iter()
                .filter(|item| chosen.iter().any(|id| id == text(item, "id")))
                .cloned()
                .collect()
        });
        if servers.is_empty() {
            return Ok(String::new());
        }
        let span = saturn_telemetry::Span::start(
            "retrieve",
            saturn_telemetry::Kind::Client,
            json!({ "gen_ai.operation.name": "retrieve", "gen_ai.agent.id": text(agent, "id"), "saturn.rag.sources": servers.len() }),
        );
        let context = span.scope(self.fetch_context(&servers, query)).await;
        match &context {
            Ok(found) => span.set("saturn.rag.context_chars", js::length(found)),
            Err(error) => span.fail(&error.message, "Error"),
        }
        context
    }

    /// Asks each retrieval server in turn.
    async fn fetch_context(&self, servers: &[Value], query: &str) -> Result<String, CoreError> {
        let client = client_builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|error| CoreError::new(400, error.without_url().to_string()))?;
        let mut chunks = Vec::new();
        for server in servers {
            let name = text(server, "name");
            // URLs can carry tokens, so errors leave them out.
            let response = client
                .post(text(server, "url"))
                .header("content-type", "application/json")
                .body(json!({ "query": query }).to_string())
                .send_noted()
                .await
                .map_err(|error| CoreError::new(400, error.without_url().to_string()))?;
            if !response.status().is_success() {
                log(
                    "agent",
                    "warning",
                    &format!(
                        "Knowledge source {name} answered {}; its context was skipped",
                        response.status().as_u16()
                    ),
                );
                continue;
            }
            chunks.push(
                response
                    .text()
                    .await
                    .map_err(|error| CoreError::new(400, error.without_url().to_string()))?,
            );
        }
        Ok(chunks.join("\n"))
    }

    /// One model call of a turn: the system prompt, the chat so far, the message and this turn's steps.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn complete(
        &self,
        model: &Value,
        agent: &Value,
        run_id: &str,
        input: &str,
        context: &str,
        tools: Vec<ToolDef>,
        actions: &[Value],
    ) -> Result<Completion, CoreError> {
        self.guard(text(agent, "id"))?;
        let current = self.find_run(run_id).unwrap_or(Value::Null);
        let thread = self.find_thread(text(&current, "threadId"));
        let workdir = self.workdir_for(thread.as_ref())?;
        let project = thread
            .as_ref()
            .map(|thread| text(thread, "projectId"))
            .filter(|id| !id.is_empty());
        let memory = self.memory_for_prompt(project).await;
        let plan_approval = self
            .store
            .read(|state| state.settings.get("planApproval") == Some(&Value::Bool(true)));
        let images = load_images(self.store.root(), &strings(&current, "inputImages")).await;
        let stored_rules = project.and_then(|id| {
            self.store
                .read(|state| by_id(&state.projects, id).map(|item| text(item, "rules").to_owned()))
        });
        // The folder's instruction files and skills come with it, so they take part only once the user allowed them.
        let allowed = match (&workdir, project) {
            (Some(root), Some(id)) => self.instructions_allowed(id, root).await,
            _ => true,
        };
        let rules = match (&workdir, project) {
            (Some(root), Some(_)) if allowed => {
                project_rules(root, stored_rules.as_deref().unwrap_or("")).await
            }
            (Some(root), Some(_)) => {
                stored_rules_only(root, stored_rules.as_deref().unwrap_or("")).await
            }
            _ => String::new(),
        };
        let server_ids = strings(agent, "mcpConnectionIds");
        let working = workdir.as_ref().map_or(String::new(), |root| {
            format!("Working directory: {}\nThis chat belongs to the project in that folder. The files and code tools read, write and run commands there; paths are relative to it.", root.display())
        });
        // Only when the agent has the skill tool: names and descriptions, loaded on demand.
        let skills = if server_ids.iter().any(|id| id == GENERAL_SKILLS_ID) {
            let listed = list_skills(
                workdir.as_deref().filter(|_| allowed),
                &self.store.root().join("skills"),
                &self.enabled_plugin_folders(),
            )
            .await;
            skills_prompt(
                &listed
                    .into_iter()
                    .map(|skill| (skill.name, skill.description))
                    .collect::<Vec<_>>(),
            )
        } else {
            String::new()
        };
        let joined = [working.as_str(), context, skills.as_str()]
            .iter()
            .filter(|part| !part.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join("\n\n");
        let deferred = self.deferred_toolkits(agent, Some(run_id));
        let system = build_system_prompt(&PromptInput {
            instructions: text(agent, "instructions"),
            context: &joined,
            server_ids: &server_ids,
            deferred: &deferred,
            memory: &memory,
            rules: &rules,
            plan_approval,
            mode: RunMode::parse(current.get("mode").and_then(Value::as_str)),
        });
        // Earlier turns within the model's budget: the chat's summary, then the turns after it.
        let mut messages = vec![ChatMessage::new(Role::System, system)];
        messages.extend(self.history_for(agent, model, run_id).await?);
        let mut message = ChatMessage::new(Role::User, input);
        message.images = images;
        messages.push(message);
        let rounds = current
            .get("rounds")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let answers_round = |action: &Value| {
            let id = text(action, "callId");
            !id.is_empty()
                && rounds.iter().any(|round| {
                    round
                        .get("calls")
                        .and_then(Value::as_array)
                        .is_some_and(|calls| calls.iter().any(|call| text(call, "id") == id))
                })
        };
        if !actions.is_empty() && !rounds.is_empty() && actions.iter().all(answers_round) {
            messages.extend(tool_turns(&rounds, actions));
        } else if !actions.is_empty() {
            // Runs from before native tool turns: the steps as a JSON list, as the model saw them then.
            let mut steps = ChatMessage::new(
                Role::Assistant,
                Value::Array(compact_actions(&sanitize_actions(actions))).to_string(),
            );
            steps.reasoning = current
                .get("thinking")
                .and_then(Value::as_str)
                .filter(|thinking| !thinking.is_empty())
                .map(str::to_owned);
            messages.push(steps);
            let screenshots = extract_screenshots(actions);
            if screenshots.is_empty() {
                // Ends the request on a user turn, which every provider accepts.
                messages.push(ChatMessage::new(Role::User, CONTINUE_AFTER_TOOLS));
            } else {
                let mut observed = ChatMessage::new(
                    Role::User,
                    "Observation from computer_screenshot (attached as multimodal image input):",
                );
                observed.images = screenshots;
                messages.push(observed);
            }
        }
        Ok(self
            .call_model(
                model,
                CompletionInput {
                    context: CallContext {
                        agent_id: text(agent, "id").to_owned(),
                        agent_name: text(agent, "name").to_owned(),
                        run_id: Some(run_id.to_owned()),
                        purpose: "run",
                    },
                    messages,
                    tools,
                    temperature: Some(number_of(agent.get("temperature"), 0.2, 0.0, 2.0)),
                    max_output: Some(
                        number_of(agent.get("maxOutput"), 4000.0, 1.0, 128_000.0) as u64
                    ),
                    low_thinking: false,
                },
            )
            .await?)
    }
}
