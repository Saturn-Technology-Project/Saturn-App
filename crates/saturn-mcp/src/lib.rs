//! An MCP client. It speaks Streamable HTTP, falls back to the older SSE transport and finally to plain JSON-RPC POSTs for
//! simple local servers, and starts local programs over stdio once the user has allowed them. Sessions are reused per server.
//! Stopping a call is dropping its future.
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use saturn_store::FileStore;
use serde_json::{Value, json};
use tokio::sync::OnceCell;

mod local;
mod oauth;
mod remote;
mod sse;

use local::LocalSession;
use oauth::Pending;
use remote::{HttpSession, SseSession};

/// How long a server gets to finish the handshake.
const HANDSHAKE: Duration = Duration::from_secs(15);
/// How long a request may take, as the official SDKs allow by default.
const REQUEST: Duration = Duration::from_secs(60);
/// The newest protocol version this client speaks.
const PROTOCOL_VERSION: &str = "2025-06-18";

/// A local server to start and talk to over stdio, already allowed by the user.
#[derive(Clone, Debug, Default)]
pub struct LocalCommand {
    pub program: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: Option<PathBuf>,
}

/// What the client needs to reach one MCP server.
#[derive(Clone, Debug, Default)]
pub struct Target {
    pub id: String,
    pub url: String,
    /// "oauth": sign in through the browser; "token": a bearer token the user pasted; anything else: an open server.
    pub auth: String,
    pub command: Option<LocalCommand>,
}

/// Why a call did not work.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum McpError {
    /// The server needs the user to sign in; the browser has been sent to this address.
    SignIn(String),
    Failed(String),
}

impl McpError {
    fn failed(message: impl Into<String>) -> Self {
        Self::Failed(message.into())
    }
}

impl std::fmt::Display for McpError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::SignIn(_) => "Sign-in required",
            Self::Failed(message) => message,
        })
    }
}

/// MCP answers with these to steer the run, not because something broke, so the session stays open.
const CONTROL: [&str; 4] = [
    "approval_required",
    "policy_denied",
    "approval_rejected",
    "Agent is not allowed to call this tool",
];

/// An open connection to a server.
enum Session {
    Http(HttpSession),
    Sse(SseSession),
    Local(LocalSession),
    /// A small server that takes plain JSON-RPC POSTs and nothing of MCP's transports.
    Plain,
}

/// A JSON-RPC answer's result, or the failure it reports.
fn result_of(answer: Value) -> Result<Value, McpError> {
    if let Some(error) = answer.get("error").filter(|error| !error.is_null()) {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty());
        return Err(McpError::failed(message.unwrap_or("MCP call failed")));
    }
    Ok(answer.get("result").cloned().unwrap_or_else(|| json!({})))
}

/// What the client says to a new server.
fn initialize_params() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": { "name": "saturn", "version": "0.1.0" },
    })
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Host only: the rest of a URL can carry tokens.
pub(crate) fn host_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|parsed| {
            let host = parsed.host_str()?.to_owned();
            Some(
                parsed
                    .port()
                    .map_or(host.clone(), |port| format!("{host}:{port}")),
            )
        })
        .unwrap_or_default()
}

/// Opens the sign-in page in the user's browser.
pub type OpenBrowser = Arc<dyn Fn(&str) + Send + Sync>;

/// An MCP client for all of a runtime's servers.
pub struct McpClient {
    store: Arc<FileStore>,
    redirect_url: String,
    open_browser: OpenBrowser,
    http: reqwest::Client,
    sessions: Mutex<HashMap<String, Arc<OnceCell<Arc<Session>>>>>,
    /// OAuth sign-ins waiting for the browser to come back, by `state`.
    pending: Mutex<HashMap<String, Pending>>,
}

impl McpClient {
    /// `redirect_url` is where providers send the browser back after sign-in.
    pub fn new(
        store: Arc<FileStore>,
        redirect_url: String,
        open_browser: OpenBrowser,
    ) -> Result<Self, McpError> {
        let http = reqwest::Client::builder()
            .no_proxy()
            .build()
            .map_err(|error| McpError::failed(error.without_url().to_string()))?;
        Ok(Self {
            store,
            redirect_url,
            open_browser,
            http,
            sessions: Mutex::default(),
            pending: Mutex::default(),
        })
    }

