//! Chrome or Chromium through the DevTools protocol: pages read as an accessibility tree, clicks and typing by element id
//! or CSS selector, screenshots, and a screencast shared by the live view and recordings.
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use saturn_domain::js;
use saturn_domain::skills::public_address::parse_public_address;
use saturn_tools::public_host::{SystemLookup, assert_public_host};
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};

use crate::cdp::{Cdp, CdpEvent};
use crate::{
    Mode, Page, Recording, Supervised, Viewers, files, launch_env, locked, plain_number, scroll_by,
    settle,
};

/// The cursor drawn into every page: a pointer that glides to a point, and a ripple on click. Hidden from the accessibility tree.
pub(crate) const CURSOR_SCRIPT: &str = include_str!("cursor.js");
/// Elements per snapshot, so a long page does not flood the model.
const SNAPSHOT_LIMIT: usize = 400;
/// How long a page gets to load before it is read as it stands.
const LOAD_WAIT: Duration = Duration::from_secs(15);
/// How long the browser gets to start.
const START_WAIT: Duration = Duration::from_secs(10);
/// How long each frame of a recording shows, in seconds.
const FRAME_SECONDS: &str = "0.1";

/// Where Chrome and its relatives are installed.
const CANDIDATES: &[&str] = &[
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

/// The browser that runs now.
struct Connection {
    cdp: Arc<Cdp>,
    session: String,
    program: Supervised,
    /// Counts the page's loads, so navigating can wait for the next.
    loads: watch::Receiver<u64>,
}

#[derive(Default)]
struct State {
    connection: Option<Connection>,
    page: Page,
    /// Snapshot ids → backend DOM node ids, so clicks name the element the agent saw.
    nodes: HashMap<u64, i64>,
    recording: Option<Recording>,
    screencasting: bool,
}

/// The agent's Chrome.
pub(crate) struct Chrome {
    data_dir: PathBuf,
    viewers: Arc<Viewers>,
    state: Arc<Mutex<State>>,
}

impl Chrome {
    pub fn new(data_dir: &Path, viewers: Arc<Viewers>) -> Self {
        Self {
            data_dir: data_dir.to_path_buf(),
            viewers,
            state: Arc::default(),
        }
    }

    /// Whether it is open, and on which page.
    pub fn state(&self) -> (bool, Page) {
        let state = locked(&self.state);
        (state.connection.is_some(), state.page.clone())
    }

    /// One screencast for live viewers and recordings together: on while either needs it.
    pub async fn sync_frames(&self) {
        let (cdp, session, wanted) = {
            let mut state = locked(&self.state);
            let wanted = self.viewers.watched() || state.recording.is_some();
            let Some(connection) = &state.connection else {
                return;
            };
            let (cdp, session) = (Arc::clone(&connection.cdp), connection.session.clone());
            if wanted == state.screencasting {
                return;
            }
            state.screencasting = wanted;
            (cdp, session, wanted)
        };
        if wanted {
            let started = cdp
                .send(
                    "Page.startScreencast",
                    json!({ "format": "jpeg", "quality": 65, "maxWidth": 1280, "maxHeight": 800, "everyNthFrame": 1 }),
                    Some(&session),
                )
                .await;
            if started.is_err() {
                locked(&self.state).screencasting = false;
            }
        } else {
            let _ = cdp
                .send("Page.stopScreencast", json!({}), Some(&session))
                .await;
        }
    }

    /// Runs one of the browser tools.
    pub async fn run(&self, tool: &str, args: &Value, mode: Mode) -> Result<Value, String> {
        match tool {
            "browser_navigate" => self.navigate(&js::text(args.get("url")), mode).await,
            "browser_snapshot" => Ok(json!({ "snapshot": self.snapshot(mode).await? })),
            "browser_click" => self.click(args, mode).await,
            "browser_type" => self.type_text(args, mode).await,
            "browser_press" => {
                let key = js::text(args.get("key"));
                let (cdp, session) = self.ensure(mode).await?;
                press(&cdp, &session, &key).await?;
                Ok(json!({ "pressed": key, "snapshot": self.snapshot(mode).await? }))
            }
            "browser_scroll" => {
                let (cdp, session) = self.ensure(mode).await?;
                let (direction, x, y) = scroll_by(args);
                cdp.send(
                    "Runtime.evaluate",
                    json!({ "expression": format!("window.scrollBy({}, {})", plain_number(x), plain_number(y)) }),
                    Some(&session),
                )
                .await?;
                settle(300).await;
                Ok(json!({ "scrolled": direction, "snapshot": self.snapshot(mode).await? }))
            }
            "browser_screenshot" => self.screenshot(args, mode).await,
            "browser_evaluate" => self.evaluate(&js::text(args.get("expression")), mode).await,
            "browser_record_start" => {
                let _ = self.ensure(mode).await?;
                if locked(&self.state).recording.is_some() {
                    return Err("Already recording; call browser_record_stop first.".to_owned());
                }
                let recording = Recording::start(&self.data_dir, args.get("name")).await?;
                let folder = recording.folder.to_string_lossy().into_owned();
                locked(&self.state).recording = Some(recording);
                // The frames come from the screencast the live view shares.
                self.sync_frames().await;
                Ok(json!({
                    "recording": folder,
                    "note": "Frames are saved as JPEGs; browser_record_stop writes frames.txt for ffmpeg (ffmpeg -f concat -i frames.txt -r 10 out.mp4).",
                }))
            }
            "browser_record_stop" => self.record_stop().await,
            "browser_close" => {
                self.close().await;
                Ok(json!({ "closed": true }))
            }
            _ => Err(format!("Unknown browser tool: {tool}")),
        }
    }

    /// Ends a recording and writes its list.
    async fn record_stop(&self) -> Result<Value, String> {
        let recording = locked(&self.state).recording.take();
        let Some(recording) = recording else {
            return Err("Not recording.".to_owned());
        };
        self.sync_frames().await;
        recording.finish(FRAME_SECONDS).await
    }

    /// Closes the browser, finishing a recording first.
    pub async fn close(&self) {
        if locked(&self.state).recording.is_some() {
            let _ = self.record_stop().await;
        }
        let connection = {
            let mut state = locked(&self.state);
            state.screencasting = false;
            state.page = Page::default();
            state.nodes.clear();
            state.connection.take()
        };
        if let Some(connection) = connection {
            // Asked to close, Chrome writes its profile and takes its helper processes with it.
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                connection.cdp.send("Browser.close", json!({}), None),
            )
            .await;
            connection.program.end().await;
        }
    }

    /// The program to start: SATURN_BROWSER, or an installed Chrome or relative.
    fn program() -> Result<PathBuf, String> {
        if let Some(chosen) = std::env::var_os("SATURN_BROWSER").filter(|value| !value.is_empty()) {
            return Ok(PathBuf::from(chosen));
        }
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let personal = home
            .map(|home| home.join("Applications/Google Chrome.app/Contents/MacOS/Google Chrome"));
        CANDIDATES
            .iter()
            .map(PathBuf::from)
            .chain(personal)
            .find(|candidate| candidate.exists())
            .ok_or_else(|| {
                "No browser found. Install Google Chrome (or Chromium), or set SATURN_BROWSER to a Chrome binary."
                    .to_owned()
            })
    }

    /// The running browser, started if it is not.
    async fn ensure(&self, mode: Mode) -> Result<(Arc<Cdp>, String), String> {
        if let Some(connection) = &locked(&self.state).connection {
            return Ok((Arc::clone(&connection.cdp), connection.session.clone()));
        }
        let program = Self::program()?;
        let profile = self.data_dir.join("browser-profile");
        std::fs::create_dir_all(&profile).map_err(|error| error.to_string())?;
        restrict(&profile);
        // Chrome picks a free port and says which in this file, so no other program's port can be taken for it.
        let port_file = profile.join("DevToolsActivePort");
        let _ = std::fs::remove_file(&port_file);
        let mut command = tokio::process::Command::new(&program);
        command
            .arg("--remote-debugging-port=0")
            .arg(format!("--user-data-dir={}", profile.display()));
        // "system": a real window the user watches; otherwise no window, the page streams into the Browser panel.
        if mode != Mode::System {
            command.arg("--headless=new");
        }
        command
            .args([
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-extensions",
                "--window-size=1280,860",
                "about:blank",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        launch_env(&mut command);
        let child = command.spawn().map_err(|error| {
            format!(
                "The browser could not start: {error} ({}). Install Google Chrome, or set SATURN_BROWSER to a Chrome binary.",
                program.display()
            )
        })?;
        let state = Arc::clone(&self.state);
        let supervised = Supervised::watch(child, move || {
            let mut state = locked(&state);
            state.connection = None;
            state.screencasting = false;
        });
        let address = match wait_for_address(&port_file).await {
            Some(address) => address,
            None => {
                supervised.end().await;
                let name = program.file_name().unwrap_or_default().to_string_lossy();
                return Err(format!("The browser did not start ({name})"));
            }
        };
        self.connect(&address, supervised).await
    }

    /// Connects to the started browser and prepares its page.
    async fn connect(
        &self,
        address: &str,
        program: Supervised,
    ) -> Result<(Arc<Cdp>, String), String> {
        let prepared = async {
            let (cdp, events) = Cdp::connect(address).await?;
            let cdp = Arc::new(cdp);
            let targets = cdp.send("Target.getTargets", json!({}), None).await?;
            let page = targets["targetInfos"]
                .as_array()
                .and_then(|targets| targets.iter().find(|target| target["type"] == "page"))
                .and_then(|target| target["targetId"].as_str())
                .map(str::to_owned);
            let target = match page {
                Some(page) => page,
                None => js::text(
                    cdp.send("Target.createTarget", json!({ "url": "about:blank" }), None)
                        .await?
                        .get("targetId"),
                ),
            };
            let attached = cdp
                .send(
                    "Target.attachToTarget",
                    json!({ "targetId": target, "flatten": true }),
                    None,
                )
                .await?;
            let session = js::text(attached.get("sessionId"));
            let on = Some(session.as_str());
            for domain in ["Page", "Runtime", "Accessibility", "DOM"] {
                cdp.send(&format!("{domain}.enable"), json!({}), on).await?;
            }
            cdp.send(
                "Emulation.setDeviceMetricsOverride",
                json!({ "width": 1280, "height": 800, "deviceScaleFactor": 1, "mobile": false }),
                on,
            )
            .await?;
            // The visible cursor, in every page from now on and in this one.
            cdp.send(
                "Page.addScriptToEvaluateOnNewDocument",
                json!({ "source": CURSOR_SCRIPT }),
                on,
            )
            .await?;
            let _ = cdp
                .send(
                    "Runtime.evaluate",
                    json!({ "expression": CURSOR_SCRIPT }),
                    on,
                )
                .await;
            Ok::<_, String>((cdp, events, session))
        }
        .await;
        let (cdp, events, session) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                program.end().await;
                return Err(error);
            }
        };
        let (load_counter, loads) = watch::channel(0);
        tokio::spawn(handle_events(
            events,
            Arc::clone(&cdp),
            session.clone(),
            load_counter,
            Arc::clone(&self.state),
            Arc::clone(&self.viewers),
        ));
        {
            let mut state = locked(&self.state);
            state.connection = Some(Connection {
                cdp: Arc::clone(&cdp),
                session: session.clone(),
                program,
                loads,
            });
            state.screencasting = false;
        }
        self.sync_frames().await;
        Ok((cdp, session))
    }

    /// Opens a public page and reads it.
    async fn navigate(&self, raw: &str, mode: Mode) -> Result<Value, String> {
        let lower = raw.to_lowercase();
        let spelled = if lower.starts_with("http://") || lower.starts_with("https://") {
            raw.to_owned()
        } else {
            format!("https://{raw}")
        };
        let address = parse_public_address(&spelled)?;
        assert_public_host(&address, &SystemLookup).await?;
        let url = address.to_string();
        let (cdp, session) = self.ensure(mode).await?;
        let mut loads = locked(&self.state)
            .connection
            .as_ref()
            .map(|connection| connection.loads.clone())
            .ok_or("The browser has closed")?;
        loads.mark_unchanged();
        let opened = cdp
            .send("Page.navigate", json!({ "url": url }), Some(&session))
            .await?;
        if let Some(reason) = opened
            .get("errorText")
            .and_then(Value::as_str)
            .filter(|reason| !reason.is_empty())
        {
            return Err(format!("Could not open {url}: {reason}"));
        }
        let _ = tokio::time::timeout(LOAD_WAIT, loads.changed()).await;
        settle(300).await;
        let info = cdp
            .send(
                "Runtime.evaluate",
                json!({ "expression": "JSON.stringify({ title: document.title, url: location.href })", "returnByValue": true }),
                Some(&session),
            )
            .await?;
        let page: Value = serde_json::from_str(info["result"]["value"].as_str().unwrap_or("{}"))
            .map_err(|error| error.to_string())?;
        Ok(
            json!({ "title": page["title"], "url": page["url"], "snapshot": self.snapshot(mode).await? }),
        )
    }

    /// The page as an accessibility tree: "[id] role name=… value=…", indented, interactive elements first-class.
    async fn snapshot(&self, mode: Mode) -> Result<String, String> {
        let (cdp, session) = self.ensure(mode).await?;
        let tree = cdp
            .send("Accessibility.getFullAXTree", json!({}), Some(&session))
            .await?;
        let empty = Vec::new();
        let (text, nodes) = snapshot_text(tree["nodes"].as_array().unwrap_or(&empty));
        locked(&self.state).nodes = nodes;
        Ok(text)
    }

    /// The element the agent means: a snapshot id, or a CSS selector.
    async fn resolve(&self, args: &Value, cdp: &Cdp, session: &str) -> Result<String, String> {
        if let Some(id) = args.get("id") {
            let number = js::number(Some(id));
            let backend = locked(&self.state)
                .nodes
                .get(&(number as u64))
                .copied()
                .filter(|_| number >= 0.0 && number.fract() == 0.0);
            let Some(backend) = backend else {
                return Err(format!(
                    "No element [{}] in the last snapshot. Call browser_snapshot and use an id from it.",
                    js::text(Some(id))
                ));
            };
            let resolved = cdp
                .send(
                    "DOM.resolveNode",
                    json!({ "backendNodeId": backend }),
                    Some(session),
                )
                .await?;
            return Ok(js::text(resolved["object"].get("objectId")));
        }
        let selector = js::text(args.get("selector"));
        let selector = js::trim(&selector);
        if selector.is_empty() {
            return Err("Give an element id from the snapshot, or a CSS selector.".to_owned());
        }
        let expression = format!("document.querySelector({})", json!(selector));
        let found = cdp
            .send(
                "Runtime.evaluate",
                json!({ "expression": expression }),
                Some(session),
            )
            .await?;
        let result = &found["result"];
        match result.get("objectId").and_then(Value::as_str) {
            Some(object) if result.get("subtype").and_then(Value::as_str) != Some("null") => {
                Ok(object.to_owned())
            }
            _ => Err(format!("Nothing matches the selector {selector}")),
        }
    }

    async fn click(&self, args: &Value, mode: Mode) -> Result<Value, String> {
        let (cdp, session) = self.ensure(mode).await?;
        let object = self.resolve(args, &cdp, &session).await?;
        call_on(
            &cdp,
            &session,
            &object,
            "function () { this.scrollIntoView({ block: 'center', inline: 'center' }); }",
        )
        .await?;
        if let Some(content) = box_of(&cdp, &session, &object).await {
            let x = (content[0] + content[2]) / 2.0;
            let y = (content[1] + content[5]) / 2.0;
            // The cursor glides there and ripples, so whoever watches sees what is clicked.
            point_at(&cdp, &session, x, y, false).await;
            point_at(&cdp, &session, x, y, true).await;
            for kind in ["mouseMoved", "mousePressed", "mouseReleased"] {
                cdp.send(
                    "Input.dispatchMouseEvent",
                    json!({ "type": kind, "x": x, "y": y, "button": "left", "clickCount": 1 }),
                    Some(&session),
                )
                .await?;
            }
        } else {
            call_on(&cdp, &session, &object, "function () { this.click(); }").await?;
        }
        settle(400).await;
        Ok(json!({ "clicked": true, "snapshot": self.snapshot(mode).await? }))
    }

    async fn type_text(&self, args: &Value, mode: Mode) -> Result<Value, String> {
        let (cdp, session) = self.ensure(mode).await?;
        let text = js::text(args.get("text"));
        if args.get("id").is_some() || js::truthy(args.get("selector")) {
            let object = self.resolve(args, &cdp, &session).await?;
            if let Some(content) = box_of(&cdp, &session, &object).await {
                point_at(
                    &cdp,
                    &session,
                    (content[0] + content[2]) / 2.0,
                    (content[1] + content[5]) / 2.0,
                    true,
                )
                .await;
            }
            call_on(&cdp, &session, &object, "function () { this.focus(); }").await?;
            // Kept text is typed after, not replaced: the caret goes to its end.
            let prepare = if args.get("clear") == Some(&Value::Bool(false)) {
                "function () { if ('setSelectionRange' in this && 'value' in this) { try { this.setSelectionRange(this.value.length, this.value.length); } catch {} } }"
            } else {
                "function () { if ('select' in this) this.select(); if ('value' in this) { this.value = ''; this.dispatchEvent(new Event('input', { bubbles: true })); } }"
            };
            call_on(&cdp, &session, &object, prepare).await?;
        }
        cdp.send("Input.insertText", json!({ "text": text }), Some(&session))
            .await?;
        if js::truthy(args.get("submit")) {
            press(&cdp, &session, "Enter").await?;
        }
        settle(200).await;
        Ok(json!({ "typed": js::length(&text), "snapshot": self.snapshot(mode).await? }))
    }

    async fn screenshot(&self, args: &Value, mode: Mode) -> Result<Value, String> {
        let (cdp, session) = self.ensure(mode).await?;
        let mut params = json!({ "format": "jpeg", "quality": 70 });
        if js::truthy(args.get("fullPage")) {
            params["captureBeyondViewport"] = json!(true);
        }
        let shot = cdp
            .send("Page.captureScreenshot", params, Some(&session))
            .await?;
        let data = shot["data"].as_str().unwrap_or_default();
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
            json!({ "image": format!("data:image/jpeg;base64,{data}"), "width": 1280, "height": 800 }),
        )
    }

    async fn evaluate(&self, expression: &str, mode: Mode) -> Result<Value, String> {
        let (cdp, session) = self.ensure(mode).await?;
        if js::trim(expression).is_empty() {
            return Err("Give a JavaScript expression".to_owned());
        }
        let answer = cdp
            .send(
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }),
                Some(&session),
            )
            .await?;
        if let Some(thrown) = answer.get("exceptionDetails") {
            return Err(thrown["exception"]
                .get("description")
                .or_else(|| thrown.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("The expression failed")
                .to_owned());
        }
        let result = &answer["result"];
        let value = result
            .get("value")
            .filter(|value| !value.is_null())
            .or_else(|| result.get("description").filter(|value| !value.is_null()))
            .cloned()
            .unwrap_or(Value::Null);
        Ok(json!({ "value": value }))
    }
}

