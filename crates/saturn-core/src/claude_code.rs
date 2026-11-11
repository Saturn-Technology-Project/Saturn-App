//! Claude Code models: the runtime starts the official `claude` program and speaks its stream-json protocol, the one the official
//! Agent SDK speaks. That program alone reads the user's login and talks to Anthropic; Saturn never reads, copies or passes a
//! credential. Its part is the guard rails: a working directory limited to the chat's project folder, and an approval for every
//! tool that is not read-only.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use regex::Regex;
use saturn_domain::js;
use saturn_domain::new_id;
use saturn_domain::permissions::Effect;
use saturn_domain::policies::{GuardrailMode, is_read_only_call, is_sensitive_operation};
use saturn_domain::prompt::{RunMode, mode_instructions, read_only_refusal, read_only_refusal_for};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::task::JoinSet;

use crate::agent_programs::{Answer, ask_program, question_timeout};
use crate::agent_sessions::{
    RunningProgram, SKILLS_SERVER, SkillsBridge, Turn, clip, keep_stderr, program_command,
    resolved, stderr_of, with_knowledge,
};
use crate::permissions::explain;
use crate::records::text;
use crate::run_images::load_images;
use crate::tool_runs::tool_category;
use crate::{CoreError, Kernel, locked, log};

/// Tools that only read; they run without asking. Everything else (edits, Bash, MCP) waits for the user.
const READ_ONLY_TOOLS: [&str; 8] = [
    "Read",
    "Glob",
    "Grep",
    "LS",
    "NotebookRead",
    "TodoWrite",
    "Task",
    "ExitPlanMode",
];
/// No general network tools.
const DISALLOWED_TOOLS: &str = "WebSearch,WebFetch";
/// How long the program gets to end by itself once its input is closed.
const CLOSING: Duration = Duration::from_secs(5);

static NOT_SIGNED_IN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)login|authenticat|oauth|api key|401").expect("the pattern is valid")
});

/// The input field naming the file of a tool that edits one.
fn file_of<'a>(tool: &str, input: &'a Value) -> Option<&'a str> {
    let field = match tool {
        "Write" | "Edit" | "MultiEdit" => "file_path",
        "NotebookEdit" => "notebook_path",
        _ => return None,
    };
    input.get(field).and_then(Value::as_str)
}

/// A Claude Code tool call as the permission rules see it: its shell as Saturn's `code` tool with the command, its file
/// tools as `files` with the action and path, a Saturn skill by its own name, and anything else by the name Claude Code
/// gives it, so only a rule for every tool reaches it.
fn ruled_call(tool: &str, input: &Value) -> (String, saturn_domain::Arguments) {
    let mut arguments = saturn_domain::Arguments::new();
    let field = |name: &str| input.get(name).cloned().unwrap_or(Value::Null);
    match tool {
        "Bash" | "PowerShell" => {
            arguments.insert("command".to_owned(), field("command"));
            ("code".to_owned(), arguments)
        }
        "Read" | "Glob" | "Grep" | "LS" | "NotebookRead" => {
            arguments.insert("action".to_owned(), json!("read"));
            arguments.insert(
                "path".to_owned(),
                if tool == "NotebookRead" {
                    field("notebook_path")
                } else if tool == "Read" {
                    field("file_path")
                } else {
                    field("path")
                },
            );
            ("files".to_owned(), arguments)
        }
        "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => {
            arguments.insert("action".to_owned(), json!("write"));
            arguments.insert(
                "path".to_owned(),
                json!(file_of(tool, input).unwrap_or_default()),
            );
            ("files".to_owned(), arguments)
        }
        _ => (
            skill_of(tool).unwrap_or(tool).to_owned(),
            input.as_object().cloned().unwrap_or_default(),
        ),
    }
}

/// How Claude Code names a tool of Saturn's skills server, without its prefix.
fn skill_of(tool: &str) -> Option<&str> {
    tool.strip_prefix("mcp__")?
        .strip_prefix(SKILLS_SERVER)?
        .strip_prefix("__")
}