    /// The tools a server has, as saved routes.
    pub async fn list_tools(&self, target: &Target) -> Result<Vec<Value>, McpError> {
        let payload = self.rpc(target, "tools/list", json!({}), &[]).await?;
        Ok(payload
            .get("tools")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|tool| {
                let name = tool.get("name")?.as_str()?;
                let schema = tool.get("inputSchema").filter(|schema| schema.is_object());
                Some(json!({
                    "toolId": name,
                    "serverId": "",
                    "description": tool.get("description").and_then(Value::as_str).unwrap_or(""),
                    "inputSchema": schema.cloned().unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
                    "environments": ["production"],
                }))
            })
            .collect())
    }

    /// Calls one tool. `headers` go only to servers that take plain JSON-RPC.
    pub async fn call(
        &self,
        target: &Target,
        tool: &str,
        arguments: &Value,
        headers: &[(&str, &str)],
    ) -> Result<Value, McpError> {
        self.rpc(
            target,
            "tools/call",
            json!({ "name": tool, "arguments": arguments }),
            headers,
        )
        .await
    }

    /// Connects, signing in if needed.
    pub async fn connect(&self, target: &Target) -> Result<(), McpError> {
        self.session(target).await.map(|_| ())
    }

    /// Ends a server's session (stopping a local server's process) without touching its credentials.
    pub fn close(&self, id: &str) {
        locked(&self.sessions).remove(id);
    }

    /// Drops the session and every stored credential for a server.
    pub async fn forget(&self, id: &str) -> Result<(), McpError> {
        self.close(id);
        locked(&self.pending).retain(|_, waiting| waiting.target.id != id);
        for part in ["client", "tokens", "verifier", "token"] {
            self.store
                .delete_secret(&secret_key(id, part))
                .await
                .map_err(|error| McpError::failed(error.to_string()))?;
        }
        Ok(())
    }

    /// Saves a bearer token the user pasted.
    pub async fn save_token(&self, id: &str, token: &str) -> Result<(), McpError> {
        self.store
            .put_secret(&secret_key(id, "token"), token.trim())
            .await
            .map_err(|error| McpError::failed(error.to_string()))?;
        self.close(id);
        Ok(())
    }

    /// Registers a client the user created with the provider, for servers that do not allow self-registration.
    pub async fn save_oauth_client(
        &self,
        id: &str,
        client_id: &str,
        client_secret: Option<&str>,
    ) -> Result<(), McpError> {
        let mut info = json!({ "client_id": client_id.trim() });
        if let Some(secret) = client_secret
            .map(str::trim)
            .filter(|secret| !secret.is_empty())
        {
            info["client_secret"] = secret.into();
        }
        self.store
            .put_secret(&secret_key(id, "client"), &info.to_string())
            .await
            .map_err(|error| McpError::failed(error.to_string()))?;
        self.close(id);
        Ok(())
    }

    /// The server's open session, opened now if it has none.
    async fn session(&self, target: &Target) -> Result<Arc<Session>, McpError> {
        let cell = Arc::clone(locked(&self.sessions).entry(target.id.clone()).or_default());
        cell.get_or_try_init(|| async { self.open(target).await.map(Arc::new) })
            .await
            .cloned()
    }

    async fn open(&self, target: &Target) -> Result<Session, McpError> {
        if let Some(command) = &target.command {
            return LocalSession::start(command).await.map(Session::Local);
        }
        match HttpSession::open(self, target).await {
            Ok(Some(session)) => return Ok(Session::Http(session)),
            Ok(None) => return Ok(Session::Plain),
            Err(remote::OpenFailure::Final(error)) => return Err(error),
            Err(remote::OpenFailure::Other(reason)) => {
                eprintln!(
                    "[mcp] {} did not accept Streamable HTTP ({reason}); trying SSE",
                    host_of(&target.url)
                );
            }
        }
        match SseSession::open(self, target).await {
            Ok(session) => Ok(Session::Sse(session)),
            Err(reason) => {
                eprintln!(
                    "[mcp] {} did not accept SSE ({reason}); using plain JSON-RPC",
                    host_of(&target.url)
                );
                Ok(Session::Plain)
            }
        }
    }

    /// One request. A session that broke is reopened on the next call.
    async fn rpc(
        &self,
        target: &Target,
        method: &str,
        params: Value,
        headers: &[(&str, &str)],
    ) -> Result<Value, McpError> {
        let answer = async {
            let session = self.session(target).await?;
            match session.as_ref() {
                Session::Http(http) => {
                    tokio::time::timeout(REQUEST, http.request(self, target, method, params))
                        .await
                        .unwrap_or_else(|_| Err(timed_out(method)))
                }
                Session::Sse(sse) => {
                    tokio::time::timeout(REQUEST, sse.request(self, method, params))
                        .await
                        .unwrap_or_else(|_| Err(timed_out(method)))
                }
                Session::Local(local) => {
                    tokio::time::timeout(REQUEST, local.request(method, params))
                        .await
                        .unwrap_or_else(|_| Err(timed_out(method)))
                }
                Session::Plain => {
                    remote::send_plain(self, &target.url, method, params, headers).await
                }
            }
        }
        .await;
        if let Err(McpError::Failed(message)) = &answer
            && !CONTROL.contains(&message.as_str())
        {
            self.close(&target.id);
        }
        answer
    }
}

fn timed_out(method: &str) -> McpError {
    McpError::failed(format!("The MCP server did not answer {method} in time"))
}

/// Where a server's credential is kept: the encrypted secrets file.
pub(crate) fn secret_key(id: &str, part: &str) -> String {
    format!("mcp:{id}:{part}")
}
