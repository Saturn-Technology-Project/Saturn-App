//! The computer-use tools on macOS and Windows: real screenshots, real mouse and keyboard input, and the app's element tree
//! (macOS accessibility, Windows UI Automation). Every action either happens or says why not (a missing permission says
//! what to turn on); nothing reports success it did not have.
mod macos;
mod windows;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use saturn_domain::js;
use saturn_domain::time::{iso_time, now_millis};
use serde_json::{Map, Value, json};

use windows::Helper;

/// Every coordinate the model sends or sees is a pixel in this canvas.
const CANVAS: Canvas = Canvas {
    width: 1280,
    height: 800,
};
/// Elements read per accessibility snapshot, so a large window does not flood the model's context.
const TREE_LIMIT: usize = 250;
/// How long a permission check is trusted before asking macOS again.
const PERMISSION_TTL: Duration = Duration::from_secs(15);
/// Snapshots kept; ids from older ones are reported as stale.
const SNAPSHOTS_KEPT: usize = 20;
/// The longest wait that blocks here; the run loop suspends the run for longer ones before they get here.
const LONGEST_WAIT_MS: f64 = 30_000.0;

/// The size of the picture the model sees.
#[derive(Clone, Copy)]
pub(crate) struct Canvas {
    pub width: u32,
    pub height: u32,
}

/// A refusal; a permission's message says how to fix it.
#[derive(Debug)]
pub(crate) struct Failure {
    pub permission: bool,
    pub message: String,
}

impl Failure {
    pub fn plain(message: impl Into<String>) -> Self {
        Self {
            permission: false,
            message: message.into(),
        }
    }

    pub fn permission(message: impl Into<String>) -> Self {
        Self {
            permission: true,
            message: message.into(),
        }
    }
}

impl From<Failure> for String {
    fn from(failure: Failure) -> Self {
        failure.message
    }
}

/// `Math.round`: halves go up, also below zero.
pub(crate) fn round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

