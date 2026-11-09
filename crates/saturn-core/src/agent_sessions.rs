//! What a Claude Code turn and a Codex turn share: the session they resume, what Saturn knows going in, the run record they
//! update, approval cards, and Saturn's skills as an MCP server.
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use saturn_domain::js;
use saturn_domain::new_id;
use saturn_domain::permissions::Effect;
use saturn_domain::policies::{
    GuardrailMode, autonomy_of, is_read_only_call, is_sensitive_operation,
};
use saturn_domain::prompt::{RunMode, read_only_refusal};
use saturn_domain::time::iso_time;
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::oneshot;

use crate::builtins::GENERAL_SKILLS_ID;
use crate::permissions::explain;
use crate::records::{by_id, by_id_mut, generation, remove, strings, text};
use crate::rules::{project_rules_without, stored_rules_only};
use crate::tool_runs::tool_category;
use crate::{CoreError, Kernel, locked, log};

/// The MCP server name Claude Code and Codex see Saturn's skills under.
pub(crate) const SKILLS_SERVER: &str = "saturn";
/// The newest MCP version the skills server speaks, and the others it accepts.
const MCP_VERSIONS: [&str; 5] = [
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];

/// How much a Claude Code or Codex agent may do without asking: its own setting, unless the group it works in sets one.
pub(crate) fn approval_mode(
    agent: &Value,
    group: Option<&Value>,
    chat_mode: Option<&str>,
) -> GuardrailMode {
    let autonomy = group
        .and_then(|group| group.get("autonomy"))
        .and_then(Value::as_str);
    if let Some(autonomy) = autonomy {
        return autonomy_of(Some(autonomy));
    }
    // A chat's mode says how much it asks; the agent's own setting is for a chat with none.
    if let Some(approvals) = chat_mode.and_then(saturn_domain::research::chat_approvals) {
        return autonomy_of(Some(approvals));
    }
    autonomy_of(agent.get("autonomy").and_then(Value::as_str))
}

/// The stricter of two approval modes: Review asks for everything, Default for risky calls, Bypass for nothing.
fn stricter(one: GuardrailMode, other: GuardrailMode) -> GuardrailMode {
    let rank = |mode: GuardrailMode| match mode {
        GuardrailMode::Bypass => 0,
        GuardrailMode::Default => 1,
        GuardrailMode::Review => 2,
    };
    if rank(other) > rank(one) { other } else { one }
}

impl Kernel {
    /// How much a run asks: its group's setting, else its chat's mode, else its agent's own setting; and a run another
    /// run delegated to never asks less than the run that delegated it, whichever agent it was given to.
    pub(crate) fn run_approval(&self, run: &Value, agent: &Value) -> GuardrailMode {
        let group = self.group_of(run);
        let own = approval_mode(agent, group.as_ref(), self.chat_mode_of(run).as_deref());
        let parent = text(run, "parentRunId");
        if parent.is_empty() {
            return own;
        }
        let Some((parent, parent_agent)) = self.find_run(parent).and_then(|parent| {
            let agent = self.get_agent(text(&parent, "agentId")).ok()?;
            Some((parent, agent))
        }) else {
            return own;
        };
        stricter(own, self.run_approval(&parent, &parent_agent))
    }
}

/// The most of a text kept on a run.
pub(crate) fn clip(value: &str, max: usize) -> String {
    if js::length(value) > max {
        format!("{}…", js::prefix(value, max))
    } else {
        value.to_owned()
    }
}

/// A path as a project sees it, resolved without touching the disk.
pub(crate) fn resolved(workdir: &Path, requested: &str) -> PathBuf {
    let mut path = PathBuf::new();
    for part in workdir.join(requested).components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                path.pop();
            }
            other => path.push(other),
        }
    }
    path
}

/// The next message of a Claude Code or Codex turn, after what the knowledge sources returned for it.
pub(crate) fn with_knowledge(input: &str, knowledge: &str) -> String {
    if knowledge.is_empty() {
        input.to_owned()
    } else {
        format!(
            "<knowledge>\nRelevant knowledge from this agent's sources, for the message below:\n{knowledge}\n</knowledge>\n\n{input}"
        )
    }
}

