//! The desktop on macOS: JXA (JavaScript for Automation), CoreGraphics events, accessibility, and `screencapture`.
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use regex::Regex;
use saturn_domain::js;
use saturn_domain::time::now_millis;
use saturn_tools::launch_env;
use serde_json::{Value, json};
use tokio::process::Command;

use crate::{Canvas, Failure, Region, Tree};

/// What the user has to do when macOS refuses input or the accessibility tree.
pub(crate) const ACCESSIBILITY_HELP: &str = "Saturn needs the Accessibility permission to control apps. Open System Settings → Privacy & Security → Accessibility and turn on Saturn. If Saturn is already on but this keeps happening, remove it with the − button and add it again: each Saturn update is a new app to macOS.";
/// What the user has to do when macOS refuses screenshots.
pub(crate) const SCREEN_RECORDING_HELP: &str = "Saturn needs the Screen Recording permission to take screenshots. Open System Settings → Privacy & Security → Screen & System Audio Recording and turn on Saturn, then restart Saturn. If it is already on, remove it with the − button and add it again: each Saturn update is a new app to macOS.";
/// What the agent tells the user when the screen is locked.
pub(crate) const SCREEN_LOCKED_HELP: &str = "The Mac's screen is locked, so nothing on it can be seen or controlled. Ask the user to unlock it, then try again.";
const AUTOMATION_HELP: &str = "Saturn is not allowed to control System Events. Open System Settings → Privacy & Security → Automation and allow Saturn to control System Events.";

/// How long a script or program gets.
const TIMEOUT: Duration = Duration::from_secs(15);
/// How long reading an element tree may take; the script stops by itself at its budget and hands over what it read.
const TREE_BUDGET_MS: u64 = 18_000;

/// A macOS program, by its full path; SATURN_DESKTOP_BIN puts stand-ins in their place, so tests never touch the real screen.
fn program(name: &str, folder: &str) -> PathBuf {
    std::env::var_os("SATURN_DESKTOP_BIN")
        .filter(|value| !value.is_empty())
        .map_or_else(|| PathBuf::from(folder), PathBuf::from)
        .join(name)
}

/// macOS errors in the user's terms: a missing permission says where to grant it; anything else keeps its message.
fn explain(stderr: &str) -> Failure {
    let lower = stderr.to_lowercase();
    if [
        "-25211",
        "-1719",
        "assistive access",
        "not allowed assistive",
        "not trusted",
    ]
    .iter()
    .any(|sign| lower.contains(sign))
    {
        return Failure::permission(ACCESSIBILITY_HELP);
    }
    if [
        "-1743",
        "not authorized to send apple events",
        "not allowed to send",
    ]
    .iter()
    .any(|sign| lower.contains(sign))
    {
        return Failure::permission(AUTOMATION_HELP);
    }
    // osascript prints "execution error: Error: <message> (-2700)"; keep only the message.
    let after = stderr
        .rfind("execution error:")
        .map_or(stderr, |at| &stderr[at + "execution error:".len()..]);
    let code = Regex::new(r"\s*\(-?\d+\)\s*$").expect("a valid pattern");
    let mut detail = code.replace(after, "").trim().to_owned();
    while let Some(rest) = detail.strip_prefix("Error:") {
        detail = rest.trim_start().to_owned();
    }
    if detail.is_empty() {
        Failure::plain("The macOS action failed")
    } else {
        Failure::plain(detail)
    }
}

/// Runs a program to its end; what it printed, or why not.
async fn run(mut command: Command, timeout: Duration) -> Result<Vec<u8>, Failure> {
    launch_env(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = command
        .spawn()
        .map_err(|error| Failure::plain(error.to_string()))?;
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| {
            Failure::plain("macOS did not answer in time; the app may be busy. Try again.")
        })?
        .map_err(|error| Failure::plain(error.to_string()))?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(explain(&String::from_utf8_lossy(&output.stderr)))
    }
}

/// Runs a JXA script. Its `run(argv)` receives `params` as JSON in argv[0], so no value is ever spliced into the script
/// text, and whatever it returns comes back parsed from JSON.
async fn jxa(script: &str, params: &Value, timeout: Duration) -> Result<Value, Failure> {
    let mut command = Command::new(program("osascript", "/usr/bin"));
    command
        .args(["-l", "JavaScript", "-e", script])
        .arg(params.to_string());
    let printed = run(command, timeout).await?;
    let text = String::from_utf8_lossy(&printed);
    let text = text.trim();
    if text.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(text).map_err(|error| Failure::plain(error.to_string()))
}

/// The same, for a script that only acts.
async fn act(script: &str, params: &Value) -> Result<(), Failure> {
    jxa(script, params, TIMEOUT).await.map(|_| ())
}

