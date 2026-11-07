//! One agent turn: starting it, stopping it, answering its approvals, and the loop of model calls and tool rounds.
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use saturn_domain::hooks::HookDecision;
use saturn_domain::js;
use saturn_domain::new_id;
use saturn_domain::permissions::{Effect, Rule, Scope};
use saturn_domain::policies::{
    GuardrailMode, autonomy_of, is_read_only_call, is_sensitive_operation,
};
use saturn_domain::prompt::{RunMode, clip, explain_run_error, join_thinking, read_only_refusal};
use saturn_domain::time::{iso_time, now_millis};
use saturn_llm::{Completion, ImagePart, ToolCall};
use saturn_telemetry::{Kind, Span};
use serde_json::{Value, json};

use crate::permissions::explain;
use crate::records::{active, by_id, by_id_mut, generation, remove, strings, text};
use crate::run_images::{forget_images, save_images};
use crate::tool_runs::tool_category;
use crate::{CoreError, Kernel, locked, log};

/// computer_wait up to this long blocks inline; longer waits suspend the run and the scheduler resumes it.
pub const INLINE_WAIT_MS: f64 = 30_000.0;
/// One computer_wait call may suspend the run for at most an hour.
pub const MAX_WAIT_MS: f64 = 3_600_000.0;
/// Long waits per run, so a polling loop cannot run (and bill) forever.
pub const MAX_SLEEPS: u64 = 48;
/// Tool rounds one turn may take before it stops and says so; long computer-use tasks need a good number.
pub const MAX_TOOL_ROUNDS: usize = 60;
/// The tool steps in one turn of an agent with the research tools: a study takes many, and most of them wait on a run.
pub const MAX_RESEARCH_TOOL_ROUNDS: usize = 400;

/// How many tool steps one of an agent's turns may take.
fn tool_rounds_of(agent: &Value) -> usize {
    if strings(agent, "mcpConnectionIds")
        .iter()
        .any(|id| id == crate::builtins::RESEARCH_ID)
    {
        MAX_RESEARCH_TOOL_ROUNDS
    } else {
        MAX_TOOL_ROUNDS
    }
}
/// How many levels a sub-agent may delegate below the chat's own run.
pub const MAX_DELEGATION_DEPTH: usize = 2;
/// Tasks one `delegate` call may run at once.
pub const MAX_PARALLEL_DELEGATIONS: usize = 6;
/// The reason recorded when the user turns down an approval; the run continues and is not counted as failed.
pub(crate) const DENIED_BY_USER: &str = "Denied by the user";
/// Providers whose adapter sends a user's images to the model. DeepSeek's API takes text only.
const SEES_IMAGES: [&str; 7] = [
    "claude",
    "openai",
    "gemini",
    "lmstudio",
    "mlx",
    "claude-code",
    "codex",
];

/// What the user sees when a turn stops at the step limit.
pub fn step_limit_note(limit: usize) -> String {
    format!(
        "I stopped after {limit} tool steps, the limit for one turn, before finishing. Reply \"continue\" and I will pick up from here."
    )
}

/// A sub-agent run's link to the run that delegated it.
#[derive(Clone, Debug)]
pub struct ParentRun {
    pub run_id: String,
    pub task: String,
    pub tools: String,
}

/// What a new run may start with.
#[derive(Clone, Debug, Default)]
pub struct StartOptions {
    pub images: Vec<ImagePart>,
    pub mode: Option<RunMode>,
    /// Started by Saturn (a failed check, a stop hook), not by the user's message.
    pub automatic: bool,
    pub parent: Option<ParentRun>,
    /// Started because tasks this chat started reported back: their chats' ids.
    pub from_tasks: Vec<String>,
}

/// A tool call of a model's reply, with the id its result answers.
#[derive(Clone, Debug)]
pub(crate) struct Call {
    pub id: String,
    pub name: String,
    pub arguments: Value,
    pub thought_signature: Option<String>,
}

/// A new step record.
pub(crate) fn step(
    id: &str,
    tool: &str,
    arguments: &Value,
    status: &str,
    reason: Option<&str>,
) -> Value {
    let mut action = json!({ "id": id, "toolId": tool, "arguments": arguments, "status": status });
    if let Some(reason) = reason {
        action["reason"] = reason.into();
    }
    action
}

/// The step answers the call: its id, and Gemini's signature for it.
fn tag(mut action: Value, call: &Call) -> Value {
    if let Some(signature) = &call.thought_signature {
        action["thoughtSignature"] = signature.as_str().into();
    }
    action["callId"] = call.id.as_str().into();
    action
}

/// The first line of a message as a chat's title.
fn title_of(input: &str) -> String {
    let first = js::trim(input).split('\n').next().unwrap_or("");
    js::prefix(first, 45).to_owned()
}

/// The text, or a fallback when it is empty.
fn or_else<'a>(text: &'a str, fallback: &'a str) -> &'a str {
    if text.is_empty() { fallback } else { text }
}

/// A run's span and metrics, closed when its pass ends, however it does: a stopped run's task is dropped midway.
struct RunSpan {
    kernel: Arc<Kernel>,
    run_id: String,
    at: u64,
    span: Span,
    provider: Option<String>,
    started: std::time::Instant,
}

impl RunSpan {
    fn start(kernel: &Arc<Kernel>, run_id: &str, at: u64) -> Self {
        let run = kernel.find_run(run_id).unwrap_or(Value::Null);
        let agent_id = text(&run, "agentId").to_owned();
        let agent = kernel.get_agent(&agent_id).ok();
        let model = agent.as_ref().and_then(|agent| kernel.model_of(agent));
        let shown = agent
            .as_ref()
            .map_or_else(|| agent_id.clone(), |agent| text(agent, "name").to_owned());
        let mut attributes = json!({
            "gen_ai.operation.name": "invoke_agent",
            "gen_ai.agent.id": agent_id,
            "gen_ai.agent.name": agent.as_ref().map_or("", |agent| text(agent, "name")),
            "saturn.run.id": run_id,
            "saturn.run.generation": at,
        });
        if let Some(model) = &model {
            let name = text(model, "model");
            attributes["gen_ai.request.model"] = json!(if name.is_empty() {
                text(model, "name")
            } else {
                name
            });
            attributes["gen_ai.provider.name"] = json!(text(model, "provider"));
        }
        if let Some(autonomy) = agent
            .as_ref()
            .map(|agent| text(agent, "autonomy"))
            .filter(|autonomy| !autonomy.is_empty())
        {
            attributes["saturn.agent.autonomy"] = json!(autonomy);
        }
        Self {
            kernel: Arc::clone(kernel),
            run_id: run_id.to_owned(),
            at,
            span: Span::start(format!("invoke_agent {shown}"), Kind::Internal, attributes),
            provider: model
                .as_ref()
                .map(|model| text(model, "provider").to_owned()),
            started: std::time::Instant::now(),
        }
    }
}

