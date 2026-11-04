//! The agent's browser as a window of the user's Safari, driven through Apple's `safaridriver` (WebDriver; Safari has no
//! DevTools protocol). Safari runs it as a separate automation window with a clean state: none of the user's logins, and
//! the user cannot click into it while the agent works. One automation session at a time.
//!
//! Without the DevTools protocol there is no accessibility tree and no screencast, so the snapshot is built by a script in
//! the page (elements marked with `data-saturn-ref`), and the live view and recordings are screenshots.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use saturn_domain::js;
use saturn_domain::skills::public_address::parse_public_address;
use saturn_tools::launch_env;
use saturn_tools::public_host::{SystemLookup, assert_public_host};
use serde_json::{Value, json};
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

use crate::chrome::CURSOR_SCRIPT;
use crate::{Page, Recording, Supervised, Viewers, files, locked, plain_number, scroll_by, settle};

const SAFARIDRIVER: &str = "/usr/bin/safaridriver";
const SNAPSHOT_LIMIT: u64 = 400;
/// How often the live view and a recording take a screenshot.
const FRAME_MS: u64 = 700;
/// How long each frame of a recording shows, in seconds.
const FRAME_SECONDS: &str = "0.7";
/// WebDriver's element key in responses.
const ELEMENT: &str = "element-6066-11e4-a52f-4a8f-b8c4-f3bc2b7a1b40";
/// Builds the snapshot in the page: "[id] role name=… value=…", one line per meaningful element, ids kept on the elements.
const SNAPSHOT_SCRIPT: &str = include_str!("snapshot.js");
const SAFARI_SETUP: &str = "Safari needs remote automation turned on, once: in Safari open Settings → Advanced and tick \"Show features for web developers\", then Develop → Allow Remote Automation (or run `safaridriver --enable` in Terminal). Then try again.";
const ELEMENT_CENTER: &str = "const el = arguments[0]; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };";
const EVALUATE: &str = "const done = arguments[arguments.length - 1]; try { Promise.resolve((0, eval)(arguments[0])).then((value) => { try { done({ ok: JSON.parse(JSON.stringify(value === undefined ? null : value)) }); } catch { done({ ok: String(value) }); } }, (error) => done({ error: String(error && error.stack || error) })); } catch (error) { done({ error: String(error && error.stack || error) }); }";

/// WebDriver's code for a key with a name.
fn key_code(name: &str) -> Option<&'static str> {
    Some(match name {
        "enter" | "return" => "\u{e007}",
        "tab" => "\u{e004}",
        "escape" | "esc" => "\u{e00c}",
        "backspace" => "\u{e003}",
        "delete" => "\u{e017}",
        "space" => " ",
        "arrowup" => "\u{e013}",
        "arrowdown" => "\u{e015}",
        "arrowleft" => "\u{e012}",
        "arrowright" => "\u{e014}",
        "pageup" => "\u{e00e}",
        "pagedown" => "\u{e00f}",
        "home" => "\u{e011}",
        "end" => "\u{e010}",
        _ => return None,
    })
}

/// WebDriver's code for a key held down.
fn modifier_code(name: &str) -> Option<&'static str> {
    Some(match name {
        "shift" => "\u{e008}",
        "ctrl" | "control" => "\u{e009}",
        "alt" | "option" => "\u{e00a}",
        "meta" | "cmd" | "command" => "\u{e03d}",
        _ => return None,
    })
}

#[derive(Default)]
struct State {
    base: String,
    session: Option<String>,
    driver: Option<Supervised>,
    page: Page,
    recording: Option<Recording>,
    ticker: Option<JoinHandle<()>>,
}

/// The agent's Safari window.
pub(crate) struct Safari {
    data_dir: PathBuf,
    viewers: Arc<Viewers>,
    endpoint: Option<String>,
    http: reqwest::Client,
    state: Arc<Mutex<State>>,
    /// One WebDriver command at a time: screenshots for the live view interleave with the agent's commands.
    queue: Arc<AsyncMutex<()>>,
}

/// What a tick and a tool share to send a command.
#[derive(Clone)]
struct Driver {
    http: reqwest::Client,
    state: Arc<Mutex<State>>,
    queue: Arc<AsyncMutex<()>>,
    viewers: Arc<Viewers>,
}

