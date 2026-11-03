//! The client against fake servers on a temporary data folder: the older SSE transport and a whole OAuth sign-in.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use saturn_mcp::{McpClient, McpError, OpenBrowser, Target};
use saturn_store::key_store::{KeyStoreName, key_store};
use saturn_store::{FileStore, SecretsFile};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::mpsc;
use tokio_stream_shim::channel_body;

/// Turns a channel into a streaming response body, as a long-lived SSE stream needs.
mod tokio_stream_shim {
    use super::{Body, mpsc};
    pub fn channel_body(mut receiver: mpsc::UnboundedReceiver<String>) -> Body {
        let stream = futures_util::stream::poll_fn(move |context| {
            receiver
                .poll_recv(context)
                .map(|item| item.map(Ok::<_, std::convert::Infallible>))
        });
        Body::from_stream(stream)
    }
}

async fn store() -> (Arc<FileStore>, TempDir) {
    let data = tempfile::tempdir().expect("a folder");
    let root = data.path().to_path_buf();
    let secrets = SecretsFile::with_preferred(
        data.path(),
        Box::new(move || key_store(KeyStoreName::File, &root)),
    );
    (
        Arc::new(
            FileStore::load_with(data.path(), secrets)
                .await
                .expect("a store"),
        ),
        data,
    )
}

async fn listen(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a free port");
    let address = listener.local_addr().expect("an address");
    tokio::spawn(async move { axum::serve(listener, app).await });
    format!("http://{address}")
}

fn answer(message: &Value) -> Value {
    let result = match message["method"].as_str() {
        Some("initialize") => {
            json!({ "protocolVersion": message["params"]["protocolVersion"], "capabilities": {}, "serverInfo": { "name": "fake", "version": "1" } })
        }
        Some("tools/list") => {
            json!({ "tools": [{ "name": "lookup", "description": "d", "inputSchema": { "type": "object" } }, { "description": "no name" }] })
        }
        _ => json!({ "content": [{ "type": "text", "text": "called" }] }),
    };
    json!({ "jsonrpc": "2.0", "id": message["id"], "result": result })
}

#[derive(Clone, Default)]
struct Sse {
    stream: Arc<Mutex<Option<mpsc::UnboundedSender<String>>>>,
    streamable_tries: Arc<Mutex<u32>>,
}

async fn sse_open(State(state): State<Sse>) -> Response {
    let (sender, receiver) = mpsc::unbounded_channel();
    sender
        .send("event: endpoint\ndata: /messages?session=1\n\n".to_owned())
        .expect("open");
    *state.stream.lock().expect("not poisoned") = Some(sender);
    (
        [(header::CONTENT_TYPE, "text/event-stream")],
        channel_body(receiver),
    )
        .into_response()
}

/// The older transport refuses Streamable HTTP's POST.
async fn sse_refuses(State(state): State<Sse>) -> StatusCode {
    *state.streamable_tries.lock().expect("not poisoned") += 1;
    StatusCode::METHOD_NOT_ALLOWED
}

async fn sse_message(State(state): State<Sse>, body: String) -> StatusCode {
    let message: Value = serde_json::from_str(&body).expect("JSON");
    if message.get("id").is_some() {
        let frame = format!("event: message\ndata: {}\n\n", answer(&message));
        if let Some(stream) = state.stream.lock().expect("not poisoned").as_ref() {
            stream.send(frame).expect("open");
        }
    }
    StatusCode::ACCEPTED
}

#[tokio::test]
async fn a_server_on_the_older_sse_transport_works() {
    let state = Sse::default();
    let url = listen(
        Router::new()
            .route("/sse", get(sse_open).post(sse_refuses))
            .route("/messages", post(sse_message))
            .with_state(state.clone()),
    )
    .await;
    let (store, _data) = store().await;
    let client = McpClient::new(
        store,
        "http://127.0.0.1:1/oauth/callback".to_owned(),
        Arc::new(|_: &str| {}),
    )
    .expect("a client");
    let target = Target {
        id: "s".to_owned(),
        url: format!("{url}/sse"),
        auth: "none".to_owned(),
        command: None,
    };
    let tools = client.list_tools(&target).await.expect("tools");
    assert_eq!(tools.len(), 1, "a tool with no name is left out");
    assert_eq!(tools[0]["toolId"], "lookup");
    let called = client
        .call(&target, "lookup", &json!({}), &[])
        .await
        .expect("called");
    assert_eq!(called["content"][0]["text"], "called");
    assert_eq!(
        *state.streamable_tries.lock().expect("not poisoned"),
        1,
        "the session is reused"
    );
}