/// Words that mark a variable as a credential.
const CREDENTIAL_WORDS: [&str; 6] = ["TOKEN", "KEY", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH"];
/// The credentials Claude Code itself uses: an Anthropic key or token, Bedrock's AWS credentials, Vertex's Google ones.
const CLAUDE_CREDENTIALS: [&str; 4] = ["ANTHROPIC_", "CLAUDE_", "AWS_", "GOOGLE_"];

/// "Ask for risky actions": a destructive shell command, one that names Saturn's data folder (which Saturn does not
/// hide from Claude Code's own shell, as it does from its sandboxed commands), an edit outside the working folder, or a
/// Saturn skill call the default mode asks about.
fn risky(tool: &str, input: &Value, workdir: &Path, data: &Path) -> bool {
    if let Some(skill) = skill_of(tool) {
        return is_sensitive_operation(skill, &input.as_object().cloned().unwrap_or_default());
    }
    if tool == "Bash" || tool == "PowerShell" {
        let command = input.get("command").and_then(Value::as_str).unwrap_or("");
        let mut arguments = serde_json::Map::new();
        arguments.insert("command".to_owned(), json!(command));
        let folder = data.to_string_lossy();
        return is_sensitive_operation("code", &arguments)
            || (!folder.is_empty() && command.contains(folder.as_ref()));
    }
    file_of(tool, input).is_some_and(|file| {
        let file = resolved(workdir, file);
        !file.starts_with(workdir) || file.starts_with(data)
    })
}

/// The sign-in command to paste in a terminal: PowerShell syntax on Windows, POSIX shell elsewhere.
fn login_command(config: &Path, cli: &Path) -> String {
    let (config, cli) = (config.to_string_lossy(), cli.to_string_lossy());
    if cfg!(windows) {
        let quote = |value: &str| format!("'{}'", value.replace('\'', "''"));
        return format!(
            "$env:CLAUDE_CONFIG_DIR={}; & {} auth login --claudeai",
            quote(&config),
            quote(&cli)
        );
    }
    let quote = |value: &str| {
        let plain = !value.is_empty()
            && value
                .chars()
                .all(|one| one.is_alphanumeric() || "_@%+=:,./-".contains(one));
        if plain {
            value.to_owned()
        } else {
            format!("'{}'", value.replace('\'', "'\\''"))
        }
    };
    format!(
        "CLAUDE_CONFIG_DIR={} {} auth login --claudeai",
        quote(&config),
        quote(&cli)
    )
}

/// The text of a tool result's content.
fn text_of(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| text(part, "text"))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// What the handlers of one Claude Code turn share.
struct ClaudeTurn {
    turn: Arc<Turn>,
    agent: Value,
    mode: Option<RunMode>,
    approval: GuardrailMode,
    workdir: PathBuf,
    /// Edits in a project folder keep their originals, so the chat can show a diff and revert them.
    checkpointing: bool,
    /// Files edited by tool calls whose results have not arrived.
    edited: Mutex<HashMap<String, String>>,
    bridge: Option<SkillsBridge>,
}

impl ClaudeTurn {
    /// The action of a tool call, shown under the skill's own name when it is one of Saturn's.
    /// Marks a noted action as refused, with why.
    fn mark_denied(&self, id: &str, reason: &str) {
        let mut record = locked(&self.turn.record);
        if let Some(action) = record
            .actions
            .iter_mut()
            .find(|item| text(item, "id") == id)
        {
            action["status"] = "denied".into();
            action["reason"] = json!(reason);
        }
    }

    fn note_action(&self, id: &str, tool: &str, input: &Value) {
        let mut record = locked(&self.turn.record);
        if !record.actions.iter().any(|item| text(item, "id") == id) {
            let shown = skill_of(tool).unwrap_or(tool);
            record.actions.push(
                json!({ "id": id, "toolId": shown, "arguments": input, "status": "completed" }),
            );
        }
    }

    /// Before an edit runs, keeps the file's original for the diff and revert.
    async fn keep_original(&self, action_id: &str, tool: &str, input: &Value) {
        if !self.checkpointing {
            return;
        }
        let Some(file) = file_of(tool, input) else {
            return;
        };
        let target = resolved(&self.workdir, file);
        let Ok(relative) = target.strip_prefix(&self.workdir) else {
            return;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        if relative.is_empty() {
            return;
        }
        if let Err(error) = self
            .turn
            .kernel
            .capture_before(&self.turn.run_id, &self.workdir, &relative, action_id)
            .await
        {
            log(
                "checkpoints",
                "warning",
                &format!("Could not keep the original of {relative}: {error}"),
            );
        }
        locked(&self.edited).insert(action_id.to_owned(), relative);
    }

    /// Records what an edit left on disk.
    async fn keep_result(&self, relative: &str) {
        if let Err(error) = self
            .turn
            .kernel
            .capture_after(&self.turn.run_id, &self.workdir, relative)
            .await
        {
            log(
                "checkpoints",
                "warning",
                &format!("Could not record the edit of {relative}: {error}"),
            );
        }
    }

    /// The answer to the program's question whether a tool may run.
    async fn permission(&self, request: &Value) -> Result<Value, CoreError> {
        let tool = text(request, "tool_name");
        let input = request.get("input").cloned().unwrap_or_else(|| json!({}));
        let given = text(request, "tool_use_id");
        let id = if given.is_empty() {
            new_id("act").map_err(|error| CoreError::new(500, error.to_string()))?
        } else {
            given.to_owned()
        };
        let allowed = json!({ "behavior": "allow", "updatedInput": input, "toolUseID": id });
        // The permission rules first, as in Saturn's own loop: a deny refuses even a read; an allow or ask is applied
        // below, after the turn's mode has had its say.
        let run = self.turn.kernel.get_run(&self.turn.run_id)?;
        let (ruled_tool, ruled_arguments) = ruled_call(tool, &input);
        let ruled = self
            .turn
            .kernel
            .decide_permission(text(&self.agent, "id"), &run, &ruled_tool, &ruled_arguments)
            .await;
        if let Some(decision) = ruled
            .as_ref()
            .filter(|decision| decision.effect == Effect::Deny)
        {
            let reason = explain(decision);
            self.note_action(&id, tool, &input);
            self.mark_denied(&id, &reason);
            return Ok(json!({ "behavior": "deny", "message": reason, "toolUseID": id }));
        }
        // A read runs without asking, unless a rule says to ask about it.
        let asked_by_rule = ruled
            .as_ref()
            .is_some_and(|decision| decision.effect == Effect::Ask);
        if READ_ONLY_TOOLS.contains(&tool) && !asked_by_rule {
            return Ok(allowed);
        }
        if let Some(mode) = self.mode.filter(|mode| *mode != RunMode::Agent) {
            // An Ask or Plan turn only reads: a Saturn skill that only reads still runs; anything else is refused.
            if let Some(skill) = skill_of(tool) {
                let kernel = &self.turn.kernel;
                let category = kernel
                    .store
                    .read(|state| tool_category(state, &self.agent, skill));
                let arguments = input.as_object().cloned().unwrap_or_default();
                if is_read_only_call(skill, &arguments, category.as_deref()) {
                    return Ok(allowed);
                }
            }
            let refusal = match skill_of(tool) {
                Some(skill) => read_only_refusal_for(
                    mode,
                    skill,
                    &input.as_object().cloned().unwrap_or_default(),
                ),
                None => read_only_refusal(mode),
            };
            self.note_action(&id, tool, &input);
            {
                let mut record = locked(&self.turn.record);
                if let Some(action) = record
                    .actions
                    .iter_mut()
                    .find(|item| text(item, "id") == id)
                {
                    action["status"] = "denied".into();
                    action["reason"] = json!(refusal);
                }
            }
            return Ok(json!({ "behavior": "deny", "message": refusal, "toolUseID": id }));
        }
        self.note_action(&id, tool, &input);
        let file = file_of(tool, &input).map(str::to_owned);
        if let Some(file) = &file
            && let Some(reason) = self
                .turn
                .kernel
                .research_refusal_for_file(&run, tool, file, &id)
                .await
        {
            let mut record = locked(&self.turn.record);
            if let Some(action) = record
                .actions
                .iter_mut()
                .find(|item| text(item, "id") == id)
            {
                action["status"] = "denied".into();
                action["reason"] = json!(reason);
            }
            return Ok(json!({ "behavior": "deny", "message": reason, "toolUseID": id }));
        }
        let pair = match &file {
            Some(file) => {
                self.turn
                    .kernel
                    .research_file_needs_approval(&run, file)
                    .await
            }
            // A Pair chat asks about anything that changes something, and a command can.
            None => {
                matches!(tool, "Bash" | "PowerShell")
                    && self.turn.kernel.chat_mode_of(&run).as_deref() == Some("pair")
            }
        };
        let asks = match ruled.as_ref().map(|decision| decision.effect) {
            Some(Effect::Allow) => false,
            Some(Effect::Ask) => true,
            _ => {
                pair || match self.approval {
                    GuardrailMode::Bypass => false,
                    GuardrailMode::Default => {
                        risky(tool, &input, &self.workdir, self.turn.kernel.store.root())
                    }
                    GuardrailMode::Review => true,
                }
            }
        };
        if asks {
            let shown = skill_of(tool).unwrap_or(tool);
            let reason = ruled.as_ref().map(explain);
            let allow = self
                .turn
                .ask(text(&self.agent, "name"), &id, shown, reason.as_deref())
                .await?;
            if !allow {
                return Ok(
                    json!({ "behavior": "deny", "message": "The user denied this action.", "toolUseID": id }),
                );
            }
        }
        self.keep_original(&id, tool, &input).await;
        Ok(allowed)
    }

    /// A request from the program, as the line that answers it.
    async fn answer_request(&self, request_id: String, request: Value) -> Value {
        let answered: Result<Value, String> = match text(&request, "subtype") {
            "can_use_tool" => self
                .permission(&request)
                .await
                .map_err(|error| error.message),
            "mcp_message" => match &self.bridge {
                Some(bridge) if text(&request, "server_name") == SKILLS_SERVER => {
                    let message = request.get("message").cloned().unwrap_or(Value::Null);
                    let reply = bridge
                        .answer(&message)
                        .await
                        .unwrap_or_else(|| json!({ "jsonrpc": "2.0", "result": {}, "id": 0 }));
                    Ok(json!({ "mcp_response": reply }))
                }
                _ => Err(format!(
                    "SDK MCP server not found: {}",
                    text(&request, "server_name")
                )),
            },
            other => Err(format!("Unsupported control request subtype: {other}")),
        };
        match answered {
            Ok(response) => {
                json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": response } })
            }
            Err(error) => {
                json!({ "type": "control_response", "response": { "subtype": "error", "request_id": request_id, "error": error } })
            }
        }
    }
}

/// Records what an edit left on disk even when the run was stopped before its result arrived.
struct FinishEdits(Arc<ClaudeTurn>);

impl Drop for FinishEdits {
    fn drop(&mut self) {
        let left: Vec<String> = locked(&self.0.edited)
            .drain()
            .map(|(_, file)| file)
            .collect();
        if left.is_empty() {
            return;
        }
        let turn = Arc::clone(&self.0);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                for file in left {
                    turn.keep_result(&file).await;
                }
            });
        }
    }
}