/// Asks macOS itself (AXIsProcessTrusted, CGPreflightScreenCaptureAccess) for the permissions Saturn holds.
pub(crate) async fn permissions() -> Result<(bool, bool), Failure> {
    let granted = jxa(include_str!("macos/permissions.js"), &json!({}), TIMEOUT).await?;
    Ok((
        js::truthy(granted.get("accessibility")),
        js::truthy(granted.get("screenRecording")),
    ))
}

/// True while the Mac shows its lock screen: nothing can be seen or clicked until the user unlocks it.
pub(crate) async fn screen_locked() -> Result<bool, Failure> {
    Ok(js::truthy(Some(
        &jxa(include_str!("macos/screen_locked.js"), &json!({}), TIMEOUT).await?,
    )))
}

/// The main display's size in points (the coordinate space mouse events use).
pub(crate) async fn display_size() -> Result<(f64, f64), Failure> {
    let size = jxa(include_str!("macos/display_size.js"), &json!({}), TIMEOUT).await?;
    Ok((
        js::number(size.get("width")),
        js::number(size.get("height")),
    ))
}

/// Real mouse input through CoreGraphics events, in screen points. Without the Accessibility permission macOS drops these
/// events silently, so callers check `permissions` first.
pub(crate) async fn mouse(input: &Value) -> Result<(), Failure> {
    act(include_str!("macos/mouse.js"), input).await
}

/// Scroll wheel ticks at a screen point: positive `dy` scrolls content up (wheel away), as on a mouse.
pub(crate) async fn scroll(x: i64, y: i64, dx: i64, dy: i64) -> Result<(), Failure> {
    act(
        include_str!("macos/scroll.js"),
        &json!({ "x": x, "y": y, "dx": dx, "dy": dy }),
    )
    .await
}

/// macOS virtual key codes for named keys (Events.h); letters and digits go through System Events keystrokes.
fn key_code(name: &str) -> Option<u32> {
    Some(match name {
        "return" | "enter" => 36,
        "tab" => 48,
        "space" => 49,
        "delete" | "backspace" => 51,
        "escape" | "esc" => 53,
        "forwarddelete" => 117,
        "home" => 115,
        "end" => 119,
        "pageup" => 116,
        "pagedown" => 121,
        "left" | "arrowleft" => 123,
        "right" | "arrowright" => 124,
        "down" | "arrowdown" => 125,
        "up" | "arrowup" => 126,
        "f1" => 122,
        "f2" => 120,
        "f3" => 99,
        "f4" => 118,
        "f5" => 96,
        "f6" => 97,
        "f7" => 98,
        "f8" => 100,
        "f9" => 101,
        "f10" => 109,
        "f11" => 103,
        "f12" => 111,
        _ => return None,
    })
}

/// "cmd+shift+s" → the key and the System Events modifiers it needs; refuses a name it does not know.
fn parse_chord(chord: &str) -> Result<Value, Failure> {
    let mut parts: Vec<&str> = chord
        .split('+')
        .map(js::trim)
        .filter(|part| !part.is_empty())
        .collect();
    let last = parts.pop().ok_or_else(|| Failure::plain("No key given"))?;
    let mut modifiers = Vec::new();
    for part in parts {
        modifiers.push(match part.to_lowercase().as_str() {
            "cmd" | "command" | "meta" | "super" => "command down",
            "ctrl" | "control" => "control down",
            "alt" | "option" | "opt" => "option down",
            "shift" => "shift down",
            _ => {
                return Err(Failure::plain(format!(
                    "Unknown modifier \"{part}\". Use cmd, ctrl, alt or shift."
                )));
            }
        });
    }
    if let Some(code) = key_code(&last.to_lowercase()) {
        return Ok(json!({ "key": last, "code": code, "modifiers": modifiers }));
    }
    if last.chars().count() != 1 {
        return Err(Failure::plain(format!(
            "Unknown key \"{last}\". Use a single character or a name like Return, Tab, Escape, Up or F5."
        )));
    }
    Ok(json!({ "key": last.to_lowercase(), "modifiers": modifiers }))
}

/// Presses a key or chord in the frontmost app.
pub(crate) async fn key(chord: &str) -> Result<(), Failure> {
    act(include_str!("macos/key.js"), &parse_chord(chord)?).await
}

/// Types text into the focused field of the frontmost app. Plain ASCII is typed as keystrokes; anything else (Chinese,
/// emoji…) is pasted, and the clipboard is put back afterwards.
pub(crate) async fn type_text(text: &str) -> Result<(), Failure> {
    act(include_str!("macos/type_text.js"), &json!({ "text": text })).await
}