/// A signed server and its authorization server.
#[derive(Clone, Default)]
struct Auth {
    base: Arc<Mutex<String>>,
    forms: Arc<Mutex<Vec<String>>>,
    registered: Arc<Mutex<Vec<Value>>>,
    valid_token: Arc<Mutex<String>>,
}

async fn signed_server(State(state): State<Auth>, headers: HeaderMap, body: String) -> Response {
    let wanted = format!("Bearer {}", state.valid_token.lock().expect("not poisoned"));
    if headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        != Some(&wanted)
    {
        let base = state.base.lock().expect("not poisoned").clone();
        let challenge = format!(
            "Bearer resource_metadata=\"{base}/.well-known/oauth-protected-resource/mcp\", scope=\"read write\""
        );
        return (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, challenge)],
        )
            .into_response();
    }
    let message: Value = serde_json::from_str(&body).expect("JSON");
    if message.get("id").is_none() {
        return StatusCode::ACCEPTED.into_response();
    }
    (
        [(header::CONTENT_TYPE, "application/json")],
        answer(&message).to_string(),
    )
        .into_response()
}

async fn resource_metadata(State(state): State<Auth>) -> String {
    let base = state.base.lock().expect("not poisoned").clone();
    json!({ "resource": format!("{base}/mcp"), "authorization_servers": [base] }).to_string()
}

async fn server_metadata(State(state): State<Auth>) -> String {
    let base = state.base.lock().expect("not poisoned").clone();
    json!({ "issuer": base, "authorization_endpoint": format!("{base}/authorize"), "token_endpoint": format!("{base}/token"), "registration_endpoint": format!("{base}/register") }).to_string()
}

async fn register(State(state): State<Auth>, body: String) -> (StatusCode, String) {
    state
        .registered
        .lock()
        .expect("not poisoned")
        .push(serde_json::from_str(&body).expect("JSON"));
    (
        StatusCode::CREATED,
        json!({ "client_id": "registered-client" }).to_string(),
    )
}

async fn token(State(state): State<Auth>, body: String) -> String {
    state.forms.lock().expect("not poisoned").push(body.clone());
    let refreshed = body.contains("grant_type=refresh_token");
    let access = if refreshed {
        "second-token"
    } else {
        "first-token"
    };
    *state.valid_token.lock().expect("not poisoned") = access.to_owned();
    if refreshed {
        json!({ "access_token": access }).to_string()
    } else {
        json!({ "access_token": access, "refresh_token": "refresh-value" }).to_string()
    }
}

async fn unused(Query(_): Query<Value>) -> StatusCode {
    StatusCode::NOT_FOUND
}