/// What Saturn knows going into a turn.
pub(crate) struct TurnContext {
    pub(crate) memory: String,
    pub(crate) knowledge: String,
    pub(crate) rules: String,
    /// Whether the project's instruction files may reach the program: there are none, or the user allowed them as they
    /// are. When not, a program that reads one by itself (Codex, AGENTS.md) is told not to.
    pub(crate) instructions_allowed: bool,
}

/// A program running for a turn: it ends when this is dropped, which is what stopping the run does, and with the runtime.
pub(crate) struct RunningProgram {
    kernel: Arc<Kernel>,
    pid: Option<u32>,
    end: saturn_tools::EndOnDrop,
}

impl RunningProgram {
    pub(crate) fn watch(kernel: &Arc<Kernel>, pid: Option<u32>) -> Self {
        if let Some(pid) = pid {
            locked(&kernel.programs.running).insert(pid);
        }
        Self {
            kernel: Arc::clone(kernel),
            pid,
            end: saturn_tools::EndOnDrop::new(pid),
        }
    }

    /// When the program has ended by itself there is nothing left to end. One that has not is ended on drop.
    pub(crate) fn settle(&mut self, child: &mut tokio::process::Child) {
        if matches!(child.try_wait(), Ok(Some(_))) {
            self.end.finished();
        }
    }
}

/// The most of a program's error output kept for its failure message.
const STDERR_KEPT: usize = 8192;

/// Reads a program's error output to its end, keeping the last of it. The answer comes when the pipe closes.
pub(crate) fn keep_stderr(
    mut pipe: tokio::process::ChildStderr,
) -> tokio::task::JoinHandle<String> {
    tokio::spawn(async move {
        let mut kept = Vec::new();
        let mut chunk = [0_u8; 4096];
        while let Ok(read) = pipe.read(&mut chunk).await {
            if read == 0 {
                break;
            }
            kept.extend_from_slice(&chunk[..read]);
            if kept.len() > STDERR_KEPT {
                kept.drain(..kept.len() - STDERR_KEPT);
            }
        }
        String::from_utf8_lossy(&kept).into_owned()
    })
}

/// A program's error output, without waiting long: something it started may hold the pipe open after it ended.
pub(crate) async fn stderr_of(stderr: tokio::task::JoinHandle<String>) -> String {
    match tokio::time::timeout(Duration::from_secs(1), stderr).await {
        Ok(Ok(text)) => text,
        _ => String::new(),
    }
}

impl Drop for RunningProgram {
    fn drop(&mut self) {
        if let Some(pid) = self.pid {
            locked(&self.kernel.programs.running).remove(&pid);
        }
    }
}

/// A program with its pipes, in a process group of its own, in the environment `configure` gives it.
pub(crate) fn program_command(
    file: &Path,
    cwd: &Path,
    args: &[String],
    configure: impl FnOnce(&mut Command),
) -> Command {
    let mut command = Command::new(file);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure(&mut command);
    saturn_tools::in_own_group(&mut command);
    command
}

/// What a turn has shown so far.
#[derive(Default)]
pub(crate) struct TurnRecord {
    pub(crate) actions: Vec<Value>,
    pub(crate) output: String,
    pub(crate) thoughts: Vec<Value>,
}

impl TurnRecord {
    /// Adds a paragraph of the reply.
    pub(crate) fn add_output(&mut self, text: &str) {
        if !self.output.is_empty() {
            self.output.push_str("\n\n");
        }
        self.output.push_str(text);
    }

    pub(crate) fn add_thought(&mut self, text: &str) {
        self.thoughts
            .push(json!({ "text": text, "seconds": 0, "at": self.actions.len() }));
    }
}

/// One running turn of a program, and its place in the run record.
pub(crate) struct Turn {
    pub(crate) kernel: Arc<Kernel>,
    pub(crate) run_id: String,
    pub(crate) at: u64,
    pub(crate) record: Mutex<TurnRecord>,
}

