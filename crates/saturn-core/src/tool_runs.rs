//! Running one tool call: choosing which server it belongs to, the built-in skills with their checkpoints and sandbox, and
//! `delegate`, `skill` and `load_tools`, which need the loop itself.
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use saturn_browser::Mode;
use saturn_domain::js;
use saturn_domain::new_id;
use saturn_domain::policies::may_read_only;
use saturn_domain::prompt::RunMode;
use saturn_domain::skills::workspace::Workspace;
use saturn_domain::toolkits::{toolkit_name, toolkit_server};
use saturn_llm::{ToolDef, ToolFunction};
use saturn_mcp::McpError;
use saturn_store::AppState;
use saturn_tools::code::{CodeOptions, ScopedJobs};
use saturn_tools::file::FileCheckpoint;
use saturn_tools::general::{CallFuture, GeneralSkills, ToolCaller};
use saturn_tools::sandbox::{DEFAULT_SANDBOX, SandboxSettings};
use serde_json::{Value, json};

use crate::builtins::{AUTOMATIONS_ID, BROWSER_ID, COMPUTER_USE_ID, GENERAL_SKILLS_ID, ORIGIN_ID};
use crate::checkpoints::{CommandSnapshot, StepCheckpoint};
use crate::origin::Origin;
use crate::records::{by_id, by_id_mut, strings, text};
use crate::runs::{MAX_DELEGATION_DEPTH, MAX_PARALLEL_DELEGATIONS, ParentRun, StartOptions, step};
use crate::skill_files::{list_skills, load_skill};
use crate::{CoreError, Kernel, TrackedJob, locked, log};

/// A tool's declared read or write category, when its server declares one.
pub(crate) fn tool_category(state: &AppState, agent: &Value, tool: &str) -> Option<String> {
    let attached = strings(agent, "mcpConnectionIds");
    state
        .mcp
        .iter()
        .filter(|server| attached.iter().any(|id| id == text(server, "id")))
        .find_map(|server| {
            server
                .get("tools")?
                .as_array()?
                .iter()
                .find(|item| text(item, "toolId") == tool)
        })
        .map(|item| text(item, "category").to_owned())
        .filter(|category| !category.is_empty())
}

/// Calls another server's tool for the `mcp` skill, as one more tool call of the same run.
struct NestedCaller {
    kernel: Arc<Kernel>,
    agent_id: String,
    run_id: String,
}

impl ToolCaller for NestedCaller {
    fn call<'a>(&'a self, tool: &'a str, arguments: saturn_domain::Arguments) -> CallFuture<'a> {
        Box::pin(async move {
            let id = new_id("act").map_err(|error| error.to_string())?;
            let action = self
                .kernel
                .execute_tool(
                    &self.agent_id,
                    tool,
                    &Value::Object(arguments),
                    &self.run_id,
                    &id,
                )
                .await
                .map_err(|error| error.message)?;
            if text(&action, "status") != "completed" {
                let reason = text(&action, "reason");
                return Err(if reason.is_empty() {
                    "MCP call failed".to_owned()
                } else {
                    reason.to_owned()
                });
            }
            Ok(action.get("result").cloned().unwrap_or(Value::Null))
        })
    }
}

/// Records what a stopped command changed: stopping drops the call, and a command that was cut off can still have changed files.
struct RecordWhenDropped {
    kernel: Arc<Kernel>,
    run_id: String,
    snapshot: Option<CommandSnapshot>,
    action_id: String,
}

impl Drop for RecordWhenDropped {
    fn drop(&mut self) {
        let Some(snapshot) = self.snapshot.take() else {
            return;
        };
        let (kernel, run_id, action_id) = (
            Arc::clone(&self.kernel),
            self.run_id.clone(),
            self.action_id.clone(),
        );
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = kernel.after_command(&run_id, &snapshot, &action_id).await;
            });
        }
    }
}

impl Kernel {
    /// Background commands belong to the chat, or to the agent outside one, so they outlive the turn.
    fn job_scope_of(&self, run: &Value) -> String {
        let thread = text(run, "threadId");
        if thread.is_empty() {
            format!("agent:{}", text(run, "agentId"))
        } else {
            thread.to_owned()
        }
    }