/// The program's arguments for a turn, as the Agent SDK passes them.
fn arguments(
    model: &Value,
    resume: Option<&str>,
    project_settings: bool,
    mode: Option<RunMode>,
) -> Vec<String> {
    let mut args: Vec<String> = [
        "--output-format",
        "stream-json",
        "--verbose",
        "--input-format",
        "stream-json",
    ]
    .map(str::to_owned)
    .to_vec();
    let effort = text(model, "effort");
    if !effort.is_empty() {
        args.push(format!("--effort={effort}"));
    }
    // "default" leaves the choice to Claude Code, which then uses the model its own settings or the plan name.
    let chosen = text(model, "model");
    if !chosen.is_empty() && chosen != "default" {
        args.push(format!("--model={chosen}"));
    }
    args.push("--permission-prompt-tool=stdio".to_owned());
    if let Some(session) = resume {
        args.push(format!("--resume={session}"));
    }
    args.push(format!("--disallowedTools={DISALLOWED_TOOLS}"));
    args.push(format!(
        "--setting-sources={}",
        if project_settings { "project" } else { "" }
    ));
    args.push(format!(
        "--permission-mode={}",
        if mode == Some(RunMode::Plan) {
            "plan"
        } else {
            "default"
        }
    ));
    args
}

impl Kernel {
    /// Claude Code's own config directory for Saturn, so this login stays apart from the user's other Claude apps.
    fn claude_config(&self) -> PathBuf {
        self.store.root().join("claude")
    }