/// A number as JSON has it: whole numbers without a fraction.
fn plain(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

/// The screen region a screenshot showed, in screen points: canvas pixels map onto it.
#[derive(Clone, Copy)]
pub(crate) struct Region {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Region {
    pub fn from_value(value: &Value) -> Self {
        Self {
            x: js::number(value.get("x")),
            y: js::number(value.get("y")),
            width: js::number(value.get("width")),
            height: js::number(value.get("height")),
        }
    }

    fn to_value(self) -> Value {
        json!({ "x": plain(self.x), "y": plain(self.y), "width": plain(self.width), "height": plain(self.height) })
    }

    /// As `screencapture -R` takes it.
    pub fn rounded(self) -> String {
        format!(
            "{},{},{},{}",
            round(self.x),
            round(self.y),
            round(self.width),
            round(self.height)
        )
    }

    /// A canvas pixel → the screen point it shows.
    fn to_screen(self, x: i64, y: i64) -> (i64, i64) {
        let cx = x.clamp(0, i64::from(CANVAS.width) - 1) as f64;
        let cy = y.clamp(0, i64::from(CANVAS.height) - 1) as f64;
        (
            round(self.x + cx * self.width / f64::from(CANVAS.width)),
            round(self.y + cy * self.height / f64::from(CANVAS.height)),
        )
    }
}

/// An element tree as read.
pub(crate) struct Tree {
    pub nodes: Vec<Value>,
    pub truncated: bool,
}

/// An app screenshot's window region, handed to the model as an opaque token and checked on the way back.
fn encode_token(pid: i64, region: Region) -> String {
    let body = json!({ "pid": pid, "x": plain(region.x), "y": plain(region.y), "width": plain(region.width), "height": plain(region.height) });
    URL_SAFE_NO_PAD.encode(body.to_string())
}

fn decode_token(token: &str, pid: i64) -> Result<Region, String> {
    let invalid = || {
        "coordinate_token is not valid. Take a new computer_screenshot of this app and use its coordinate_token.".to_owned()
    };
    let bytes = URL_SAFE_NO_PAD.decode(token).map_err(|_| invalid())?;
    let parsed: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let is_number = |name: &str| parsed.get(name).is_some_and(Value::is_number);
    if parsed.get("pid").and_then(Value::as_i64) != Some(pid)
        || !["x", "y", "width", "height"]
            .iter()
            .all(|name| is_number(name))
    {
        return Err("coordinate_token belongs to another app or screenshot. Take a new computer_screenshot of this app.".to_owned());
    }
    Ok(Region::from_value(&parsed))
}

/// AXShowMenu → show-menu (how actions are listed).
fn action_name(ax: &str) -> String {
    let bare = ax.strip_prefix("AX").unwrap_or(ax);
    let mut name = String::new();
    let mut previous_lower = false;
    for character in bare.chars() {
        if previous_lower && character.is_ascii_uppercase() {
            name.push('-');
        }
        previous_lower = character.is_ascii_lowercase();
        name.extend(character.to_lowercase());
    }
    name
}

/// show-menu, ShowMenu or AXShowMenu → AXShowMenu (how they run).
fn ax_action(name: &str) -> String {
    if name.is_empty() || name == "press" {
        return "AXPress".to_owned();
    }
    if name.starts_with("AX") {
        return name.to_owned();
    }
    let mut full = "AX".to_owned();
    for part in name
        .split(['-', '_', ' ', '\t', '\n'])
        .filter(|part| !part.is_empty())
    {
        let mut characters = part.chars();
        if let Some(first) = characters.next() {
            full.extend(first.to_uppercase());
            full.push_str(characters.as_str());
        }
    }
    full
}

/// Accessibility tree lines in the format the tool definition promises: "[id] ROLE name=… value=… settable actions=…".
fn format_tree(nodes: &[(u64, &Value)], snapshot_id: &str) -> String {
    let mut lines: Vec<String> = nodes
        .iter()
        .map(|(id, node)| {
            let role = js::text(node.get("role"));
            let mut parts = vec![format!(
                "[{id}] {}",
                role.strip_prefix("AX").unwrap_or(&role)
            )];
            if js::truthy(node.get("name")) {
                parts.push(format!("name={}", node["name"]));
            }
            if js::truthy(node.get("value")) {
                parts.push(format!("value={}", node["value"]));
            }
            if js::truthy(node.get("settable")) {
                parts.push("settable".to_owned());
            }
            let actions = node["actions"].as_array().map_or(&[][..], Vec::as_slice);
            if !actions.is_empty() {
                let names: Vec<String> = actions
                    .iter()
                    .map(|action| action_name(&js::text(Some(action))))
                    .collect();
                parts.push(format!("actions={}", names.join(",")));
            }
            if js::truthy(node.get("omitted")) {
                parts.push(format!(
                    "(+{} descendants omitted)",
                    js::text(node.get("omitted"))
                ));
            }
            let depth = node["depth"].as_u64().unwrap_or(1).saturating_sub(1) as usize;
            format!("{}{}", "  ".repeat(depth), parts.join(" "))
        })
        .collect();
    lines.push(format!("snapshot_id={snapshot_id}"));
    lines.join("\n")
}

/// What may be started: an app, nothing else. `open` and the Windows shell run whatever they are handed, so a script, a
/// document or a web address given as an "app" would run outside the sandbox.
fn assert_launchable(
    bundle_id: &str,
    app_path: &str,
    app_name: &str,
    on_windows: bool,
) -> Result<(), String> {
    let extension = if on_windows { ".exe" } else { ".app" };
    let refuse = |value: &str| {
        format!("{value} is not an app. Give an app's name, bundle id or path ({extension}).")
    };
    let is_path = |value: &str| value.contains(['/', '\\', ':']);
    for value in [bundle_id, app_path, app_name] {
        if value.starts_with('-') {
            return Err(refuse(value));
        }
    }
    if !app_path.is_empty()
        && !app_path
            .trim_end_matches(['/', '\\'])
            .to_lowercase()
            .ends_with(extension)
    {
        return Err(refuse(app_path));
    }
    if is_path(app_name) {
        return Err(refuse(app_name));
    }
    // On Windows a bundle id is the executable's path that computer_apps reports.
    if is_path(bundle_id) && !(on_windows && bundle_id.to_lowercase().ends_with(".exe")) {
        return Err(refuse(bundle_id));
    }
    Ok(())
}

/// The system underneath.
enum Desktop {
    Mac,
    Windows(Helper),
    /// Anything else: only waiting works.
    None,
}

/// Which element each id of a snapshot means.
struct Snapshot {
    id: String,
    pid: i64,
    elements: std::collections::HashMap<i64, Vec<i64>>,
    next: i64,
}

/// The permissions as last asked.
#[derive(Clone, Copy)]
struct Granted {
    accessibility: bool,
    screen_recording: bool,
    at: Instant,
}

/// A string argument, trimmed; nothing for anything else.
fn text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map(js::trim)
        .unwrap_or_default()
        .to_owned()
}

/// A number argument as a whole number, or `fallback` when it holds none.
fn number(value: Option<&Value>, fallback: i64) -> i64 {
    let parsed = js::number(value);
    if parsed.is_finite() {
        round(parsed)
    } else {
        fallback
    }
}

/// An argument under its first name that holds something.
fn either<'a>(args: &'a Value, names: &[&str]) -> Option<&'a Value> {
    names
        .iter()
        .find_map(|name| args.get(*name).filter(|value| !value.is_null()))
}

/// The base name of a path without the extension of a program, in either system's spelling.
fn stem(file: &str) -> String {
    let unified = file.replace('\\', "/");
    let base = unified
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_owned();
    let lower = base.to_lowercase();
    if lower.ends_with(".app") || lower.ends_with(".exe") {
        base[..base.len() - 4].to_owned()
    } else {
        base
    }
}

/// The mouse button asked for.
fn button(args: &Value) -> String {
    let given = js::text(args.get("button"));
    if ["left", "right", "middle"].contains(&given.as_str()) {
        given
    } else {
        "left".to_owned()
    }
}