impl Drop for RunSpan {
    fn drop(&mut self) {
        let run = self.kernel.find_run(&self.run_id);
        let status = match &run {
            None => "deleted".to_owned(),
            Some(run) if run.get("generation").and_then(Value::as_u64).unwrap_or(0) != self.at => {
                "superseded".to_owned()
            }
            Some(run) => text(run, "status").to_owned(),
        };
        self.span.set("saturn.run.status", status.as_str());
        self.span.set(
            "saturn.run.actions",
            run.as_ref()
                .and_then(|run| run["actions"].as_array())
                .map_or(0, Vec::len),
        );
        if status == "failed" {
            self.span.set("error.type", "run_failed");
        }
        if let Some(error) = run
            .as_ref()
            .map(|run| text(run, "error"))
            .filter(|error| !error.is_empty())
        {
            self.span.set("saturn.run.error", js::prefix(error, 200));
        }
        let mut labels = json!({ "saturn.run.status": status });
        if let Some(provider) = &self.provider {
            labels["gen_ai.provider.name"] = json!(provider);
        }
        saturn_telemetry::add("saturn.agent.runs", 1.0, labels.clone());
        saturn_telemetry::record(
            "saturn.agent.run.duration",
            self.started.elapsed().as_secs_f64(),
            labels,
        );
    }
}

impl Kernel {
    /// Runs `work` as a run's pass, so stopping the run can abort it.
    fn spawn_tracked(
        self: &Arc<Self>,
        run_id: &str,
        generation: u64,
        work: impl Future<Output = ()> + Send + 'static,
    ) {
        let key = format!("{run_id}:{generation}");
        // Held across the spawn, so a pass that ends at once removes its own entry only after it was added.
        let mut stops = locked(&self.stops);
        let kernel = Arc::clone(self);
        let owned = key.clone();
        // The work belongs to the trace of the request that started it.
        let work = saturn_telemetry::carry(work);
        let task = tokio::spawn(async move {
            work.await;
            locked(&kernel.stops).remove(&owned);
        });
        stops.insert(key, task.abort_handle());
    }

    /// Begins or continues a run in the background.
    pub(crate) fn advance(self: &Arc<Self>, run_id: &str) {
        let Some(current) = self.find_run(run_id) else {
            return;
        };
        if text(&current, "status") == "cancelled" {
            return;
        }
        let at = generation(&current);
        let kernel = Arc::clone(self);
        let id = run_id.to_owned();
        self.spawn_tracked(run_id, at, async move { kernel.pass(&id, at).await });
    }

    /// Starts a turn in a chat: the chat's own when one is named, a new one in a project, else the agent's own.
    pub async fn start_run(
        self: &Arc<Self>,
        agent_id: &str,
        input: &str,
        thread_id: Option<&str>,
        project_id: Option<&str>,
        options: StartOptions,
    ) -> Result<Value, CoreError> {
        let agent = self.get_agent(agent_id)?;
        self.guard(agent_id)?;
        let model = self.require_model(&agent)?;
        self.broker
            .require_key(&crate::catalog::connection_of(&model))?;
        if !options.images.is_empty() && !SEES_IMAGES.contains(&text(&model, "provider")) {
            return Err(CoreError::new(
                409,
                format!(
                    "{} cannot take images. Remove them, or switch the agent to a model that can see (Claude, OpenAI, Gemini, Claude Code, Codex, or a vision model in LM Studio).",
                    text(&model, "name")
                ),
            ));
        }
        // A project chat only runs once the user has allowed access to its folder.
        let thread_project = match thread_id {
            Some(id) => self
                .find_thread(id)
                .map(|thread| text(&thread, "projectId").to_owned()),
            None => project_id.map(str::to_owned),
        };
        if let Some(project) = thread_project.filter(|id| !id.is_empty()) {
            self.workdir(&project)?;
        }
        let effective = self
            .thread_for_run(agent_id, input, thread_id, project_id)
            .await?;
        // Tasks this chat started may have reported back since its last turn.
        let input = &self.with_task_reports(&effective, input).await?;
        let id = new_id("run")?;
        let mut run = json!({
            "id": id,
            "agentId": agent_id,
            "threadId": effective,
            "input": input,
            "status": "running",
            "output": "",
            "thinking": "",
            "thoughts": [],
            "actions": [],
            "generation": 0,
        });
        if !options.images.is_empty() {
            run["inputImages"] = json!(save_images(self.store.root(), &id, &options.images).await?);
        }
        // A Manual chat only reads, whatever was asked. So does a Pair chat on Codex, which cannot ask before it writes.
        let chat_mode = self.chat_mode_of(&run);
        let reads_only = chat_mode.as_deref() == Some("manual")
            || (chat_mode.as_deref() == Some("pair") && text(&model, "provider") == "codex");
        let mode = match options.mode {
            Some(mode) if mode.reads_only() => Some(mode),
            _ if reads_only => Some(RunMode::Ask),
            mode => mode,
        };
        if let Some(mode) = mode.filter(|mode| *mode != RunMode::Agent) {
            run["mode"] = mode.as_str().into();
        }
        if options.automatic {
            run["automatic"] = true.into();
        }
        if !options.from_tasks.is_empty() {
            run["fromTasks"] = json!(options.from_tasks);
        }
        if let Some(parent) = &options.parent {
            run["parentRunId"] = parent.run_id.as_str().into();
            run["delegated"] = json!({ "task": parent.task, "tools": parent.tools });
        }
        let saved = run.clone();
        self.store
            .update(|state| state.runs.insert(0, saved))
            .await?;
        self.advance(&id);
        Ok(run)
    }

    /// One agent's turn in a group chat. It belongs to no chat thread: the group transcript travels in `input`, so earlier
    /// turns are not replayed as history.
    pub(crate) async fn start_group_run(
        self: &Arc<Self>,
        agent_id: &str,
        input: &str,
        group_id: &str,
        message_id: &str,
    ) -> Result<Value, CoreError> {
        let agent = self.get_agent(agent_id)?;
        self.guard(agent_id)?;
        let model = self.require_model(&agent)?;
        self.broker
            .require_key(&crate::catalog::connection_of(&model))?;
        let id = new_id("run")?;
        let run = json!({
            "id": id,
            "agentId": agent_id,
            "groupId": group_id,
            "groupMessageId": message_id,
            "input": input,
            "status": "running",
            "output": "",
            "thinking": "",
            "thoughts": [],
            "actions": [],
            "generation": 0,
        });
        let saved = run.clone();
        self.store
            .update(|state| state.runs.insert(0, saved))
            .await?;
        self.advance(&id);
        Ok(run)
    }