    /// The program's environment: the runtime's own. Whatever the user set up for Claude Code (their own key, Bedrock, Vertex AI or
    /// Foundry settings) reaches it, and it picks by its own documented order. Saturn adds no credential of its own.
    /// The user's environment for Claude Code, without the credentials it has no use for. Its shell, which Saturn does
    /// not sandbox, could print any variable it inherits; it keeps the ones it signs in or reaches its provider with.
    fn claude_environment(&self, command: &mut Command) {
        saturn_tools::launch_env(command);
        for (name, _) in std::env::vars_os() {
            let upper = name.to_string_lossy().to_ascii_uppercase();
            let credential = CREDENTIAL_WORDS.iter().any(|word| upper.contains(word));
            let its_own = CLAUDE_CREDENTIALS
                .iter()
                .any(|prefix| upper.starts_with(prefix));
            if credential && !its_own {
                command.env_remove(&name);
            }
        }
        command.env("CLAUDE_CONFIG_DIR", self.claude_config());
    }

    async fn make_private_folder(folder: &Path) -> Result<(), CoreError> {
        tokio::fs::create_dir_all(folder)
            .await
            .map_err(|error| CoreError::new(500, error.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ =
                tokio::fs::set_permissions(folder, std::fs::Permissions::from_mode(0o700)).await;
        }
        Ok(())
    }

    /// Asks the official program whether it is signed in; it reads the credential, Saturn only reads its answer.
    pub async fn claude_status(&self) -> Result<Value, CoreError> {
        let config = self.claude_config();
        Self::make_private_folder(&config).await?;
        let shown = config.to_string_lossy().into_owned();
        let Ok(cli) = self.program_path("claude-code") else {
            return Ok(
                json!({ "loggedIn": false, "authMethod": "none", "loginCommand": "", "configDir": shown, "installed": false }),
            );
        };
        let login = login_command(&config, &cli);
        let answer = self.ask_claude(&cli, &["auth", "status", "--json"]).await;
        // A signed-out `claude auth status` still prints its JSON, but exits non-zero.
        let parsed: Option<Value> = serde_json::from_str(js::trim(&answer.stdout)).ok();
        let Some(parsed) = parsed.filter(Value::is_object) else {
            let detail = format!(
                "Could not ask Claude Code for its login: {}",
                js::trim(&format!("{}\n{}", answer.stderr, answer.stdout))
            );
            return Ok(
                json!({ "loggedIn": false, "authMethod": "none", "loginCommand": login, "configDir": shown, "error": detail }),
            );
        };
        let mut status = json!({
            "loggedIn": parsed.get("loggedIn") == Some(&Value::Bool(true)),
            "authMethod": parsed.get("authMethod").and_then(Value::as_str).unwrap_or("none"),
            "loginCommand": login,
            "configDir": shown,
        });
        for key in ["email", "subscriptionType"] {
            if !text(&parsed, key).is_empty() {
                status[key] = parsed[key].clone();
            }
        }
        Ok(status)
    }

    async fn ask_claude(&self, cli: &Path, args: &[&str]) -> Answer {
        ask_program(
            cli,
            args,
            |command| self.claude_environment(command),
            question_timeout(),
        )
        .await
    }

    /// Signs Saturn's Claude Code out with the program's `auth logout`, which removes the credential it stored for this config
    /// directory. The user's other Claude apps keep their own logins.
    pub async fn claude_logout(&self) -> Result<Value, CoreError> {
        let cli = self.program_path("claude-code")?;
        let answer = self.ask_claude(&cli, &["auth", "logout"]).await;
        if answer.code != Some(0) {
            return Err(CoreError::new(
                502,
                format!(
                    "Claude Code could not sign out: {}",
                    js::trim(&answer.stderr)
                ),
            ));
        }
        log("admin", "info", "Signed Claude Code out");
        self.claude_status().await
    }

    /// One turn of a Claude Code chat; the session is resumed from the chat's last turn.
    pub(crate) async fn claude_turn(
        self: &Arc<Self>,
        run_id: &str,
        at: u64,
        agent: &Value,
        model: &Value,
    ) -> Result<(), CoreError> {
        let run = self.get_run(run_id)?;
        let workdir = self.program_workdir(&run).await?;
        let workdir = tokio::fs::canonicalize(&workdir).await.unwrap_or(workdir);
        Self::make_private_folder(&self.claude_config()).await?;
        let cli = self.program_path("claude-code")?;
        let resume = self.saved_session(&run, "claudeSessionId");
        let context = self.turn_context(agent, &run, &[]).await;
        let mode = RunMode::parse(run.get("mode").and_then(Value::as_str));
        // Memory and the agent's instructions go after Claude Code's own prompt on every turn, so edits to either reach a resumed
        // session too. That needs the program's snapshot turned off below.
        let instructions = js::trim(text(agent, "instructions"));
        let append: Vec<&str> = [
            context.memory.as_str(),
            context.rules.as_str(),
            instructions,
            mode_instructions(mode),
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect();
        let append = append.join("\n\n");

        let approval = self.run_approval(&run, agent);
        let thread = self.find_thread(text(&run, "threadId"));
        let checkpointing = thread.is_some_and(|thread| !text(&thread, "projectId").is_empty());
        let turn = Turn::new(self, run_id, at);
        let tools = self.bridged_tools(agent);
        let bridge = (!tools.is_empty()).then(|| SkillsBridge {
            turn: Arc::clone(&turn),
            agent: agent.clone(),
            mode: None,
            // Its calls have passed the permission request by the time they arrive here.
            approval: GuardrailMode::Bypass,
            tools,
            orphans: Mutex::default(),
            asked: Mutex::default(),
        });
        // By default the program records a session's system prompt on its first request and ignores any other text on a resume.
        let mut initialize = json!({ "subtype": "initialize", "systemPromptSnapshot": false });
        if let Some(bridge) = &bridge {
            initialize["sdkMcpServers"] = json!([SKILLS_SERVER]);
            initialize["sdkMcpServerManifests"] = json!({ SKILLS_SERVER: bridge.manifest() });
        }
        if !append.is_empty() {
            initialize["appendSystemPrompt"] = json!(append);
        }
        let claude = Arc::new(ClaudeTurn {
            turn: Arc::clone(&turn),
            agent: agent.clone(),
            mode,
            approval,
            workdir: workdir.clone(),
            checkpointing,
            edited: Mutex::default(),
            bridge,
        });

        // None of the user's Claude settings; the project's own .claude/settings.json only when the user turned it on.
        let project_settings =
            self.settings().get("claudeProjectSettings") == Some(&Value::Bool(true));
        let args = arguments(model, resume.as_deref(), project_settings, mode);
        let mut command = program_command(&cli, &workdir, &args, |command| {
            self.claude_environment(command);
        });
        log(
            "agent",
            "info",
            &format!(
                "{} asked Claude Code ({}) in {}",
                text(agent, "name"),
                text(model, "model"),
                workdir.display()
            ),
        );
        let message = with_knowledge(text(&run, "input"), &context.knowledge);
        let paths: Vec<String> = crate::records::strings(&run, "inputImages");
        let images = load_images(self.store.root(), &paths).await;
        let mut content: Vec<Value> = images
            .iter()
            .map(|image| json!({ "type": "image", "source": { "type": "base64", "media_type": image.mime_type, "data": image.base64 } }))
            .collect();
        content.push(json!({ "type": "text", "text": message }));
        let user = json!({ "type": "user", "session_id": "", "message": { "role": "user", "content": content }, "parent_tool_use_id": null });

        let started = std::time::Instant::now();
        let mut session = resume.clone();
        let edits = FinishEdits(Arc::clone(&claude));
        let failure = match command.spawn() {
            Err(error) => Some(format!("Could not start Claude Code: {error}")),
            Ok(mut child) => {
                let mut program = RunningProgram::watch(self, child.id());
                let answer = talk(
                    self,
                    &mut child,
                    &claude,
                    initialize,
                    user,
                    model,
                    agent,
                    &mut session,
                )
                .await;
                program.settle(&mut child);
                answer
            }
        };
        let left: Vec<String> = locked(&claude.edited)
            .drain()
            .map(|(_, file)| file)
            .collect();
        for file in left {
            claude.keep_result(&file).await;
        }
        drop(edits);

        if let Some(session) = session.as_deref().filter(|_| session != resume) {
            self.save_session(&run, "claudeSessionId", session).await?;
        }
        if !self.alive(run_id, at) {
            return Ok(());
        }
        let seconds = started.elapsed().as_secs_f64();
        if let Some(failure) = failure {
            let explained = if NOT_SIGNED_IN.is_match(&failure) {
                "Claude Code isn't signed in for Saturn yet. In Settings → General → Claude Code, copy the login command and run it once in a terminal.".to_owned()
            } else {
                failure
            };
            log(
                "agent",
                "error",
                &format!(
                    "{} failed in Claude Code after {seconds:.1}s: {}",
                    text(agent, "name"),
                    clip(&explained, 200)
                ),
            );
            return turn.finish(Some(explained)).await;
        }
        turn.finish(None).await?;
        let count = locked(&turn.record).actions.len();
        log(
            "agent",
            "info",
            &format!(
                "{} finished in Claude Code after {seconds:.1}s with {count} tool {}",
                text(agent, "name"),
                if count == 1 { "call" } else { "calls" }
            ),
        );
        Ok(())
    }
}

/// The program's whole conversation: the opening messages, then every line it writes until it ends. Answers the failure, if any.
#[allow(clippy::too_many_arguments)]
async fn talk(
    kernel: &Arc<Kernel>,
    child: &mut tokio::process::Child,
    claude: &Arc<ClaudeTurn>,
    initialize: Value,
    user: Value,
    model: &Value,
    agent: &Value,
    session: &mut Option<String>,
) -> Option<String> {
    let turn = &claude.turn;
    let stdout = child.stdout.take()?;
    let stdin = child.stdin.take()?;
    let stderr = keep_stderr(child.stderr.take()?);

    // One writer: a card may wait on the user for a long time while other requests come and go.
    let (lines, mut waiting_lines) = mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(line) = waiting_lines.recv().await {
            let mut bytes = line.to_string().into_bytes();
            bytes.push(b'\n');
            if stdin.write_all(&bytes).await.is_err() || stdin.flush().await.is_err() {
                break;
            }
        }
    });
    let _ = lines
        .send(json!({ "request_id": "init", "type": "control_request", "request": initialize }));
    let _ = lines.send(user);
    let mut writer = Some(lines);