/// The address to connect to, once the browser has written it.
async fn wait_for_address(port_file: &Path) -> Option<String> {
    let started = Instant::now();
    while started.elapsed() < START_WAIT {
        settle(100).await;
        if let Ok(written) = tokio::fs::read_to_string(port_file).await {
            let mut lines = written.lines();
            if let (Some(port), Some(path)) = (lines.next(), lines.next()) {
                return Some(format!("ws://127.0.0.1:{port}{path}"));
            }
        }
    }
    None
}

/// The profile is for this user alone.
#[cfg(unix)]
fn restrict(folder: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(folder, std::fs::Permissions::from_mode(0o700));
}

/// Windows keeps a folder under the user's profile to that user already.
#[cfg(not(unix))]
fn restrict(_folder: &Path) {}

/// Handles what the browser reports: frames for the live view and a recording, and where the page went.
async fn handle_events(
    mut events: mpsc::UnboundedReceiver<CdpEvent>,
    cdp: Arc<Cdp>,
    session: String,
    loads: watch::Sender<u64>,
    state: Arc<Mutex<State>>,
    viewers: Arc<Viewers>,
) {
    while let Some(event) = events.recv().await {
        if event.session.as_deref() != Some(session.as_str()) {
            continue;
        }
        match event.method.as_str() {
            "Page.screencastFrame" => {
                cdp.post(
                    "Page.screencastFrameAck",
                    json!({ "sessionId": event.params["sessionId"] }),
                    Some(&session),
                );
                let data = event.params["data"].as_str().unwrap_or_default();
                let page = {
                    let mut state = locked(&state);
                    if let Some(recording) = &mut state.recording
                        && let Ok(bytes) = STANDARD.decode(data)
                    {
                        recording.add("jpg", &bytes);
                    }
                    state.page.clone()
                };
                let size = &event.params["metadata"];
                viewers.emit(json!({
                    "data": data,
                    "format": "jpeg",
                    "width": size.get("deviceWidth").cloned().unwrap_or(json!(1280)),
                    "height": size.get("deviceHeight").cloned().unwrap_or(json!(800)),
                    "url": page.url,
                    "title": page.title,
                }));
            }
            "Page.frameNavigated" => {
                let frame = &event.params["frame"];
                if frame.get("parentId").is_none()
                    && let Some(url) = frame["url"].as_str().filter(|url| !url.is_empty())
                {
                    locked(&state).page.url = url.to_owned();
                }
            }
            "Page.loadEventFired" => {
                loads.send_modify(|count| *count += 1);
                let (cdp, session, state) = (Arc::clone(&cdp), session.clone(), Arc::clone(&state));
                tokio::spawn(async move {
                    let title = cdp
                        .send(
                            "Runtime.evaluate",
                            json!({ "expression": "document.title", "returnByValue": true }),
                            Some(&session),
                        )
                        .await;
                    if let Ok(title) = title {
                        locked(&state).page.title = js::text(title["result"].get("value"));
                    }
                });
            }
            _ => {}
        }
    }
}