impl Turn {
    pub(crate) fn new(kernel: &Arc<Kernel>, run_id: &str, at: u64) -> Arc<Self> {
        Arc::new(Self {
            kernel: Arc::clone(kernel),
            run_id: run_id.to_owned(),
            at,
            record: Mutex::default(),
        })
    }

    /// Writes what the turn has shown to the run, plus `patch`, unless a newer pass took the run over.
    pub(crate) async fn save(
        &self,
        patch: impl FnOnce(&mut Value) + Send,
    ) -> Result<(), CoreError> {
        let (actions, output, thoughts) = {
            let record = locked(&self.record);
            (
                record.actions.clone(),
                record.output.clone(),
                record.thoughts.clone(),
            )
        };
        self.kernel
            .store
            .update(|state| {
                if let Some(current) = by_id_mut(&mut state.runs, &self.run_id)
                    && generation(current) == self.at
                {
                    current["actions"] = Value::Array(actions);
                    current["output"] = json!(output);
                    current["thoughts"] = Value::Array(thoughts);
                    patch(current);
                }
            })
            .await?;
        Ok(())
    }

    /// Shows a card on an action and waits for the user's answer. A stopped run drops this, which takes the card's listener away.
    pub(crate) async fn ask(
        &self,
        agent_name: &str,
        action_id: &str,
        tool: &str,
        reason: Option<&str>,
    ) -> Result<bool, CoreError> {
        {
            let mut record = locked(&self.record);
            if let Some(action) = record
                .actions
                .iter_mut()
                .find(|item| text(item, "id") == action_id)
            {
                action["status"] = "waiting_approval".into();
                action["reason"] = reason
                    .map_or_else(|| format!("{tool} needs your approval"), str::to_owned)
                    .into();
            }
        }
        // Listening before the card is shown: an answer that comes as soon as it appears must find it waiting.
        let key = format!("{}:{action_id}", self.run_id);
        let (sender, receiver) = oneshot::channel();
        locked(&self.kernel.programs.pending).insert(key.clone(), sender);
        let waiting = Waiting {
            kernel: &self.kernel,
            key,
        };
        self.save(|current| current["status"] = "waiting_approval".into())
            .await?;
        log(
            "agent",
            "info",
            &format!("{agent_name} {tool} waiting_approval"),
        );
        let allow = receiver.await.unwrap_or(false);
        drop(waiting);
        {
            let mut record = locked(&self.record);
            if let Some(action) = record
                .actions
                .iter_mut()
                .find(|item| text(item, "id") == action_id)
            {
                if allow {
                    action["status"] = "completed".into();
                    remove(action, "reason");
                } else {
                    action["status"] = "denied".into();
                    action["reason"] = "Denied by the user".into();
                }
            }
        }
        self.save(|current| current["status"] = "running".into())
            .await?;
        Ok(allow)
    }

    /// Ends the turn: its record, and the failure if there was one.
    pub(crate) async fn finish(&self, failure: Option<String>) -> Result<(), CoreError> {
        self.save(|current| match failure {
            Some(failure) => {
                current["status"] = "failed".into();
                current["error"] = json!(failure);
            }
            None => {
                current["status"] = "completed".into();
                remove(current, "error");
            }
        })
        .await
    }
}

/// Takes a card's listener away when the wait ends, however it ends.
struct Waiting<'a> {
    kernel: &'a Arc<Kernel>,
    key: String,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        locked(&self.kernel.programs.pending).remove(&self.key);
    }
}

/// A tool of Saturn's that the program sees, in MCP's own shape.
fn bridged_tool(tool: &Value) -> Value {
    let schema = tool
        .get("inputSchema")
        .filter(|schema| schema.is_object())
        .cloned()
        .unwrap_or_else(|| json!({ "properties": {} }));
    let mut input = json!({ "type": "object" });
    if let (Some(input), Some(schema)) = (input.as_object_mut(), schema.as_object()) {
        for (key, value) in schema {
            input.insert(key.clone(), value.clone());
        }
    }
    json!({ "name": text(tool, "toolId"), "description": text(tool, "description"), "inputSchema": input })
}

