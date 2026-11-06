//! The desktop on Windows: SendInput and UI Automation, through one long-lived Windows PowerShell process running a
//! compiled C# helper. Starting PowerShell and compiling costs about a second, so it happens once; requests then take
//! milliseconds. Restarted if it exits.
//!
//! Plain code on every system, so its protocol can be tested anywhere with a stand-in for the helper.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use saturn_domain::js;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{Mutex as AsyncMutex, oneshot};

use crate::{Canvas, Failure, Region, Tree};

/// Windows asks for no permission; what blocks input is an app running as administrator (UIPI).
pub(crate) const ACCESSIBILITY_HELP: &str = "Windows blocked input to this app. It is probably running as administrator, and Windows only lets Saturn control apps at Saturn's own privilege level. Run the app normally, or run Saturn as administrator.";
pub(crate) const SCREEN_RECORDING_HELP: &str = "Windows did not return a screenshot. Make sure the screen is on and not showing the lock screen or a UAC prompt.";
pub(crate) const SCREEN_LOCKED_HELP: &str = "The Windows screen is locked (or showing a secure desktop such as a UAC prompt), so nothing on it can be seen or controlled. Ask the user to unlock it, then try again.";

const SCRIPT: &str = include_str!("windows/helper.ps1");
const SOURCE: &str = include_str!("windows/helper.cs");
/// How long the helper gets to compile and start.
const START_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a request gets, unless it says otherwise.
const CALL_TIMEOUT: Duration = Duration::from_secs(20);
const SLOW_TIMEOUT: Duration = Duration::from_secs(60);

type Answers = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, Failure>>>>>;

/// The running helper.
struct Running {
    stdin: Arc<AsyncMutex<ChildStdin>>,
    alive: Arc<std::sync::atomic::AtomicBool>,
}

/// The helper process and what is waiting for it.
pub(crate) struct Helper {
    data_dir: PathBuf,
    /// A program to run instead of PowerShell with the helper (tests).
    stand_in: Option<PathBuf>,
    running: AsyncMutex<Option<Running>>,
    answers: Answers,
    next: AtomicU64,
}

/// Windows errors in the user's terms.
fn explain(message: &str) -> Failure {
    let lower = message.to_lowercase();
    if ["administrator", "access is denied", "uipi"]
        .iter()
        .any(|sign| lower.contains(sign))
    {
        return Failure::permission(ACCESSIBILITY_HELP);
    }
    if message.is_empty() {
        Failure::plain("The Windows action failed")
    } else {
        Failure::plain(message)
    }
}