    /// The sandbox the run's commands get: the project's setting, else the setting for everywhere, else the default.
    pub(crate) fn sandbox_of(&self, run_id: &str) -> SandboxSettings {
        self.store.read(|state| {
            let project = by_id(&state.runs, run_id)
                .and_then(|run| by_id(&state.threads, text(run, "threadId")))
                .and_then(|thread| by_id(&state.projects, text(thread, "projectId")));
            project
                .and_then(|project| project.get("sandbox"))
                .or_else(|| state.settings.get("sandbox"))
                .and_then(|value| serde_json::from_value(value.clone()).ok())
                .unwrap_or(DEFAULT_SANDBOX)
        })
    }

    /// The project folder a run works in, or nothing for chats outside a project (the private sandbox).
    fn workdir_of(&self, run: &Value) -> Result<Option<PathBuf>, CoreError> {
        self.workdir_for(self.find_thread(text(run, "threadId")).as_ref())
    }

    /// Which attached server has this tool, turned on.
    fn tool_server(&self, agent: &Value, tool: &str) -> Option<String> {
        let attached = strings(agent, "mcpConnectionIds");
        self.store.read(|state| {
            state
                .mcp
                .iter()
                .filter(|server| attached.iter().any(|id| id == text(server, "id")))
                .find(|server| {
                    !strings(server, "disabledTools")
                        .iter()
                        .any(|name| name == tool)
                        && server
                            .get("tools")
                            .and_then(Value::as_array)
                            .is_some_and(|tools| {
                                tools.iter().any(|item| text(item, "toolId") == tool)
                            })
                })
                .map(|server| text(server, "id").to_owned())
        })
    }

    /// On-demand toolkits loaded in this chat so far (any of its turns), or by this run and its parent.
    fn loaded_toolkits(&self, run_id: Option<&str>) -> HashSet<String> {
        let Some(run_id) = run_id else {
            return HashSet::new();
        };
        self.store.read(|state| {
            let Some(run) = by_id(&state.runs, run_id) else {
                return HashSet::new();
            };
            let (thread, parent) = (text(run, "threadId"), text(run, "parentRunId"));
            state
                .runs
                .iter()
                .filter(|item| {
                    let id = text(item, "id");
                    id == run_id
                        || id == parent
                        || (!thread.is_empty()
                            && parent.is_empty()
                            && text(item, "threadId") == thread
                            && text(item, "parentRunId").is_empty())
                })
                .flat_map(|item| strings(item, "toolkits"))
                .collect()
        })
    }

    /// The agent's on-demand toolkits not loaded yet; none without General Skills, which has load_tools.
    pub(crate) fn deferred_toolkits(&self, agent: &Value, run_id: Option<&str>) -> Vec<String> {
        let attached = strings(agent, "mcpConnectionIds");
        if !attached.iter().any(|id| id == GENERAL_SKILLS_ID) {
            return Vec::new();
        }
        let loaded = self.loaded_toolkits(run_id);
        attached
            .into_iter()
            .filter(|id| toolkit_name(id).is_some() && !loaded.contains(id))
            .collect()
    }

    async fn load_toolkits(&self, run_id: &str, ids: &[String]) -> Result<(), CoreError> {
        if ids.is_empty() {
            return Ok(());
        }
        self.store
            .update(|state| {
                if let Some(run) = by_id_mut(&mut state.runs, run_id) {
                    let mut list = strings(run, "toolkits");
                    for id in ids {
                        if !list.contains(id) {
                            list.push(id.clone());
                        }
                    }
                    run["toolkits"] = list.into();
                }
            })
            .await?;
        Ok(())
    }