/// A finished action as an MCP tool result: an MCP server's own content as it came, a screenshot as an image.
pub(crate) fn tool_result(action: &Value) -> Value {
    let status = text(action, "status");
    if status != "completed" {
        let reason = text(action, "reason");
        let message = if !reason.is_empty() {
            reason.to_owned()
        } else if status == "denied" {
            "The user denied this action.".to_owned()
        } else {
            format!("The tool {status}.")
        };
        return json!({ "content": [{ "type": "text", "text": message }], "isError": true });
    }
    let result = action.get("result").cloned().unwrap_or(Value::Null);
    if result.get("content").is_some_and(Value::is_array) {
        return result;
    }
    if let Some(object) = result.as_object() {
        let picture = ["image", "screenshot"]
            .iter()
            .find_map(|key| object.get(*key).and_then(Value::as_str));
        let parsed = picture
            .and_then(|picture| picture.strip_prefix("data:"))
            .and_then(|rest| rest.split_once(";base64,"));
        if let Some((mime, data)) = parsed {
            let rest: serde_json::Map<String, Value> = object
                .iter()
                .filter(|(key, _)| *key != "image" && *key != "screenshot")
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            let mut content = vec![json!({ "type": "image", "mimeType": mime, "data": data })];
            if !rest.is_empty() {
                content.push(json!({ "type": "text", "text": Value::Object(rest).to_string() }));
            }
            return json!({ "content": content });
        }
    }
    let shown = match &result {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    json!({ "content": [{ "type": "text", "text": shown }] })
}

/// One running turn's skills: what the program may call, and how each call is decided.
pub(crate) struct SkillsBridge {
    pub(crate) turn: Arc<Turn>,
    pub(crate) agent: Value,
    pub(crate) mode: Option<RunMode>,
    pub(crate) approval: GuardrailMode,
    pub(crate) tools: Vec<Value>,
    /// Codex's own items adopt the actions cards went on before it reported them.
    pub(crate) orphans: Mutex<HashSet<String>>,
    /// Actions a call has already asked about. Codex's report of a call can arrive after the next identical call.
    pub(crate) asked: Mutex<HashSet<String>>,
}

impl SkillsBridge {
    /// The manifest the Agent SDK sends along when it opens a session, so the program need not ask.
    pub(crate) fn manifest(&self) -> Value {
        json!({
            "initializeResult": {
                "protocolVersion": MCP_VERSIONS[0],
                "capabilities": { "tools": {} },
                "serverInfo": { "name": SKILLS_SERVER, "version": "1.0.0" },
            },
            "toolsListResult": { "tools": self.tools },
        })
    }

    /// Answers one JSON-RPC message from the program. None for a notification, which has no answer.
    pub(crate) async fn answer(&self, message: &Value) -> Option<Value> {
        if !message.get("method").is_some_and(Value::is_string) {
            return Some(
                json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32600, "message": "Invalid Request" } }),
            );
        }
        let id = message.get("id")?.clone();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let reply = |result: Value| json!({ "result": result, "jsonrpc": "2.0", "id": id });
        Some(match text(message, "method") {
            "initialize" => {
                let asked = text(&params, "protocolVersion");
                let version = if MCP_VERSIONS.contains(&asked) {
                    asked
                } else {
                    MCP_VERSIONS[0]
                };
                reply(json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": SKILLS_SERVER, "version": "1.0.0" },
                }))
            }
            "ping" => reply(json!({})),
            "tools/list" => reply(json!({ "tools": self.tools })),
            "tools/call" => {
                let name = text(&params, "name");
                if self.tools.iter().any(|tool| text(tool, "name") == name) {
                    let arguments = params
                        .get("arguments")
                        .cloned()
                        .unwrap_or_else(|| json!({}));
                    let action = self.call(name, &arguments).await;
                    reply(tool_result(&action))
                } else {
                    reply(
                        json!({ "content": [{ "type": "text", "text": format!("Unknown tool: {name}") }], "isError": true }),
                    )
                }
            }
            other => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("Method not found: {other}") },
            }),
        })
    }

    /// Runs one call through Saturn's own tool path; its failure comes back as a failed action.
    async fn call(&self, tool: &str, arguments: &Value) -> Value {
        match self.decide_and_run(tool, arguments).await {
            Ok(action) => action,
            Err(error) => {
                json!({ "toolId": tool, "arguments": arguments, "status": "failed", "reason": error.message })
            }
        }
    }

    /// The action a card or a refusal goes on: the one Codex already reported for this call, or one its report adopts later.
    fn action_for(&self, tool: &str, arguments: &Value) -> Result<String, CoreError> {
        let mut record = locked(&self.turn.record);
        let mut asked = locked(&self.asked);
        let reported = record.actions.iter().rev().find(|item| {
            item.get("result").is_none()
                && text(item, "status") == "completed"
                && same_call(item, tool, arguments)
                && !asked.contains(text(item, "id"))
        });
        let id = match reported {
            Some(action) => text(action, "id").to_owned(),
            None => {
                let id = new_id("act").map_err(|error| CoreError::new(500, error.to_string()))?;
                record.actions.push(
                    json!({ "id": id, "toolId": tool, "arguments": arguments, "status": "completed" }),
                );
                locked(&self.orphans).insert(id.clone());
                id
            }
        };
        asked.insert(id.clone());
        Ok(id)
    }

    /// The Codex route to a tool: Ask and Plan turns only read; then the permission rules decide (a deny refuses, an allow
    /// runs without asking, an ask asks), and with no rule Review asks here, since Codex approves every call itself.
    /// (Claude Code asks through its own permission request first, so its bridge is created with `Bypass`.)
    async fn decide_and_run(&self, tool: &str, arguments: &Value) -> Result<Value, CoreError> {
        let turn = &self.turn;
        let kernel = &turn.kernel;
        let action_id = new_id("act").map_err(|error| CoreError::new(500, error.to_string()))?;
        let args = arguments.as_object().cloned().unwrap_or_default();
        if let Some(mode) = self.mode.filter(|mode| *mode != RunMode::Agent) {
            let category = kernel
                .store
                .read(|state| tool_category(state, &self.agent, tool));
            if !is_read_only_call(tool, &args, category.as_deref()) {
                return Ok(
                    json!({ "id": action_id, "toolId": tool, "arguments": arguments, "status": "denied", "reason": read_only_refusal(mode) }),
                );
            }
        }
        let run = kernel.get_run(&turn.run_id)?;
        let ruled = kernel
            .decide_permission(text(&self.agent, "id"), &run, tool, &args)
            .await;
        if let Some(decision) = ruled
            .as_ref()
            .filter(|decision| decision.effect == Effect::Deny)
        {
            // The refusal goes on the action Codex reported for this call, so its own report of the failure keeps it denied.
            let reason = explain(decision);
            let denied = self.action_for(tool, arguments)?;
            {
                let mut record = locked(&turn.record);
                if let Some(action) = record
                    .actions
                    .iter_mut()
                    .find(|item| text(item, "id") == denied)
                {
                    action["status"] = "denied".into();
                    action["reason"] = json!(reason);
                }
            }
            return Ok(
                json!({ "id": denied, "toolId": tool, "arguments": arguments, "status": "denied", "reason": reason }),
            );
        }
        let asks = match ruled.as_ref().map(|decision| decision.effect) {
            Some(Effect::Allow) => false,
            Some(Effect::Ask) => true,
            _ => {
                self.approval == GuardrailMode::Review
                    || (self.approval == GuardrailMode::Default
                        && is_sensitive_operation(
                            tool,
                            &arguments.as_object().cloned().unwrap_or_default(),
                        ))
            }
        };
        if asks {
            let waiting = self.action_for(tool, arguments)?;
            let reason = ruled.as_ref().map(explain);
            let allow = turn
                .ask(text(&self.agent, "name"), &waiting, tool, reason.as_deref())
                .await?;
            if !allow {
                return Ok(
                    json!({ "id": waiting, "toolId": tool, "arguments": arguments, "status": "denied", "reason": "Denied by the user" }),
                );
            }
        }
        kernel
            .execute_tool(
                text(&self.agent, "id"),
                tool,
                arguments,
                &turn.run_id,
                &action_id,
            )
            .await
    }
}