fn table<T>(answers: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    answers.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Helper {
    pub fn new(data_dir: &Path, stand_in: Option<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.to_path_buf(),
            stand_in,
            running: AsyncMutex::new(None),
            answers: Answers::default(),
            next: AtomicU64::new(1),
        }
    }

    /// The command that starts the helper. Its files live in the data folder and are written anew, so what runs is always
    /// what this version carries.
    async fn command(&self) -> Result<Command, Failure> {
        if let Some(stand_in) = &self.stand_in {
            return Ok(Command::new(stand_in));
        }
        let mut hash = Sha256::new();
        hash.update(SOURCE);
        hash.update(SCRIPT);
        let name = saturn_domain::research::hex(&hash.finalize()[..6]);
        let folder = self.data_dir.join("desktop-helper");
        let unwritable = |error: std::io::Error| {
            Failure::plain(format!("The Windows desktop helper did not start: {error}"))
        };
        tokio::fs::create_dir_all(&folder)
            .await
            .map_err(unwritable)?;
        let script = folder.join(format!("saturn-desktop-{name}.ps1"));
        let source = folder.join(format!("saturn-desktop-{name}.cs"));
        tokio::fs::write(&script, SCRIPT)
            .await
            .map_err(unwritable)?;
        tokio::fs::write(&source, SOURCE)
            .await
            .map_err(unwritable)?;
        let system = std::env::var_os("SystemRoot")
            .map_or_else(|| PathBuf::from("C:\\Windows"), PathBuf::from);
        let mut command =
            Command::new(system.join("System32\\WindowsPowerShell\\v1.0\\powershell.exe"));
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(script)
            .arg(source);
        Ok(command)
    }

    /// Starts the helper and waits until it says it is ready.
    async fn start(&self) -> Result<Running, Failure> {
        let mut command = self.command().await?;
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|error| {
            Failure::plain(format!("The Windows desktop helper did not start: {error}"))
        })?;
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            return Err(Failure::plain("The Windows desktop helper did not start"));
        };
        let said = Arc::new(Mutex::new(String::new()));
        let kept = Arc::clone(&said);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut said = table(&kept);
                said.push_str(&line);
                said.push('\n');
                if said.len() > 4000 {
                    let cut = said.floor_char_boundary(said.len() - 4000);
                    said.drain(..cut);
                }
            }
        });
        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let (ready, is_ready) = oneshot::channel();
        let (answers, flag, last_words) = (
            Arc::clone(&self.answers),
            Arc::clone(&alive),
            Arc::clone(&said),
        );
        tokio::spawn(async move {
            let mut ready = Some(ready);
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if js::truthy(message.get("ready")) {
                    if let Some(ready) = ready.take() {
                        let _ = ready.send(());
                    }
                    continue;
                }
                let waiting = message
                    .get("id")
                    .and_then(Value::as_u64)
                    .and_then(|id| table(&answers).remove(&id));
                if let Some(waiting) = waiting {
                    let _ = waiting.send(if js::truthy(message.get("ok")) {
                        Ok(message.get("result").cloned().unwrap_or(Value::Null))
                    } else {
                        Err(explain(&js::text(message.get("error"))))
                    });
                }
            }
            flag.store(false, Ordering::Relaxed);
            let status = child.wait().await.ok().and_then(|status| status.code());
            let words = table(&last_words).trim().to_owned();
            let reason = format!(
                "The Windows desktop helper stopped ({}): {}",
                status.map_or_else(|| "signal".to_owned(), |code| code.to_string()),
                js::suffix(&words, 500)
            );
            for (_, waiting) in table(&answers).drain() {
                let _ = waiting.send(Err(Failure::plain(reason.clone())));
            }
        });
        match tokio::time::timeout(START_TIMEOUT, is_ready).await {
            Ok(Ok(())) => Ok(Running {
                stdin: Arc::new(AsyncMutex::new(stdin)),
                alive,
            }),
            _ => {
                let words = table(&said).trim().to_owned();
                let shown = if words.is_empty() {
                    "no answer".to_owned()
                } else {
                    words
                };
                Err(Failure::plain(format!(
                    "The Windows desktop helper did not start: {shown}"
                )))
            }
        }
    }

    /// One request to the helper.
    pub async fn call(
        &self,
        operation: &str,
        args: Value,
        timeout: Duration,
    ) -> Result<Value, Failure> {
        let stdin = {
            let mut running = self.running.lock().await;
            let usable = running
                .as_ref()
                .filter(|running| running.alive.load(Ordering::Relaxed));
            match usable {
                Some(running) => Arc::clone(&running.stdin),
                None => {
                    let started = self.start().await?;
                    let stdin = Arc::clone(&started.stdin);
                    *running = Some(started);
                    stdin
                }
            }
        };
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let mut request = json!({ "id": id, "op": operation });
        if let Value::Object(fields) = args {
            request.as_object_mut().expect("an object").extend(fields);
        }
        let (waiter, answer) = oneshot::channel();
        table(&self.answers).insert(id, waiter);
        let sent = stdin
            .lock()
            .await
            .write_all(format!("{request}\n").as_bytes())
            .await;
        if let Err(error) = sent {
            table(&self.answers).remove(&id);
            return Err(Failure::plain(format!(
                "The Windows desktop helper stopped: {error}"
            )));
        }
        match tokio::time::timeout(timeout, answer).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(Failure::plain("The Windows desktop helper stopped")),
            Err(_) => {
                table(&self.answers).remove(&id);
                Err(Failure::plain(
                    "Windows did not answer in time; the app may be busy. Try again.",
                ))
            }
        }
    }

    async fn quick(&self, operation: &str, args: Value) -> Result<Value, Failure> {
        self.call(operation, args, CALL_TIMEOUT).await
    }

    pub async fn screen_locked(&self) -> Result<bool, Failure> {
        Ok(js::truthy(Some(&self.quick("locked", json!({})).await?)))
    }

    pub async fn display_size(&self) -> Result<(f64, f64), Failure> {
        let size = self.quick("display", json!({})).await?;
        Ok((
            js::number(size.get("width")),
            js::number(size.get("height")),
        ))
    }

    pub async fn capture(&self, region: Option<Region>, canvas: Canvas) -> Result<String, Failure> {
        let area = match region {
            Some(region) => region,
            None => {
                let (width, height) = self.display_size().await?;
                Region {
                    x: 0.0,
                    y: 0.0,
                    width,
                    height,
                }
            }
        };
        let request = json!({
            "x": crate::round(area.x), "y": crate::round(area.y),
            "width": crate::round(area.width), "height": crate::round(area.height),
            "canvasWidth": canvas.width, "canvasHeight": canvas.height,
        });
        let shot = self.call("capture", request, Duration::from_secs(30)).await;
        let could_not =
            |message: &str| Failure::plain(format!("Could not take a screenshot: {message}"));
        let shot = shot.map_err(|failure| could_not(&failure.message))?;
        let base64 = shot.as_str().unwrap_or_default();
        if base64.len() < 1000 {
            return Err(could_not("Windows returned an empty screenshot"));
        }
        Ok(format!("data:image/jpeg;base64,{base64}"))
    }

    pub async fn running_apps(&self) -> Result<Vec<Value>, Failure> {
        let apps = self.quick("apps", json!({})).await?;
        let mut apps = apps.as_array().cloned().unwrap_or_default();
        apps.sort_by_cached_key(|app| {
            (
                !js::truthy(app.get("frontmost")),
                js::text(app.get("name")).to_lowercase(),
            )
        });
        Ok(apps)
    }

    /// Starts an app by executable path or name ("notepad", "calc", a full path).
    pub async fn launch_app(
        &self,
        bundle_id: &str,
        app_path: &str,
        app_name: &str,
    ) -> Result<(), Failure> {
        let target = [app_path, bundle_id, app_name]
            .into_iter()
            .find(|name| !name.is_empty())
            .unwrap_or_default();
        self.quick("launch", json!({ "target": target }))
            .await
            .map(|_| ())
            .map_err(|failure| {
                Failure::plain(format!("Could not open {target}: {}", failure.message))
            })
    }

    pub async fn activate(&self, pid: i64) -> Result<(), Failure> {
        self.quick("activate", json!({ "pid": pid }))
            .await
            .map(|_| ())
    }

    pub async fn window_frame(&self, pid: i64) -> Result<Region, Failure> {
        Ok(Region::from_value(
            &self.quick("frame", json!({ "pid": pid })).await?,
        ))
    }

    /// `input` as the tools build it: `to` and the rest may be missing.
    pub async fn mouse(&self, input: &Value) -> Result<(), Failure> {
        let request = json!({
            "kind": input["kind"], "x": input["x"], "y": input["y"],
            "toX": input["to"].get("x").unwrap_or(&input["x"]), "toY": input["to"].get("y").unwrap_or(&input["y"]),
            "button": input.get("button").cloned().unwrap_or(json!("left")),
            "count": input.get("count").cloned().unwrap_or(json!(1)),
        });
        self.quick("mouse", request).await.map(|_| ())
    }

    /// Wheel ticks at a screen point, with the same signs as on macOS: positive `dy` scrolls up, positive `dx` left.
    pub async fn scroll(&self, x: i64, y: i64, dx: i64, dy: i64) -> Result<(), Failure> {
        self.quick("scroll", json!({ "x": x, "y": y, "dx": dx, "dy": dy }))
            .await
            .map(|_| ())
    }

    pub async fn key(&self, chord: &str) -> Result<(), Failure> {
        self.quick("key", parse_chord(chord)?).await.map(|_| ())
    }

    /// Types text into the focused field as Unicode input, so any language works and the clipboard is never touched.
    pub async fn type_text(&self, text: &str) -> Result<(), Failure> {
        self.call("type", json!({ "text": text }), SLOW_TIMEOUT)
            .await
            .map(|_| ())
    }

    pub async fn accessibility_tree(
        &self,
        pid: i64,
        root: &[i64],
        limit: usize,
    ) -> Result<Tree, Failure> {
        let read = self
            .call(
                "tree",
                json!({ "pid": pid, "root": root, "limit": limit, "depth": 12 }),
                SLOW_TIMEOUT,
            )
            .await?;
        Ok(Tree {
            nodes: read.as_array().cloned().unwrap_or_default(),
            truncated: false,
        })
    }

    pub async fn accessibility_action(
        &self,
        pid: i64,
        path: &[i64],
        action: &str,
    ) -> Result<(), Failure> {
        self.quick(
            "action",
            json!({ "pid": pid, "path": path, "action": action }),
        )
        .await
        .map(|_| ())
    }

    pub async fn accessibility_set_value(
        &self,
        pid: i64,
        path: &[i64],
        value: &str,
        focus_only: bool,
    ) -> Result<(), Failure> {
        self.quick(
            "setValue",
            json!({ "pid": pid, "path": path, "value": value, "focusOnly": focus_only }),
        )
        .await
        .map(|_| ())
    }
}