impl Driver {
    /// One command in the session.
    async fn call(
        &self,
        method: reqwest::Method,
        route: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
        let _turn = self.queue.lock().await;
        let address = {
            let state = locked(&self.state);
            format!(
                "{}/session/{}{route}",
                state.base,
                state.session.as_deref().unwrap_or_default()
            )
        };
        let mut request = self
            .http
            .request(method, address)
            .header("content-type", "application/json");
        if let Some(body) = body {
            request = request.body(body.to_string());
        }
        let response = request.send().await.map_err(|error| error.to_string())?;
        let status = response.status();
        let answer: Value = response.json().await.unwrap_or_else(|_| json!({}));
        let value = answer.get("value").cloned().unwrap_or(Value::Null);
        let refusal = value.get("error").filter(|error| js::truthy(Some(error)));
        if !status.is_success() || refusal.is_some() {
            let message = value
                .get("message")
                .filter(|message| js::truthy(Some(message)))
                .or(refusal)
                .map(|message| js::text(Some(message)));
            return Err(message.unwrap_or_else(|| format!("Safari: {}", status.as_u16())));
        }
        Ok(value)
    }

    /// A screenshot for the live view and a recording.
    async fn frame(&self) {
        if locked(&self.state).session.is_none() {
            return;
        }
        let Ok(shot) = self.call(reqwest::Method::GET, "/screenshot", None).await else {
            return;
        };
        let Some(data) = shot.as_str() else {
            return;
        };
        let page = {
            let mut state = locked(&self.state);
            if let Some(recording) = &mut state.recording
                && let Ok(bytes) = STANDARD.decode(data)
            {
                recording.add("png", &bytes);
            }
            state.page.clone()
        };
        if self.viewers.watched() {
            self.viewers.emit(json!({ "data": data, "format": "png", "width": 1280, "height": 800, "url": page.url, "title": page.title }));
        }
    }
}

impl Safari {
    pub fn new(data_dir: &Path, viewers: Arc<Viewers>, endpoint: Option<String>) -> Self {
        Self {
            data_dir: data_dir.to_path_buf(),
            viewers,
            endpoint,
            http: reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap_or_default(),
            state: Arc::default(),
            queue: Arc::default(),
        }
    }

    fn driver(&self) -> Driver {
        Driver {
            http: self.http.clone(),
            state: Arc::clone(&self.state),
            queue: Arc::clone(&self.queue),
            viewers: Arc::clone(&self.viewers),
        }
    }

    async fn call(
        &self,
        method: reqwest::Method,
        route: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
        self.driver().call(method, route, body).await
    }

    async fn post(&self, route: &str, body: Value) -> Result<Value, String> {
        self.call(reqwest::Method::POST, route, Some(body)).await
    }

    /// Whether a window is open, and on which page.
    pub fn state(&self) -> (bool, Page) {
        let state = locked(&self.state);
        (state.session.is_some(), state.page.clone())
    }