/// Whether an action is the call with this tool and arguments.
pub(crate) fn same_call(action: &Value, tool: &str, arguments: &Value) -> bool {
    text(action, "toolId") == tool && action.get("arguments") == Some(arguments)
}

impl Kernel {
    /// The session a Claude Code or Codex run resumes. A chat keeps one on its conversation; a group keeps one per member agent.
    pub(crate) fn saved_session(&self, run: &Value, key: &str) -> Option<String> {
        self.store.read(|state| {
            let session = if run.get("groupId").is_some_and(Value::is_string) {
                by_id(&state.groups, text(run, "groupId"))?
                    .get("sessions")?
                    .get(text(run, "agentId"))?
                    .get(key)?
            } else {
                by_id(&state.threads, text(run, "threadId"))?.get(key)?
            };
            session.as_str().map(str::to_owned)
        })
    }

    /// Keeps the session the run ended on, so the next turn of the same chat (or agent in the group) resumes it.
    pub(crate) async fn save_session(
        &self,
        run: &Value,
        key: &str,
        value: &str,
    ) -> Result<(), CoreError> {
        self.store
            .update(|state| {
                if run.get("groupId").is_some_and(Value::is_string) {
                    if let Some(group) = by_id_mut(&mut state.groups, text(run, "groupId")) {
                        if !group.get("sessions").is_some_and(Value::is_object) {
                            group["sessions"] = json!({});
                        }
                        let agent = text(run, "agentId");
                        if !group["sessions"].get(agent).is_some_and(Value::is_object) {
                            group["sessions"][agent] = json!({});
                        }
                        group["sessions"][agent][key] = json!(value);
                    }
                } else if let Some(thread) = by_id_mut(&mut state.threads, text(run, "threadId")) {
                    thread[key] = json!(value);
                }
            })
            .await?;
        Ok(())
    }

