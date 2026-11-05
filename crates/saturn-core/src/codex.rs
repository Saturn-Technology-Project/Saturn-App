//! Codex models: the runtime starts the official `codex` program, as the official Codex SDK does. That program alone signs in, keeps
//! the login (in Saturn's own CODEX_HOME) and talks to OpenAI; Saturn never reads or passes a credential. Sign-in runs the program's
//! own `codex login` and only relays what it prints (the device code, or that the browser page opened) to Settings.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use regex::Regex;
use saturn_domain::js;
use saturn_domain::prompt::{RunMode, mode_instructions};
use saturn_domain::research::sha256_hex;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Notify;

use crate::agent_programs::{SignIn, ask_program, question_timeout};
use crate::agent_sessions::{
    RunningProgram, SKILLS_SERVER, SkillsBridge, Turn, approval_mode, clip, keep_stderr,
    program_command, same_call, stderr_of, with_knowledge,
};
use crate::records::{strings, text};
use crate::{CoreError, Kernel, locked, log, open_in_browser};

/// Credentials that would take over from the user's own Codex login. They are removed from Codex's environment so a stray API key
/// can never bill the wrong account.
const CREDENTIAL_VARIABLES: [&str; 4] = [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
];
/// A sign-in nobody finishes is ended after this long (a device code expires after 15 minutes).
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Carries the skills endpoint's token to Codex, which sends it as a bearer token. The name contains TOKEN, so Codex's default
/// shell environment policy keeps it out of the commands it runs.
const SKILLS_TOKEN_VARIABLE: &str = "SATURN_SKILLS_TOKEN";
/// The catalog's "use Codex's own default" model id.
const DEFAULT_MODEL: &str = "default";
/// How long `codex login` gets to print its link, so the first answer usually carries it.
const FIRST_WORDS: Duration = Duration::from_secs(5);

static NOT_SIGNED_IN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)login|logged in|authenticat|unauthori[sz]ed|401|token")
        .expect("the pattern is valid")
});
static ANSI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]").expect("the pattern is valid"));
static LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"https://[^\s"'<>]+"#).expect("the pattern is valid"));
static OAUTH_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)authorize|oauth|auth\.").expect("the pattern is valid"));
static DEVICE_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)device").expect("the pattern is valid"));
static ONE_TIME_CODE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b").expect("the pattern is valid"));

/// The link and one-time code `codex login` prints.
fn parse_sign_in(printed: &str, device: bool) -> (Option<String>, Option<String>) {
    let links: Vec<&str> = LINK
        .find_iter(printed)
        .map(|found| found.as_str())
        .collect();
    let wanted: &Regex = if device { &DEVICE_LINK } else { &OAUTH_LINK };
    let link = links
        .iter()
        .find(|link| wanted.is_match(link))
        .or_else(|| links.first())
        .map(|link| (*link).to_owned());
    let code = device
        .then(|| {
            ONE_TIME_CODE
                .find(printed)
                .map(|found| found.as_str().to_owned())
        })
        .flatten();
    (link, code)
}

/// Where a chat records which instructions its Codex thread last heard, by hash.
const INSTRUCTIONS_HEARD: &str = "codexInstructionsHeard";

/// What Codex is told about its skills server, as `--config` values the way the SDK writes them.
fn skills_settings(origin: &str) -> Vec<String> {
    vec![
        format!(
            "mcp_servers.{SKILLS_SERVER}.url={}",
            json!(format!("{origin}/agent-mcp"))
        ),
        format!(
            "mcp_servers.{SKILLS_SERVER}.bearer_token_env_var={}",
            json!(SKILLS_TOKEN_VARIABLE)
        ),
        format!("mcp_servers.{SKILLS_SERVER}.default_tools_approval_mode=\"approve\""),
        // A Review card can wait on the user for a while.
        format!("mcp_servers.{SKILLS_SERVER}.tool_timeout_sec=3600"),
    ]
}

/// Where the runtime listens; Codex reaches the skills endpoint here.
fn runtime_origin() -> String {
    let host = std::env::var("SATURN_RUNTIME_HOST").unwrap_or_else(|_| "127.0.0.1".to_owned());
    let port = std::env::var("SATURN_RUNTIME_PORT").unwrap_or_else(|_| "4700".to_owned());
    format!("http://{host}:{port}")
}

