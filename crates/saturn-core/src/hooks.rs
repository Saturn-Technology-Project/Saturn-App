//! Running hooks around an agent's tool calls and at the end of its turn. The user's hooks (Settings → Hooks) run as set. A
//! project's (`.saturn/hooks.json`, and the hooks of its `.claude/settings.json`) come with the folder, so they run only once
//! the user has allowed that exact set; any change asks again.
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use saturn_domain::hooks::{
    Hook, HookDecision, HookEvent, from_claude_hooks, hook_from, hooks_fingerprint, matches_tool,
    parse_answer,
};
use saturn_domain::js;
use saturn_tools::sandbox::Platform;
use saturn_tools::shell::{command_env, process_env, shell_invocation};
use saturn_tools::{Captured, run_captured};
use serde_json::{Value, json};

use crate::permissions::{CLAUDE_SETTINGS_FILE, read_json};
use crate::records::{by_id, by_id_mut, remove, text};
use crate::runs::StartOptions;
use crate::{CoreError, Kernel, log};

const DEFAULT_TIMEOUT_MS: f64 = 30_000.0;
const MAX_TIMEOUT_MS: f64 = 600_000.0;
const OUTPUT_LIMIT: usize = 4000;
/// The project's own hooks.
pub const HOOKS_FILE: &str = ".saturn/hooks.json";

/// One set of hooks and whether it may run.
#[derive(Clone, Debug, PartialEq)]
pub struct HookSet {
    pub source: &'static str,
    pub path: Option<String>,
    pub hooks: Vec<Hook>,
    pub fingerprint: Option<String>,
    pub approved: bool,
}

impl HookSet {
    /// The set as the API answers it.
    pub fn to_json(&self) -> Value {
        let mut value = json!({ "source": self.source });
        if let Some(path) = &self.path {
            value["path"] = json!(path);
        }
        value["hooks"] = json!(self.hooks);
        if let Some(fingerprint) = &self.fingerprint {
            value["fingerprint"] = json!(fingerprint);
        }
        value["approved"] = json!(self.approved);
        value
    }
}

/// What `pre_tool` hooks say about a call.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct HookOutcome {
    pub blocked: Option<String>,
    pub decision: Option<HookDecision>,
    pub reason: Option<String>,
}

/// Runs one hook with its JSON on stdin, in the chat's folder.
async fn run_hook(hook: &Hook, input: &Value, cwd: &Path) -> Captured {
    let env = process_env();
    let shell = shell_invocation(&hook.command, "/bin/sh", Platform::current(), &env);
    let timeout = hook
        .timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1_000.0, MAX_TIMEOUT_MS);
    let mut variables = command_env(Platform::current(), &env);
    variables.push((
        OsString::from("SATURN_HOOK_EVENT"),
        OsString::from(hook.event.as_str()),
    ));
    variables.push((OsString::from("SATURN_PROJECT_DIR"), cwd.into()));
    variables.push((OsString::from("CLAUDE_PROJECT_DIR"), cwd.into()));
    let mut result = run_captured(
        &shell,
        cwd,
        &variables,
        input.to_string().as_bytes(),
        Duration::from_secs_f64(timeout / 1000.0),
        OUTPUT_LIMIT * 2,
    )
    .await;
    result.stdout = js::suffix(js::trim(&result.stdout), OUTPUT_LIMIT).to_owned();
    result.stderr = js::suffix(js::trim(&result.stderr), OUTPUT_LIMIT).to_owned();
    result
}

/// How a hook failed, for the log.
fn failure(result: &Captured) -> String {
    if result.timed_out {
        return "timed out".to_owned();
    }
    result
        .code
        .map_or("exit ?".to_owned(), |code| format!("exit {code}"))
}

/// What every hook is told, whatever its event.
fn payload(event: HookEvent, agent: &Value, run: &Value, extra: Value) -> Value {
    let thread = run
        .get("threadId")
        .filter(|id| !id.is_null())
        .cloned()
        .unwrap_or(Value::Null);
    let mut value = json!({
        "event": event.as_str(),
        "hook_event_name": event.as_str(),
        "run_id": text(run, "id"),
        "thread_id": thread,
        "agent": { "id": text(agent, "id"), "name": text(agent, "name") },
    });
    if let (Some(fields), Value::Object(more)) = (value.as_object_mut(), extra) {
        fields.extend(more);
    }
    value
}

