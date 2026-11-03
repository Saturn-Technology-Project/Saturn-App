//! Servers reached over the network: Streamable HTTP, the older SSE transport, and plain JSON-RPC POSTs.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use reqwest::{RequestBuilder, Response, StatusCode};
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use url::Url;

use crate::sse::SseParser;
use crate::{
    HANDSHAKE, McpClient, McpError, PROTOCOL_VERSION, Target, initialize_params, locked, result_of,
    secret_key,
};

/// Why Streamable HTTP did not open.
pub(crate) enum OpenFailure {
    /// Trying another transport would not help: the server wants a sign-in or refused the token.
    Final(McpError),
    Other(String),
}

/// Who may read a transport error: the message without the address, which can carry tokens.
fn transport_error(error: &reqwest::Error) -> String {
    let mut message = error.to_string();
    if let Some(url) = error.url() {
        message = message.replace(&format!(" for url ({url})"), "");
    }
    message
}

/// The header this server's credential goes in.
fn bearer(client: &McpClient, target: &Target) -> Option<String> {
    let token = match target.auth.as_str() {
        "token" => client.store.secret(&secret_key(&target.id, "token")),
        "oauth" => client.saved_access_token(&target.id),
        _ => None,
    };
    token.map(|token| format!("Bearer {token}"))
}

fn with_bearer(request: RequestBuilder, client: &McpClient, target: &Target) -> RequestBuilder {
    match bearer(client, target) {
        Some(value) => request.header("authorization", value),
        None => request,
    }
}

/// What an unauthorized answer means for this server.
async fn unauthorized(client: &McpClient, target: &Target, response: &Response) -> McpError {
    if target.auth == "oauth" {
        return client
            .begin_sign_in(
                target,
                response
                    .headers()
                    .get("www-authenticate")
                    .and_then(|value| value.to_str().ok()),
            )
            .await;
    }
    McpError::failed(if target.auth == "token" {
        "The server refused the token"
    } else {
        "The server requires sign-in"
    })
}

/// A Streamable HTTP session.
pub(crate) struct HttpSession {
    url: String,
    session_id: Option<String>,
    protocol: String,
    next_id: AtomicU64,
}