    /// Where a turn works: the chat's project folder, or Saturn's own workspace, ready to use.
    pub(crate) async fn program_workdir(&self, run: &Value) -> Result<PathBuf, CoreError> {
        let thread = self.find_thread(text(run, "threadId"));
        let workdir = match self.workdir_for(thread.as_ref())? {
            Some(folder) => folder,
            None => self.store.root().join("workspace"),
        };
        tokio::fs::create_dir_all(&workdir)
            .await
            .map_err(|error| CoreError::new(500, error.to_string()))?;
        Ok(workdir)
    }

    /// What Saturn knows going into a turn, as every other provider gets it. A knowledge source that cannot be reached is logged
    /// and left out, so the turn still runs. `skip` leaves out rule files the program reads by itself.
    pub(crate) async fn turn_context(
        &self,
        agent: &Value,
        run: &Value,
        skip: &[&str],
    ) -> TurnContext {
        let thread = self.find_thread(text(run, "threadId"));
        let project = thread
            .as_ref()
            .map(|thread| text(thread, "projectId").to_owned())
            .filter(|id| !id.is_empty());
        let memory = self.memory_for_prompt(project.as_deref()).await;
        let mut instructions_allowed = true;
        let rules = match (self.workdir_for(thread.as_ref()), &project) {
            (Ok(Some(root)), Some(project)) => {
                let stored = self.store.read(|state| {
                    by_id(&state.projects, project)
                        .map(|item| text(item, "rules").to_owned())
                        .unwrap_or_default()
                });
                instructions_allowed = self.instructions_allowed(project, &root).await;
                if instructions_allowed {
                    project_rules_without(&root, &stored, skip).await
                } else {
                    stored_rules_only(&root, &stored).await
                }
            }
            _ => String::new(),
        };
        let knowledge = match self.rag_context(agent, text(run, "input")).await {
            Ok(knowledge) => knowledge,
            Err(error) => {
                log(
                    "agent",
                    "warning",
                    &format!(
                        "{}: knowledge sources skipped: {error}",
                        text(agent, "name")
                    ),
                );
                String::new()
            }
        };
        TurnContext {
            memory: js::trim(&memory).to_owned(),
            knowledge: js::trim(&knowledge).to_owned(),
            rules,
            instructions_allowed,
        }
    }

