//! `saturn`: the local runtime from a terminal or a script. It talks to the running Saturn over its HTTP API with the runtime
//! token, like the apps do; it starts nothing itself.
//!
//!   saturn run "fix the failing test" [--agent NAME] [--project PATH] [--mode agent|ask|plan] [--chat ID] [--json]
//!   saturn agents | saturn runs [--limit N] | saturn show RUN | saturn changes RUN
//!   saturn approve RUN ACTION [--deny] | saturn stop RUN
use std::collections::HashMap;
use std::io::{IsTerminal, Read, Write};
use std::path::{Component, Path, PathBuf};

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use reqwest::{Method, Response};
use serde_json::{Value, json};

const OK: i32 = 0;
const FAILED: i32 = 1;
const USAGE_CODE: i32 = 2;
const WAITING: i32 = 3;
const UNREACHABLE: i32 = 4;

const USAGE: &str = r#"saturn: the Saturn runtime from a terminal

Usage:
  saturn run PROMPT [--agent NAME] [--project PATH] [--mode agent|ask|plan] [--chat ID] [--json]
  saturn agents
  saturn runs [--limit N]
  saturn show RUN
  saturn changes RUN
  saturn approve RUN ACTION [--deny]
  saturn stop RUN

PROMPT may be "-" to read it from stdin. A run waiting for approval asks on a terminal; elsewhere saturn exits
with code 3 and prints how to answer it. Exit codes: 0 done, 1 failed, 2 usage, 3 waiting for approval,
4 Saturn is not running.

Environment: SATURN_RUNTIME_PORT (default 4700), SATURN_DATA_DIR (default ~/.saturn-app)."#;

/// Why a command could not go on, and the exit code that says so.
struct CliError {
    message: String,
    code: i32,
}

fn failed(message: impl Into<String>) -> CliError {
    CliError {
        message: message.into(),
        code: FAILED,
    }
}

fn misuse(message: impl Into<String>) -> CliError {
    CliError {
        message: message.into(),
        code: USAGE_CODE,
    }
}

/// A flag's value: `--flag value` or `--flag=value`, or `--flag` alone.
#[derive(Clone, PartialEq)]
enum Flag {
    On,
    Text(String),
}

/// A command line in positionals and flags.
struct Arguments {
    positional: Vec<String>,
    flags: HashMap<String, Flag>,
}

impl Arguments {
    /// Splits the arguments. The flags in BOOLEANS never take the next argument as their value.
    fn parse(argv: &[String]) -> Self {
        const BOOLEANS: [&str; 3] = ["json", "deny", "help"];
        let mut positional = Vec::new();
        let mut flags = HashMap::new();
        let mut index = 0;
        while index < argv.len() {
            let argument = &argv[index];
            if argument == "--" {
                positional.extend_from_slice(&argv[index + 1..]);
                break;
            }
            if let Some(flag) = argument.strip_prefix("--") {
                if let Some((name, value)) = flag.split_once('=') {
                    flags.insert(name.to_owned(), Flag::Text(value.to_owned()));
                } else if BOOLEANS.contains(&flag)
                    || argv
                        .get(index + 1)
                        .is_none_or(|next| next.starts_with("--"))
                {
                    flags.insert(flag.to_owned(), Flag::On);
                } else {
                    index += 1;
                    flags.insert(flag.to_owned(), Flag::Text(argv[index].clone()));
                }
            } else if argument == "-h" {
                flags.insert("help".to_owned(), Flag::On);
            } else {
                positional.push(argument.clone());
            }
            index += 1;
        }
        Self { positional, flags }
    }

    fn on(&self, name: &str) -> bool {
        self.flags.get(name) == Some(&Flag::On)
    }

    fn text(&self, name: &str) -> Option<&str> {
        match self.flags.get(name) {
            Some(Flag::Text(value)) => Some(value),
            _ => None,
        }
    }
}

/// What a path component keeps as it is, besides letters and digits (as `encodeURIComponent` does).
const PATH_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// A path component for a URL.
fn encoded(text: &str) -> String {
    utf8_percent_encode(text, PATH_COMPONENT).to_string()
}

/// The running Saturn.
struct Client {
    base: String,
    token: String,
    http: reqwest::Client,
}