/// The program's arguments for a turn, in the Codex SDK's order.
fn arguments(
    model: &Value,
    workdir: &Path,
    read_only: bool,
    skills: Option<&str>,
    resume: Option<&str>,
    images: &[PathBuf],
) -> Vec<String> {
    let mut args = vec!["exec".to_owned(), "--experimental-json".to_owned()];
    for setting in skills.map(skills_settings).into_iter().flatten() {
        args.extend(["--config".to_owned(), setting]);
    }
    let chosen = text(model, "model");
    if !chosen.is_empty() && chosen != DEFAULT_MODEL {
        args.extend(["--model".to_owned(), chosen.to_owned()]);
    }
    // Ask and Plan turns only read: Codex's own read-only sandbox refuses edits and writing commands.
    let sandbox = if read_only {
        "read-only"
    } else {
        "workspace-write"
    };
    args.extend(["--sandbox".to_owned(), sandbox.to_owned()]);
    args.extend(["--cd".to_owned(), workdir.to_string_lossy().into_owned()]);
    args.push("--skip-git-repo-check".to_owned());
    let effort = text(model, "effort");
    if !effort.is_empty() {
        args.extend([
            "--config".to_owned(),
            format!("model_reasoning_effort=\"{effort}\""),
        ]);
    }
    args.extend([
        "--config".to_owned(),
        "sandbox_workspace_write.network_access=false".to_owned(),
    ]);
    args.extend(["--config".to_owned(), "web_search=\"disabled\"".to_owned()]);
    args.extend([
        "--config".to_owned(),
        "approval_policy=\"never\"".to_owned(),
    ]);
    if let Some(thread) = resume {
        args.extend(["resume".to_owned(), thread.to_owned()]);
    }
    for image in images {
        args.extend(["--image".to_owned(), image.to_string_lossy().into_owned()]);
    }
    args
}

/// Shows Codex's commands, file changes and MCP calls as the run's actions. A Saturn skill call keeps the action its approval card
/// went on, under the skill's own name.
fn track(
    turn: &Arc<Turn>,
    aliases: &mut HashMap<String, String>,
    bridge: Option<&SkillsBridge>,
    item: &Value,
) {
    let (tool, input, result, failed): (String, Value, Option<Value>, bool) =
        match text(item, "type") {
            "command_execution" => {
                let mut result = json!({ "output": clip(text(item, "aggregated_output"), 4000) });
                let code = item.get("exit_code").and_then(Value::as_i64);
                if let Some(code) = code {
                    result["exitCode"] = json!(code);
                }
                (
                    "Bash".to_owned(),
                    json!({ "command": text(item, "command") }),
                    Some(result),
                    text(item, "status") == "failed" || code.is_some_and(|code| code != 0),
                )
            }
            "file_change" => {
                let changes = item.get("changes").cloned().unwrap_or_else(|| json!([]));
                let shown: Vec<String> = changes
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|change| format!("{} {}", text(change, "kind"), text(change, "path")))
                    .collect();
                (
                    "Edit".to_owned(),
                    json!({ "changes": changes }),
                    Some(json!({ "output": shown.join("\n") })),
                    text(item, "status") == "failed",
                )
            }
            "mcp_tool_call" => {
                let server = text(item, "server");
                let name = text(item, "tool");
                let tool = if server == SKILLS_SERVER {
                    name.to_owned()
                } else {
                    format!("{server}.{name}")
                };
                let input = item
                    .get("arguments")
                    .filter(|value| value.is_object())
                    .cloned()
                    .unwrap_or_else(|| json!({ "value": item.get("arguments") }));
                let status = text(item, "status");
                // No result while the call is in flight, so a Review card for it can find this action.
                let result = if status == "in_progress" {
                    None
                } else if let Some(error) = item.get("error").filter(|error| !error.is_null()) {
                    Some(json!({ "output": text(error, "message") }))
                } else {
                    let content = item
                        .get("result")
                        .and_then(|result| result.get("content"))
                        .cloned()
                        .unwrap_or_else(|| json!(""));
                    Some(json!({ "output": clip(&content.to_string(), 4000) }))
                };
                (tool, input, result, status == "failed")
            }
            _ => return,
        };
    let item_id = text(item, "id");
    let id = aliases
        .get(item_id)
        .map_or(item_id, String::as_str)
        .to_owned();
    let mut record = locked(&turn.record);
    let mut index = record
        .actions
        .iter()
        .position(|entry| text(entry, "id") == id);
    if index.is_none()
        && text(item, "type") == "mcp_tool_call"
        && text(item, "server") == SKILLS_SERVER
        && let Some(bridge) = bridge
    {
        let mut orphans = locked(&bridge.orphans);
        index = record.actions.iter().position(|entry| {
            orphans.contains(text(entry, "id")) && same_call(entry, &tool, &input)
        });
        if let Some(found) = index {
            let adopted = text(&record.actions[found], "id").to_owned();
            orphans.remove(&adopted);
            aliases.insert(item_id.to_owned(), adopted);
        }
    }
    let index = index.unwrap_or_else(|| {
        record.actions.push(
            json!({ "id": item_id, "toolId": tool, "arguments": input, "status": "completed" }),
        );
        record.actions.len() - 1
    });
    let action = &mut record.actions[index];
    action["arguments"] = input;
    // An approval card stays until the user answers it, and a denied call stays denied.
    let status = text(action, "status");
    if status == "denied" || (status == "waiting_approval" && text(item, "status") == "in_progress")
    {
        return;
    }
    let reason = result
        .as_ref()
        .map(|result| text(result, "output").to_owned())
        .filter(|output| !output.is_empty());
    match result {
        Some(result) => action["result"] = result,
        None => crate::records::remove(action, "result"),
    }
    action["status"] = if failed { "failed" } else { "completed" }.into();
    if failed {
        action["reason"] = json!(clip(reason.as_deref().unwrap_or("failed"), 300));
    } else {
        crate::records::remove(action, "reason");
    }
}