    /// The chat a new run belongs to, created or touched as needed.
    async fn thread_for_run(
        &self,
        agent_id: &str,
        input: &str,
        thread_id: Option<&str>,
        project_id: Option<&str>,
    ) -> Result<String, CoreError> {
        let now = iso_time(now_millis());
        let title = title_of(input);
        if let Some(id) = thread_id {
            let (id, title) = (id.to_owned(), title);
            let owned = id.clone();
            self.store
                .update(move |state| match by_id_mut(&mut state.threads, &owned) {
                    Some(thread) => {
                        thread["updatedAt"] = now.as_str().into();
                        if matches!(
                            text(thread, "title"),
                            "New Conversation" | "New Chat" | "Untitled Chat"
                        ) && !title.is_empty()
                        {
                            thread["title"] = title.into();
                        }
                    }
                    None => state.threads.insert(
                        0,
                        json!({
                            "id": owned,
                            "agentId": agent_id,
                            "title": or_else(&title, "Conversation"),
                            "createdAt": now,
                            "updatedAt": now,
                        }),
                    ),
                })
                .await?;
            return Ok(id);
        }
        if project_id.is_some() {
            let thread = self
                .create_thread(agent_id, Some(or_else(&title, "New Chat")), project_id)
                .await?;
            return Ok(text(&thread, "id").to_owned());
        }
        let existing = self.store.read(|state| {
            state
                .threads
                .iter()
                .find(|thread| {
                    text(thread, "agentId") == agent_id && text(thread, "projectId").is_empty()
                })
                .map(|thread| text(thread, "id").to_owned())
        });
        if let Some(id) = existing {
            return Ok(id);
        }
        let id = new_id("thread")?;
        let thread = json!({ "id": id, "agentId": agent_id, "title": or_else(&title, "Conversation"), "createdAt": now, "updatedAt": now });
        self.store
            .update(|state| state.threads.insert(0, thread))
            .await?;
        Ok(id)
    }

    /// Runs still marked running or queued at startup were cut off when the runtime last stopped; nothing resumes them, so they
    /// are failed with the reason instead of spinning forever.
    pub async fn recover_interrupted(&self) -> Result<usize, CoreError> {
        let stuck: Vec<String> = self
            .store
            .update(|state| {
                // A Claude Code or Codex run waiting on an approval lived in a process the restart ended, so it is stuck too.
                let program: Vec<String> = state
                    .agents
                    .iter()
                    .filter(|agent| {
                        by_id(&state.models, text(agent, "modelConnectionId"))
                            .is_some_and(|model| saturn_domain::llm::runs_on_plan(text(model, "provider")))
                    })
                    .map(|agent| text(agent, "id").to_owned())
                    .collect();
                let mut stuck = Vec::new();
                for run in &mut state.runs {
                    let status = text(run, "status");
                    let cut_off = status == "running"
                        || status == "queued"
                        || (status == "waiting_approval" && program.iter().any(|id| id == text(run, "agentId")));
                    if cut_off {
                        run["status"] = "failed".into();
                        run["error"] = "Interrupted when the runtime restarted. Send the message again to rerun it.".into();
                        run["generation"] = (generation(run) + 1).into();
                        stuck.push(text(run, "id").to_owned());
                    }
                }
                stuck
            })
            .await?;
        for id in &stuck {
            log(
                "agent",
                "warning",
                &format!("Run {id} was interrupted by the last restart and marked failed"),
            );
        }
        Ok(stuck.len())
    }

    /// The approval cards waiting for the user.
    pub fn pending_tasks(&self) -> Vec<Value> {
        self.store.read(|state| {
            state
                .runs
                .iter()
                .filter(|run| text(run, "status") == "waiting_approval")
                .map(|run| {
                    let waiting = run.get("actions").and_then(Value::as_array).and_then(|actions| actions.iter().find(|action| text(action, "status") == "waiting_approval"));
                    json!({
                        "id": text(run, "id"),
                        "agentId": text(run, "agentId"),
                        "agentName": by_id(&state.agents, text(run, "agentId")).map_or("Agent", |agent| text(agent, "name")),
                        "input": text(run, "input"),
                        "toolId": waiting.map_or("", |action| text(action, "toolId")),
                    })
                })
                .collect()
        })
    }

    /// A chat's turns, oldest first, each with its sub-agent runs.
    pub fn messages_for(
        &self,
        agent_id: &str,
        thread_id: Option<&str>,
    ) -> Result<Vec<Value>, CoreError> {
        self.get_agent(agent_id)?;
        let list: Vec<Value> = self.store.read(|state| {
            state
                .runs
                .iter()
                .filter(|item| {
                    text(item, "agentId") == agent_id
                        && text(item, "groupId").is_empty()
                        && thread_id.is_none_or(|id| text(item, "threadId") == id)
                        && text(item, "parentRunId").is_empty()
                })
                .cloned()
                .collect()
        });
        Ok(list
            .into_iter()
            .rev()
            .map(|run| self.with_children(run))
            .collect())
    }

    /// The run with its sub-agent runs attached, each with its own.
    pub fn with_children(&self, mut run: Value) -> Value {
        let id = text(&run, "id").to_owned();
        let children: Vec<Value> = self.store.read(|state| {
            state
                .runs
                .iter()
                .filter(|item| text(item, "parentRunId") == id)
                .rev()
                .cloned()
                .collect()
        });
        if !children.is_empty() {
            run["children"] = children
                .into_iter()
                .map(|child| self.with_children(child))
                .collect();
        }
        run
    }

    /// The run that started a chain of delegations, so checkpoints and reviews gather on it.
    pub(crate) fn root_run_id(&self, run_id: &str) -> String {
        let mut current = run_id.to_owned();
        for _ in 0..10 {
            let parent = self
                .find_run(&current)
                .map(|run| text(&run, "parentRunId").to_owned())
                .unwrap_or_default();
            if parent.is_empty() {
                break;
            }
            current = parent;
        }
        current
    }

    pub(crate) fn depth_of(&self, run_id: &str) -> usize {
        let mut depth = 0;
        let mut current = run_id.to_owned();
        while depth < 10 {
            let parent = self
                .find_run(&current)
                .map(|run| text(&run, "parentRunId").to_owned())
                .unwrap_or_default();
            if parent.is_empty() {
                break;
            }
            depth += 1;
            current = parent;
        }
        depth
    }

    /// Waits for a run to settle. Stopping the run that waits drops this, and stopping that run stops this one too.
    pub(crate) async fn wait_for_run(&self, run_id: &str) -> Result<Value, CoreError> {
        let mut changes = self.store.changes();
        loop {
            let run = self.get_run(run_id)?;
            if !active(&run) {
                return Ok(run);
            }
            let _ = tokio::time::timeout(Duration::from_millis(150), changes.changed()).await;
        }
    }

    /// The agent's chats, newest first. Runs saved before chats existed are gathered into one.
    pub async fn list_threads(&self, agent_id: &str) -> Result<Vec<Value>, CoreError> {
        self.get_agent(agent_id)?;
        let legacy_title = self.store.read(|state| {
            state
                .runs
                .iter()
                .rev()
                .find(|run| {
                    text(run, "agentId") == agent_id
                        && text(run, "threadId").is_empty()
                        && text(run, "groupId").is_empty()
                })
                .map(|run| title_of(text(run, "input")))
        });
        if let Some(title) = legacy_title {
            let now = iso_time(now_millis());
            let id = format!("legacy_{agent_id}");
            self.store
                .update(|state| {
                    if by_id(&state.threads, &id).is_none() {
                        state.threads.insert(0, json!({ "id": id, "agentId": agent_id, "title": or_else(&title, "Previous Conversation"), "createdAt": now, "updatedAt": now }));
                    }
                    for run in &mut state.runs {
                        if text(run, "agentId") == agent_id && text(run, "threadId").is_empty() && text(run, "groupId").is_empty() {
                            run["threadId"] = id.as_str().into();
                        }
                    }
                })
                .await?;
        }
        let mut threads: Vec<Value> = self.store.read(|state| {
            state
                .threads
                .iter()
                .filter(|thread| text(thread, "agentId") == agent_id)
                .cloned()
                .collect()
        });
        threads.sort_by(|a, b| text(b, "updatedAt").cmp(text(a, "updatedAt")));
        Ok(threads)
    }