impl HttpSession {
    /// The handshake. `Ok(None)` is a server that answered `initialize` with plain JSON-RPC (no protocol version).
    pub(crate) async fn open(
        client: &McpClient,
        target: &Target,
    ) -> Result<Option<Self>, OpenFailure> {
        let mut session = Self {
            url: target.url.clone(),
            session_id: None,
            protocol: PROTOCOL_VERSION.to_owned(),
            next_id: AtomicU64::new(1),
        };
        let body = json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": initialize_params() });
        let response =
            tokio::time::timeout(HANDSHAKE, session.post_refreshing(client, target, &body))
                .await
                .map_err(|_| OpenFailure::Other("the handshake timed out".to_owned()))?
                .map_err(|error| match error {
                    PostFailure::Mcp(error) => OpenFailure::Final(error),
                    PostFailure::Transport(reason) => OpenFailure::Other(reason),
                })?;
        if !response.status().is_success() {
            return Err(OpenFailure::Other(format!(
                "it answered {}",
                response.status().as_u16()
            )));
        }
        session.session_id = response
            .headers()
            .get("mcp-session-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let answer = tokio::time::timeout(HANDSHAKE, read_answer(response, 0))
            .await
            .map_err(|_| OpenFailure::Other("the handshake timed out".to_owned()))?
            .map_err(OpenFailure::Other)?;
        let Some(result) = answer.get("result") else {
            return Err(OpenFailure::Other(
                "it answered initialize with no result".to_owned(),
            ));
        };
        let Some(protocol) = result.get("protocolVersion").and_then(Value::as_str) else {
            return Ok(None);
        };
        session.protocol = protocol.to_owned();
        // Fails nothing by itself: a server that wanted it says so on the next request.
        let notice = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        let _ = session.post_refreshing(client, target, &notice).await;
        Ok(Some(session))
    }

    fn build(&self, client: &McpClient, target: &Target, body: &Value) -> RequestBuilder {
        let mut request = client
            .http
            .post(&self.url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .body(body.to_string());
        if body.get("method").and_then(Value::as_str) != Some("initialize") {
            request = request.header("mcp-protocol-version", &self.protocol);
        }
        if let Some(id) = &self.session_id {
            request = request.header("mcp-session-id", id);
        }
        with_bearer(request, client, target)
    }

    /// Sends one message, refreshing a sign-in that expired once.
    async fn post_refreshing(
        &self,
        client: &McpClient,
        target: &Target,
        body: &Value,
    ) -> Result<Response, PostFailure> {
        let send = |request: RequestBuilder| async move {
            request
                .send()
                .await
                .map_err(|error| PostFailure::Transport(transport_error(&error)))
        };
        let response = send(self.build(client, target, body)).await?;
        if response.status() != StatusCode::UNAUTHORIZED {
            return Ok(response);
        }
        if target.auth == "oauth" && client.refresh_tokens(target).await {
            let again = send(self.build(client, target, body)).await?;
            if again.status() != StatusCode::UNAUTHORIZED {
                return Ok(again);
            }
            return Err(PostFailure::Mcp(unauthorized(client, target, &again).await));
        }
        Err(PostFailure::Mcp(
            unauthorized(client, target, &response).await,
        ))
    }

    pub(crate) async fn request(
        &self,
        client: &McpClient,
        target: &Target,
        method: &str,
        params: Value,
    ) -> Result<Value, McpError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let response = self
            .post_refreshing(client, target, &body)
            .await
            .map_err(|error| match error {
                PostFailure::Mcp(error) => error,
                PostFailure::Transport(reason) => McpError::failed(reason),
            })?;
        if !response.status().is_success() {
            return Err(McpError::failed(format!(
                "The MCP server answered {}",
                response.status().as_u16()
            )));
        }
        result_of(read_answer(response, id).await.map_err(McpError::Failed)?)
    }
}

/// Why a POST did not get through.
enum PostFailure {
    Mcp(McpError),
    Transport(String),
}

/// The answer to request `id`, from a JSON body or an event stream.
async fn read_answer(mut response: Response, id: u64) -> Result<Value, String> {
    let kind = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    if !kind.contains("text/event-stream") {
        let text = response
            .text()
            .await
            .map_err(|error| transport_error(&error))?;
        return serde_json::from_str(&text).map_err(|_| "it did not answer with JSON".to_owned());
    }
    let mut parser = SseParser::default();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| transport_error(&error))?
    {
        for event in parser.feed(&chunk) {
            if let Ok(message) = serde_json::from_str::<Value>(&event.data)
                && message.get("id").and_then(Value::as_u64) == Some(id)
                && message.get("method").is_none()
            {
                return Ok(message);
            }
        }
    }
    Err("the stream ended before the answer".to_owned())
}

/// Answers waiting on an open stream, by request id.
pub(crate) type Waiting = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

/// The older SSE transport: a stream for answers, and an address to POST to that the stream names.
pub(crate) struct SseSession {
    endpoint: Url,
    authorization: Option<String>,
    waiting: Waiting,
    next_id: AtomicU64,
    reader: JoinHandle<()>,
}

impl Drop for SseSession {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

impl SseSession {
    pub(crate) async fn open(client: &McpClient, target: &Target) -> Result<Self, String> {
        tokio::time::timeout(HANDSHAKE, Self::handshake(client, target))
            .await
            .map_err(|_| "the handshake timed out".to_owned())?
    }