impl Client {
    fn new() -> Result<Self, CliError> {
        let port = std::env::var("SATURN_RUNTIME_PORT")
            .ok()
            .filter(|port| !port.is_empty())
            .unwrap_or_else(|| "4700".to_owned());
        let folder = std::env::var_os("SATURN_DATA_DIR").map_or_else(
            || std::env::home_dir().unwrap_or_default().join(".saturn-app"),
            PathBuf::from,
        );
        let file = folder.join("runtime-token");
        let token = match std::env::var("SATURN_RUNTIME_TOKEN") {
            Ok(token) => token,
            Err(_) => std::fs::read_to_string(&file)
                .map(|text| text.trim().to_owned())
                .map_err(|_| CliError {
                    message: format!(
                        "Saturn has not run on this computer yet (no {}). Open Saturn first.",
                        file.display()
                    ),
                    code: UNREACHABLE,
                })?,
        };
        let http = reqwest::Client::builder()
            .no_proxy()
            .build()
            .map_err(|error| failed(error.to_string()))?;
        Ok(Self {
            base: format!("http://127.0.0.1:{port}"),
            token,
            http,
        })
    }

    /// One request; a refusal becomes what the runtime said. This program is not the runtime, and its requests are not on
    /// the runtime's record of what it sends.
    #[allow(clippy::disallowed_methods)]
    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Response, CliError> {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.base))
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {}", self.token));
        if let Some(body) = body {
            request = request.body(body.to_string());
        }
        let response = request.send().await.map_err(|_| CliError {
            message: format!(
                "Saturn is not running (nothing answers on {}). Open Saturn and try again.",
                self.base
            ),
            code: UNREACHABLE,
        })?;
        if response.status().is_success() {
            return Ok(response);
        }
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        let said = serde_json::from_str::<Value>(&text).ok().and_then(|value| {
            value
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
        Err(failed(said.unwrap_or_else(|| {
            if text.is_empty() {
                format!("Saturn returned {status}")
            } else {
                text
            }
        })))
    }

    async fn get(&self, path: &str) -> Result<Value, CliError> {
        let response = self.send(Method::GET, path, None).await?;
        response
            .json()
            .await
            .map_err(|error| failed(error.to_string()))
    }

    async fn post(&self, path: &str, body: Value) -> Result<Value, CliError> {
        let response = self.send(Method::POST, path, Some(body)).await?;
        let text = response
            .text()
            .await
            .map_err(|error| failed(error.to_string()))?;
        Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    /// Follows a run's event stream, calling `on_run` with each new state, until it settles or waits for approval.
    async fn follow(
        &self,
        run_id: &str,
        mut on_run: impl FnMut(&Value),
    ) -> Result<Value, CliError> {
        let mut response = self
            .send(
                Method::GET,
                &format!("/runs/{}/events", encoded(run_id)),
                None,
            )
            .await?;
        let mut buffer: Vec<u8> = Vec::new();
        let mut latest = None;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| failed(error.to_string()))?
        {
            buffer.extend_from_slice(&chunk);
            while let Some(end) = buffer.windows(2).position(|pair| pair == b"\n\n") {
                let block: Vec<u8> = buffer.drain(..end + 2).collect();
                let block = String::from_utf8_lossy(&block);
                if !block.lines().any(|line| line == "event: run") {
                    continue;
                }
                let Some(data) = block.lines().find_map(|line| line.strip_prefix("data: ")) else {
                    continue;
                };
                let Ok(run) = serde_json::from_str::<Value>(data) else {
                    continue;
                };
                on_run(&run);
                let status = run["status"].as_str().unwrap_or_default();
                if status != "running" && status != "queued" {
                    return Ok(run);
                }
                latest = Some(run);
            }
        }
        latest.ok_or_else(|| failed("The run's stream ended before it said anything"))
    }
}

/// One line for a step, the way the apps say it.
fn describe_action(action: &Value) -> String {
    let arguments = &action["arguments"];
    let target = ["command", "path", "url", "task"]
        .iter()
        .find_map(|name| arguments[*name].as_str())
        .unwrap_or_default();
    let status = action["status"].as_str().unwrap_or_default();
    let state = if status == "completed" {
        String::new()
    } else {
        let reason = action["reason"]
            .as_str()
            .filter(|reason| !reason.is_empty())
            .map_or_else(String::new, |reason| format!(": {reason}"));
        format!(" ({status}{reason})")
    };
    let spaced = if target.is_empty() {
        String::new()
    } else {
        format!(" {target}")
    };
    format!(
        "{}{spaced}{state}",
        action["toolId"].as_str().unwrap_or_default()
    )
}