    /// A new chat, in a project when one is named.
    pub async fn create_thread(
        &self,
        agent_id: &str,
        title: Option<&str>,
        project_id: Option<&str>,
    ) -> Result<Value, CoreError> {
        self.get_agent(agent_id)?;
        if let Some(project) = project_id
            && self
                .store
                .read(|state| by_id(&state.projects, project).is_none())
        {
            return Err(CoreError::new(404, "Project not found"));
        }
        let now = iso_time(now_millis());
        let mut thread = json!({ "id": new_id("thread")?, "agentId": agent_id });
        if let Some(project) = project_id {
            thread["projectId"] = project.into();
        }
        thread["title"] = or_else(js::trim(title.unwrap_or("")), "New Chat").into();
        thread["createdAt"] = now.as_str().into();
        thread["updatedAt"] = now.into();
        let saved = thread.clone();
        self.store
            .update(|state| state.threads.insert(0, saved))
            .await?;
        Ok(thread)
    }

    pub async fn rename_thread(&self, thread_id: &str, title: &str) -> Result<Value, CoreError> {
        let trimmed = js::trim(title);
        if trimmed.is_empty() {
            return Err(CoreError::new(400, "Title is required"));
        }
        let now = iso_time(now_millis());
        self.store
            .update(|state| {
                let thread = by_id_mut(&mut state.threads, thread_id)
                    .ok_or_else(|| CoreError::new(404, "Conversation not found"))?;
                thread["title"] = trimmed.into();
                thread["updatedAt"] = now.into();
                Ok(thread.clone())
            })
            .await?
    }

    /// Sets how much a chat's agent may change.
    pub async fn set_chat_mode(&self, thread_id: &str, mode: &str) -> Result<Value, CoreError> {
        if !saturn_domain::research::is_chat_mode(mode) {
            return Err(CoreError::new(
                400,
                "A chat's mode must be manual, pair or delegate.",
            ));
        }
        let now = iso_time(now_millis());
        self.store
            .update(|state| {
                let thread = by_id_mut(&mut state.threads, thread_id)
                    .ok_or_else(|| CoreError::new(404, "Conversation not found"))?;
                thread["chatMode"] = mode.into();
                thread["updatedAt"] = now.into();
                Ok(thread.clone())
            })
            .await?
    }

    /// Deletes a chat with its worktree, runs, background commands and saved copies.
    pub async fn delete_thread(&self, thread_id: &str) -> Result<(), CoreError> {
        self.refuse_if_running_experiment(thread_id)?;
        if self
            .find_thread(thread_id)
            .is_some_and(|thread| thread.get("worktree").is_some_and(|tree| !tree.is_null()))
        {
            let _ = self.finish_worktree(thread_id, "discard", None).await;
        }
        let removed: Vec<String> = self.store.read(|state| {
            state
                .runs
                .iter()
                .filter(|run| text(run, "threadId") == thread_id)
                .map(|run| text(run, "id").to_owned())
                .collect()
        });
        self.jobs.stop_all(Some(thread_id));
        self.store
            .update(|state| {
                state
                    .threads
                    .retain(|thread| text(thread, "id") != thread_id);
                state.runs.retain(|run| text(run, "threadId") != thread_id);
            })
            .await?;
        self.forget_checkpoints(&removed).await;
        forget_images(self.store.root(), &removed).await;
        Ok(())
    }

    /// The runs worth showing in a list of agents at work: every run still going, then the latest finished ones, newest first.
    /// Group turns are left out.
    pub fn recent_runs(&self, project_id: Option<&str>, limit: usize) -> Vec<Value> {
        self.store.read(|state| {
            let runs: Vec<&Value> = state
                .runs
                .iter()
                .filter(|run| {
                    text(run, "groupId").is_empty()
                        && !text(run, "threadId").is_empty()
                        && text(run, "parentRunId").is_empty()
                        && project_id.is_none_or(|project| by_id(&state.threads, text(run, "threadId")).is_some_and(|thread| text(thread, "projectId") == project))
                })
                .collect();
            let going = runs.iter().filter(|run| active(run));
            let finished = runs.iter().filter(|run| !active(run)).take(limit);
            going
                .chain(finished)
                .map(|run| {
                    let thread = by_id(&state.threads, text(run, "threadId"));
                    let input = text(run, "input");
                    let shown = input.split("\n<saturn_context").next().unwrap_or(input);
                    let changed = run.get("checkpoint").and_then(|checkpoint| checkpoint.get("files")).and_then(Value::as_array).map_or(0, |files| {
                        files.iter().filter(|file| file.get("before") != file.get("after")).count()
                    });
                    let mut summary = json!({
                        "id": text(run, "id"),
                        "agentId": text(run, "agentId"),
                        "agentName": by_id(&state.agents, text(run, "agentId")).map_or("Agent", |agent| text(agent, "name")),
                        "threadId": text(run, "threadId"),
                        "threadTitle": thread.map_or("Chat", |thread| text(thread, "title")),
                    });
                    if let Some(project) = thread.map(|thread| text(thread, "projectId")).filter(|id| !id.is_empty()) {
                        summary["projectId"] = project.into();
                    }
                    if let Some(tree) = thread.and_then(|thread| thread.get("worktree")).filter(|tree| !tree.is_null()) {
                        summary["branch"] = text(tree, "branch").into();
                    }
                    summary["status"] = text(run, "status").into();
                    summary["input"] = clip(shown, 120).into();
                    summary["changedFiles"] = changed.into();
                    if let Some(updated) = thread.map(|thread| text(thread, "updatedAt")).filter(|at| !at.is_empty()) {
                        summary["updatedAt"] = updated.into();
                    }
                    summary
                })
                .collect()
        })
    }

    /// Edits a message and reruns that turn, dropping the later ones.
    pub async fn revise_run(self: &Arc<Self>, id: &str, input: &str) -> Result<Value, CoreError> {
        let trimmed = js::trim(input);
        if trimmed.is_empty() {
            return Err(CoreError::new(400, "Message is empty"));
        }
        let existing = self.get_run(id)?;
        self.guard(text(&existing, "agentId"))?;
        let agent = self.get_agent(text(&existing, "agentId"))?;
        self.require_model(&agent)?;
        let removed: Vec<String> = self
            .store
            .update(|state| {
                let Some(index) = state.runs.iter().position(|item| text(item, "id") == id) else {
                    return Vec::new();
                };
                let agent_id = text(&state.runs[index], "agentId").to_owned();
                let thread = text(&state.runs[index], "threadId").to_owned();
                let removed: Vec<String> = state.runs[..index]
                    .iter()
                    .filter(|item| {
                        text(item, "agentId") == agent_id
                            && (thread.is_empty() || text(item, "threadId") == thread)
                    })
                    .map(|item| text(item, "id").to_owned())
                    .collect();
                state
                    .runs
                    .retain(|item| !removed.iter().any(|gone| gone == text(item, "id")));
                if let Some(run) = by_id_mut(&mut state.runs, id) {
                    run["input"] = trimmed.into();
                    run["output"] = "".into();
                    run["thinking"] = "".into();
                    run["thoughts"] = json!([]);
                    run["actions"] = json!([]);
                    remove(run, "rounds");
                    remove(run, "error");
                    run["status"] = "running".into();
                    run["generation"] = (generation(run) + 1).into();
                }
                removed
            })
            .await?;
        if !removed.is_empty() {
            forget_images(self.store.root(), &removed).await;
        }
        let run = self.get_run(id)?;
        log(
            "agent",
            "info",
            &format!(
                "{}: message edited, rerunning that turn",
                text(&agent, "name")
            ),
        );
        self.advance(id);
        Ok(json!({ "run": run, "removed": removed }))
    }