    async fn handshake(client: &McpClient, target: &Target) -> Result<Self, String> {
        let base = Url::parse(&target.url).map_err(|error| error.to_string())?;
        let request = with_bearer(
            client
                .http
                .get(base.clone())
                .header("accept", "text/event-stream"),
            client,
            target,
        );
        let mut response = request
            .send()
            .await
            .map_err(|error| transport_error(&error))?;
        if !response.status().is_success() {
            return Err(format!("it answered {}", response.status().as_u16()));
        }
        let mut parser = SseParser::default();
        let mut endpoint = None;
        let mut early = Vec::new();
        while endpoint.is_none() {
            let chunk = response
                .chunk()
                .await
                .map_err(|error| transport_error(&error))?
                .ok_or("the stream ended before naming an address")?;
            for event in parser.feed(&chunk) {
                if event.name == "endpoint" && endpoint.is_none() {
                    let joined = base.join(&event.data).map_err(|error| error.to_string())?;
                    // A server names only an address of its own, so the credential never goes elsewhere.
                    if joined.origin() != base.origin() {
                        return Err("it named an address on another host".to_owned());
                    }
                    endpoint = Some(joined);
                } else {
                    early.push(event);
                }
            }
        }
        let waiting: Waiting = Arc::default();
        let routed = Arc::clone(&waiting);
        let reader = tokio::spawn(async move {
            while let Ok(Some(chunk)) = response.chunk().await {
                for event in parser.feed(&chunk) {
                    route(&routed, &event.data);
                }
            }
            // The stream ended: nothing more will be answered.
            locked(&routed).clear();
        });
        let session = Self {
            endpoint: endpoint.ok_or("no address")?,
            authorization: bearer(client, target),
            waiting,
            next_id: AtomicU64::new(1),
            reader,
        };
        session
            .request(client, "initialize", initialize_params())
            .await
            .map_err(|error| error.to_string())?;
        session
            .post(
                client,
                &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            )
            .await
            .map_err(|error| error.to_string())?;
        Ok(session)
    }

    async fn post(&self, client: &McpClient, body: &Value) -> Result<(), McpError> {
        let mut request = client
            .http
            .post(self.endpoint.clone())
            .header("content-type", "application/json")
            .body(body.to_string());
        if let Some(value) = &self.authorization {
            request = request.header("authorization", value);
        }
        let response = request
            .send()
            .await
            .map_err(|error| McpError::Failed(transport_error(&error)))?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(McpError::failed(format!(
                "The MCP server answered {}",
                response.status().as_u16()
            )))
        }
    }

    pub(crate) async fn request(
        &self,
        client: &McpClient,
        method: &str,
        params: Value,
    ) -> Result<Value, McpError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        locked(&self.waiting).insert(id, sender);
        self.post(
            client,
            &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        )
        .await?;
        let answer = receiver
            .await
            .map_err(|_| McpError::failed("The connection to the MCP server closed"))?;
        result_of(answer)
    }
}

/// Hands an answer to whoever waits for it.
pub(crate) fn route(waiting: &Waiting, data: &str) {
    let Ok(message) = serde_json::from_str::<Value>(data) else {
        return;
    };
    if message.get("method").is_some() {
        return;
    }
    if let Some(sender) = message
        .get("id")
        .and_then(Value::as_u64)
        .and_then(|id| locked(waiting).remove(&id))
    {
        let _ = sender.send(message);
    }
}

/// Plain JSON-RPC over POST, for small local servers that do not implement the MCP transports.
pub(crate) async fn send_plain(
    client: &McpClient,
    url: &str,
    method: &str,
    params: Value,
    headers: &[(&str, &str)],
) -> Result<Value, McpError> {
    let mut request = client
        .http
        .post(url)
        .header("content-type", "application/json")
        .body(json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }).to_string());
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = request.send().await.map_err(|error| {
        McpError::failed(format!(
            "Could not reach the MCP server at {}: {}",
            crate::host_of(url),
            transport_error(&error)
        ))
    })?;
    let text = response
        .text()
        .await
        .map_err(|error| McpError::Failed(transport_error(&error)))?;
    let answer = serde_json::from_str(&text)
        .map_err(|_| McpError::failed("The MCP server did not answer with JSON"))?;
    result_of(answer)
}
