//! A local server: a program this client starts and speaks MCP with over its stdin and stdout. Its stderr is kept (the last few
//! KB) so a server that fails to start says why. The process ends when the session is closed or the runtime exits.
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex as AsyncMutex, oneshot};
use tokio::task::JoinHandle;

use crate::remote::{Waiting, route};
use crate::{HANDSHAKE, LocalCommand, McpError, initialize_params, locked, result_of};

/// Bytes of a server's stderr that are kept.
const STDERR_LIMIT: usize = 4000;
/// Of the runtime's own variables, the only ones a local server gets, so API keys in its environment never reach it.
#[cfg(unix)]
const INHERITED: [&str; 6] = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];
#[cfg(windows)]
const INHERITED: [&str; 13] = [
    "APPDATA",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "PATH",
    "PROCESSOR_ARCHITECTURE",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "USERNAME",
    "USERPROFILE",
    "PROGRAMFILES",
    "COMSPEC",
];

pub(crate) struct LocalSession {
    stdin: Arc<AsyncMutex<ChildStdin>>,
    waiting: Waiting,
    next_id: AtomicU64,
    reader: JoinHandle<()>,
    errors: JoinHandle<()>,
    // Ends the process when the session goes.
    _child: Child,
}

impl Drop for LocalSession {
    fn drop(&mut self) {
        self.reader.abort();
        self.errors.abort();
    }
}

impl LocalSession {
    pub(crate) async fn start(command: &LocalCommand) -> Result<Self, McpError> {
        // A missing working folder fails the start with a misleading message about the program itself.
        if let Some(cwd) = &command.cwd {
            tokio::fs::create_dir_all(cwd)
                .await
                .map_err(|error| McpError::failed(error.to_string()))?;
        }
        let mut prepared = Command::new(&command.program);
        prepared
            .args(&command.args)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for name in INHERITED {
            if let Some(value) = std::env::var_os(name) {
                prepared.env(name, value);
            }
        }
        prepared.envs(&command.env);
        if let Some(cwd) = &command.cwd {
            prepared.current_dir(cwd);
        }
        let failed = |reason: &str, stderr: &str| {
            let detail = stderr
                .trim()
                .lines()
                .rev()
                .take(6)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n");
            let more = if detail.is_empty() {
                String::new()
            } else {
                format!("\n{detail}")
            };
            McpError::failed(format!(
                "Could not start {}: {reason}{more}",
                command.program
            ))
        };
        let mut child = prepared
            .spawn()
            .map_err(|error| failed(&error.to_string(), ""))?;
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            return Err(failed("its pipes did not open", ""));
        };
        let kept = Arc::new(Mutex::new(Vec::new()));
        let written = Arc::clone(&kept);
        let errors = tokio::spawn(async move {
            let mut stderr = stderr;
            let mut chunk = [0_u8; 1024];
            while let Ok(read) = stderr.read(&mut chunk).await {
                if read == 0 {
                    break;
                }
                let mut bytes = locked(&written);
                bytes.extend_from_slice(&chunk[..read]);
                let extra = bytes.len().saturating_sub(STDERR_LIMIT);
                bytes.drain(..extra);
            }
        });
        let waiting: Waiting = Arc::default();
        let routed = Arc::clone(&waiting);
        let stdin = Arc::new(AsyncMutex::new(stdin));
        let answering = Arc::clone(&stdin);
        let reader = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                match serde_json::from_str::<Value>(&line) {
                    Ok(message)
                        if message.get("method").is_some() && message.get("id").is_some() =>
                    {
                        let _ = write_line(&answering, &answer_to(&message)).await;
                    }
                    _ => route(&routed, &line),
                }
            }
            // The program ended: nothing more will be answered.
            locked(&routed).clear();
        });
        let session = Self {
            stdin,
            waiting,
            next_id: AtomicU64::new(1),
            reader,
            errors,
            _child: child,
        };
        let starting = async {
            session.request("initialize", initialize_params()).await?;
            session
                .send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
                .await
        };
        // A package runner may download the server first.
        let outcome = tokio::time::timeout(HANDSHAKE * 4, starting).await;
        let reason = match outcome {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(error.to_string()),
            Err(_) => Some("it did not finish the handshake in time".to_owned()),
        };
        if let Some(reason) = reason {
            // Lets what it just wrote arrive.
            tokio::time::sleep(Duration::from_millis(50)).await;
            let stderr = String::from_utf8_lossy(&locked(&kept)).into_owned();
            return Err(failed(&reason, &stderr));
        }
        Ok(session)
    }

    async fn send(&self, message: &Value) -> Result<(), McpError> {
        write_line(&self.stdin, message).await
    }

    pub(crate) async fn request(&self, method: &str, params: Value) -> Result<Value, McpError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        locked(&self.waiting).insert(id, sender);
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await?;
        let answer = receiver
            .await
            .map_err(|_| McpError::failed("The MCP server stopped"))?;
        result_of(answer)
    }
}

/// One message to the program.
async fn write_line(stdin: &AsyncMutex<ChildStdin>, message: &Value) -> Result<(), McpError> {
    let mut line = message.to_string();
    line.push('\n');
    let mut stdin = stdin.lock().await;
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|error| McpError::failed(format!("The MCP server closed its input: {error}")))?;
    stdin
        .flush()
        .await
        .map_err(|error| McpError::failed(error.to_string()))
}

/// The answer to a server's own request: `ping` is answered, anything else is not something this client offers.
fn answer_to(request: &Value) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    if request.get("method").and_then(Value::as_str) == Some("ping") {
        json!({ "jsonrpc": "2.0", "id": id, "result": {} })
    } else {
        json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Method not found" } })
    }
}