/// Runs a function with an element as `this`.
async fn call_on(cdp: &Cdp, session: &str, object: &str, function: &str) -> Result<Value, String> {
    cdp.send(
        "Runtime.callFunctionOn",
        json!({ "objectId": object, "functionDeclaration": function }),
        Some(session),
    )
    .await
}

/// The corners of an element's content, as x and y in turn, when it has a box.
async fn box_of(cdp: &Cdp, session: &str, object: &str) -> Option<Vec<f64>> {
    let answer = cdp
        .send(
            "DOM.getBoxModel",
            json!({ "objectId": object }),
            Some(session),
        )
        .await
        .ok()?;
    let content: Vec<f64> = answer["model"]["content"]
        .as_array()?
        .iter()
        .filter_map(Value::as_f64)
        .collect();
    (content.len() >= 8).then_some(content)
}

/// Moves the drawn cursor to (x, y), or ripples it there for a click, and gives the motion time to show.
async fn point_at(cdp: &Cdp, session: &str, x: f64, y: f64, click: bool) {
    let action = if click { "click" } else { "move" };
    let expression = format!(
        "window.__saturnCursor && window.__saturnCursor.{action}({}, {})",
        x.round(),
        y.round()
    );
    let _ = cdp
        .send(
            "Runtime.evaluate",
            json!({ "expression": expression }),
            Some(session),
        )
        .await;
    settle(if click { 120 } else { 300 }).await;
}