/// Takes a turn's token back when it ends, however it ends.
struct ClosedBridge {
    kernel: Arc<Kernel>,
    token: Option<String>,
}

impl Drop for ClosedBridge {
    fn drop(&mut self) {
        if let Some(token) = &self.token {
            locked(&self.kernel.programs.bridges).remove(token);
        }
    }
}

impl Kernel {
    /// Codex's home for Saturn, so this login stays apart from the user's own `codex` setup.
    fn codex_home(&self) -> PathBuf {
        self.store.root().join("codex")
    }

    /// The program's environment: the runtime's own, minus every credential that outranks the user's login.
    fn codex_environment(&self, command: &mut Command) {
        saturn_tools::launch_env(command);
        for variable in CREDENTIAL_VARIABLES {
            command.env_remove(variable);
        }
        command.env("CODEX_HOME", self.codex_home());
    }

    async fn make_codex_home(&self) -> Result<(), CoreError> {
        let home = self.codex_home();
        tokio::fs::create_dir_all(&home)
            .await
            .map_err(|error| CoreError::new(500, error.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = tokio::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).await;
        }
        Ok(())
    }

    /// The sign-in on show: the one in progress, or the last one that failed.
    fn sign_in_shown(&self) -> Option<Value> {
        if let Some(current) = locked(&self.programs.sign_in).as_ref() {
            return Some(locked(&current.info).clone());
        }
        locked(&self.programs.last_sign_in).clone()
    }

    /// Asks the official program whether it is signed in; Saturn only reads its answer.
    pub async fn codex_status(&self) -> Result<Value, CoreError> {
        self.make_codex_home().await?;
        let mut base = json!({ "loggedIn": false, "authMethod": "none", "configDir": self.codex_home().to_string_lossy() });
        if let Some(shown) = self.sign_in_shown() {
            base["signIn"] = shown;
        }
        let Ok(cli) = self.program_path("codex") else {
            base["installed"] = json!(false);
            return Ok(base);
        };
        // `codex login status` prints e.g. "Logged in using ChatGPT", and exits non-zero when signed out.
        let answer = ask_program(
            &cli,
            &["login", "status"],
            |command| self.codex_environment(command),
            question_timeout(),
        )
        .await;
        let printed = format!("{}\n{}", answer.stdout, answer.stderr).to_lowercase();
        let signed_out = printed.contains("not logged in");
        if answer.code == Some(0) && printed.contains("logged in") && !signed_out {
            base["loggedIn"] = json!(true);
            base["authMethod"] = json!(if printed.contains("chatgpt") {
                "chatgpt"
            } else if printed.contains("api key") {
                "api-key"
            } else {
                "unknown"
            });
        } else if !signed_out && answer.code.is_none() {
            base["error"] = json!(format!(
                "Could not ask Codex for its login: {}",
                clip(js::trim(&answer.stderr), 200)
            ));
        }
        Ok(base)
    }