/// The computer-use tools of a data folder.
pub struct Computer {
    desktop: Desktop,
    granted: Mutex<Option<Granted>>,
    snapshots: Mutex<Vec<Snapshot>>,
    snapshot_count: AtomicU64,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Computer {
    /// The tools for this system.
    pub fn new(data_dir: &Path) -> Self {
        let desktop = if cfg!(target_os = "macos") {
            Desktop::Mac
        } else if cfg!(windows) {
            Desktop::Windows(Helper::new(data_dir, None))
        } else {
            Desktop::None
        };
        Self::with(desktop)
    }

    /// The Windows tools with a program standing in for the helper, on any system (tests).
    pub fn with_windows_stand_in(data_dir: &Path, stand_in: PathBuf) -> Self {
        Self::with(Desktop::Windows(Helper::new(data_dir, Some(stand_in))))
    }

    /// Tools for a system without a desktop to control (tests).
    pub fn unsupported() -> Self {
        Self::with(Desktop::None)
    }

    fn with(desktop: Desktop) -> Self {
        Self {
            desktop,
            granted: Mutex::new(None),
            snapshots: Mutex::new(Vec::new()),
            snapshot_count: AtomicU64::new(0),
        }
    }

    fn helps(&self) -> (&'static str, &'static str, &'static str) {
        if matches!(self.desktop, Desktop::Windows(_)) {
            (
                windows::ACCESSIBILITY_HELP,
                windows::SCREEN_RECORDING_HELP,
                windows::SCREEN_LOCKED_HELP,
            )
        } else {
            (
                macos::ACCESSIBILITY_HELP,
                macos::SCREEN_RECORDING_HELP,
                macos::SCREEN_LOCKED_HELP,
            )
        }
    }

    async fn screen_locked(&self) -> Result<bool, Failure> {
        match &self.desktop {
            Desktop::Mac => macos::screen_locked().await,
            Desktop::Windows(helper) => helper.screen_locked().await,
            Desktop::None => Ok(false),
        }
    }

    async fn display_size(&self) -> Result<(f64, f64), Failure> {
        match &self.desktop {
            Desktop::Mac => macos::display_size().await,
            Desktop::Windows(helper) => helper.display_size().await,
            Desktop::None => Err(Failure::plain(
                "Computer use is available on macOS and Windows.",
            )),
        }
    }

    async fn screen_region(&self) -> Result<Region, Failure> {
        let (width, height) = self.display_size().await?;
        Ok(Region {
            x: 0.0,
            y: 0.0,
            width,
            height,
        })
    }

    async fn capture(&self, region: Option<Region>) -> Result<String, Failure> {
        match &self.desktop {
            Desktop::Mac => macos::capture(region, CANVAS).await,
            Desktop::Windows(helper) => helper.capture(region, CANVAS).await,
            Desktop::None => Err(Failure::plain(
                "Computer use is available on macOS and Windows.",
            )),
        }
    }

    async fn running_apps(&self) -> Result<Vec<Value>, Failure> {
        match &self.desktop {
            Desktop::Mac => macos::running_apps().await,
            Desktop::Windows(helper) => helper.running_apps().await,
            Desktop::None => Ok(Vec::new()),
        }
    }

    async fn activate(&self, pid: i64) -> Result<(), Failure> {
        match &self.desktop {
            Desktop::Mac => macos::activate(pid).await,
            Desktop::Windows(helper) => helper.activate(pid).await,
            Desktop::None => Ok(()),
        }
    }

    async fn mouse(&self, input: Value) -> Result<(), Failure> {
        match &self.desktop {
            Desktop::Mac => macos::mouse(&input).await,
            Desktop::Windows(helper) => helper.mouse(&input).await,
            Desktop::None => Ok(()),
        }
    }

    async fn type_keys(&self, value: &str) -> Result<(), Failure> {
        match &self.desktop {
            Desktop::Mac => macos::type_text(value).await,
            Desktop::Windows(helper) => helper.type_text(value).await,
            Desktop::None => Ok(()),
        }
    }

    async fn set_element(
        &self,
        pid: i64,
        path: &[i64],
        value: &str,
        focus_only: bool,
    ) -> Result<(), Failure> {
        match &self.desktop {
            Desktop::Mac => macos::accessibility_set_value(pid, path, value, focus_only).await,
            Desktop::Windows(helper) => {
                helper
                    .accessibility_set_value(pid, path, value, focus_only)
                    .await
            }
            Desktop::None => Ok(()),
        }
    }

    /// What the settings page shows: whether this computer lets Saturn control it.
    pub async fn permission_status(&self) -> Value {
        if !matches!(self.desktop, Desktop::Mac) {
            let platform = if matches!(self.desktop, Desktop::Windows(_)) {
                "win32"
            } else {
                std::env::consts::OS
            };
            return json!({ "platform": platform, "required": false, "accessibility": true, "screenRecording": true });
        }
        match self.check_permissions().await {
            Ok(status) => json!({
                "platform": "darwin", "required": true,
                "accessibility": js::truthy(status.get("accessibility")),
                "screenRecording": js::truthy(status.get("screenRecording")),
            }),
            Err(error) => {
                json!({ "platform": "darwin", "required": true, "accessibility": false, "screenRecording": false, "error": error })
            }
        }
    }

    /// Runs one of the computer-use tools.
    pub async fn run(&self, tool: &str, args: &Value) -> Result<Value, String> {
        if matches!(self.desktop, Desktop::None) && tool != "computer_wait" {
            return Err("Computer use is available on macOS and Windows.".to_owned());
        }
        // On the lock screen every screenshot is the wallpaper and every click is lost, so say so instead.
        let passive = matches!(
            tool,
            "computer_check_permissions"
                | "computer_apps"
                | "computer_resolve_app"
                | "computer_wait"
                | "computer_start_control"
                | "computer_release_control"
        );
        if !passive && self.screen_locked().await? {
            return Err(self.helps().2.to_owned());
        }
        match tool {
            "computer_check_permissions" => self.check_permissions().await,
            "computer_apps" => {
                let apps = self.running_apps().await?;
                let count = apps.len();
                let apps: Vec<Value> = apps
                    .into_iter()
                    .map(|mut app| {
                        let id = format!("app_{}", js::text(app.get("pid")));
                        app["target_id"] = json!(id);
                        app
                    })
                    .collect();
                Ok(json!({ "apps": apps, "count": count }))
            }
            "computer_resolve_app" => self.resolve_app(args).await,
            "computer_screenshot" => self.screenshot(args).await,
            "computer_click" => self.click(args).await,
            "computer_move" => self.move_to(args).await,
            "computer_drag" => self.drag(args).await,
            "computer_type" => self.type_text(args).await,
            "computer_key" => self.press_key(args).await,
            "computer_scroll" => self.scroll(args).await,
            "computer_wait" => Ok(wait(args).await),
            "computer_start_control" => Ok(
                json!({ "active": true, "display": "primary", "message": "Display control acquired" }),
            ),
            "computer_release_control" => {
                Ok(json!({ "active": false, "message": "Display control released" }))
            }
            "computer_app_state" => self.app_state(args).await,
            "computer_set_value" => self.set_value(args).await,
            "computer_app_action" => self.app_action(args).await,
            _ => Err(format!("Unknown computer use tool: {tool}")),
        }
    }

    async fn check_permissions(&self) -> Result<Value, String> {
        let granted = self.permissions(true).await?;
        let locked = self.screen_locked().await?;
        let (accessibility_help, recording_help, _) = self.helps();
        let status = if !granted.accessibility {
            "requires_accessibility_permission"
        } else if !granted.screen_recording {
            "requires_screen_recording_permission"
        } else {
            "ready"
        };
        let mut answer = json!({
            "accessibility": granted.accessibility,
            "screenRecording": granted.screen_recording,
            "screenLocked": locked,
            "displayAttached": true,
            "canvas": { "width": CANVAS.width, "height": CANVAS.height },
            "status": if status == "ready" && locked { "screen_locked" } else { status },
        });
        if status != "ready" {
            answer["help"] = json!(if granted.accessibility {
                recording_help
            } else {
                accessibility_help
            });
        }
        Ok(answer)
    }

    async fn permissions(&self, fresh: bool) -> Result<Granted, Failure> {
        if !fresh
            && let Some(granted) = *lock(&self.granted)
            && granted.at.elapsed() < PERMISSION_TTL
        {
            return Ok(granted);
        }
        // Windows grants desktop control to every app at the same privilege level, so there is nothing to ask for.
        let (accessibility, screen_recording) = if matches!(self.desktop, Desktop::Mac) {
            macos::permissions().await?
        } else {
            (true, true)
        };
        let granted = Granted {
            accessibility,
            screen_recording,
            at: Instant::now(),
        };
        *lock(&self.granted) = Some(granted);
        Ok(granted)
    }

    /// Input and the accessibility tree are dropped silently by macOS without this permission, so it is checked first.
    async fn require_accessibility(&self) -> Result<(), String> {
        if !self.permissions(false).await?.accessibility {
            *lock(&self.granted) = None;
            return Err(self.helps().0.to_owned());
        }
        Ok(())
    }

    async fn require_screen_recording(&self) -> Result<(), String> {
        if !self.permissions(false).await?.screen_recording {
            *lock(&self.granted) = None;
            return Err(self.helps().1.to_owned());
        }
        Ok(())
    }

    /// Finds an app by exactly one selector, starting it (in the background on macOS) when it is not running.
    async fn resolve_app(&self, args: &Value) -> Result<Value, String> {
        let pid = args.get("pid").and_then(Value::as_f64).unwrap_or(0.0);
        let bundle_id = text(args.get("bundle_id"));
        let app_path = text(args.get("app_path"));
        let name = text(args.get("app_name"));
        let app_name = if name.is_empty() {
            text(args.get("name"))
        } else {
            name
        };
        let given = usize::from(pid != 0.0)
            + usize::from(!bundle_id.is_empty())
            + usize::from(!app_path.is_empty())
            + usize::from(!app_name.is_empty());
        if given != 1 {
            return Err("Give exactly one of pid, bundle_id, app_path or app_name.".to_owned());
        }
        let same = |a: Option<&Value>, b: &str| {
            a.and_then(Value::as_str)
                .is_some_and(|a| !a.is_empty() && a.to_lowercase() == b.to_lowercase())
        };
        let matches_app = |app: &Value| {
            (pid != 0.0 && app.get("pid").and_then(Value::as_f64) == Some(pid))
                || (!bundle_id.is_empty() && same(app.get("bundle_id"), &bundle_id))
                || (!app_name.is_empty()
                    && (same(app.get("name"), &app_name)
                        || same(app.get("process"), &stem(&app_name))))
                || (!app_path.is_empty()
                    && (same(app.get("bundle_id"), &app_path)
                        || same(app.get("name"), &stem(&app_path))
                        || same(app.get("process"), &stem(&app_path))))
        };
        let mut found = self.running_apps().await?.into_iter().find(&matches_app);
        if found.is_none() && pid == 0.0 {
            assert_launchable(
                &bundle_id,
                &app_path,
                &app_name,
                matches!(self.desktop, Desktop::Windows(_)),
            )?;
            match &self.desktop {
                Desktop::Mac => macos::launch_app(&bundle_id, &app_path, &app_name).await?,
                Desktop::Windows(helper) => {
                    helper.launch_app(&bundle_id, &app_path, &app_name).await?
                }
                Desktop::None => {}
            }
            for _ in 0..20 {
                tokio::time::sleep(Duration::from_millis(250)).await;
                found = self.running_apps().await?.into_iter().find(&matches_app);
                if found.is_some() {
                    break;
                }
            }
        }
        let Some(found) = found else {
            let named = if pid != 0.0 {
                format!("pid {}", plain(pid))
            } else {
                [&bundle_id, &app_path, &app_name]
                    .into_iter()
                    .find(|name| !name.is_empty())
                    .cloned()
                    .unwrap_or_default()
            };
            return Err(format!("No running app matches {named}."));
        };
        Ok(
            json!({ "resolved": true, "name": found["name"], "pid": found["pid"], "bundle_id": found["bundle_id"], "target_id": format!("app_{}", js::text(found.get("pid"))) }),
        )
    }

    /// The app a target names, or nothing for the whole screen.
    fn app_target(args: &Value) -> Result<Option<i64>, String> {
        let target = args
            .get("target")
            .filter(|target| !target.is_null())
            .cloned()
            .unwrap_or(json!({}));
        if target.get("scope").and_then(Value::as_str) == Some("screen") {
            return Ok(None);
        }
        let pid = match target.get("pid").filter(|pid| pid.is_number()) {
            Some(pid) => pid.as_f64().unwrap_or(0.0) as i64,
            None => {
                let id = js::text(target.get("target_id"));
                let bare = id.strip_prefix("app_").unwrap_or(&id);
                let parsed = js::number(Some(&json!(bare)));
                if parsed.is_finite() { parsed as i64 } else { 0 }
            }
        };
        if target.get("scope").and_then(Value::as_str) == Some("app") && pid == 0 {
            return Err("An app target needs the pid or target_id from computer_apps or computer_resolve_app.".to_owned());
        }
        Ok((pid != 0).then_some(pid))
    }

    /// The screen region canvas coordinates refer to: the whole display, or the app window its token recorded.
    async fn region_for(&self, args: &Value) -> Result<(Region, Option<i64>), String> {
        let Some(pid) = Self::app_target(args)? else {
            return Ok((self.screen_region().await?, None));
        };
        let token = text(args.get("coordinate_token"));
        if token.is_empty() {
            return Err("With an app target, pass the coordinate_token from the latest computer_screenshot of this app.".to_owned());
        }
        Ok((decode_token(&token, pid)?, Some(pid)))
    }

    async fn screenshot(&self, args: &Value) -> Result<Value, String> {
        self.require_screen_recording().await?;
        let pid = Self::app_target(args)?;
        let region = match pid {
            None => self.screen_region().await?,
            Some(pid) => {
                self.require_accessibility().await?;
                match &self.desktop {
                    Desktop::Windows(helper) => helper.window_frame(pid).await?,
                    _ => macos::window_frame(pid).await?,
                }
            }
        };
        let image = self.capture(pid.map(|_| region)).await?;
        let mut answer = json!({
            "image": image,
            "width": CANVAS.width,
            "height": CANVAS.height,
            "scope": if pid.is_some() { "app" } else { "screen" },
            "region": region.to_value(),
        });
        if let Some(pid) = pid {
            answer["pid"] = json!(pid);
            answer["coordinate_token"] = json!(encode_token(pid, region));
        }
        answer["timestamp"] = json!(iso_time(now_millis()));
        Ok(answer)
    }

    /// After a screen-scope action, a fresh screenshot so the model sees what changed (app-scope results are text).
    async fn after(&self, mut action: Value, pid: Option<i64>) -> Value {
        if pid.is_some() {
            return action;
        }
        tokio::time::sleep(Duration::from_millis(350)).await;
        if let Ok(image) = self.capture(None).await {
            action["image"] = json!(image);
            action["width"] = json!(CANVAS.width);
            action["height"] = json!(CANVAS.height);
        }
        action
    }

    async fn click(&self, args: &Value) -> Result<Value, String> {
        self.require_accessibility().await?;
        let (region, pid) = self.region_for(args).await?;
        if let Some(pid) = pid {
            self.activate(pid).await?;
        }
        let (x, y) = (number(args.get("x"), 0), number(args.get("y"), 0));
        let (screen_x, screen_y) = region.to_screen(x, y);
        let button = button(args);
        let count = number(either(args, &["count", "click_count"]), 1).clamp(1, 3);
        self.mouse(json!({ "kind": "click", "x": screen_x, "y": screen_y, "button": button, "count": count })).await?;
        Ok(self
            .after(
                json!({ "action": "click", "x": x, "y": y, "screen": { "x": screen_x, "y": screen_y }, "button": button, "count": count, "success": true }),
                pid,
            )
            .await)
    }

    async fn move_to(&self, args: &Value) -> Result<Value, String> {
        self.require_accessibility().await?;
        let (region, pid) = self.region_for(args).await?;
        let (x, y) = (number(args.get("x"), 0), number(args.get("y"), 0));
        let (screen_x, screen_y) = region.to_screen(x, y);
        self.mouse(json!({ "kind": "move", "x": screen_x, "y": screen_y }))
            .await?;
        Ok(self
            .after(json!({ "action": "move", "x": x, "y": y, "screen": { "x": screen_x, "y": screen_y }, "success": true }), pid)
            .await)
    }

    async fn drag(&self, args: &Value) -> Result<Value, String> {
        self.require_accessibility().await?;
        let (region, pid) = self.region_for(args).await?;
        if let Some(pid) = pid {
            self.activate(pid).await?;
        }
        let point =
            |name: &str, x: &str, y: &str| match args.get(name).filter(|value| !value.is_null()) {
                Some(point) => (number(point.get("x"), 0), number(point.get("y"), 0)),
                None => (number(args.get(x), 0), number(args.get(y), 0)),
            };
        let (from_x, from_y) = point("from", "start_x", "start_y");
        let (to_x, to_y) = point("to", "end_x", "end_y");
        let (start_x, start_y) = region.to_screen(from_x, from_y);
        let (end_x, end_y) = region.to_screen(to_x, to_y);
        let to = json!({ "x": end_x, "y": end_y });
        self.mouse(
            json!({ "kind": "drag", "x": start_x, "y": start_y, "to": to, "button": button(args) }),
        )
        .await?;
        Ok(self
            .after(json!({ "action": "drag", "from": { "x": start_x, "y": start_y }, "to": to, "success": true }), pid)
            .await)
    }

    async fn scroll(&self, args: &Value) -> Result<Value, String> {
        self.require_accessibility().await?;
        let (region, pid) = self.region_for(args).await?;
        if let Some(pid) = pid {
            self.activate(pid).await?;
        }
        let (screen_x, screen_y) =
            region.to_screen(number(args.get("x"), 0), number(args.get("y"), 0));
        let amount = number(
            args.get("amount")
                .filter(|value| !value.is_null())
                .or(Some(&json!(3))),
            3,
        )
        .clamp(1, 50);
        let given = js::text(args.get("direction"));
        let direction = if ["up", "down", "left", "right"].contains(&given.as_str()) {
            given.as_str()
        } else {
            "down"
        };
        // Wheel ticks: positive moves content down the page view (wheel up), as macOS scroll events count them.
        let dy = match direction {
            "up" => amount,
            "down" => -amount,
            _ => 0,
        };
        let dx = match direction {
            "left" => amount,
            "right" => -amount,
            _ => 0,
        };
        match &self.desktop {
            Desktop::Mac => macos::scroll(screen_x, screen_y, dx, dy).await?,
            Desktop::Windows(helper) => helper.scroll(screen_x, screen_y, dx, dy).await?,
            Desktop::None => {}
        }
        Ok(self
            .after(json!({ "action": "scroll", "direction": direction, "amount": amount, "screen": { "x": screen_x, "y": screen_y }, "success": true }), pid)
            .await)
    }

    async fn press_key(&self, args: &Value) -> Result<Value, String> {
        self.require_accessibility().await?;
        let chord = text(args.get("key"));
        if chord.is_empty() {
            return Err("No key given".to_owned());
        }
        let pid = Self::app_target(args)?;
        if let Some(pid) = pid {
            self.activate(pid).await?;
        }
        match &self.desktop {
            Desktop::Mac => macos::key(&chord).await?,
            Desktop::Windows(helper) => helper.key(&chord).await?,
            Desktop::None => {}
        }
        Ok(self
            .after(
                json!({ "action": "key", "key": chord, "success": true }),
                pid,
            )
            .await)
    }

    async fn type_text(&self, args: &Value) -> Result<Value, String> {
        self.require_accessibility().await?;
        let value = args.get("text").and_then(Value::as_str).unwrap_or_default();
        if value.is_empty() {
            return Err("No text given".to_owned());
        }
        let Some(pid) = Self::app_target(args)? else {
            return Err("Screen-scope typing is refused: type into an app target (from computer_apps or computer_resolve_app).".to_owned());
        };
        self.activate(pid).await?;
        if args.get("element_id").is_some() {
            let path = self.element(args, pid)?;
            self.set_element(pid, &path, "", true).await?;
        }
        self.type_keys(value).await?;
        Ok(json!({ "action": "type", "length": js::length(value), "success": true }))
    }

    /// Reads the app's front-window accessibility tree (or the part under element_id) and numbers its elements.
    async fn app_state(&self, args: &Value) -> Result<Value, String> {
        self.require_accessibility().await?;
        let Some(pid) = Self::app_target(args)? else {
            return Err("computer_app_state needs an app target (from computer_apps or computer_resolve_app).".to_owned());
        };
        let given = text(args.get("snapshot_id"));
        let expanding = args.get("element_id").is_some() && !given.is_empty();
        let root = if expanding {
            self.element(args, pid)?
        } else {
            Vec::new()
        };
        let snapshot_id = if expanding {
            given
        } else {
            let count = self.snapshot_count.fetch_add(1, Ordering::Relaxed);
            format!("snap_{:x}{count:x}", now_millis())
        };
        let tree = match &self.desktop {
            Desktop::Windows(helper) => helper.accessibility_tree(pid, &root, TREE_LIMIT).await?,
            _ => macos::accessibility_tree(pid, &root, TREE_LIMIT).await?,
        };
        let numbered = self.remember(&snapshot_id, pid, expanding, &tree)?;
        if numbered.is_empty() {
            return Ok(
                json!({ "snapshot_id": snapshot_id, "pid": pid, "text": format!("(no elements)\nsnapshot_id={snapshot_id}") }),
            );
        }
        // A big page (a web page full of items, say) is read only partly; the agent hears how to see more.
        let partial = tree.truncated
            || numbered
                .iter()
                .any(|(_, node)| js::truthy(node.get("omitted")));
        let note = if partial {
            "\nThis tree is partial: the app answered slowly or an element holds many children. Expand an element with snapshot_id and its id to read inside it. For a web page, the browser tools (browser_snapshot) read it much faster."
        } else {
            ""
        };
        let mut answer = Map::new();
        answer.insert("snapshot_id".to_owned(), json!(snapshot_id));
        answer.insert("pid".to_owned(), json!(pid));
        answer.insert("count".to_owned(), json!(numbered.len()));
        if tree.truncated {
            answer.insert("truncated".to_owned(), json!(true));
        }
        answer.insert(
            "text".to_owned(),
            json!(format!("{}{note}", format_tree(&numbered, &snapshot_id))),
        );
        Ok(Value::Object(answer))
    }

    /// Gives a tree's elements their ids in the snapshot, which then stays among the recent ones.
    fn remember<'a>(
        &self,
        snapshot_id: &str,
        pid: i64,
        expanding: bool,
        tree: &'a Tree,
    ) -> Result<Vec<(u64, &'a Value)>, String> {
        let mut snapshots = lock(&self.snapshots);
        if !expanding {
            snapshots.push(Snapshot {
                id: snapshot_id.to_owned(),
                pid,
                elements: std::collections::HashMap::new(),
                next: 1,
            });
        }
        let snapshot = snapshots
            .iter_mut()
            .find(|snapshot| snapshot.id == snapshot_id && snapshot.pid == pid)
            .ok_or_else(stale)?;
        let mut numbered = Vec::with_capacity(tree.nodes.len());
        for node in &tree.nodes {
            let id = snapshot.next;
            snapshot.next += 1;
            let path = node["path"].as_array().map_or_else(Vec::new, |path| {
                path.iter().filter_map(Value::as_i64).collect()
            });
            snapshot.elements.insert(id, path);
            numbered.push((id as u64, node));
        }
        let extra = snapshots.len().saturating_sub(SNAPSHOTS_KEPT);
        snapshots.drain(..extra);
        Ok(numbered)
    }