impl Kernel {
    /// Every hook set that applies in a project (or only the user's, outside one), approved or not.
    pub async fn hook_sets(&self, project_id: Option<&str>) -> Vec<HookSet> {
        let (user, project) = self.store.read(|state| {
            let user: Vec<Hook> = state
                .settings
                .get("hooks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(hook_from)
                .collect();
            (
                user,
                project_id.and_then(|id| by_id(&state.projects, id).cloned()),
            )
        });
        let mut sets = vec![HookSet {
            source: "user",
            path: None,
            hooks: user,
            fingerprint: None,
            approved: true,
        }];
        let Some(project) = project else {
            return sets;
        };
        let root = PathBuf::from(text(&project, "path"));
        let own: Vec<Hook> = read_json(&root.join(HOOKS_FILE))
            .await
            .and_then(|json| json.get("hooks").cloned())
            .and_then(|hooks| {
                hooks
                    .as_array()
                    .map(|items| items.iter().filter_map(hook_from).collect())
            })
            .unwrap_or_default();
        let claude = from_claude_hooks(
            read_json(&root.join(CLAUDE_SETTINGS_FILE))
                .await
                .as_ref()
                .and_then(|json| json.get("hooks")),
        );
        for (source, file, hooks) in [
            ("project-file", HOOKS_FILE, own),
            ("claude-file", CLAUDE_SETTINGS_FILE, claude),
        ] {
            if hooks.is_empty() {
                continue;
            }
            let fingerprint = hooks_fingerprint(&hooks);
            let approved = project
                .get("approvedHooks")
                .and_then(|items| items.get(file))
                .and_then(Value::as_str)
                == Some(fingerprint.as_str());
            sets.push(HookSet {
                source,
                path: Some(file.to_owned()),
                hooks,
                fingerprint: Some(fingerprint),
                approved,
            });
        }
        sets
    }

    /// The user allows a project file's hooks: only the exact set they saw, named by its fingerprint.
    pub async fn approve_hooks(
        &self,
        project_id: &str,
        file: &str,
        fingerprint: &str,
    ) -> Result<Vec<HookSet>, CoreError> {
        let sets = self.hook_sets(Some(project_id)).await;
        let current = sets
            .iter()
            .find(|set| set.path.as_deref() == Some(file))
            .ok_or_else(|| CoreError::new(404, format!("{file} has no hooks")))?;
        if current.fingerprint.as_deref() != Some(fingerprint) {
            return Err(CoreError::new(
                409,
                format!("The hooks in {file} changed since you looked; review them again."),
            ));
        }
        self.store
            .update(|state| {
                let project = by_id_mut(&mut state.projects, project_id)
                    .ok_or_else(|| CoreError::new(404, "Project not found"))?;
                if !project.get("approvedHooks").is_some_and(Value::is_object) {
                    project["approvedHooks"] = json!({});
                }
                project["approvedHooks"][file] = json!(fingerprint);
                Ok::<(), CoreError>(())
            })
            .await??;
        log(
            "runtime",
            "info",
            &format!("Hooks in {file} allowed for this project"),
        );
        Ok(self.hook_sets(Some(project_id)).await)
    }

    /// Holds a project file's hooks again.
    pub async fn revoke_hooks(
        &self,
        project_id: &str,
        file: &str,
    ) -> Result<Vec<HookSet>, CoreError> {
        self.store
            .update(|state| {
                if let Some(approved) = by_id_mut(&mut state.projects, project_id)
                    .and_then(|project| project.get_mut("approvedHooks"))
                {
                    remove(approved, file);
                }
            })
            .await?;
        Ok(self.hook_sets(Some(project_id)).await)
    }

    /// Replaces the user's own hooks.
    pub async fn set_user_hooks(&self, hooks: &Value) -> Result<Vec<HookSet>, CoreError> {
        let parsed: Option<Vec<Hook>> = hooks
            .as_array()
            .and_then(|items| items.iter().map(hook_from).collect());
        let parsed = parsed.ok_or_else(|| {
            CoreError::new(
                400,
                "Each hook needs an event (pre_tool, post_tool or stop) and a command",
            )
        })?;
        let cleaned: Vec<Hook> = parsed
            .into_iter()
            .map(|hook| Hook {
                matcher: hook
                    .matcher
                    .map(|text| js::trim(&text).to_owned())
                    .filter(|text| !text.is_empty()),
                command: js::trim(&hook.command).to_owned(),
                timeout_ms: hook.timeout_ms.filter(|ms| *ms != 0.0),
                event: hook.event,
            })
            .collect();
        self.store
            .update(|state| {
                state.settings.insert("hooks".to_owned(), json!(cleaned));
            })
            .await?;
        Ok(self.hook_sets(None).await)
    }

    /// The hooks that run for an event in a run's chat, and where.
    async fn active_hooks(
        &self,
        run: &Value,
        event: HookEvent,
        tool: &str,
    ) -> Option<(Vec<Hook>, PathBuf)> {
        let thread = self.find_thread(text(run, "threadId"));
        let project = thread
            .as_ref()
            .map(|thread| text(thread, "projectId"))
            .filter(|id| !id.is_empty());
        let sets = self.hook_sets(project).await;
        let hooks: Vec<Hook> = sets
            .into_iter()
            .filter(|set| set.approved)
            .flat_map(|set| set.hooks)
            .filter(|hook| {
                hook.event == event
                    && (event == HookEvent::Stop || matches_tool(hook.matcher.as_deref(), tool))
            })
            .collect();
        if hooks.is_empty() {
            return None;
        }
        // A project that lost its access: hooks run in the agent's own workspace.
        let cwd = self
            .workdir_for(thread.as_ref())
            .ok()
            .flatten()
            .unwrap_or_else(|| self.store.root().join("workspace"));
        if let Err(error) = tokio::fs::create_dir_all(&cwd).await {
            log(
                "agent",
                "warning",
                &format!("Could not open the hooks' folder: {error}"),
            );
        }
        Some((hooks, cwd))
    }

    /// `pre_tool`: the strictest answer of the matching hooks (deny or block beats ask beats allow).
    pub(crate) async fn before_tool(
        &self,
        agent: &Value,
        run: &Value,
        tool: &str,
        arguments: &Value,
    ) -> HookOutcome {
        let Some((hooks, cwd)) = self.active_hooks(run, HookEvent::PreTool, tool).await else {
            return HookOutcome::default();
        };
        let mut outcome = HookOutcome::default();
        for hook in &hooks {
            let input = payload(
                HookEvent::PreTool,
                agent,
                run,
                json!({ "tool": tool, "tool_name": tool, "arguments": arguments, "tool_input": arguments }),
            );
            let result = run_hook(hook, &input, &cwd).await;
            if result.code == Some(2) {
                let reason = if result.stderr.is_empty() {
                    format!("Blocked by the hook: {}", hook.command)
                } else {
                    result.stderr
                };
                return HookOutcome {
                    blocked: Some(reason),
                    ..HookOutcome::default()
                };
            }
            if result.code != Some(0) {
                log(
                    "agent",
                    "warning",
                    &format!(
                        "pre_tool hook failed ({}): {}",
                        failure(&result),
                        hook.command
                    ),
                );
                continue;
            }
            let (decision, reason) = parse_answer(&result.stdout);
            let reason = reason.filter(|text| !text.is_empty());
            match decision {
                Some(HookDecision::Deny) => {
                    return HookOutcome {
                        blocked: Some(
                            reason
                                .unwrap_or_else(|| format!("Denied by the hook: {}", hook.command)),
                        ),
                        ..HookOutcome::default()
                    };
                }
                Some(HookDecision::Ask) => {
                    outcome.decision = decision;
                    outcome.reason = Some(
                        reason.unwrap_or_else(|| format!("Asked by the hook: {}", hook.command)),
                    );
                }
                Some(HookDecision::Allow) if outcome.decision != Some(HookDecision::Ask) => {
                    outcome.decision = decision;
                    outcome.reason = Some(
                        reason.unwrap_or_else(|| format!("Allowed by the hook: {}", hook.command)),
                    );
                }
                _ => {}
            }
        }
        outcome
    }

    /// `post_tool`: the feedback of every hook that exited 2, added to the result the model sees.
    pub(crate) async fn after_tool(&self, agent: &Value, run: &Value, mut action: Value) -> Value {
        let tool = text(&action, "toolId").to_owned();
        let Some((hooks, cwd)) = self.active_hooks(run, HookEvent::PostTool, &tool).await else {
            return action;
        };
        let result_value = action.get("result").cloned().unwrap_or(Value::Null);
        let arguments = action.get("arguments").cloned().unwrap_or(Value::Null);
        let mut feedback = Vec::new();
        for hook in &hooks {
            let input = payload(
                HookEvent::PostTool,
                agent,
                run,
                json!({
                    "tool": tool, "tool_name": tool, "arguments": arguments, "tool_input": arguments,
                    "status": text(&action, "status"), "result": result_value, "tool_response": result_value,
                }),
            );
            let result = run_hook(hook, &input, &cwd).await;
            if result.code == Some(2) && !result.stderr.is_empty() {
                feedback.push(result.stderr);
            } else if result.code != Some(0) {
                log(
                    "agent",
                    "warning",
                    &format!(
                        "post_tool hook failed ({}): {}",
                        failure(&result),
                        hook.command
                    ),
                );
            }
        }
        if feedback.is_empty() {
            return action;
        }
        let note = feedback.join("\n\n");
        let combined = match result_value {
            Value::Object(mut fields) => {
                fields.insert("hookFeedback".to_owned(), note.into());
                Value::Object(fields)
            }
            other => json!({ "result": other, "hookFeedback": note }),
        };
        action["result"] = combined;
        action
    }

    /// `stop`: a hook that exits 2 sends its stderr back to the agent as an automatic follow-up.
    pub(crate) async fn stop_hooks(self: &Arc<Self>, run: &Value) -> Result<(), CoreError> {
        let thread_id = text(run, "threadId");
        if text(run, "status") != "completed"
            || !text(run, "groupId").is_empty()
            || !text(run, "parentRunId").is_empty()
            || thread_id.is_empty()
        {
            return Ok(());
        }
        let Ok(agent) = self.get_agent(text(run, "agentId")) else {
            return Ok(());
        };
        let Some((hooks, cwd)) = self.active_hooks(run, HookEvent::Stop, "").await else {
            return Ok(());
        };
        let changed: Vec<Value> = run
            .get("checkpoint")
            .and_then(|checkpoint| checkpoint.get("files"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|file| file.get("before") != file.get("after"))
            .filter_map(|file| file.get("path").cloned())
            .collect();
        let mut messages = Vec::new();
        for hook in &hooks {
            let input = payload(
                HookEvent::Stop,
                &agent,
                run,
                json!({ "input": text(run, "input"), "output": text(run, "output"), "changed_files": changed }),
            );
            let result = run_hook(hook, &input, &cwd).await;
            if result.code == Some(2) {
                messages.push(if result.stderr.is_empty() {
                    format!("The stop hook `{}` asked you to continue.", hook.command)
                } else {
                    result.stderr
                });
            } else if result.code != Some(0) {
                log(
                    "agent",
                    "warning",
                    &format!("stop hook failed ({}): {}", failure(&result), hook.command),
                );
            }
        }
        if messages.is_empty() {
            return Ok(());
        }
        if self.automatic_rounds(thread_id) >= 2 {
            log(
                "agent",
                "warning",
                "A stop hook still objects after 2 automatic rounds; leaving it to the user",
            );
            return Ok(());
        }
        self.start_run(
            text(run, "agentId"),
            &format!(
                "A stop hook did not accept this turn:\n\n{}\n\nAddress it, then finish again.",
                messages.join("\n\n")
            ),
            Some(thread_id),
            None,
            StartOptions {
                automatic: true,
                ..StartOptions::default()
            },
        )
        .await?;
        Ok(())
    }

    /// Automatic runs in a chat since the user's own last message (newest runs come first in state).
    pub fn automatic_rounds(&self, thread_id: &str) -> usize {
        self.store.read(|state| {
            state
                .runs
                .iter()
                .filter(|run| {
                    text(run, "threadId") == thread_id && text(run, "parentRunId").is_empty()
                })
                .take_while(|run| run.get("automatic").and_then(Value::as_bool) == Some(true))
                .count()
        })
    }
}