    /// Resumes sleeping runs whose wake time has come; also catches up on runs that slept through a restart.
    pub async fn wake_due(self: &Arc<Self>) -> Vec<String> {
        let now = now_millis();
        let due: Vec<String> = self.store.read(|state| {
            state
                .runs
                .iter()
                .filter(|run| {
                    text(run, "status") == "sleeping"
                        && run
                            .get("wake")
                            .and_then(|wake| saturn_domain::time::parse_iso(text(wake, "at")))
                            .is_some_and(|at| at <= now)
                })
                .map(|run| text(run, "id").to_owned())
                .collect()
        });
        for id in &due {
            if let Err(error) = self.resume(id, now, false).await {
                log(
                    "agent",
                    "warning",
                    &format!("Could not wake a run: {error}"),
                );
            }
        }
        due
    }

    /// Wakes a sleeping run now (the user's "Wake now"), handing the model how long it actually waited.
    pub async fn wake_run(self: &Arc<Self>, id: &str) -> Result<Value, CoreError> {
        if text(&self.get_run(id)?, "status") != "sleeping" {
            return Err(CoreError::new(409, "This run is not waiting"));
        }
        self.resume(id, now_millis(), true).await?;
        self.get_run(id)
    }

    async fn resume(self: &Arc<Self>, id: &str, now: i64, early: bool) -> Result<(), CoreError> {
        let resumed = self
            .store
            .update(|state| {
                let Some(run) = by_id_mut(&mut state.runs, id) else {
                    return false;
                };
                let Some(wake) = run.get("wake").filter(|_| text(run, "status") == "sleeping").cloned() else {
                    return false;
                };
                let since = saturn_domain::time::parse_iso(text(&wake, "since")).unwrap_or(now);
                let action = run.get_mut("actions").and_then(Value::as_array_mut).and_then(|actions| actions.iter_mut().find(|item| text(item, "id") == text(&wake, "actionId")));
                if let Some(action) = action {
                    action["status"] = "completed".into();
                    let mut result = json!({ "waited_ms": (now - since).max(0), "requested_ms": wake.get("requestedMs") });
                    if let Some(reason) = wake.get("reason") {
                        result["reason"] = reason.clone();
                    }
                    result["woke"] = if early { "early, by the user" } else { "on time" }.into();
                    result["now"] = iso_time(now).into();
                    action["result"] = result;
                }
                run["status"] = "running".into();
                run["sleeps"] = (run.get("sleeps").and_then(Value::as_u64).unwrap_or(0) + 1).into();
                remove(run, "wake");
                true
            })
            .await?;
        if resumed {
            self.advance(id);
        }
        Ok(())
    }

    /// Suspends the run on a long computer_wait. Returns the action recorded in its place.
    async fn sleep(
        &self,
        run_id: &str,
        at: u64,
        call: &Call,
        actions: &mut Vec<Value>,
    ) -> Result<Value, CoreError> {
        let run = self.get_run(run_id)?;
        let ms = call
            .arguments
            .get("ms")
            .filter(|value| !value.is_null())
            .or_else(|| {
                call.arguments
                    .get("duration_ms")
                    .filter(|value| !value.is_null())
            });
        let requested = js::number(ms).clamp(0.0, MAX_WAIT_MS);
        let reason = call
            .arguments
            .get("reason")
            .and_then(Value::as_str)
            .map(|text| js::prefix(text, 300).to_owned());
        let mut action = step(
            &new_id("act")?,
            &call.name,
            &call.arguments,
            "sleeping",
            reason.as_deref(),
        );
        action = tag(action, call);
        if run.get("sleeps").and_then(Value::as_u64).unwrap_or(0) >= MAX_SLEEPS {
            action["status"] = "completed".into();
            action["result"] = json!({ "error": format!("This run has already waited {MAX_SLEEPS} times; finish with what you have or ask the user.") });
            return Ok(action);
        }
        let since = now_millis();
        actions.push(action.clone());
        let mut wake = json!({ "at": iso_time(since + requested as i64), "since": iso_time(since), "actionId": text(&action, "id"), "requestedMs": requested as i64 });
        if let Some(reason) = reason {
            wake["reason"] = reason.into();
        }
        let saved = Value::Array(actions.clone());
        self.update_run(run_id, at, move |current| {
            current["actions"] = saved;
            current["status"] = "sleeping".into();
            current["wake"] = wake;
        })
        .await?;
        Ok(action)
    }

    /// Stops a run: aborts its pass, which drops whatever it was waiting for, and stops its sub-agents.
    pub fn stop_run<'a>(
        self: &'a Arc<Self>,
        id: &'a str,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<Value, CoreError>> + Send + 'a>> {
        Box::pin(async move {
            let run = self.get_run(id)?;
            if !active(&run) {
                return Ok(run);
            }
            let prefix = format!("{id}:");
            locked(&self.stops).retain(|key, handle| {
                let stopping = key.starts_with(&prefix);
                if stopping {
                    handle.abort();
                }
                !stopping
            });
            self.store
                .update(|state| {
                    if let Some(current) =
                        by_id_mut(&mut state.runs, id).filter(|current| active(current))
                    {
                        current["status"] = "cancelled".into();
                        remove(current, "wake");
                        current["generation"] = (generation(current) + 1).into();
                        remove(current, "error");
                    }
                })
                .await?;
            let children: Vec<String> = self.store.read(|state| {
                state
                    .runs
                    .iter()
                    .filter(|item| text(item, "parentRunId") == id)
                    .map(|item| text(item, "id").to_owned())
                    .collect()
            });
            for child in children {
                self.stop_run(&child).await?;
            }
            log("agent", "info", &format!("Run {id} stopped"));
            self.get_run(id)
        })
    }