    /// Where the element an id names is, in a recent snapshot of this app.
    fn element(&self, args: &Value, pid: i64) -> Result<Vec<i64>, String> {
        let snapshot_id = text(args.get("snapshot_id"));
        let snapshots = lock(&self.snapshots);
        let snapshot = snapshots
            .iter()
            .find(|snapshot| snapshot.id == snapshot_id && snapshot.pid == pid)
            .ok_or_else(stale)?;
        snapshot
            .elements
            .get(&number(args.get("element_id"), -1))
            .cloned()
            .ok_or_else(|| {
                format!(
                    "Element {} is not in snapshot {snapshot_id}. Read computer_app_state again.",
                    js::text(args.get("element_id"))
                )
            })
    }

    async fn set_value(&self, args: &Value) -> Result<Value, String> {
        self.require_accessibility().await?;
        let Some(pid) = Self::app_target(args)? else {
            return Err("computer_set_value needs an app target.".to_owned());
        };
        let value = args
            .get("value")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let path = self.element(args, pid)?;
        self.set_element(pid, &path, value, false).await?;
        Ok(
            json!({ "action": "set_value", "element_id": args["element_id"], "length": js::length(value), "success": true }),
        )
    }

    async fn app_action(&self, args: &Value) -> Result<Value, String> {
        self.require_accessibility().await?;
        let Some(pid) = Self::app_target(args)? else {
            return Err("computer_app_action needs an app target.".to_owned());
        };
        let action = ax_action(&text(args.get("action")));
        let path = self.element(args, pid)?;
        match &self.desktop {
            Desktop::Windows(helper) => helper.accessibility_action(pid, &path, &action).await?,
            _ => macos::accessibility_action(pid, &path, &action).await?,
        }
        Ok(
            json!({ "action": action_name(&action), "element_id": args["element_id"], "success": true }),
        )
    }
}