    /// Takes a screenshot every so often while someone watches or a recording runs.
    pub fn sync_frames(&self) {
        let mut state = locked(&self.state);
        let wanted =
            state.session.is_some() && (self.viewers.watched() || state.recording.is_some());
        if wanted && state.ticker.is_none() {
            let driver = self.driver();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                state.ticker = Some(runtime.spawn(async move {
                    let mut ticks = tokio::time::interval(Duration::from_millis(FRAME_MS));
                    ticks.tick().await;
                    loop {
                        ticks.tick().await;
                        driver.frame().await;
                    }
                }));
            }
        } else if !wanted && let Some(ticker) = state.ticker.take() {
            ticker.abort();
        }
    }

    /// Starts safaridriver and opens the automation window, if they are not yet.
    async fn ensure(&self) -> Result<(), String> {
        if locked(&self.state).session.is_some() {
            return Ok(());
        }
        let base = match &self.endpoint {
            Some(endpoint) => endpoint.clone(),
            None => self.start_driver().await?,
        };
        locked(&self.state).base.clone_from(&base);
        let response = self
            .http
            .post(format!("{base}/session"))
            .header("content-type", "application/json")
            .body(
                json!({ "capabilities": { "alwaysMatch": { "browserName": "safari" } } })
                    .to_string(),
            )
            .send()
            .await
            .map_err(|error| format!("Safari could not start an automation window: {error}"))?;
        let status = response.status();
        let answer: Value = response.json().await.unwrap_or_else(|_| json!({}));
        let value = answer.get("value").cloned().unwrap_or(Value::Null);
        let session = value
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|_| status.is_success());
        let Some(session) = session else {
            let message = value
                .get("message")
                .or_else(|| value.get("error"))
                .map_or_else(
                    || format!("status {}", status.as_u16()),
                    |message| js::text(Some(message)),
                );
            let program = locked(&self.state).driver.take();
            if let Some(program) = program {
                program.end().await;
            }
            let lower = message.to_lowercase();
            if lower.contains("remote automation") || lower.contains("--enable") {
                return Err(SAFARI_SETUP.to_owned());
            }
            if lower.contains("already paired")
                || lower.contains("another session")
                || lower.contains("another webdriver session")
            {
                return Err("Safari is already being automated by another session (one at a time). Close it and try again.".to_owned());
            }
            return Err(format!(
                "Safari could not start an automation window: {message}"
            ));
        };
        locked(&self.state).session = Some(session.to_owned());
        let _ = self
            .post("/window/rect", json!({ "width": 1280, "height": 860 }))
            .await;
        self.sync_frames();
        Ok(())
    }

    /// Starts safaridriver on a free port and gives its address.
    async fn start_driver(&self) -> Result<String, String> {
        if !cfg!(target_os = "macos") || !Path::new(SAFARIDRIVER).exists() {
            return Err("Safari is only on macOS. Pick Saturn or Chrome in Settings → General → Agent browser.".to_owned());
        }
        let port = {
            let free =
                std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
            free.local_addr().map_err(|error| error.to_string())?.port()
        };
        let mut command = tokio::process::Command::new(SAFARIDRIVER);
        command
            .args(["--port", &port.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        launch_env(&mut command);
        let child = command
            .spawn()
            .map_err(|error| format!("safaridriver could not start: {error}"))?;
        let state = Arc::clone(&self.state);
        let driver = Supervised::watch(child, move || {
            let mut state = locked(&state);
            state.driver = None;
            state.session = None;
            if let Some(ticker) = state.ticker.take() {
                ticker.abort();
            }
        });
        let base = format!("http://127.0.0.1:{port}");
        for _ in 0..40 {
            settle(150).await;
            let up = self.http.get(format!("{base}/status")).send().await;
            if up.is_ok_and(|response| response.status().is_success()) {
                locked(&self.state).driver = Some(driver);
                return Ok(base);
            }
        }
        driver.end().await;
        Err("safaridriver did not start".to_owned())
    }

    /// Ends the session and safaridriver, finishing a recording first.
    pub async fn close(&self) {
        if locked(&self.state).recording.is_some() {
            let _ = self.record_stop().await;
        }
        if locked(&self.state).session.is_some() {
            let _ = self.call(reqwest::Method::DELETE, "", None).await;
        }
        let driver = {
            let mut state = locked(&self.state);
            state.session = None;
            state.page = Page::default();
            state.driver.take()
        };
        self.sync_frames();
        if let Some(driver) = driver {
            driver.end().await;
        }
    }

    async fn execute(&self, script: &str, args: Value) -> Result<Value, String> {
        self.post("/execute/sync", json!({ "script": script, "args": args }))
            .await
    }

    /// Looks again at where the page is.
    async fn refresh(&self) {
        let shown = locked(&self.state).page.clone();
        let url = self.call(reqwest::Method::GET, "/url", None).await;
        let title = self.call(reqwest::Method::GET, "/title", None).await;
        let page = Page {
            url: url.map_or(shown.url, |url| js::text(Some(&url))),
            title: title.map_or(shown.title, |title| js::text(Some(&title))),
        };
        locked(&self.state).page = page;
    }

    async fn snapshot(&self) -> Result<Value, String> {
        self.refresh().await;
        self.execute(SNAPSHOT_SCRIPT, json!([SNAPSHOT_LIMIT])).await
    }

    /// The element the agent means (a snapshot id or a CSS selector), scrolled into view, with its center.
    async fn target(&self, args: &Value) -> Result<(String, f64, f64), String> {
        let id = args.get("id");
        let selector = match id {
            Some(id) => format!(
                "[data-saturn-ref=\"{}\"]",
                plain_number(js::number(Some(id)))
            ),
            None => {
                let selector = js::text(args.get("selector"));
                let selector = js::trim(&selector);
                if selector.is_empty() {
                    return Err(
                        "Give an element id from the snapshot, or a CSS selector.".to_owned()
                    );
                }
                selector.to_owned()
            }
        };
        let found = self
            .post(
                "/element",
                json!({ "using": "css selector", "value": selector }),
            )
            .await
            .ok();
        let Some(element) = found
            .as_ref()
            .and_then(|found| found.get(ELEMENT))
            .and_then(Value::as_str)
        else {
            return Err(match id {
                Some(id) => format!(
                    "No element [{}] in the last snapshot. Call browser_snapshot and use an id from it.",
                    js::text(Some(id))
                ),
                None => format!("Nothing matches the selector {selector}"),
            });
        };
        let center = self
            .execute(ELEMENT_CENTER, json!([{ ELEMENT: element }]))
            .await?;
        Ok((
            element.to_owned(),
            center["x"].as_f64().unwrap_or(0.0),
            center["y"].as_f64().unwrap_or(0.0),
        ))
    }

    /// The drawn cursor: injected again on each call, since WebDriver cannot add a script to every new page.
    async fn point_at(&self, x: f64, y: f64) {
        let spot = json!([plain_number(x.round()), plain_number(y.round())]);
        let script =
            format!("{CURSOR_SCRIPT}; window.__saturnCursor.move(arguments[0], arguments[1]);");
        let _ = self.execute(&script, spot.clone()).await;
        settle(300).await;
        let _ = self
            .execute(
                "window.__saturnCursor && window.__saturnCursor.click(arguments[0], arguments[1]);",
                spot,
            )
            .await;
        settle(120).await;
    }

    /// Key presses through WebDriver actions, with modifiers held around them.
    async fn keys(&self, keys: &[String], held: &[&str]) -> Result<(), String> {
        let mut actions = Vec::new();
        for value in held {
            actions.push(json!({ "type": "keyDown", "value": value }));
        }
        for value in keys {
            actions.push(json!({ "type": "keyDown", "value": value }));
            actions.push(json!({ "type": "keyUp", "value": value }));
        }
        for value in held.iter().rev() {
            actions.push(json!({ "type": "keyUp", "value": value }));
        }
        self.post(
            "/actions",
            json!({ "actions": [{ "type": "key", "id": "keyboard", "actions": actions }] }),
        )
        .await?;
        let _ = self.call(reqwest::Method::DELETE, "/actions", None).await;
        Ok(())
    }

    async fn record_stop(&self) -> Result<Value, String> {
        let recording = locked(&self.state).recording.take();
        let Some(recording) = recording else {
            return Err("Not recording.".to_owned());
        };
        self.sync_frames();
        recording.finish(FRAME_SECONDS).await
    }

    /// Runs one of the browser tools.
    pub async fn run(&self, tool: &str, args: &Value) -> Result<Value, String> {
        if tool == "browser_close" {
            self.close().await;
            return Ok(json!({ "closed": true }));
        }
        self.ensure().await?;
        match tool {
            "browser_navigate" => {
                let raw = js::text(args.get("url"));
                let lower = raw.to_lowercase();
                let spelled = if lower.starts_with("http://") || lower.starts_with("https://") {
                    raw
                } else {
                    format!("https://{raw}")
                };
                let address = parse_public_address(&spelled)?;
                assert_public_host(&address, &SystemLookup).await?;
                self.post("/url", json!({ "url": address.to_string() }))
                    .await?;
                let snapshot = self.snapshot().await?;
                let page = locked(&self.state).page.clone();
                Ok(json!({ "url": page.url, "title": page.title, "snapshot": snapshot }))
            }
            "browser_snapshot" => Ok(json!({ "snapshot": self.snapshot().await? })),
            "browser_click" => {
                let (element, x, y) = self.target(args).await?;
                self.point_at(x, y).await;
                self.post(&format!("/element/{element}/click"), json!({}))
                    .await?;
                settle(400).await;
                Ok(json!({ "clicked": true, "snapshot": self.snapshot().await? }))
            }
            "browser_type" => {
                let text = js::text(args.get("text"));
                if args.get("id").is_some() || js::truthy(args.get("selector")) {
                    let (element, x, y) = self.target(args).await?;
                    self.point_at(x, y).await;
                    if args.get("clear") != Some(&Value::Bool(false)) {
                        let _ = self
                            .post(&format!("/element/{element}/clear"), json!({}))
                            .await;
                    }
                    self.post(
                        &format!("/element/{element}/value"),
                        json!({ "text": text }),
                    )
                    .await?;
                } else {
                    let keys: Vec<String> = text.chars().map(String::from).collect();
                    self.keys(&keys, &[]).await?;
                }
                if js::truthy(args.get("submit")) {
                    self.keys(&["\u{e007}".to_owned()], &[]).await?;
                }
                settle(200).await;
                Ok(json!({ "typed": js::length(&text), "snapshot": self.snapshot().await? }))
            }
            "browser_press" => {
                let key = js::text(args.get("key"));
                let mut parts: Vec<&str> = key.split('+').map(js::trim).collect();
                let last = parts.pop().unwrap_or_default();
                let held: Vec<&str> = parts
                    .iter()
                    .filter_map(|part| modifier_code(&part.to_lowercase()))
                    .collect();
                let pressed = key_code(&last.to_lowercase()).unwrap_or(last).to_owned();
                self.keys(&[pressed], &held).await?;
                settle(300).await;
                Ok(json!({ "pressed": key, "snapshot": self.snapshot().await? }))
            }
            "browser_scroll" => {
                let (direction, x, y) = scroll_by(args);
                self.execute(
                    "window.scrollBy(arguments[0], arguments[1]);",
                    json!([plain_number(x), plain_number(y)]),
                )
                .await?;
                settle(300).await;
                Ok(json!({ "scrolled": direction, "snapshot": self.snapshot().await? }))
            }
            "browser_screenshot" => {
                let shot = self.call(reqwest::Method::GET, "/screenshot", None).await?;
                let data = shot.as_str().unwrap_or_default();
                let file = args
                    .get("file")
                    .and_then(Value::as_str)
                    .map(js::trim)
                    .filter(|file| !file.is_empty());
                if let Some(file) = file {
                    let bytes = STANDARD.decode(data).map_err(|error| error.to_string())?;
                    return files::save_screenshot(&self.data_dir, file, &bytes).await;
                }
                Ok(
                    json!({ "image": format!("data:image/png;base64,{data}"), "width": 1280, "height": 800 }),
                )
            }
            "browser_evaluate" => {
                let expression = js::text(args.get("expression"));
                if js::trim(&expression).is_empty() {
                    return Err("Give a JavaScript expression".to_owned());
                }
                let result = self
                    .post(
                        "/execute/async",
                        json!({ "script": EVALUATE, "args": [expression] }),
                    )
                    .await?;
                if let Some(error) = result.get("error").filter(|error| js::truthy(Some(error))) {
                    return Err(js::text(Some(error)));
                }
                self.refresh().await;
                Ok(json!({ "value": result.get("ok").cloned().unwrap_or(Value::Null) }))
            }
            "browser_record_start" => {
                if locked(&self.state).recording.is_some() {
                    return Err("Already recording; call browser_record_stop first.".to_owned());
                }
                let recording = Recording::start(&self.data_dir, args.get("name")).await?;
                let folder = recording.folder.to_string_lossy().into_owned();
                locked(&self.state).recording = Some(recording);
                self.sync_frames();
                Ok(json!({
                    "recording": folder,
                    "note": format!("Safari records a screenshot every {FRAME_MS} ms; browser_record_stop writes frames.txt for ffmpeg (ffmpeg -f concat -i frames.txt out.mp4)."),
                }))
            }
            "browser_record_stop" => self.record_stop().await,
            _ => Err(format!("Unknown browser tool: {tool}")),
        }
    }
}