/// A key's name, code and Windows key code, for the keys with a name.
fn named_key(name: &str) -> Option<(&'static str, &'static str, u32)> {
    Some(match name {
        "enter" => ("Enter", "Enter", 13),
        "tab" => ("Tab", "Tab", 9),
        "escape" => ("Escape", "Escape", 27),
        "backspace" => ("Backspace", "Backspace", 8),
        "delete" => ("Delete", "Delete", 46),
        "space" => (" ", "Space", 32),
        "arrowup" => ("ArrowUp", "ArrowUp", 38),
        "arrowdown" => ("ArrowDown", "ArrowDown", 40),
        "arrowleft" => ("ArrowLeft", "ArrowLeft", 37),
        "arrowright" => ("ArrowRight", "ArrowRight", 39),
        "pageup" => ("PageUp", "PageUp", 33),
        "pagedown" => ("PageDown", "PageDown", 34),
        "home" => ("Home", "Home", 36),
        "end" => ("End", "End", 35),
        _ => return None,
    })
}

/// Presses a key or chord such as "cmd+a".
async fn press(cdp: &Cdp, session: &str, chord: &str) -> Result<(), String> {
    let mut parts: Vec<&str> = chord.split('+').map(js::trim).collect();
    let last = parts.pop().unwrap_or_default();
    let modifiers = parts.iter().fold(0, |bits, part| {
        bits | match part.to_lowercase().as_str() {
            "alt" => 1,
            "ctrl" | "control" => 2,
            "meta" | "cmd" | "command" => 4,
            "shift" => 8,
            _ => 0,
        }
    });
    let upper = last.to_uppercase();
    let (key, code, key_code) = match named_key(&last.to_lowercase()) {
        Some((key, code, number)) => (key.to_owned(), code.to_owned(), json!(number)),
        None => (
            last.to_owned(),
            format!("Key{upper}"),
            upper
                .encode_utf16()
                .next()
                .map_or(Value::Null, |unit| json!(unit)),
        ),
    };
    // What the key types: Enter a return, which is what submits a form; nothing while ctrl or cmd is held.
    let typed = if modifiers & 6 != 0 {
        None
    } else if key == "Enter" {
        Some("\r".to_owned())
    } else if js::length(&key) == 1 {
        Some(key.clone())
    } else {
        None
    };
    for kind in ["keyDown", "keyUp"] {
        let mut event = json!({ "type": kind, "modifiers": modifiers, "key": key, "code": code, "windowsVirtualKeyCode": key_code });
        if kind == "keyDown"
            && let Some(typed) = &typed
        {
            event["text"] = json!(typed);
        }
        cdp.send("Input.dispatchKeyEvent", event, Some(session))
            .await?;
    }
    settle(300).await;
    Ok(())
}