/// Why a snapshot id means nothing.
fn stale() -> String {
    "This snapshot is stale or unknown. Read computer_app_state again and use the new ids."
        .to_owned()
}

/// computer_wait: short waits block here; the run loop suspends the run for long ones before they get here.
async fn wait(args: &Value) -> Value {
    let requested =
        either(args, &["ms", "duration_ms"]).map_or(1000.0, |value| js::number(Some(value)));
    let milliseconds = if requested.is_finite() {
        requested.clamp(0.0, LONGEST_WAIT_MS)
    } else {
        1000.0
    };
    let started = Instant::now();
    tokio::time::sleep(Duration::from_secs_f64(milliseconds / 1000.0)).await;
    let mut answer = json!({ "elapsed_ms": started.elapsed().as_millis() as u64 });
    if let Some(reason) = args.get("reason").and_then(Value::as_str) {
        answer["reason"] = json!(reason);
    }
    answer
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_app_can_be_started_on_either_system() {
        assert!(assert_launchable("", "/Applications/Notes.app/", "", false).is_ok());
        assert!(assert_launchable("", "", "Notes", false).is_ok());
        assert!(assert_launchable("com.apple.Notes", "", "", false).is_ok());
        assert!(assert_launchable("", "C:\\Tools\\App.EXE", "", true).is_ok());
        assert!(assert_launchable("C:\\Tools\\App.exe", "", "", true).is_ok());
        assert!(assert_launchable("", "", "notepad", true).is_ok());
        for (bundle, path, name, on_windows) in [
            ("", "/tmp/run.command", "", false),
            ("", "", "/tmp/run.command", false),
            ("", "", "-h", false),
            ("--args", "", "", false),
            ("C:\\Tools\\App.exe", "", "", false),
            ("", "C:\\Tools\\run.bat", "", true),
            ("", "", "https://example.com/", true),
            ("C:\\Tools\\run.ps1", "", "", true),
        ] {
            let refused = assert_launchable(bundle, path, name, on_windows).unwrap_err();
            assert!(refused.contains("is not an app"), "{refused}");
        }
    }

    #[test]
    fn action_names_go_both_ways() {
        assert_eq!(action_name("AXShowMenu"), "show-menu");
        assert_eq!(ax_action("show-menu"), "AXShowMenu");
        assert_eq!(ax_action("AXRaise"), "AXRaise");
        assert_eq!(ax_action(""), "AXPress");
        assert_eq!(ax_action("press"), "AXPress");
    }

    #[test]
    fn windows_chords_mean_the_same_as_in_the_typescript_runtime() {
        let chord = |text: &str| windows::parse_chord(text).map_err(|failure| failure.message);
        assert_eq!(
            chord("cmd+c").unwrap(),
            json!({ "modifiers": [0x11], "vk": 0, "char": "c", "extended": false })
        );
        assert_eq!(
            chord("ctrl+shift+Escape").unwrap(),
            json!({ "modifiers": [0x11, 0x10], "vk": 0x1b, "char": "", "extended": false })
        );
        assert_eq!(
            chord("win+Up").unwrap(),
            json!({ "modifiers": [0x5b], "vk": 0x26, "char": "", "extended": true })
        );
        assert_eq!(
            chord("F5").unwrap(),
            json!({ "modifiers": [], "vk": 0x74, "char": "", "extended": false })
        );
        assert_eq!(
            chord("A").unwrap(),
            json!({ "modifiers": [], "vk": 0, "char": "A", "extended": false })
        );
        assert!(chord("hyper+x").unwrap_err().contains("Unknown modifier"));
        assert!(chord("ctrl+banana").unwrap_err().contains("Unknown key"));
    }
}