/// A named key's Windows virtual-key code; "extended" keys need the extended-key flag to reach the right key.
fn named_key(name: &str) -> Option<(u32, bool)> {
    Some(match name {
        "return" | "enter" => (0x0d, false),
        "tab" => (0x09, false),
        "space" => (0x20, false),
        "backspace" => (0x08, false),
        "delete" | "forwarddelete" => (0x2e, true),
        "escape" | "esc" => (0x1b, false),
        "insert" => (0x2d, true),
        "home" => (0x24, true),
        "end" => (0x23, true),
        "pageup" => (0x21, true),
        "pagedown" => (0x22, true),
        "left" | "arrowleft" => (0x25, true),
        "up" | "arrowup" => (0x26, true),
        "right" | "arrowright" => (0x27, true),
        "down" | "arrowdown" => (0x28, true),
        _ => {
            let number: u32 = name.strip_prefix('f')?.parse().ok()?;
            if !(1..=12).contains(&number) {
                return None;
            }
            (0x70 + number - 1, false)
        }
    })
}

/// A chord for the helper. cmd and command mean Ctrl here, so shortcuts written the macOS way ("cmd+c") still work.
pub(crate) fn parse_chord(chord: &str) -> Result<Value, Failure> {
    let mut parts: Vec<&str> = chord
        .split('+')
        .map(js::trim)
        .filter(|part| !part.is_empty())
        .collect();
    let last = parts.pop().ok_or_else(|| Failure::plain("No key given"))?;
    let mut modifiers = Vec::new();
    for part in parts {
        modifiers.push(match part.to_lowercase().as_str() {
            "ctrl" | "control" | "cmd" | "command" => 0x11,
            "alt" | "option" | "opt" => 0x12,
            "shift" => 0x10,
            "win" | "super" | "meta" => 0x5b,
            _ => {
                return Err(Failure::plain(format!(
                    "Unknown modifier \"{part}\". Use ctrl, alt, shift or win."
                )));
            }
        });
    }
    if let Some((vk, extended)) = named_key(&last.to_lowercase()) {
        return Ok(json!({ "modifiers": modifiers, "vk": vk, "char": "", "extended": extended }));
    }
    if last.chars().count() != 1 {
        return Err(Failure::plain(format!(
            "Unknown key \"{last}\". Use a single character or a name like Return, Tab, Escape, Up or F5."
        )));
    }
    // With a modifier, a letter is the key itself (ctrl+a, not ctrl+shift+a for "A").
    let character = if modifiers.is_empty() {
        last.to_owned()
    } else {
        last.to_lowercase()
    };
    Ok(json!({ "modifiers": modifiers, "vk": 0, "char": character, "extended": false }))
}