/// Roles shown even with no name or value.
const INTERACTIVE: &[&str] = &[
    "button",
    "link",
    "textbox",
    "combobox",
    "checkbox",
    "radio",
    "tab",
    "menuitem",
    "heading",
    "searchbox",
    "slider",
    "switch",
    "option",
    "listbox",
    "image",
];
/// Roles that say nothing unless named.
const QUIET: &[&str] = &[
    "none",
    "generic",
    "InlineTextBox",
    "LineBreak",
    "StaticText",
];
/// States worth saying.
const STATES: &[&str] = &[
    "checked", "expanded", "disabled", "selected", "focused", "pressed",
];

/// The accessibility tree as text, with the backend node of each id. A list, not recursion: a page chooses how deep it nests.
fn snapshot_text(nodes: &[Value]) -> (String, HashMap<u64, i64>) {
    let by_id: HashMap<&str, &Value> = nodes
        .iter()
        .filter_map(|node| Some((node["nodeId"].as_str()?, node)))
        .collect();
    let mut lines: Vec<String> = Vec::new();
    let mut ids = HashMap::new();
    let mut next = 1;
    let root = nodes
        .iter()
        .find(|node| node["role"]["value"] == "RootWebArea")
        .or_else(|| nodes.first());
    let mut pending: Vec<(&Value, usize)> = root.map(|root| (root, 0)).into_iter().collect();
    let mut seen = HashSet::new();
    while let Some((node, depth)) = pending.pop() {
        if lines.len() >= SNAPSHOT_LIMIT {
            break;
        }
        if !seen.insert(node["nodeId"].as_str().unwrap_or_default()) {
            continue;
        }
        let role = node["role"]
            .get("value")
            .map_or_else(String::new, |value| js::text(Some(value)));
        let name = js::text(node["name"].get("value"));
        let name = js::trim(&name);
        let value = node["value"].get("value");
        let skip =
            js::truthy(node.get("ignored")) || (QUIET.contains(&role.as_str()) && name.is_empty());
        if !skip
            && !role.is_empty()
            && (!name.is_empty()
                || value.is_some()
                || INTERACTIVE.iter().any(|kind| role.contains(kind)))
        {
            let id = next;
            next += 1;
            if let Some(backend) = node.get("backendDOMNodeId").and_then(Value::as_i64) {
                ids.insert(id, backend);
            }
            let mut parts = vec![format!("[{id}] {role}")];
            if !name.is_empty() {
                parts.push(format!("name={}", json!(js::prefix(name, 120))));
            }
            if let Some(value) = value {
                let shown = if value.is_null() {
                    "null".to_owned()
                } else {
                    js::text(Some(value))
                };
                if !shown.is_empty() {
                    parts.push(format!("value={}", json!(js::prefix(&shown, 120))));
                }
            }
            for property in node["properties"].as_array().map_or(&[][..], Vec::as_slice) {
                let name = property["name"].as_str().unwrap_or_default();
                let state = property["value"].get("value");
                if STATES.contains(&name) && state.is_some_and(|state| *state != Value::Bool(false))
                {
                    parts.push(format!("{name}={}", js::text(state)));
                }
            }
            lines.push(format!("{}{}", "  ".repeat(depth.min(12)), parts.join(" ")));
        }
        let below = if skip { depth } else { depth + 1 };
        for child in node["childIds"]
            .as_array()
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .rev()
        {
            if let Some(child) = child.as_str().and_then(|child| by_id.get(child)) {
                pending.push((child, below));
            }
        }
    }
    if lines.len() >= SNAPSHOT_LIMIT {
        lines.push("… (more elements; scroll or navigate to see the rest)".to_owned());
    }
    let text = if lines.is_empty() {
        "(empty page)".to_owned()
    } else {
        lines.join("\n")
    };
    (text, ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_nested_very_deep_is_read_without_running_out_of_stack() {
        let nodes: Vec<Value> = (0..200_000)
            .map(|index| json!({ "nodeId": index.to_string(), "role": { "value": "generic" }, "childIds": [(index + 1).to_string()] }))
            .collect();
        let (text, ids) = snapshot_text(&nodes);
        assert_eq!(text, "(empty page)");
        assert!(ids.is_empty());
    }

    #[test]
    fn a_node_listed_as_its_own_child_ends() {
        let nodes = [
            json!({ "nodeId": "1", "role": { "value": "button" }, "name": { "value": "Go" }, "childIds": ["1"] }),
        ];
        assert_eq!(snapshot_text(&nodes).0, "[1] button name=\"Go\"");
    }

    #[test]
    fn the_snapshot_shows_what_matters_and_stops_at_its_limit() {
        let nodes = [
            json!({ "nodeId": "1", "role": { "value": "RootWebArea" }, "name": { "value": "Page" }, "childIds": ["2", "3", "4", "5", "6"] }),
            json!({ "nodeId": "2", "role": { "value": "generic" }, "childIds": ["7"] }),
            json!({ "nodeId": "3", "role": { "value": "button" }, "backendDOMNodeId": 33, "name": { "value": "  Go  " }, "properties": [{ "name": "disabled", "value": { "value": true } }, { "name": "focused", "value": { "value": false } }, { "name": "busy", "value": { "value": true } }] }),
            json!({ "nodeId": "4", "role": { "value": "textbox" }, "backendDOMNodeId": 44, "value": { "value": "typed" } }),
            json!({ "nodeId": "5", "role": { "value": "StaticText" } }),
            json!({ "nodeId": "6", "ignored": true, "role": { "value": "button" }, "name": { "value": "Hidden" } }),
            json!({ "nodeId": "7", "role": { "value": "link" }, "backendDOMNodeId": 77 }),
        ];
        let (text, ids) = snapshot_text(&nodes);
        assert_eq!(
            text,
            "[1] RootWebArea name=\"Page\"\n  [2] link\n  [3] button name=\"Go\" disabled=true\n  [4] textbox value=\"typed\""
        );
        assert_eq!(ids, HashMap::from([(2, 77), (3, 33), (4, 44)]));

        let children: Vec<String> = (2..600).map(|index| index.to_string()).collect();
        let mut many = vec![
            json!({ "nodeId": "1", "role": { "value": "RootWebArea" }, "childIds": children }),
        ];
        many.extend(
            (2..600)
                .map(|index| json!({ "nodeId": index.to_string(), "role": { "value": "button" } })),
        );
        let text = snapshot_text(&many).0;
        assert_eq!(text.lines().count(), SNAPSHOT_LIMIT + 1);
        assert!(text.ends_with("… (more elements; scroll or navigate to see the rest)"));
    }
}