    /// The tools the model is offered; an Ask or Plan turn gets only those that can read without changing anything.
    pub(crate) fn tool_list(
        &self,
        agent: &Value,
        mode: Option<RunMode>,
        run_id: Option<&str>,
    ) -> Vec<ToolDef> {
        let reads_only = mode.is_some_and(RunMode::reads_only);
        let deferred = self.deferred_toolkits(agent, run_id);
        let attached = strings(agent, "mcpConnectionIds");
        self.store.read(|state| {
            let mut tools = Vec::new();
            for server in &state.mcp {
                let id = text(server, "id");
                if !attached.iter().any(|item| item == id) || deferred.iter().any(|item| item == id)
                {
                    continue;
                }
                let disabled = strings(server, "disabledTools");
                for tool in server
                    .get("tools")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let name = text(tool, "toolId");
                    let category = tool.get("category").and_then(Value::as_str);
                    if disabled.iter().any(|item| item == name)
                        || (name == "load_tools" && deferred.is_empty())
                        || (reads_only && !may_read_only(name, category))
                    {
                        continue;
                    }
                    tools.push(ToolDef {
                        function: ToolFunction {
                            name: name.to_owned(),
                            description: Some(text(tool, "description").to_owned()),
                            parameters: tool.get("inputSchema").cloned(),
                        },
                    });
                }
            }
            tools
        })
    }

    /// One tool call. A tool's own failure is a failed step the model is told about; an error here ends the run.
    pub(crate) async fn execute_tool(
        self: &Arc<Self>,
        agent_id: &str,
        tool: &str,
        arguments: &Value,
        run_id: &str,
        action_id: &str,
    ) -> Result<Value, CoreError> {
        self.guard(agent_id)?;
        let agent = self.get_agent(agent_id)?;
        let failed = |reason: &str| step(action_id, tool, arguments, "failed", Some(reason));
        let completed = |result: Value| {
            let mut action = step(action_id, tool, arguments, "completed", None);
            action["result"] = result;
            action
        };
        let Some(server) = self.tool_server(&agent, tool) else {
            // A saved chat can still hold a call to a tool of Saturn IDE, such as an approval waiting since before the upgrade.
            return Ok(failed(&if tool.starts_with("ide_") {
                format!("{tool} was part of Saturn IDE, which Saturn no longer includes")
            } else {
                format!("Unknown tool: {tool}")
            }));
        };
        // A toolkit's tool called before loading it (its name is in the instructions): it counts as loaded.
        if toolkit_name(&server).is_some() && !self.loaded_toolkits(Some(run_id)).contains(&server)
        {
            self.load_toolkits(run_id, std::slice::from_ref(&server))
                .await?;
        }
        if matches!(server.as_str(), AUTOMATIONS_ID | "antigravity-skills") {
            return Ok(failed(&not_ported(&server, tool)));
        }
        if matches!(server.as_str(), COMPUTER_USE_ID | "cursor-computer-use") {
            return Ok(match self.computer.run(tool, arguments).await {
                Ok(result) => completed(result),
                Err(reason) => failed(&reason),
            });
        }
        if server == BROWSER_ID {
            self.browser.set_mode(self.browser_mode()).await;
            return Ok(match self.browser.run(tool, arguments).await {
                Ok(result) => completed(result),
                Err(reason) => failed(&reason),
            });
        }
        if matches!(server.as_str(), ORIGIN_ID | "cursor-origin") {
            let run = self.get_run(run_id)?;
            let workdir = self.workdir_of(&run)?;
            return Ok(
                match Origin::new(self, workdir).run(tool, arguments).await {
                    Ok(result) => completed(result),
                    Err(reason) => failed(&reason),
                },
            );
        }
        if server != GENERAL_SKILLS_ID {
            return self
                .call_mcp(&server, agent_id, tool, arguments, run_id, action_id)
                .await;
        }
        let run = self.get_run(run_id)?;
        match tool {
            "skill" => {
                let name = text(arguments, "name");
                let workdir = self.workdir_of(&run)?;
                let user_dir = self.store.root().join("skills");
                let plugins = self.enabled_plugin_folders();
                let loaded = if name.is_empty() {
                    None
                } else {
                    load_skill(workdir.as_deref(), &user_dir, &plugins, name).await
                };
                Ok(match loaded {
                    Some(skill) => completed(skill),
                    None => {
                        let known: Vec<String> =
                            list_skills(workdir.as_deref(), &user_dir, &plugins)
                                .await
                                .into_iter()
                                .map(|item| item.name)
                                .collect();
                        failed(&format!(
                            "No skill named \"{name}\". Available: {}",
                            if known.is_empty() {
                                "none".to_owned()
                            } else {
                                known.join(", ")
                            }
                        ))
                    }
                })
            }
            "load_tools" => {
                let names: Vec<String> = match arguments.get("toolkits") {
                    Some(Value::Array(items)) => {
                        items.iter().map(|item| js::text(Some(item))).collect()
                    }
                    other => vec![js::text(other)],
                };
                let attached = strings(&agent, "mcpConnectionIds");
                let ids: Vec<String> = names
                    .iter()
                    .filter_map(|name| toolkit_server(name))
                    .filter(|id| attached.iter().any(|item| item == id))
                    .map(str::to_owned)
                    .collect();
                if ids.is_empty() {
                    let offered: Vec<&str> =
                        attached.iter().filter_map(|id| toolkit_name(id)).collect();
                    return Ok(failed(&format!(
                        "No such toolkit for this agent. Available: {}",
                        if offered.is_empty() {
                            "none".to_owned()
                        } else {
                            offered.join(", ")
                        }
                    )));
                }
                self.load_toolkits(run_id, &ids).await?;
                let loaded: Vec<Value> = self.store.read(|state| {
                    state
                        .mcp
                        .iter()
                        .filter(|server| ids.iter().any(|id| id == text(server, "id")))
                        .map(|server| {
                            let disabled = strings(server, "disabledTools");
                            let tools: Vec<&str> = server
                                .get("tools")
                                .and_then(Value::as_array)
                                .into_iter()
                                .flatten()
                                .map(|item| text(item, "toolId"))
                                .filter(|name| !disabled.iter().any(|item| item == name))
                                .collect();
                            json!({ "toolkit": toolkit_name(text(server, "id")), "tools": tools })
                        })
                        .collect()
                });
                Ok(completed(
                    json!({ "loaded": loaded, "note": "These tools can be called from the next step on." }),
                ))
            }
            "delegate" => Ok(match self.delegate(agent_id, arguments, run_id).await {
                Ok(result) => completed(result),
                Err(error) => failed(&error.message),
            }),
            _ => Ok(
                match self
                    .run_general_skill(agent_id, tool, arguments, &run, action_id)
                    .await
                {
                    Ok(result) => completed(result),
                    Err(message) => failed(&message),
                },
            ),
        }
    }

    /// A tool of an MCP server. Its answers that steer the run are refusals, and any other failure is a failed step.
    async fn call_mcp(
        &self,
        server_id: &str,
        agent_id: &str,
        tool: &str,
        arguments: &Value,
        run_id: &str,
        action_id: &str,
    ) -> Result<Value, CoreError> {
        let step_of =
            |status: &str, reason: &str| step(action_id, tool, arguments, status, Some(reason));
        let Some(server) = self
            .store
            .read(|state| by_id(&state.mcp, server_id).cloned())
        else {
            return Ok(step_of("failed", "MCP server missing"));
        };
        let target = match self.mcp_target(&server) {
            Ok(target) => target,
            Err(error) => return Ok(step_of("failed", &error.message)),
        };
        let remote = server
            .get("tools")
            .and_then(Value::as_array)
            .and_then(|tools| tools.iter().find(|item| text(item, "toolId") == tool))
            .map(|item| text(item, "remoteName"))
            .filter(|name| !name.is_empty())
            .unwrap_or(tool);
        let headers = [
            ("X-Saturn-Agent-Id", agent_id),
            ("X-Saturn-Run-Id", run_id),
            ("X-Saturn-Action-Id", action_id),
        ];
        match self.mcp.call(&target, remote, arguments, &headers).await {
            Ok(result) => {
                let mut action = step(action_id, tool, arguments, "completed", None);
                action["result"] = result;
                Ok(action)
            }
            Err(McpError::SignIn(_)) => Ok(step_of(
                "failed",
                &format!(
                    "{} needs you to sign in; finish it in the browser, then try again.",
                    text(&server, "name")
                ),
            )),
            Err(McpError::Failed(message)) => Ok(match message.as_str() {
                "approval_required" => step(action_id, tool, arguments, "waiting_approval", None),
                "policy_denied" => step_of("denied", "Policy denied"),
                "approval_rejected" => step_of("denied", "Approval rejected"),
                "Agent is not allowed to call this tool" => step_of("denied", &message),
                _ => step_of("failed", &message),
            }),
        }
    }

    /// `files`, `code` and the other skills that need nothing of the loop.
    async fn run_general_skill(
        self: &Arc<Self>,
        agent_id: &str,
        tool: &str,
        arguments: &Value,
        run: &Value,
        action_id: &str,
    ) -> Result<Value, String> {
        let run_id = text(run, "id");
        let workdir = self.workdir_of(run).map_err(|error| error.message)?;
        let root_run = self.root_run_id(run_id);
        let values = arguments.as_object().cloned().unwrap_or_default();
        let background = values.get("background") == Some(&Value::Bool(true));
        // A shell command's file changes join the run's checkpoint too, so they can be reviewed and reverted.
        let tracked = match (&workdir, tool) {
            (Some(folder), "code") => self.before_command(&root_run, folder).await,
            _ => None,
        };
        let mut writable = vec![
            self.store
                .root()
                .join("workspace")
                .to_string_lossy()
                .into_owned(),
        ];
        // A worktree keeps its git data in the project's .git: sandboxed commits must be able to write there.
        if tool == "code"
            && let Some(thread) = self.find_thread(text(run, "threadId"))
            && let Some(folder) = self.worktree_path(&thread)
            && let Some(dir) = Self::git_common_dir(&folder).await
        {
            writable.push(dir);
        }
        let checkpoint: Option<Arc<dyn FileCheckpoint>> = workdir.as_ref().map(|folder| {
            Arc::new(StepCheckpoint {
                kernel: Arc::clone(self),
                run_id: root_run.clone(),
                workspace: Workspace::new(folder),
                action_id: action_id.to_owned(),
            }) as Arc<dyn FileCheckpoint>
        });
        let caller: Arc<dyn ToolCaller> = Arc::new(NestedCaller {
            kernel: Arc::clone(self),
            agent_id: agent_id.to_owned(),
            run_id: run_id.to_owned(),
        });
        let skills = GeneralSkills::new(
            self.store.root(),
            workdir.as_deref(),
            Some(caller),
            checkpoint,
            CodeOptions {
                sandbox: Some(self.sandbox_of(run_id)),
                writable,
                jobs: Some(ScopedJobs {
                    table: self.jobs.clone(),
                    scope: self.job_scope_of(run),
                }),
            },
        );
        let mut guard = RecordWhenDropped {
            kernel: Arc::clone(self),
            run_id: root_run.clone(),
            snapshot: if background { None } else { tracked.clone() },
            action_id: action_id.to_owned(),
        };
        let result = if matches!(tool, "files" | "multi_step") {
            // A file write finishes with its checkpoint even if the run is stopped meanwhile: stopping must not leave it half told.
            let (skills, name, values) = (skills, tool.to_owned(), values.clone());
            tokio::spawn(async move { skills.run(&name, &values).await })
                .await
                .map_err(|error| error.to_string())?
        } else {
            skills.run(tool, &values).await
        };
        // A failing command can still have changed files.
        if let Some(snapshot) = guard.snapshot.take()
            && let Err(error) = self.after_command(&root_run, &snapshot, action_id).await
        {
            log(
                "agent",
                "warning",
                &format!("Could not record a command's changes: {error}"),
            );
        }
        if background
            && tool == "code"
            && let (Some(snapshot), Ok(answer)) = (tracked, &result)
            && let Some(job) = answer.get("jobId").and_then(Value::as_str)
        {
            // A background command changes files as it runs: recorded when it is read or stopped, and when it ends.
            self.track_job(
                job,
                TrackedJob {
                    run_id: root_run.clone(),
                    snapshot,
                    action_id: action_id.to_owned(),
                },
            );
        }
        if matches!(tool, "code_output" | "code_stop")
            && let Some(job) = values.get("jobId").and_then(Value::as_str)
        {
            self.record_job(job).await;
        }
        result
    }

    fn track_job(self: &Arc<Self>, job: &str, tracked: TrackedJob) {
        locked(&self.tracked_jobs).insert(job.to_owned(), Arc::new(tracked));
        let kernel = Arc::clone(self);
        let id = job.to_owned();
        tokio::spawn(async move {
            kernel.jobs.when_ended(&id).await;
            kernel.record_job(&id).await;
            locked(&kernel.tracked_jobs).remove(&id);
        });
    }

    /// Records what a background command has changed so far.
    async fn record_job(&self, job: &str) {
        let tracked = locked(&self.tracked_jobs).get(job).cloned();
        if let Some(tracked) = tracked {
            let _ = self
                .after_command(&tracked.run_id, &tracked.snapshot, &tracked.action_id)
                .await;
        }
    }

    /// The `delegate` tool: one or more sub-agent runs in the same chat, each with a fresh context (only its task), run in
    /// parallel and waited for; only their final answers come back. A read-only sub-agent runs in Ask mode; one with all tools
    /// inherits this run's mode, approvals and sandbox.
    async fn delegate(
        self: &Arc<Self>,
        agent_id: &str,
        arguments: &Value,
        run_id: &str,
    ) -> Result<Value, CoreError> {
        let failure = |message: String| CoreError::new(400, message);
        let parent = self.get_run(run_id)?;
        if self.depth_of(run_id) >= MAX_DELEGATION_DEPTH {
            return Err(failure(format!(
                "Sub-agents may not delegate further than {MAX_DELEGATION_DEPTH} levels deep; do this task yourself."
            )));
        }
        let mut tasks: Vec<String> = Vec::new();
        if let Some(task) = arguments
            .get("task")
            .and_then(Value::as_str)
            .map(js::trim)
            .filter(|task| !task.is_empty())
        {
            tasks.push(task.to_owned());
        }
        for task in arguments
            .get("tasks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(js::trim)
            .filter(|task| !task.is_empty())
        {
            tasks.push(task.to_owned());
        }
        if tasks.is_empty() {
            return Err(failure(
                "Give the sub-agent a task (task, or tasks for several)".to_owned(),
            ));
        }
        if tasks.len() > MAX_PARALLEL_DELEGATIONS {
            return Err(failure(format!(
                "At most {MAX_PARALLEL_DELEGATIONS} tasks at once"
            )));
        }
        let tools = if text(arguments, "tools") == "all" {
            "all"
        } else {
            "read-only"
        };
        let wanted = js::trim(text(arguments, "agent"));
        let agent = if wanted.is_empty() {
            self.get_agent(agent_id)?
        } else {
            self.store
                .read(|state| {
                    state
                        .agents
                        .iter()
                        .find(|item| {
                            text(item, "id") == wanted
                                || text(item, "name").to_lowercase() == wanted.to_lowercase()
                        })
                        .cloned()
                })
                .ok_or_else(|| failure(format!("No agent named \"{wanted}\"")))?
        };
        // Read-only sub-agents run in Ask mode; others inherit the mode of this turn (an Ask turn cannot escape it).
        let turn = RunMode::parse(parent.get("mode").and_then(Value::as_str));
        let mode = if tools == "read-only" || turn.is_some_and(RunMode::reads_only) {
            RunMode::Ask
        } else {
            turn.unwrap_or(RunMode::Agent)
        };
        let thread = text(&parent, "threadId");
        let mut started = Vec::new();
        for task in &tasks {
            let run = self
                .start_run(
                    text(&agent, "id"),
                    task,
                    Some(thread).filter(|id| !id.is_empty()),
                    None,
                    StartOptions {
                        mode: Some(mode),
                        parent: Some(ParentRun {
                            run_id: run_id.to_owned(),
                            task: task.clone(),
                            tools: tools.to_owned(),
                        }),
                        ..StartOptions::default()
                    },
                )
                .await
                .map_err(|error| failure(error.message))?;
            started.push(text(&run, "id").to_owned());
        }
        log(
            "agent",
            "info",
            &format!(
                "{}: {} sub-agent runs started by {run_id}",
                text(&agent, "name"),
                started.len()
            ),
        );
        let mut results = Vec::new();
        for id in started {
            let run = self.wait_for_run(&id).await?;
            let steps = run
                .get("actions")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            let (output, error) = (text(&run, "output"), text(&run, "error"));
            let answer = if !output.is_empty() {
                output.to_owned()
            } else if !error.is_empty() {
                format!("(failed: {error})")
            } else {
                "(no answer)".to_owned()
            };
            let task = run
                .get("delegated")
                .map_or_else(|| text(&run, "input"), |delegated| text(delegated, "task"));
            results.push(json!({ "task": task, "runId": id, "status": text(&run, "status"), "answer": answer, "steps": steps }));
        }
        Ok(json!({ "results": results }))
    }
}

impl Kernel {
    /// The browser the settings choose.
    pub fn browser_mode(&self) -> Mode {
        self.store
            .read(|state| Mode::parse(state.settings.get("browser").and_then(Value::as_str)))
    }
}

/// Why a tool of a server the Rust runtime does not run yet failed.
fn not_ported(server: &str, tool: &str) -> String {
    let named = match server {
        AUTOMATIONS_ID | "antigravity-skills" => "The automation tools",
        _ => "Other MCP servers' tools",
    };
    format!("{named} are not in the Rust runtime yet, so {tool} did not run.")
}