/// Regular running apps (those with a Dock icon), frontmost first. Needs no permission.
pub(crate) async fn running_apps() -> Result<Vec<Value>, Failure> {
    let apps = jxa(include_str!("macos/running_apps.js"), &json!({}), TIMEOUT).await?;
    let mut apps = apps.as_array().cloned().unwrap_or_default();
    apps.sort_by_key(|app| !js::truthy(app.get("frontmost")));
    Ok(apps)
}

/// Brings an app's windows forward, so input lands in it.
pub(crate) async fn activate(pid: i64) -> Result<(), Failure> {
    act(include_str!("macos/activate.js"), &json!({ "pid": pid })).await
}

/// The front window's frame in screen points, through accessibility.
pub(crate) async fn window_frame(pid: i64) -> Result<Region, Failure> {
    let frame = jxa(
        include_str!("macos/window_frame.js"),
        &json!({ "pid": pid }),
        TIMEOUT,
    )
    .await?;
    Ok(Region::from_value(&frame))
}

/// Reads an app's front-window accessibility tree breadth-first, up to `limit` elements. `root` starts below an element
/// instead. A big web page can take System Events longer than any timeout, so the script has a time budget and returns
/// what it read so far (`truncated`).
pub(crate) async fn accessibility_tree(
    pid: i64,
    root: &[i64],
    limit: usize,
) -> Result<Tree, Failure> {
    let params = json!({ "pid": pid, "root": root, "limit": limit, "depth": 12, "budget": TREE_BUDGET_MS, "wide": 150 });
    let timeout = Duration::from_millis(TREE_BUDGET_MS) + TIMEOUT;
    let mut tree = read_tree(&params, timeout).await?;
    // WebKit builds a web view's tree only once something asks for it: the first read of a window holding one (Saturn
    // itself, Safari, any WebKit app) finds an empty group where the page will be. It is read again once it is built.
    for _ in 0..WEB_VIEW_RETRIES {
        if !root.is_empty() || !web_view_unbuilt(&tree.nodes) {
            break;
        }
        tokio::time::sleep(WEB_VIEW_WAIT).await;
        let again = read_tree(&params, timeout).await?;
        if again.nodes.len() > tree.nodes.len() {
            tree = again;
        }
    }
    Ok(tree)
}

/// How often a window whose web view has not built its tree yet is read again, and how long to wait each time.
const WEB_VIEW_RETRIES: usize = 3;
const WEB_VIEW_WAIT: Duration = Duration::from_millis(400);

/// One read of a front window's tree.
async fn read_tree(params: &Value, timeout: Duration) -> Result<Tree, Failure> {
    let read = jxa(include_str!("macos/tree.js"), params, timeout).await?;
    Ok(Tree {
        nodes: read["nodes"].as_array().cloned().unwrap_or_default(),
        truncated: js::truthy(read.get("truncated")),
    })
}

/// Whether a window's tree looks like a web view that has not built its tree yet: an unnamed group or scroll area near
/// the window with nothing in it, in a tree of only a few elements.
pub(crate) fn web_view_unbuilt(nodes: &[Value]) -> bool {
    if nodes.len() > 24 {
        return false;
    }
    let path = |node: &Value| -> Vec<i64> {
        node["path"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_i64)
            .collect()
    };
    let paths: Vec<Vec<i64>> = nodes.iter().map(path).collect();
    nodes.iter().zip(&paths).any(|(node, own)| {
        let role = node["role"].as_str().unwrap_or_default();
        let empty_name = node["name"].as_str().is_none_or(str::is_empty);
        let leaf = !paths
            .iter()
            .any(|other| other.len() > own.len() && other.starts_with(own));
        matches!(role, "AXGroup" | "AXScrollArea")
            && empty_name
            && leaf
            && node["depth"].as_u64().is_some_and(|depth| depth <= 3)
    })
}

/// Performs an accessibility action ("AXPress", "AXShowMenu"…) on the element at `path` in the front window.
pub(crate) async fn accessibility_action(
    pid: i64,
    path: &[i64],
    action: &str,
) -> Result<(), Failure> {
    act(
        include_str!("macos/action.js"),
        &json!({ "pid": pid, "path": path, "action": action }),
    )
    .await
}

/// Sets the value of the element at `path` in the front window, focusing it first.
pub(crate) async fn accessibility_set_value(
    pid: i64,
    path: &[i64],
    value: &str,
    focus_only: bool,
) -> Result<(), Failure> {
    act(
        include_str!("macos/set_value.js"),
        &json!({ "pid": pid, "path": path, "value": value, "focusOnly": focus_only }),
    )
    .await
}

