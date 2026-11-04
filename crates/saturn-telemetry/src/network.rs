//! A record of every HTTP(S) request the runtime sends. Rust has no global place to watch them from, so every request goes
//! through `send_noted` and a clippy rule (clippy.toml) refuses a plain `send`. Query strings are dropped, since some APIs put
//! keys there; bodies are never read. Kept in memory for the Telemetry page and appended to `<data>/network.log` (JSON lines)
//! for `tail -f`. Programs the runtime starts (Claude Code, Codex, git) are separate processes and are not in it.
use std::collections::VecDeque;
use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use reqwest::header::HeaderValue;
use reqwest::redirect::{Attempt, Policy};
use reqwest::{ClientBuilder, RequestBuilder, Response};
use saturn_domain::time::{iso_time, now_millis};
use serde_json::{Value, json};
use url::Url;

use crate::locked;
use crate::span::{Kind, Span};

const RECENT: usize = 500;
const FILE_LIMIT: u64 = 5 * 1024 * 1024;
/// Redirects followed before giving up, reqwest's own limit.
const MOST_REDIRECTS: usize = 10;

#[derive(Default)]
struct Log {
    recent: VecDeque<Value>,
    hosts: Vec<Value>,
    file: Option<PathBuf>,
}

static LOG: LazyLock<Mutex<Log>> = LazyLock::new(Mutex::default);
static STARTED: LazyLock<String> = LazyLock::new(|| iso_time(now_millis()));

/// Starts keeping the record on disk, in `directory`.
pub fn start(directory: &Path) {
    LazyLock::force(&STARTED);
    locked(&LOG).file = Some(directory.join("network.log"));
}

/// Appends a line, moving a full file aside first. The file is for this user alone.
fn persist(file: &Path, entry: &Value) {
    if std::fs::metadata(file).is_ok_and(|info| info.len() > FILE_LIMIT) {
        let _ = std::fs::rename(file, file.with_extension("log.1"));
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(mut opened) = options.open(file) {
        let _ = writeln!(opened, "{entry}");
    }
}

/// Records one request.
pub fn note(method: &str, url: &Url) {
    let hostname = url.host_str().unwrap_or_default();
    let bare = hostname.trim_start_matches('[').trim_end_matches(']');
    let local = matches!(bare, "127.0.0.1" | "localhost" | "::1");
    let host = url
        .port()
        .map_or_else(|| hostname.to_owned(), |port| format!("{hostname}:{port}"));
    let at = iso_time(now_millis());
    let method = method.to_uppercase();
    let entry =
        json!({ "at": at, "method": method, "host": host, "path": url.path(), "local": local });
    let mut log = locked(&LOG);
    log.recent.push_back(entry.clone());
    if log.recent.len() > RECENT {
        log.recent.pop_front();
    }
    match log.hosts.iter_mut().find(|known| known["host"] == host.as_str()) {
        Some(known) => {
            known["requests"] = json!(known["requests"].as_u64().unwrap_or(0) + 1);
            known["last"] = json!(at);
            if let Some(methods) = known["methods"].as_array_mut()
                && !methods.iter().any(|seen| *seen == method.as_str())
            {
                methods.push(json!(method));
            }
        }
        None => log.hosts.push(json!({ "host": host, "local": local, "requests": 1, "first": at, "last": at, "methods": [method] })),
    }
    if let Some(file) = log.file.clone() {
        persist(&file, &entry);
    }
}

/// Hosts by most recent use, and the latest requests, newest first.
pub fn view(limit: usize) -> Value {
    let log = locked(&LOG);
    let mut hosts = log.hosts.clone();
    hosts.sort_by(|a, b| b["last"].as_str().cmp(&a["last"].as_str()));
    let recent: Vec<&Value> = log.recent.iter().rev().take(limit).collect();
    json!({
        "since": *STARTED,
        "hosts": hosts,
        "recent": recent,
        "file": log.file.as_ref().map(|file| file.to_string_lossy().into_owned()),
    })
}

/// Follows redirects as reqwest would, recording each hop, since they are requests too. A redirect that changes the method
/// does so to GET, which is what most are; the record says GET for all of them.
fn noting_redirects(attempt: Attempt<'_>) -> reqwest::redirect::Action {
    if attempt.previous().len() >= MOST_REDIRECTS {
        return attempt.error("too many redirects");
    }
    note("GET", attempt.url());
    attempt.follow()
}

/// A client whose followed redirects are on the record too. Every client starts here; one that sets its own policy records
/// its own hops by sending each one.
pub fn client_builder() -> ClientBuilder {
    reqwest::Client::builder().redirect(Policy::custom(noting_redirects))
}

/// Sending a request so that it is on the record.
pub trait SendNoted {
    /// Sends it, as a client span of the active trace that the server is told about.
    fn send_noted(self) -> impl Future<Output = reqwest::Result<Response>> + Send;
}

impl SendNoted for RequestBuilder {
    async fn send_noted(self) -> reqwest::Result<Response> {
        let (client, request) = self.build_split();
        let mut request = request?;
        note(request.method().as_str(), request.url());
        let span = Span::start(
            request.method().as_str().to_owned(),
            Kind::Client,
            json!({
                "http.request.method": request.method().as_str(),
                "server.address": request.url().host_str().unwrap_or_default(),
                "server.port": request.url().port_or_known_default(),
            }),
        );
        if let Some(context) = span.context()
            && let Ok(value) = HeaderValue::from_str(&context.traceparent())
        {
            request.headers_mut().insert("traceparent", value);
        }
        #[allow(clippy::disallowed_methods)]
        let answer = client.execute(request).await;
        match &answer {
            Ok(response) => {
                let status = response.status().as_u16();
                span.set("http.response.status_code", status);
                if status >= 400 {
                    span.error_status();
                }
            }
            Err(_) => span.fail("The request failed", "request_failed"),
        }
        answer
    }
}

/// The same for what must not make a span: the requests that send spans away.
pub(crate) async fn send_without_span(builder: RequestBuilder) -> reqwest::Result<Response> {
    let (client, request) = builder.build_split();
    let request = request?;
    note(request.method().as_str(), request.url());
    #[allow(clippy::disallowed_methods)]
    client.execute(request).await
}