    let mut handlers = JoinSet::new();
    let mut reader = BufReader::new(stdout).lines();
    let mut failure = None;
    loop {
        let line = tokio::select! {
            line = reader.next_line() => line,
            Some(_) = handlers.join_next(), if !handlers.is_empty() => continue,
            () = tokio::time::sleep(CLOSING), if writer.is_none() => break,
        };
        let Ok(Some(line)) = line else {
            break;
        };
        if !kernel.alive(&turn.run_id, turn.at) {
            break;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(id) = message.get("session_id").and_then(Value::as_str) {
            *session = Some(id.to_owned());
        }
        match text(&message, "type") {
            "control_request" => {
                let (Some(sender), Some(request)) =
                    (writer.clone(), message.get("request").cloned())
                else {
                    continue;
                };
                let request_id = text(&message, "request_id").to_owned();
                let claude = Arc::clone(claude);
                handlers.spawn(async move {
                    let answer = claude.answer_request(request_id, request).await;
                    let _ = sender.send(answer);
                });
            }
            "control_response" => {
                let response = message.get("response").cloned().unwrap_or(Value::Null);
                if text(&response, "request_id") == "init" && text(&response, "subtype") == "error"
                {
                    failure = Some(text(&response, "error").to_owned());
                    break;
                }
            }
            "assistant" => {
                note_assistant(claude, &message);
                let _ = turn.save(|_| {}).await;
            }
            "user" => {
                note_results(claude, &message).await;
                let _ = turn.save(|_| {}).await;
            }
            "result" => {
                record_usage(kernel, turn, model, agent, &message).await;
                if text(&message, "subtype") == "success"
                    && message.get("is_error") != Some(&Value::Bool(true))
                {
                    let result = text(&message, "result");
                    if !js::trim(result).is_empty() {
                        locked(&turn.record).output = result.to_owned();
                    }
                } else {
                    failure = Some(failure_of(&message));
                }
                // Its input closes with the turn, so the program ends.
                writer = None;
            }
            _ => {}
        }
    }
    drop(writer);
    handlers.abort_all();
    let ended = tokio::time::timeout(CLOSING, child.wait()).await;
    let status = match ended {
        Ok(Ok(status)) => Some(status),
        _ => None,
    };
    if failure.is_some() || !kernel.alive(&turn.run_id, turn.at) {
        return failure;
    }
    let code = status.and_then(|status| status.code());
    match (status, code) {
        (Some(status), Some(code)) if !status.success() => {
            let tail = stderr_of(stderr).await;
            let tail = js::trim(&tail);
            Some(if tail.is_empty() {
                format!("Claude Code process exited with code {code}")
            } else {
                format!("Claude Code process exited with code {code}: {tail}")
            })
        }
        _ => None,
    }
}

/// The reply, thoughts and tool calls of one assistant message.
fn note_assistant(claude: &Arc<ClaudeTurn>, message: &Value) {
    let blocks = message
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array);
    for block in blocks.into_iter().flatten() {
        match text(block, "type") {
            "text" if !js::trim(text(block, "text")).is_empty() => {
                locked(&claude.turn.record).add_output(text(block, "text"));
            }
            "thinking" if !js::trim(text(block, "thinking")).is_empty() => {
                locked(&claude.turn.record).add_thought(text(block, "thinking"));
            }
            "tool_use" => {
                let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                claude.note_action(text(block, "id"), text(block, "name"), &input);
            }
            _ => {}
        }
    }
}