/// Takes the picture; the caller removes the two files whatever happens.
async fn take(
    region: Option<Region>,
    canvas: Canvas,
    raw: &PathBuf,
    jpeg: &PathBuf,
) -> Result<Vec<u8>, Failure> {
    let mut shoot = Command::new(program("screencapture", "/usr/sbin"));
    shoot.args(["-x", "-C", "-t", "png"]);
    match region {
        Some(region) => {
            shoot.arg("-R").arg(region.rounded());
        }
        None => {
            shoot.arg("-m");
        }
    }
    shoot.arg(raw);
    run(shoot, TIMEOUT).await?;
    let mut shrink = Command::new(program("sips", "/usr/bin"));
    shrink
        .args(["-z", &canvas.height.to_string(), &canvas.width.to_string()])
        .args(["-s", "format", "jpeg", "-s", "formatOptions", "70"])
        .arg(raw)
        .arg("--out")
        .arg(jpeg);
    run(shrink, TIMEOUT).await?;
    tokio::fs::read(jpeg)
        .await
        .map_err(|error| Failure::plain(error.to_string()))
}

/// A screenshot of the display (or of `region`, in points) stretched to the canvas, as a JPEG data URL. Refuses instead of
/// returning a blank image when macOS refuses it.
pub(crate) async fn capture(region: Option<Region>, canvas: Canvas) -> Result<String, Failure> {
    let stem = format!("saturn-shot-{}-{}", std::process::id(), now_millis());
    let folder = std::env::temp_dir();
    let (raw, jpeg) = (
        folder.join(format!("{stem}.png")),
        folder.join(format!("{stem}.jpg")),
    );
    let taken = take(region, canvas, &raw, &jpeg).await;
    let _ = tokio::fs::remove_file(&raw).await;
    let _ = tokio::fs::remove_file(&jpeg).await;
    let taken = taken.and_then(|bytes| {
        if bytes.len() < 1000 {
            Err(Failure::plain("macOS returned an empty screenshot"))
        } else {
            Ok(bytes)
        }
    });
    match taken {
        Ok(bytes) => Ok(format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes))),
        Err(failure) if failure.permission => Err(failure),
        Err(failure) => Err(Failure::plain(format!(
            "Could not take a screenshot: {}",
            failure.message
        ))),
    }
}

/// Opens an app in the background (`open -g`) by bundle id, .app path or name.
pub(crate) async fn launch_app(
    bundle_id: &str,
    app_path: &str,
    app_name: &str,
) -> Result<(), Failure> {
    let mut command = Command::new(program("open", "/usr/bin"));
    command.arg("-g");
    if !bundle_id.is_empty() {
        command.args(["-b", bundle_id]);
    } else if !app_path.is_empty() {
        command.arg(app_path);
    } else {
        command.args(["-a", app_name]);
    }
    run(command, TIMEOUT).await.map(|_| ()).map_err(|failure| {
        let named = [bundle_id, app_path, app_name]
            .into_iter()
            .find(|name| !name.is_empty())
            .unwrap_or_default();
        Failure::plain(format!("Could not open {named}: {}", failure.message))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(path: &[i64], role: &str, name: &str) -> Value {
        json!({ "path": path, "depth": path.len(), "role": role, "name": name })
    }

    #[test]
    fn a_web_view_not_built_yet_is_an_empty_group_near_the_window() {
        // Saturn's window on the first read: the traffic lights, and two nested groups with nothing in them.
        let first = [
            node(&[0], "AXButton", ""),
            node(&[1], "AXButton", ""),
            node(&[2], "AXButton", ""),
            node(&[3], "AXGroup", ""),
            node(&[3, 0], "AXGroup", ""),
        ];
        assert!(web_view_unbuilt(&first));
    }

    #[test]
    fn a_built_page_or_a_plain_native_window_is_read_once() {
        let built = [
            node(&[0], "AXButton", ""),
            node(&[3], "AXGroup", ""),
            node(&[3, 0], "AXGroup", ""),
            node(&[3, 0, 0], "AXScrollArea", ""),
            node(&[3, 0, 0, 0], "AXWebArea", "Home – Saturn"),
            node(&[3, 0, 0, 0, 0], "AXButton", "Home"),
        ];
        assert!(!web_view_unbuilt(&built));
        let native = [
            node(&[0], "AXButton", ""),
            node(&[1], "AXTextField", "Name"),
            node(&[2], "AXGroup", "Options"),
        ];
        assert!(
            !web_view_unbuilt(&native),
            "a named group is the app's own, not a page being built"
        );
        let many: Vec<Value> = (0..30).map(|i| node(&[i], "AXGroup", "")).collect();
        assert!(!web_view_unbuilt(&many), "a large tree is read as it is");
    }
}