#[tokio::test]
async fn a_whole_sign_in_registers_uses_pkce_and_refreshes() {
    let state = Auth::default();
    *state.valid_token.lock().expect("not poisoned") = "nothing yet".to_owned();
    let base = listen(
        Router::new()
            .route("/mcp", post(signed_server))
            .route(
                "/.well-known/oauth-protected-resource/mcp",
                get(resource_metadata),
            )
            .route(
                "/.well-known/oauth-authorization-server",
                get(server_metadata),
            )
            .route("/register", post(register))
            .route("/token", post(token))
            .route("/authorize", get(unused))
            .with_state(state.clone()),
    )
    .await;
    *state.base.lock().expect("not poisoned") = base.clone();
    let (store, _data) = store().await;
    let opened = Arc::new(Mutex::new(Vec::new()));
    let recording = Arc::clone(&opened);
    let browser: OpenBrowser = Arc::new(move |address: &str| {
        recording
            .lock()
            .expect("not poisoned")
            .push(address.to_owned())
    });
    let client = McpClient::new(
        Arc::clone(&store),
        "http://127.0.0.1:4791/oauth/callback".to_owned(),
        browser,
    )
    .expect("a client");
    let target = Target {
        id: "signed".to_owned(),
        url: format!("{base}/mcp"),
        auth: "oauth".to_owned(),
        command: None,
    };

    let Err(McpError::SignIn(address)) = client.connect(&target).await else {
        panic!("a sign-in was needed");
    };
    assert_eq!(
        opened.lock().expect("not poisoned").as_slice(),
        std::slice::from_ref(&address),
        "the browser went there"
    );
    let page = url::Url::parse(&address).expect("an address");
    let query: std::collections::HashMap<String, String> =
        page.query_pairs().into_owned().collect();
    assert!(address.starts_with(&format!("{base}/authorize?")));
    assert_eq!(query["client_id"], "registered-client");
    assert_eq!(query["code_challenge_method"], "S256");
    assert_eq!(query["scope"], "read write");
    assert_eq!(query["resource"], format!("{base}/mcp"));
    assert_eq!(
        state.registered.lock().expect("not poisoned")[0]["redirect_uris"][0],
        "http://127.0.0.1:4791/oauth/callback"
    );

    assert!(
        client
            .finish_sign_in("not-the-state", "code")
            .await
            .is_err(),
        "a state Saturn did not start"
    );
    let finished = client
        .finish_sign_in(&query["state"], "the-code")
        .await
        .expect("signed in");
    assert_eq!(finished.id, "signed");
    let form = state.forms.lock().expect("not poisoned")[0].clone();
    assert!(
        form.contains("grant_type=authorization_code")
            && form.contains("code=the-code")
            && form.contains("code_verifier="),
        "{form}"
    );
    assert!(
        client
            .finish_sign_in(&query["state"], "the-code")
            .await
            .is_err(),
        "only once"
    );
    assert_eq!(
        client.list_tools(&target).await.expect("tools")[0]["toolId"],
        "lookup"
    );

    // The token expires: the refresh token gets another without asking the user.
    *state.valid_token.lock().expect("not poisoned") = "expired".to_owned();
    client.close(&target.id);
    tokio::time::sleep(Duration::from_millis(1)).await;
    assert_eq!(
        client
            .list_tools(&target)
            .await
            .expect("tools after a refresh")[0]["toolId"],
        "lookup"
    );
    assert!(state.forms.lock().expect("not poisoned")[1].contains("refresh_token=refresh-value"));
    let saved: Value =
        serde_json::from_str(&store.secret("mcp:signed:tokens").expect("saved")).expect("JSON");
    assert_eq!(saved["access_token"], "second-token");
    assert_eq!(
        saved["refresh_token"], "refresh-value",
        "a refresh with no new one keeps the old"
    );

    client.forget(&target.id).await.expect("forgotten");
    assert!(store.secret("mcp:signed:tokens").is_none());
    assert!(store.secret("mcp:signed:client").is_none());
}

#[tokio::test]
async fn a_sign_in_page_that_is_not_a_web_address_is_never_opened() {
    let state = Auth::default();
    async fn bad_metadata() -> String {
        json!({ "authorization_endpoint": "file:///etc/passwd", "token_endpoint": "https://x.example/token" }).to_string()
    }
    let base = listen(
        Router::new()
            .route("/mcp", post(signed_server))
            .route("/.well-known/oauth-authorization-server", get(bad_metadata))
            .route("/.well-known/oauth-protected-resource", get(unused))
            .with_state(state.clone()),
    )
    .await;
    *state.base.lock().expect("not poisoned") = base.clone();
    *state.valid_token.lock().expect("not poisoned") = "nothing".to_owned();
    let (store, _data) = store().await;
    let opened = Arc::new(Mutex::new(0));
    let counting = Arc::clone(&opened);
    let browser: OpenBrowser =
        Arc::new(move |_: &str| *counting.lock().expect("not poisoned") += 1);
    let client =
        McpClient::new(store, "http://127.0.0.1:1/cb".to_owned(), browser).expect("a client");
    let target = Target {
        id: "bad".to_owned(),
        url: format!("{base}/mcp"),
        auth: "oauth".to_owned(),
        command: None,
    };
    let error = client.connect(&target).await.expect_err("refused");
    assert!(
        matches!(&error, McpError::Failed(message) if message.contains("must use https")),
        "{error}"
    );
    assert_eq!(*opened.lock().expect("not poisoned"), 0);
}