/// The tool results the program reports.
async fn note_results(claude: &Arc<ClaudeTurn>, message: &Value) {
    let blocks = message
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array);
    for block in blocks.into_iter().flatten() {
        if text(block, "type") != "tool_result" {
            continue;
        }
        let id = text(block, "tool_use_id");
        let edited = locked(&claude.edited).remove(id);
        if let Some(file) = edited {
            claude.keep_result(&file).await;
        }
        let content = block.get("content").cloned().unwrap_or(Value::Null);
        let shown = text_of(&content);
        let mut record = locked(&claude.turn.record);
        let Some(action) = record
            .actions
            .iter_mut()
            .find(|item| text(item, "id") == id)
        else {
            continue;
        };
        if text(action, "status") == "denied" {
            continue;
        }
        let failed = block.get("is_error") == Some(&Value::Bool(true));
        action["status"] = if failed { "failed" } else { "completed" }.into();
        action["result"] = json!({ "output": clip(&shown, 4000) });
        if failed {
            action["reason"] = json!(clip(&shown, 300));
        }
    }
}

/// Token counts from the turn's result.
async fn record_usage(
    kernel: &Arc<Kernel>,
    turn: &Arc<Turn>,
    model: &Value,
    agent: &Value,
    message: &Value,
) {
    let Some(usage) = message.get("usage").filter(|usage| usage.is_object()) else {
        return;
    };
    let count = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    let input = count("input_tokens")
        + count("cache_read_input_tokens")
        + count("cache_creation_input_tokens");
    kernel
        .record_plan_usage(
            &turn.run_id,
            agent,
            model,
            "Claude plan",
            (input, count("output_tokens")),
        )
        .await;
}

/// What a failed result says went wrong.
fn failure_of(message: &Value) -> String {
    let result = text(message, "result");
    if !result.is_empty() {
        return result.to_owned();
    }
    let errors: Vec<&str> = message
        .get("errors")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    if errors.is_empty() {
        text(message, "subtype").to_owned()
    } else {
        errors.join("; ")
    }
}