    /// The user's answer to an approval card. The waiting tool call runs, or is denied, and the turn continues from there as a
    /// new generation, so nothing from the paused pass can resume.
    pub async fn decide(
        self: &Arc<Self>,
        run_id: &str,
        action_id: &str,
        allow: bool,
    ) -> Result<Value, CoreError> {
        let run = self.get_run(run_id)?;
        let actions = run
            .get("actions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let index = actions.iter().position(|item| {
            text(item, "id") == action_id && text(item, "status") == "waiting_approval"
        });
        let index = index
            .filter(|_| text(&run, "status") == "waiting_approval")
            .ok_or_else(|| CoreError::new(409, "This approval is no longer waiting"))?;
        self.guard(text(&run, "agentId"))?;
        let pending = actions[index].clone();
        let at = generation(&run) + 1;
        let kept: Vec<Value> = actions[..index].to_vec();
        let saved = Value::Array(kept.clone());
        self.store
            .update(|state| {
                if let Some(current) = by_id_mut(&mut state.runs, run_id) {
                    current["status"] = "running".into();
                    current["generation"] = at.into();
                    current["actions"] = saved;
                }
            })
            .await?;
        let kernel = Arc::clone(self);
        let id = run_id.to_owned();
        self.spawn_tracked(run_id, at, async move {
            if let Err(error) = kernel
                .continue_after_decision(&id, at, &pending, allow, kept)
                .await
                && kernel.alive(&id, at)
            {
                kernel.fail(&id, at, &error.message).await;
            }
        });
        self.get_run(run_id)
    }

    async fn continue_after_decision(
        self: &Arc<Self>,
        run_id: &str,
        at: u64,
        pending: &Value,
        allow: bool,
        mut actions: Vec<Value>,
    ) -> Result<(), CoreError> {
        let run = self.get_run(run_id)?;
        let agent = self.get_agent(text(&run, "agentId"))?;
        let model = self.require_model(&agent)?;
        let tool = text(pending, "toolId");
        let mut done = if allow {
            let action = self
                .execute_tool(
                    text(&agent, "id"),
                    tool,
                    pending.get("arguments").unwrap_or(&Value::Null),
                    run_id,
                    text(pending, "id"),
                )
                .await?;
            self.after_tool(&agent, &run, action).await
        } else {
            let mut denied = pending.clone();
            denied["status"] = "denied".into();
            denied["reason"] = DENIED_BY_USER.into();
            denied
        };
        for key in ["thoughtSignature", "callId"] {
            if let Some(value) = pending.get(key) {
                done[key] = value.clone();
            }
        }
        actions.push(done);
        log(
            "agent",
            "info",
            &format!(
                "{} {tool} {} by the user",
                text(&agent, "name"),
                if allow { "approved" } else { "denied" }
            ),
        );
        if !self.alive(run_id, at) {
            return Ok(());
        }
        let saved = Value::Array(actions.clone());
        self.update_run(run_id, at, move |current| current["actions"] = saved)
            .await?;
        let context = self.rag_context(&agent, text(&run, "input")).await?;
        self.finish_from_model(run_id, at, &agent, &model, &context, actions, None)
            .await
    }

    /// One pass of a run.
    async fn pass(self: &Arc<Self>, run_id: &str, at: u64) {
        if !self.alive(run_id, at) {
            return;
        }
        let traced = RunSpan::start(self, run_id, at);
        traced
            .span
            .clone()
            .scope(self.pass_traced(run_id, at))
            .await;
    }

    async fn pass_traced(self: &Arc<Self>, run_id: &str, at: u64) {
        if let Err(error) = self.pass_inner(run_id, at).await
            && self.alive(run_id, at)
        {
            self.fail(run_id, at, &error.message).await;
        }
    }

    async fn pass_inner(self: &Arc<Self>, run_id: &str, at: u64) -> Result<(), CoreError> {
        let run = self.get_run(run_id)?;
        let agent = self.get_agent(text(&run, "agentId"))?;
        let model = self.require_model(&agent)?;
        self.guard(text(&agent, "id"))?;
        match text(&model, "provider") {
            // The official programs run the whole agent loop (tools, approvals, session) themselves.
            "claude-code" => {
                let watched = self.get_run(run_id)?;
                self.research_watch_run(&watched).await;
                let turn = Box::pin(self.claude_turn(run_id, at, &agent, &model)).await;
                self.research_check_run(&watched, "Claude Code").await;
                turn?;
                self.note_program_finished(run_id, at);
                return Ok(());
            }
            "codex" => {
                let watched = self.get_run(run_id)?;
                self.research_watch_run(&watched).await;
                let turn = Box::pin(self.codex_turn(run_id, at, &agent, &model)).await;
                self.research_check_run(&watched, "Codex").await;
                turn?;
                self.note_program_finished(run_id, at);
                return Ok(());
            }
            _ => {}
        }
        let input = text(&run, "input");
        let context = self.rag_context(&agent, input).await?;
        if !self.alive(run_id, at) {
            return Ok(());
        }
        let done = run
            .get("actions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if !done.is_empty() {
            // Resuming (after a wait): continue from the actions already taken instead of starting over.
            return self
                .finish_from_model(run_id, at, &agent, &model, &context, done, None)
                .await;
        }
        log(
            "agent",
            "info",
            &format!(
                "{} asked {}: {}",
                text(&agent, "name"),
                or_else(text(&model, "model"), text(&model, "name")),
                clip(input, 120)
            ),
        );
        let started = now_millis();
        let tools = self.tool_list(
            &agent,
            RunMode::parse(run.get("mode").and_then(Value::as_str)),
            Some(run_id),
        );
        let first = self
            .complete(&model, &agent, run_id, input, &context, tools, &[])
            .await?;
        if !self.alive(run_id, at) {
            return Ok(());
        }
        self.note_thinking(run_id, at, &first, started).await?;
        let mut actions = Vec::new();
        let waiting = self
            .run_tools(&agent, run_id, at, &first, &mut actions)
            .await?;
        if waiting || !self.alive(run_id, at) {
            return Ok(());
        }
        // A reply with no tool calls is already the answer; asking again would only double the cost.
        let answered = first.tool_calls.is_empty().then_some(first);
        self.finish_from_model(run_id, at, &agent, &model, &context, actions, answered)
            .await
    }

    /// The tool calls of a reply, each with an id (the provider's, or one of ours).
    fn calls_of(calls: &[ToolCall]) -> Result<Vec<Call>, CoreError> {
        calls
            .iter()
            .map(|call| {
                Ok(Call {
                    id: match &call.id {
                        Some(id) => id.clone(),
                        None => new_id("call")?,
                    },
                    name: call.name.clone(),
                    arguments: Value::Object(call.arguments.clone()),
                    thought_signature: call.thought_signature.clone(),
                })
            })
            .collect()
    }

    /// Runs a reply's tool calls in order. True when the round ended early: the run waits for something, or was stopped.
    async fn run_tools(
        self: &Arc<Self>,
        agent: &Value,
        run_id: &str,
        at: u64,
        reply: &Completion,
        actions: &mut Vec<Value>,
    ) -> Result<bool, CoreError> {
        let calls = Self::calls_of(&reply.tool_calls)?;
        if !calls.is_empty() {
            // The reply is kept as a round, so the next request sends the calls and their results in the provider's own format.
            let listed: Vec<Value> = calls
                .iter()
                .map(|call| {
                    let mut item =
                        json!({ "id": call.id, "name": call.name, "arguments": call.arguments });
                    if let Some(signature) = &call.thought_signature {
                        item["thoughtSignature"] = signature.as_str().into();
                    }
                    item
                })
                .collect();
            let mut round = json!({ "calls": listed });
            if !reply.content.is_empty() {
                round["text"] = reply.content.as_str().into();
            }
            let thinking = js::trim(&reply.thinking);
            if !thinking.is_empty() {
                round["thinking"] = thinking.into();
            }
            if let Some(replay) = &reply.replay {
                round["replay"] = json!(replay);
            }
            self.update_run(run_id, at, move |current| {
                if !current.get("rounds").is_some_and(Value::is_array) {
                    current["rounds"] = json!([]);
                }
                if let Some(rounds) = current["rounds"].as_array_mut() {
                    rounds.push(round);
                }
            })
            .await?;
        }
        let agent_id = text(agent, "id");
        let run = self.get_run(run_id)?;
        // In a group, the group's approval setting (when it has one) replaces the agent's own.
        let autonomy = self.store.read(|state| {
            by_id(&state.groups, text(&run, "groupId"))
                .and_then(|group| group.get("autonomy"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
        let mode = autonomy_of(
            autonomy
                .as_deref()
                .or_else(|| {
                    self.chat_mode_of(&run)
                        .and_then(|mode| saturn_domain::research::chat_approvals(&mode))
                })
                .or_else(|| agent.get("autonomy").and_then(Value::as_str)),
        );
        let turn_mode = RunMode::parse(run.get("mode").and_then(Value::as_str));
        for call in calls {
            if !self.alive(run_id, at) {
                return Ok(true);
            }
            self.guard(agent_id)?;
            let arguments = call.arguments.as_object().cloned().unwrap_or_default();
            // An Ask or Plan turn only reads: a tool that would change something is refused, and the model is told why.
            if let Some(reading) = turn_mode.filter(|mode| mode.reads_only()) {
                let category = self
                    .store
                    .read(|state| tool_category(state, agent, &call.name));
                if !is_read_only_call(&call.name, &arguments, category.as_deref()) {
                    let refused = step(
                        &new_id("act")?,
                        &call.name,
                        &call.arguments,
                        "denied",
                        Some(&read_only_refusal(reading)),
                    );
                    actions.push(tag(refused, &call));
                    continue;
                }
            }
            // pre_tool hooks first: exit 2 or a "deny" answer refuses the call; "allow" and "ask" act like rules.
            let current = self.get_run(run_id)?;
            let hooked = self
                .before_tool(agent, &current, &call.name, &call.arguments)
                .await;
            if let Some(blocked) = &hooked.blocked {
                let refused = step(
                    &new_id("act")?,
                    &call.name,
                    &call.arguments,
                    "denied",
                    Some(&format!("Blocked by a hook: {blocked}")),
                );
                actions.push(tag(refused, &call));
                log(
                    "agent",
                    "warning",
                    &format!(
                        "{} {} blocked by a pre_tool hook",
                        text(agent, "name"),
                        call.name
                    ),
                );
                continue;
            }
            // The permission rules: a deny rule refuses the call, an allow rule runs it without asking in any mode, an ask rule
            // asks. A hook's answer counts like a rule from the hook; the stricter of the two wins.
            let ruled = self
                .decide_permission(agent_id, &current, &call.name, &arguments)
                .await;
            let from_hook = |effect| saturn_domain::permissions::Decision {
                effect,
                rule: Rule {
                    tool: call.name.clone(),
                    pattern: "*".to_owned(),
                    effect,
                },
                scope: Scope::User,
                path: Some("hook".to_owned()),
            };
            let ruled_effect = ruled.as_ref().map(|decision| decision.effect);
            let ruling = if hooked.decision == Some(HookDecision::Ask)
                && ruled_effect != Some(Effect::Deny)
            {
                Some(from_hook(Effect::Ask))
            } else if hooked.decision == Some(HookDecision::Allow) && ruled.is_none() {
                Some(from_hook(Effect::Allow))
            } else {
                ruled
            };
            if let Some(decision) = ruling
                .as_ref()
                .filter(|decision| decision.effect == Effect::Deny)
            {
                let refused = step(
                    &new_id("act")?,
                    &call.name,
                    &call.arguments,
                    "denied",
                    Some(&explain(decision)),
                );
                actions.push(tag(refused, &call));
                log(
                    "agent",
                    "warning",
                    &format!(
                        "{} {} denied by a permission rule",
                        text(agent, "name"),
                        call.name
                    ),
                );
                continue;
            }
            let escapes = call.name == "code"
                && text(&call.arguments, "sandbox") == "off"
                && self.sandbox_of(run_id).mode != saturn_tools::sandbox::SandboxMode::Off;
            // Leaving the sandbox asks in every mode but bypass, whatever the rules say.
            let approval: Option<String> = if escapes && mode != GuardrailMode::Bypass {
                Some(
                    "Runs outside the sandbox: this command may write anywhere on this computer"
                        .to_owned(),
                )
            } else if let Some(decision) = ruling
                .as_ref()
                .filter(|decision| decision.effect == Effect::Ask)
            {
                Some(if decision.path.as_deref() == Some("hook") {
                    hooked
                        .reason
                        .clone()
                        .unwrap_or_else(|| "Asked by a hook".to_owned())
                } else {
                    explain(decision)
                })
            } else if ruling
                .as_ref()
                .is_some_and(|decision| decision.effect == Effect::Allow)
            {
                None
            } else if mode == GuardrailMode::Review {
                Some("Request Review mode: every command requires approval".to_owned())
            } else if mode == GuardrailMode::Default
                && is_sensitive_operation(&call.name, &arguments)
            {
                Some(format!(
                    "Sensitive operation requires approval: {}",
                    call.name
                ))
            } else {
                None
            };
            let approval = match approval {
                None => {
                    self.research_needs_approval(&current, &call.name, &call.arguments)
                        .await
                }
                reason => reason,
            };
            if let Some(reason) = approval {
                let action = step(
                    &new_id("act")?,
                    &call.name,
                    &call.arguments,
                    "waiting_approval",
                    Some(&reason),
                );
                actions.push(tag(action, &call));
                log(
                    "agent",
                    "info",
                    &format!(
                        "{} {} waiting_approval: {reason}",
                        text(agent, "name"),
                        call.name
                    ),
                );
                let saved = Value::Array(actions.clone());
                self.update_run(run_id, at, move |current| {
                    current["actions"] = saved;
                    current["status"] = "waiting_approval".into();
                })
                .await?;
                return Ok(true);
            }
            let waits = call
                .arguments
                .get("ms")
                .filter(|value| !value.is_null())
                .or_else(|| {
                    call.arguments
                        .get("duration_ms")
                        .filter(|value| !value.is_null())
                });
            if call.name == "computer_wait" && js::number(waits) > INLINE_WAIT_MS {
                let slept = self.sleep(run_id, at, &call, actions).await?;
                // Suspended: the round ends here, with no model call while the run waits.
                if text(&slept, "status") == "sleeping" {
                    return Ok(true);
                }
                actions.push(slept);
                continue;
            }
            let action_id = new_id("act")?;
            let action = self
                .execute_tool(agent_id, &call.name, &call.arguments, run_id, &action_id)
                .await?;
            let current = self.get_run(run_id)?;
            let action = tag(self.after_tool(agent, &current, action).await, &call);
            let status = text(&action, "status").to_owned();
            let detail = action
                .get("reason")
                .and_then(Value::as_str)
                .map_or(String::new(), |reason| format!(": {}", clip(reason, 80)));
            log(
                "agent",
                if matches!(status.as_str(), "failed" | "denied") {
                    "warning"
                } else {
                    "info"
                },
                &format!("{} {} {status}{detail}", text(agent, "name"), call.name),
            );
            actions.push(action);
            let saved = Value::Array(actions.clone());
            let waiting = status == "waiting_approval";
            self.update_run(run_id, at, move |current| {
                current["actions"] = saved;
                if waiting {
                    current["status"] = "waiting_approval".into();
                }
            })
            .await?;
            if waiting {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Goes on from the actions so far until the model answers without tools, then saves the outcome.
    #[allow(clippy::too_many_arguments)]
    async fn finish_from_model(
        self: &Arc<Self>,
        run_id: &str,
        at: u64,
        agent: &Value,
        model: &Value,
        context: &str,
        mut actions: Vec<Value>,
        answered: Option<Completion>,
    ) -> Result<(), CoreError> {
        if !self.alive(run_id, at) {
            return Ok(());
        }
        let run = self.get_run(run_id)?;
        let input = text(&run, "input");
        let mode = RunMode::parse(run.get("mode").and_then(Value::as_str));
        let mut response = match answered {
            Some(reply) => reply,
            None => {
                // Tools the run has taken so far may have loaded a toolkit (load_tools).
                let tools = self.tool_list(agent, mode, Some(run_id));
                let started = now_millis();
                let reply = self
                    .complete(model, agent, run_id, input, context, tools, &actions)
                    .await?;
                self.note_thinking(run_id, at, &reply, started).await?;
                reply
            }
        };
        let mut rounds = 0;
        let has_servers = !strings(agent, "mcpConnectionIds").is_empty();
        let limit = tool_rounds_of(agent);
        while has_servers && rounds < limit {
            if response.tool_calls.is_empty() || !self.alive(run_id, at) {
                break;
            }
            rounds += 1;
            let waiting = self
                .run_tools(agent, run_id, at, &response, &mut actions)
                .await?;
            if waiting || !self.alive(run_id, at) {
                return Ok(());
            }
            // A toolkit loaded in this round brings its tools to the next request.
            let tools = self.tool_list(agent, mode, Some(run_id));
            let started = now_millis();
            response = self
                .complete(model, agent, run_id, input, context, tools, &actions)
                .await?;
            self.note_thinking(run_id, at, &response, started).await?;
        }
        // Still asking for tools after the last round: the step limit ended this turn, not the model.
        let cut_off = rounds >= limit && !response.tool_calls.is_empty();
        if cut_off {
            log(
                "agent",
                "warning",
                &format!(
                    "{} reached the limit of {limit} tool rounds in one turn",
                    text(agent, "name")
                ),
            );
        }
        let answer = js::trim(&response.content);
        let output = if cut_off {
            if answer.is_empty() {
                step_limit_note(limit)
            } else {
                format!("{answer}\n\n{}", step_limit_note(limit))
            }
        } else {
            response.content.clone()
        };
        // A failed tool call the agent recovered from is part of the work: the turn failed only when something went wrong and
        // the agent ended without an answer.
        let troubled = actions.iter().any(|item| {
            let reason = text(item, "reason");
            text(item, "status") == "failed"
                || (text(item, "status") == "denied"
                    && reason != DENIED_BY_USER
                    && !reason.contains("mode only reads"))
        });
        let has_answer = !cut_off && !answer.is_empty();
        let saved_actions = Value::Array(actions);
        let saved = self
            .update_run(run_id, at, move |current| {
                current["actions"] = saved_actions;
                current["output"] = output.into();
                current["status"] = if troubled && !has_answer {
                    "failed"
                } else {
                    "completed"
                }
                .into();
            })
            .await?;
        if !saved {
            return Ok(());
        }
        let current = self.get_run(run_id)?;
        log(
            "agent",
            if text(&current, "status") == "failed" {
                "error"
            } else {
                "info"
            },
            &format!("{} {}", text(agent, "name"), text(&current, "status")),
        );
        // A sub-agent's turn feeds neither memory nor verification: the run that delegated it does, once it finishes.
        if text(&current, "parentRunId").is_empty() {
            self.after_finished(current);
        }
        Ok(())
    }

    /// What follows a finished turn, none of which it waits for.
    /// A Claude Code or Codex turn that completed feeds memory, as a local run's does when it finishes.
    fn note_program_finished(self: &Arc<Self>, run_id: &str, at: u64) {
        let Some(run) = self.find_run(run_id) else {
            return;
        };
        if generation(&run) == at && text(&run, "status") == "completed" {
            self.after_finished_without_hooks(run);
        }
    }

    fn after_finished(self: &Arc<Self>, run: Value) {
        self.after_finished_without_hooks(run.clone());
        let kernel = Arc::clone(self);
        tokio::spawn(async move {
            if let Err(error) = kernel.stop_hooks(&run).await {
                log(
                    "agent",
                    "warning",
                    &format!("Stop hooks failed to run: {error}"),
                );
            }
        });
    }

    fn after_finished_without_hooks(self: &Arc<Self>, run: Value) {
        let kernel = Arc::clone(self);
        let noted = run.clone();
        tokio::spawn(async move { kernel.note_run(&noted).await });
        let kernel = Arc::clone(self);
        let finished = run.clone();
        tokio::spawn(async move {
            if let Err(error) = kernel.pull_request_after_run(&finished).await {
                log(
                    "worktrees",
                    "warning",
                    &format!("The pull request follow-up failed: {error}"),
                );
            }
        });
        let kernel = Arc::clone(self);
        tokio::spawn(async move {
            if let Err(error) = kernel.verify_after_run(&run).await {
                log(
                    "agent",
                    "warning",
                    &format!("Verification failed to run: {error}"),
                );
            }
        });
    }

    async fn note_thinking(
        &self,
        run_id: &str,
        at: u64,
        reply: &Completion,
        started: i64,
    ) -> Result<(), CoreError> {
        let next = js::trim(&reply.thinking).to_owned();
        if next.is_empty() {
            return Ok(());
        }
        let seconds = ((now_millis() - started) as f64 / 100.0).round() / 10.0;
        self.update_run(run_id, at, move |run| {
            run["thinking"] =
                join_thinking(run.get("thinking").and_then(Value::as_str), &next).into();
            let position = run
                .get("actions")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            if !run.get("thoughts").is_some_and(Value::is_array) {
                run["thoughts"] = json!([]);
            }
            if let Some(thoughts) = run["thoughts"].as_array_mut() {
                thoughts.push(json!({ "text": next, "seconds": seconds, "at": position }));
            }
        })
        .await?;
        Ok(())
    }

    /// Fails a run with its error explained.
    async fn fail(&self, run_id: &str, at: u64, message: &str) {
        let explained = explain_run_error(message);
        let error = explained.clone();
        let saved = self.update_run(run_id, at, move |run| {
            run["status"] = "failed".into();
            run["output"] = "".into();
            run["error"] = error.into();
        });
        match saved.await {
            Ok(true) => log(
                "agent",
                "error",
                &format!("Run {run_id} failed: {}", clip(&explained, 120)),
            ),
            Ok(false) => {}
            Err(error) => log(
                "agent",
                "error",
                &format!("Could not save a failed run: {error}"),
            ),
        }
    }
}