    /// Starts the official `codex login`. Device mode prints a link and a one-time code, with no local redirect at all; browser mode
    /// opens the sign-in page, and the program itself waits for the redirect on its own loopback port. Either way the program runs
    /// under the runtime, so it is still listening when the browser comes back, and it ends once signed in, cancelled, or after 15
    /// minutes.
    pub async fn start_codex_sign_in(self: &Arc<Self>, browser: bool) -> Result<Value, CoreError> {
        let mode = if browser { "browser" } else { "device" };
        let same = locked(&self.programs.sign_in)
            .as_ref()
            .map(|current| text(&locked(&current.info), "mode") == mode);
        match same {
            Some(true) => return self.codex_status().await,
            Some(false) => self.cancel_codex_sign_in(),
            None => {}
        }
        let cli = self.program_path("codex")?;
        self.make_codex_home().await?;
        let info = Arc::new(Mutex::new(json!({ "mode": mode, "state": "starting" })));
        let mut command = Command::new(&cli);
        command
            .args(if browser {
                vec!["login"]
            } else {
                vec!["login", "--device-auth"]
            })
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        self.codex_environment(&mut command);
        command.env("NO_COLOR", "1");
        saturn_tools::in_own_group(&mut command);
        *locked(&self.programs.last_sign_in) = None;
        let cancel = Arc::new(Notify::new());
        match command.spawn() {
            Err(error) => {
                let mut shown = locked(&info);
                shown["state"] = "failed".into();
                shown["error"] = json!(format!("Could not start Codex sign-in: {error}"));
                *locked(&self.programs.last_sign_in) = Some(shown.clone());
            }
            Ok(child) => {
                *locked(&self.programs.sign_in) = Some(SignIn {
                    info: Arc::clone(&info),
                    cancel: Arc::clone(&cancel),
                });
                let kernel = Arc::clone(self);
                let watched = Arc::clone(&info);
                tokio::spawn(
                    async move { kernel.watch_sign_in(child, watched, cancel, browser).await },
                );
            }
        }
        log(
            "admin",
            "info",
            &format!(
                "Codex sign-in started ({})",
                if browser { "browser" } else { "device code" }
            ),
        );
        // Give the program a moment to print its link and code, so the first answer usually carries them.
        let began = std::time::Instant::now();
        while began.elapsed() < FIRST_WORDS && text(&locked(&info), "state") == "starting" {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        self.codex_status().await
    }

    /// Reads what `codex login` prints until it ends.
    async fn watch_sign_in(
        self: Arc<Self>,
        mut child: tokio::process::Child,
        info: Arc<Mutex<Value>>,
        cancel: Arc<Notify>,
        browser: bool,
    ) {
        let printed = Arc::new(Mutex::new(String::new()));
        let opened = Arc::new(Mutex::new(false));
        let mut readers = Vec::new();
        let stdout = child
            .stdout
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn AsyncRead + Send + Unpin>);
        let stderr = child
            .stderr
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn AsyncRead + Send + Unpin>);
        for mut pipe in [stdout, stderr].into_iter().flatten() {
            let (printed, opened, info) =
                (Arc::clone(&printed), Arc::clone(&opened), Arc::clone(&info));
            readers.push(tokio::spawn(async move {
                let mut chunk = [0_u8; 4096];
                while let Ok(read) = pipe.read(&mut chunk).await {
                    if read == 0 {
                        break;
                    }
                    let open = {
                        let mut text_so_far = locked(&printed);
                        let piece = String::from_utf8_lossy(&chunk[..read]);
                        text_so_far.push_str(&ANSI.replace_all(&piece, ""));
                        let (link, code) = parse_sign_in(&text_so_far, !browser);
                        let mut shown = locked(&info);
                        if let Some(link) = &link {
                            shown["url"] = json!(link);
                        }
                        if let Some(code) = code {
                            shown["code"] = json!(code);
                        }
                        if !text(&shown, "url").is_empty()
                            && (browser || !text(&shown, "code").is_empty())
                        {
                            shown["state"] = "waiting".into();
                        }
                        // The program opens the page itself where it can; the runtime has no terminal, so open it here too.
                        let mut was_opened = locked(&opened);
                        let open = browser && link.is_some() && !*was_opened;
                        if open {
                            *was_opened = true;
                        }
                        open.then_some(link).flatten()
                    };
                    if let Some(link) = open {
                        open_in_browser(&link);
                    }
                }
            }));
        }
        let pid = child.id();
        enum Ended {
            Exited(Option<i32>),
            TimedOut,
            Cancelled,
        }
        let ended = tokio::select! {
            status = child.wait() => Ended::Exited(status.ok().and_then(|status| status.code())),
            () = tokio::time::sleep(SIGN_IN_TIMEOUT) => Ended::TimedOut,
            () = cancel.notified() => Ended::Cancelled,
        };
        if !matches!(ended, Ended::Exited(_))
            && let Some(pid) = pid
        {
            saturn_tools::terminate(pid);
        }
        for mut reader in readers {
            // Pipes that end with the program still hold what it said last; one left open by something it started is not waited on.
            let waited = matches!(ended, Ended::Exited(_));
            if !waited
                || tokio::time::timeout(Duration::from_secs(1), &mut reader)
                    .await
                    .is_err()
            {
                reader.abort();
            }
        }
        let mine = {
            let mut current = locked(&self.programs.sign_in);
            let mine = current
                .as_ref()
                .is_some_and(|item| Arc::ptr_eq(&item.info, &info));
            if mine {
                *current = None;
            }
            mine
        };
        let error = match ended {
            Ended::Cancelled => return,
            Ended::Exited(Some(0)) => {
                log("admin", "info", "Codex signed in");
                return;
            }
            Ended::TimedOut => "The sign-in expired. Start it again.".to_owned(),
            Ended::Exited(code) => {
                let printed = locked(&printed).clone();
                let last = printed
                    .lines()
                    .map(js::trim)
                    .rfind(|line| !line.is_empty())
                    .map(str::to_owned);
                last.unwrap_or_else(|| {
                    format!(
                        "Codex sign-in ended (exit {})",
                        code.map_or("signal".to_owned(), |code| code.to_string())
                    )
                })
            }
        };
        let shown = {
            let mut shown = locked(&info);
            shown["state"] = "failed".into();
            shown["error"] = json!(error);
            shown.clone()
        };
        if mine {
            *locked(&self.programs.last_sign_in) = Some(shown);
        }
        log(
            "admin",
            "warning",
            &format!("Codex sign-in failed: {}", clip(&error, 200)),
        );
    }

    /// Opens the sign-in page again: the link Codex printed for the sign-in in progress, never one from a request.
    pub fn open_codex_sign_in(&self) -> Result<Value, CoreError> {
        let link = locked(&self.programs.sign_in)
            .as_ref()
            .map(|current| text(&locked(&current.info), "url").to_owned())
            .filter(|link| link.starts_with("https://"));
        let Some(link) = link else {
            return Err(CoreError::new(409, "No Codex sign-in is waiting"));
        };
        open_in_browser(&link);
        Ok(json!({ "opened": true }))
    }

    /// Ends the sign-in in progress, and forgets the last failure.
    pub fn cancel_codex_sign_in(&self) {
        *locked(&self.programs.last_sign_in) = None;
        if let Some(current) = locked(&self.programs.sign_in).take() {
            current.cancel.notify_one();
        }
    }

    /// Signs Saturn's Codex out with the official `codex logout`; the user's own Codex setup is untouched.
    pub async fn codex_logout(&self) -> Result<Value, CoreError> {
        self.cancel_codex_sign_in();
        let cli = self.program_path("codex")?;
        let answer = ask_program(
            &cli,
            &["logout"],
            |command| self.codex_environment(command),
            question_timeout(),
        )
        .await;
        let printed = format!("{}\n{}", answer.stdout, answer.stderr);
        // Signing out when already signed out is not an error worth showing.
        if answer.code != Some(0) && !printed.to_lowercase().contains("not logged in") {
            return Err(CoreError::new(
                502,
                format!("Codex could not sign out: {}", js::trim(&printed)),
            ));
        }
        log("admin", "info", "Signed Codex out");
        self.codex_status().await
    }

    /// One turn of a Codex chat; the Codex thread is resumed from the chat's last turn. Codex's exec mode has no per-command approval,
    /// so its guard rails are its own sandbox: writes only inside the chat's project folder, and no network for the commands it runs.
    /// The agent's Saturn skills are the exception: they run in Saturn, which asks for them by the agent's approval setting.
    pub(crate) async fn codex_turn(
        self: &Arc<Self>,
        run_id: &str,
        at: u64,
        agent: &Value,
        model: &Value,
    ) -> Result<(), CoreError> {
        let run = self.get_run(run_id)?;
        let workdir = self.program_workdir(&run).await?;
        let workdir = tokio::fs::canonicalize(&workdir).await.unwrap_or(workdir);
        self.make_codex_home().await?;
        let cli = self.program_path("codex")?;
        let mode = RunMode::parse(run.get("mode").and_then(Value::as_str));
        let read_only = matches!(mode, Some(RunMode::Ask | RunMode::Plan));
        let turn = Turn::new(self, run_id, at);

        // The agent's Saturn skills and MCP servers, over the runtime's /agent-mcp endpoint with a token only this turn holds. Codex
        // approves every call itself; Saturn asks the user here when the agent's setting is Review.
        let group = self.group_of(&run);
        let tools = self.bridged_tools(agent);
        let token = (!tools.is_empty()).then(|| saturn_domain::random_hex(32));
        let token = token
            .transpose()
            .map_err(|error| CoreError::new(500, error.to_string()))?;
        let bridge = token.as_ref().map(|token| {
            let bridge = Arc::new(SkillsBridge {
                turn: Arc::clone(&turn),
                agent: agent.clone(),
                mode,
                approval: approval_mode(agent, group.as_ref()),
                tools,
                orphans: Mutex::default(),
            });
            locked(&self.programs.bridges).insert(token.clone(), Arc::clone(&bridge));
            bridge
        });
        let closing = ClosedBridge {
            kernel: Arc::clone(self),
            token: token.clone(),
        };

        let resume = self.saved_session(&run, "codexThreadId");
        // Memory and the agent's instructions open a new Codex thread, and a resumed thread already has them, unless the
        // instructions changed since it last heard them or it has no record of what it heard. What the knowledge sources
        // return goes with every message. Codex reads AGENTS.md from its working folder itself.
        let context = self.turn_context(agent, &run, &["AGENTS.md"]).await;
        let instructions = js::trim(text(agent, "instructions"));
        let instructions_hash = sha256_hex(instructions.as_bytes());
        let heard = self.saved_session(&run, INSTRUCTIONS_HEARD);
        let opening: Vec<String> = if resume.is_some() {
            if heard.as_deref() == Some(instructions_hash.as_str()) {
                Vec::new()
            } else {
                [("instructions", instructions)]
                    .into_iter()
                    .filter(|(_, content)| !content.is_empty())
                    .map(|(tag, content)| format!("<{tag}>\n{content}\n</{tag}>"))
                    .collect()
            }
        } else {
            [
                ("memory", context.memory.as_str()),
                ("project_rules", context.rules.as_str()),
                ("instructions", instructions),
            ]
            .into_iter()
            .filter(|(_, content)| !content.is_empty())
            .map(|(tag, content)| format!("<{tag}>\n{content}\n</{tag}>"))
            .collect()
        };
        let note = mode_instructions(mode);
        let input = text(&run, "input");
        let message = if note.is_empty() {
            input.to_owned()
        } else {
            format!("{note}\n\n{input}")
        };
        let message = with_knowledge(&message, &context.knowledge);
        let prompt = if opening.is_empty() {
            message
        } else {
            format!("{}\n\n{message}", opening.join("\n\n"))
        };
        // Attached images go to Codex as files it reads itself.
        let images: Vec<PathBuf> = strings(&run, "inputImages")
            .iter()
            .map(|relative| self.store.root().join(relative))
            .collect();
        let origin = runtime_origin();
        let args = arguments(
            model,
            &workdir,
            read_only,
            token.as_ref().map(|_| origin.as_str()),
            resume.as_deref(),
            &images,
        );
        let mut command = program_command(&cli, &workdir, &args, |command| {
            self.codex_environment(command);
            if let Some(token) = &token {
                command.env(SKILLS_TOKEN_VARIABLE, token);
            }
        });
        log(
            "agent",
            "info",
            &format!(
                "{} asked Codex ({}) in {}",
                text(agent, "name"),
                text(model, "model"),
                workdir.display()
            ),
        );

        let started = std::time::Instant::now();
        let mut thread = resume.clone();
        let failure = match command.spawn() {
            Err(error) => Some(format!("Could not start Codex: {error}")),
            Ok(mut child) => {
                let mut program = RunningProgram::watch(self, child.id());
                let answer = self
                    .read_codex(
                        &mut child,
                        &turn,
                        bridge.as_deref(),
                        prompt,
                        agent,
                        model,
                        &mut thread,
                    )
                    .await;
                program.settle(&mut child);
                answer
            }
        };
        drop(closing);

        if let Some(thread) = thread.as_deref().filter(|_| thread != resume) {
            self.save_session(&run, "codexThreadId", thread).await?;
        }
        // Only a turn that went through has told the thread; a failed one says it again next time.
        if thread.is_some()
            && failure.is_none()
            && heard.as_deref() != Some(instructions_hash.as_str())
        {
            self.save_session(&run, INSTRUCTIONS_HEARD, &instructions_hash)
                .await?;
        }
        if !self.alive(run_id, at) {
            return Ok(());
        }
        let seconds = started.elapsed().as_secs_f64();
        if let Some(failure) = failure {
            let explained = if NOT_SIGNED_IN.is_match(&failure) {
                "Codex isn't signed in for Saturn yet. Sign in under Settings → General → Codex."
                    .to_owned()
            } else {
                failure
            };
            log(
                "agent",
                "error",
                &format!(
                    "{} failed in Codex after {seconds:.1}s: {}",
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
                "{} finished in Codex after {seconds:.1}s with {count} tool {}",
                text(agent, "name"),
                if count == 1 { "call" } else { "calls" }
            ),
        );
        Ok(())
    }

    /// Gives the program its prompt and follows its events until it ends. Answers the failure, if any.
    #[allow(clippy::too_many_arguments)]
    async fn read_codex(
        &self,
        child: &mut tokio::process::Child,
        turn: &Arc<Turn>,
        bridge: Option<&SkillsBridge>,
        prompt: String,
        agent: &Value,
        model: &Value,
        thread: &mut Option<String>,
    ) -> Option<String> {
        let mut stdin = child.stdin.take()?;
        let stdout = child.stdout.take()?;
        let stderr = keep_stderr(child.stderr.take()?);
        // The prompt can outgrow a pipe's buffer, and the program's output must be read meanwhile.
        tokio::spawn(async move {
            let _ = stdin.write_all(prompt.as_bytes()).await;
            let _ = stdin.shutdown().await;
        });
        let mut reader = BufReader::new(stdout).lines();
        let mut failure = None;
        let mut aliases = HashMap::new();
        while let Ok(Some(line)) = reader.next_line().await {
            if !self.alive(&turn.run_id, turn.at) {
                return failure;
            }
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match text(&event, "type") {
                "thread.started" => *thread = Some(text(&event, "thread_id").to_owned()),
                kind @ ("item.started" | "item.updated" | "item.completed") => {
                    let done = kind == "item.completed";
                    let item = event.get("item").cloned().unwrap_or(Value::Null);
                    let content = text(&item, "text");
                    match text(&item, "type") {
                        "agent_message" => {
                            if done && !js::trim(content).is_empty() {
                                locked(&turn.record).add_output(content);
                            }
                        }
                        "reasoning" => {
                            if done && !js::trim(content).is_empty() {
                                locked(&turn.record).add_thought(content);
                            }
                        }
                        "error" => log(
                            "agent",
                            "warning",
                            &format!("Codex: {}", text(&item, "message")),
                        ),
                        _ => track(turn, &mut aliases, bridge, &item),
                    }
                    let _ = turn.save(|_| {}).await;
                }
                "turn.completed" => {
                    let usage = event.get("usage").cloned().unwrap_or(Value::Null);
                    let count = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
                    self.record_plan_usage(
                        &turn.run_id,
                        agent,
                        model,
                        "ChatGPT plan",
                        (count("input_tokens"), count("output_tokens")),
                    )
                    .await;
                }
                "turn.failed" => {
                    let error = event.get("error").cloned().unwrap_or(Value::Null);
                    failure = Some(text(&error, "message").to_owned());
                }
                "error" => failure = Some(text(&event, "message").to_owned()),
                _ => {}
            }
        }
        let status = child.wait().await.ok();
        if failure.is_some() {
            return failure;
        }
        let status = status?;
        if status.success() {
            return None;
        }
        let tail = stderr_of(stderr).await;
        let detail = status
            .code()
            .map_or_else(|| "signal".to_owned(), |code| format!("code {code}"));
        Some(format!("Codex Exec exited with {detail}: {tail}"))
    }
}