/// A path made absolute and with `.` and `..` worked out, by its spelling.
fn resolved(path: &str) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| Path::new(path).to_path_buf());
    let mut plain = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                plain.pop();
            }
            other => plain.push(other.as_os_str()),
        }
    }
    plain
}

fn names(agents: &[Value]) -> String {
    agents
        .iter()
        .filter_map(|agent| agent["name"].as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

async fn pick_agent(client: &Client, wanted: Option<&str>) -> Result<Value, CliError> {
    let agents = client.get("/agents").await?;
    let agents = agents.as_array().map_or(&[][..], Vec::as_slice);
    if agents.is_empty() {
        return Err(failed(
            "There are no agents yet. Create one in Saturn first.",
        ));
    }
    if let Some(wanted) = wanted {
        let lower = wanted.to_lowercase();
        return agents
            .iter()
            .find(|agent| {
                agent["id"] == wanted
                    || agent["name"]
                        .as_str()
                        .is_some_and(|name| name.to_lowercase() == lower)
            })
            .cloned()
            .ok_or_else(|| {
                misuse(format!(
                    "No agent named \"{wanted}\". Agents: {}",
                    names(agents)
                ))
            });
    }
    if let [only] = agents {
        return Ok(only.clone());
    }
    Err(misuse(format!(
        "Name the agent with --agent. Agents: {}",
        names(agents)
    )))
}

async fn pick_project(client: &Client, wanted: Option<&str>) -> Result<Option<Value>, CliError> {
    let Some(wanted) = wanted else {
        return Ok(None);
    };
    let projects = client.get("/projects").await?;
    let full = resolved(wanted);
    let project = projects
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .find(|item| {
            item["id"] == wanted
                || item["path"]
                    .as_str()
                    .is_some_and(|path| resolved(path) == full)
        })
        .ok_or_else(|| {
            misuse(format!(
                "{wanted} is not a Saturn project. Add the folder in Saturn and allow access first."
            ))
        })?;
    if project["access"].is_null() {
        return Err(misuse(format!(
            "Saturn does not have access to {} yet. Allow it in Saturn first.",
            project["path"].as_str().unwrap_or_default()
        )));
    }
    Ok(Some(project.clone()))
}

/// Asks on the terminal; true for yes.
fn ask(question: &str) -> bool {
    eprint!("{question}");
    let _ = std::io::stderr().flush();
    let mut answer = String::new();
    let _ = std::io::stdin().read_line(&mut answer);
    matches!(answer.trim().to_lowercase().as_str(), "y" | "yes")
}

async fn run(client: &Client, arguments: &Arguments) -> Result<i32, CliError> {
    let json_out = arguments.on("json");
    let mut prompt = arguments.positional.join(" ");
    if prompt == "-" {
        prompt.clear();
        std::io::stdin()
            .read_to_string(&mut prompt)
            .map_err(|error| failed(error.to_string()))?;
    }
    if prompt.trim().is_empty() {
        return Err(misuse("Give the prompt: saturn run \"what to do\""));
    }
    let interactive =
        std::io::stdin().is_terminal() && std::io::stdout().is_terminal() && !json_out;
    let agent = pick_agent(client, arguments.text("agent")).await?;
    let agent_name = agent["name"].as_str().unwrap_or_default();
    let models = client.get("/connections/models").await?;
    let model = models.as_array().and_then(|models| {
        models
            .iter()
            .find(|item| item["id"] == agent["modelConnectionId"])
    });
    // The same rule as automations: Anthropic's terms allow automated access to Claude only through an API key.
    if model.is_some_and(|model| model["provider"] == "claude-code") && !interactive {
        return Err(misuse(format!(
            "{agent_name} runs on Claude (via Claude Code), which saturn cannot run unattended: that would be a violation of Anthropic's policy on automated access. Use an agent on an API model, or run it from a terminal."
        )));
    }
    let project = pick_project(client, arguments.text("project")).await?;
    let mode = arguments.text("mode");
    if mode.is_some_and(|mode| !["agent", "ask", "plan"].contains(&mode)) {
        return Err(misuse("--mode is agent, ask or plan"));
    }
    let mut body = json!({ "input": prompt });
    if let Some(chat) = arguments.text("chat") {
        body["threadId"] = json!(chat);
    } else if let Some(project) = &project {
        body["projectId"] = project["id"].clone();
    }
    if let Some(mode) = mode.filter(|mode| *mode != "agent") {
        body["mode"] = json!(mode);
    }
    let started = client
        .post(
            &format!(
                "/agents/{}/runs",
                encoded(agent["id"].as_str().unwrap_or_default())
            ),
            body,
        )
        .await?;
    let id = started["id"].as_str().unwrap_or_default().to_owned();
    if !json_out {
        let chat = started["threadId"]
            .as_str()
            .map_or_else(String::new, |chat| format!(" · chat {chat}"));
        eprintln!("{agent_name} · run {id}{chat}");
    }
    let mut shown = 0;
    loop {
        let current = client
            .follow(&id, |current| {
                if json_out {
                    return;
                }
                for action in current["actions"]
                    .as_array()
                    .map_or(&[][..], Vec::as_slice)
                    .iter()
                    .skip(shown)
                {
                    if action["status"] == "waiting_approval" {
                        break;
                    }
                    eprintln!("  · {}", describe_action(action));
                    shown += 1;
                }
            })
            .await?;
        if current["status"] == "waiting_approval" {
            let actions = current["actions"].as_array().map_or(&[][..], Vec::as_slice);
            let Some(action) = actions
                .iter()
                .find(|item| item["status"] == "waiting_approval")
            else {
                continue;
            };
            let action_id = action["id"].as_str().unwrap_or_default();
            if !interactive {
                if json_out {
                    println!("{current}");
                } else {
                    eprintln!(
                        "Waiting for approval: {}\nAnswer with: saturn approve {id} {action_id}   (or --deny)",
                        describe_action(action)
                    );
                }
                return Ok(WAITING);
            }
            let allow = ask(&format!("Allow {}? [y/N] ", describe_action(action)));
            client
                .post(
                    &format!(
                        "/runs/{}/actions/{}/decision",
                        encoded(&id),
                        encoded(action_id)
                    ),
                    json!({ "allow": allow }),
                )
                .await?;
            continue;
        }
        if json_out {
            println!("{current}");
        } else if let Some(output) = current["output"]
            .as_str()
            .filter(|output| !output.is_empty())
        {
            println!("{output}");
        }
        if current["status"] == "completed" {
            return Ok(OK);
        }
        if !json_out {
            let error = current["error"]
                .as_str()
                .filter(|error| !error.is_empty())
                .map_or_else(String::new, |error| format!(": {error}"));
            eprintln!("{}{error}", current["status"].as_str().unwrap_or_default());
        }
        return Ok(FAILED);
    }
}

/// A value as a line of text shows it.
fn shown(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

async fn command(argv: &[String]) -> Result<i32, CliError> {
    let name = argv.first().map(String::as_str);
    let arguments = Arguments::parse(argv.get(1..).unwrap_or_default());
    let asked_help = matches!(name, Some("help" | "--help" | "-h")) || arguments.on("help");
    if name.is_none() || asked_help {
        println!("{USAGE}");
        return Ok(if name.is_some() { OK } else { USAGE_CODE });
    }
    let client = Client::new()?;
    let first = arguments.positional.first().map(String::as_str);
    let json_out = arguments.on("json");
    match name.unwrap_or_default() {
        "run" => run(&client, &arguments).await,
        "agents" => {
            let agents = client.get("/agents").await?;
            let models = client.get("/connections/models").await?;
            for agent in agents.as_array().map_or(&[][..], Vec::as_slice) {
                let model = models.as_array().and_then(|models| {
                    models
                        .iter()
                        .find(|item| item["id"] == agent["modelConnectionId"])
                });
                println!(
                    "{}\t{}\t{}",
                    shown(&agent["name"]),
                    model.map_or("no model".to_owned(), |model| shown(&model["name"])),
                    shown(&agent["id"])
                );
            }
            Ok(OK)
        }
        "runs" => {
            let limit = arguments
                .text("limit")
                .and_then(|limit| limit.parse::<u32>().ok())
                .filter(|limit| *limit > 0)
                .unwrap_or(20);
            let runs = client.get(&format!("/runs?limit={limit}")).await?;
            if json_out {
                println!("{runs}");
            } else {
                for item in runs.as_array().map_or(&[][..], Vec::as_slice) {
                    println!(
                        "{}\t{}\t{}\t{}\t{}",
                        shown(&item["id"]),
                        shown(&item["status"]),
                        shown(&item["agentName"]),
                        shown(&item["threadTitle"]),
                        shown(&item["input"])
                    );
                }
            }
            Ok(OK)
        }
        "show" => {
            let id = first.ok_or_else(|| misuse("saturn show RUN"))?;
            let current = client.get(&format!("/runs/{}", encoded(id))).await?;
            if json_out {
                println!("{current}");
                return Ok(OK);
            }
            let error = current["error"]
                .as_str()
                .filter(|error| !error.is_empty())
                .map_or_else(String::new, |error| format!(" · {error}"));
            println!(
                "{} · {}{error}",
                shown(&current["id"]),
                shown(&current["status"])
            );
            for action in current["actions"].as_array().map_or(&[][..], Vec::as_slice) {
                let waiting = if action["status"] == "waiting_approval" {
                    format!("   [{}]", shown(&action["id"]))
                } else {
                    String::new()
                };
                println!("  · {}{waiting}", describe_action(action));
            }
            if let Some(output) = current["output"]
                .as_str()
                .filter(|output| !output.is_empty())
            {
                println!("\n{output}");
            }
            Ok(OK)
        }
        "changes" => {
            let id = first.ok_or_else(|| misuse("saturn changes RUN"))?;
            let changes = client
                .get(&format!("/runs/{}/changes", encoded(id)))
                .await?;
            let files = changes["files"].as_array().map_or(&[][..], Vec::as_slice);
            if json_out {
                println!("{changes}");
            } else if files.is_empty() {
                println!("No file changes.");
            } else {
                for file in files {
                    println!(
                        "{}\t+{} -{}\t{}\t{}",
                        shown(&file["status"]),
                        shown(&file["additions"]),
                        shown(&file["deletions"]),
                        shown(&file["review"]),
                        shown(&file["path"])
                    );
                }
            }
            Ok(OK)
        }
        "approve" => {
            let ([id, action, ..],) = (arguments.positional.as_slice(),) else {
                return Err(misuse("saturn approve RUN ACTION [--deny]"));
            };
            let deny = arguments.on("deny");
            client
                .post(
                    &format!("/runs/{}/actions/{}/decision", encoded(id), encoded(action)),
                    json!({ "allow": !deny }),
                )
                .await?;
            println!("{}", if deny { "Denied." } else { "Approved." });
            Ok(OK)
        }
        "stop" => {
            let id = first.ok_or_else(|| misuse("saturn stop RUN"))?;
            let current = client
                .post(&format!("/runs/{}/stop", encoded(id)), json!({}))
                .await?;
            println!("{} · {}", shown(&current["id"]), shown(&current["status"]));
            Ok(OK)
        }
        unknown => Err(misuse(format!("Unknown command \"{unknown}\".\n\n{USAGE}"))),
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let code = command(&argv).await.unwrap_or_else(|error| {
        eprintln!("saturn: {}", error.message);
        error.code
    });
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_and_step_lines() {
        let argv: Vec<String> = [
            "fix",
            "it",
            "--agent",
            "Saturn",
            "--json",
            "--mode=plan",
            "--a=b=c",
            "--",
            "--literal",
        ]
        .iter()
        .map(ToString::to_string)
        .collect();
        let parsed = Arguments::parse(&argv);
        assert_eq!(parsed.positional, ["fix", "it", "--literal"]);
        assert_eq!(parsed.text("agent"), Some("Saturn"));
        assert!(parsed.on("json"));
        assert_eq!(parsed.text("mode"), Some("plan"));
        assert_eq!(parsed.text("a"), Some("b=c"));
        assert_eq!(
            describe_action(
                &json!({ "toolId": "code", "arguments": { "command": "npm test" }, "status": "completed" })
            ),
            "code npm test"
        );
        assert_eq!(
            describe_action(
                &json!({ "toolId": "files", "arguments": { "path": "x.ts" }, "status": "denied", "reason": "no" })
            ),
            "files x.ts (denied: no)"
        );
        assert_eq!(encoded("a/b c"), "a%2Fb%20c");
    }
}