    /// The Saturn tools a Claude Code or Codex agent gets: every skill and MCP server attached to the agent, except General Skills,
    /// whose files, shell, web, MCP and plan tools are the program's own tools under other names.
    pub(crate) fn bridged_tools(&self, agent: &Value) -> Vec<Value> {
        let attached = strings(agent, "mcpConnectionIds");
        self.store.read(|state| {
            state
                .mcp
                .iter()
                .filter(|server| {
                    text(server, "id") != GENERAL_SKILLS_ID
                        && attached.iter().any(|id| id == text(server, "id"))
                })
                .flat_map(|server| {
                    let disabled = strings(server, "disabledTools");
                    server
                        .get("tools")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter(move |tool| !disabled.iter().any(|id| id == text(tool, "toolId")))
                        .map(bridged_tool)
                })
                .collect()
        })
    }

    /// The group a run works in, if any.
    pub(crate) fn group_of(&self, run: &Value) -> Option<Value> {
        self.store
            .read(|state| by_id(&state.groups, text(run, "groupId")).cloned())
    }

    /// Tokens a turn used. Billing is the user's plan, so no cost is recorded.
    pub(crate) async fn record_plan_usage(
        &self,
        run_id: &str,
        agent: &Value,
        model: &Value,
        pricing: &str,
        tokens: (u64, u64),
    ) {
        let Ok(id) = new_id("use") else {
            return;
        };
        let record = json!({
            "id": id,
            "runId": run_id,
            "agentId": text(agent, "id"),
            "agentName": text(agent, "name"),
            "modelId": text(model, "id"),
            "modelName": text(model, "name"),
            "provider": text(model, "provider"),
            "model": text(model, "model"),
            "purpose": "run",
            "inputTokens": tokens.0,
            "outputTokens": tokens.1,
            "inputRate": null,
            "outputRate": null,
            "pricing": pricing,
            "costUsd": null,
            "createdAt": iso_time(saturn_domain::time::now_millis()),
        });
        if let Err(error) = self
            .store
            .update(|state| state.usage.insert(0, record))
            .await
        {
            log(
                "usage",
                "warning",
                &format!("Could not record the program's usage: {error}"),
            );
        }
    }

    /// The user's answer to a card a running program is waiting on. False when no program is waiting on it.
    pub fn answer_program_card(&self, run_id: &str, action_id: &str, allow: bool) -> bool {
        let waiting = locked(&self.programs.pending).remove(&format!("{run_id}:{action_id}"));
        match waiting {
            Some(sender) => {
                let _ = sender.send(allow);
                true
            }
            None => false,
        }
    }

    /// Answers the skills endpoint: the bearer token picks the turn, and with it the agent's tools and approval setting. None when
    /// no running turn holds this token.
    pub async fn answer_agent_mcp(
        &self,
        token: Option<&str>,
        message: &Value,
    ) -> Option<Option<Value>> {
        let token = token?;
        let bridge = {
            let bridges = locked(&self.programs.bridges);
            bridges
                .iter()
                .find(|(key, _)| same_token(key, token))
                .map(|(_, bridge)| Arc::clone(bridge))
        }?;
        Some(bridge.answer(message).await)
    }
}

/// Compares in constant time, so a token cannot be guessed byte by byte from timing.
fn same_token(expected: &str, provided: &str) -> bool {
    expected.len() == provided.len()
        && expected
            .bytes()
            .zip(provided.bytes())
            .fold(0, |seen, (one, other)| seen | (one ^ other))
            == 0
}
