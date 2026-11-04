//! The browser an agent drives. Pages are read as text with element ids rather than as pixels, so actions name what they
//! mean. Set in Settings → General → Agent browser:
//! - "saturn" (default): Chrome without a window, its page streaming live into the app's Browser panel;
//! - "system": a visible Chrome window, with Saturn's own profile, never the user's;
//! - "safari": a Safari automation window on macOS, through safaridriver.
//!
//! Every way a cursor drawn in the page moves to what the agent points at and ripples when it clicks.
mod cdp;
mod chrome;
mod files;
mod safari;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::process::Child;
use tokio::sync::{Mutex as AsyncMutex, broadcast, oneshot};
use tokio::task::JoinHandle;

use chrome::Chrome;
use safari::Safari;

/// How long the browser stays open after the last call.
const IDLE: Duration = Duration::from_secs(5 * 60);
/// Frames a slow viewer may fall behind by before it skips some.
const FRAME_BUFFER: usize = 8;
/// How long a program gets to end by itself when asked to.
const GRACE: Duration = Duration::from_secs(2);

/// Which browser the agent uses.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mode {
    Saturn,
    System,
    Safari,
}

impl Mode {
    /// The setting's value; anything unknown is the default.
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("system") => Self::System,
            Some("safari") => Self::Safari,
            _ => Self::Saturn,
        }
    }

    /// The name the setting and the live view use.
    fn name(self) -> &'static str {
        match self {
            Self::Saturn => "saturn",
            Self::System => "system",
            Self::Safari => "safari",
        }
    }
}

/// The page's address and title as last seen.
#[derive(Clone)]
pub(crate) struct Page {
    pub url: String,
    pub title: String,
}

impl Default for Page {
    fn default() -> Self {
        Self {
            url: "about:blank".to_owned(),
            title: String::new(),
        }
    }
}

/// A recording in progress: frames in a folder, listed for ffmpeg when it stops.
pub(crate) struct Recording {
    pub folder: PathBuf,
    pub frames: u64,
    pub started: Instant,
    pub lines: Vec<String>,
}

impl Recording {
    /// Starts a recording in the folder of `name`.
    pub async fn start(data_dir: &Path, name: Option<&Value>) -> Result<Self, String> {
        let folder = data_dir
            .join("workspace")
            .join("recordings")
            .join(files::recording_name(name));
        tokio::fs::create_dir_all(&folder)
            .await
            .map_err(|error| error.to_string())?;
        Ok(Self {
            folder,
            frames: 0,
            started: Instant::now(),
            lines: Vec::new(),
        })
    }

    /// Saves the next frame; a frame that cannot be saved is left out.
    pub fn add(&mut self, extension: &str, bytes: &[u8]) {
        let name = format!("frame-{:05}.{extension}", self.frames + 1);
        if std::fs::write(self.folder.join(&name), bytes).is_ok() {
            self.frames += 1;
            self.lines.push(format!("file '{name}'"));
        }
    }

    /// Writes the list for ffmpeg, each frame shown for `duration` seconds, and says what was recorded.
    pub async fn finish(self, duration: &str) -> Result<Value, String> {
        let list: Vec<String> = self
            .lines
            .iter()
            .map(|line| format!("{line}\nduration {duration}"))
            .collect();
        tokio::fs::write(
            self.folder.join("frames.txt"),
            format!("{}\n", list.join("\n")),
        )
        .await
        .map_err(|error| error.to_string())?;
        let tenths = (self.started.elapsed().as_millis() as f64 / 100.0).round();
        Ok(json!({
            "recording": self.folder.to_string_lossy(),
            "frames": self.frames,
            "seconds": tenths / 10.0,
        }))
    }
}

/// Who watches the page, and how frames reach them.
pub(crate) struct Viewers {
    frames: broadcast::Sender<Arc<Value>>,
    count: AtomicUsize,
}

impl Viewers {
    /// Whether anyone wants frames.
    pub fn watched(&self) -> bool {
        self.count.load(Ordering::Relaxed) > 0
    }

    /// Hands a frame to whoever watches.
    pub fn emit(&self, frame: Value) {
        let _ = self.frames.send(Arc::new(frame));
    }
}

/// A program the browser depends on, ended when asked to or when it ends by itself.
pub(crate) struct Supervised {
    stop: oneshot::Sender<()>,
    done: JoinHandle<()>,
}

impl Supervised {
    /// Watches a program; `on_exit` runs when it has ended.
    pub fn watch(mut child: Child, on_exit: impl FnOnce() + Send + 'static) -> Self {
        let (stop, stopping) = oneshot::channel();
        let done = tokio::spawn(async move {
            tokio::select! {
                _ = child.wait() => {}
                _ = stopping => {
                    // A program asked to end through its own protocol gets a moment first.
                    if tokio::time::timeout(GRACE, child.wait()).await.is_err() {
                        let _ = child.kill().await;
                    }
                }
            }
            on_exit();
        });
        Self { stop, done }
    }

    /// Ends the program and waits until it has.
    pub async fn end(self) {
        let _ = self.stop.send(());
        let _ = self.done.await;
    }
}

/// Locks shared state; a panic elsewhere leaves it usable.
pub(crate) fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

struct Inner {
    mode: Mutex<Mode>,
    /// One tool at a time: snapshot ids are only good for the next action, and one call starts the browser.
    busy: AsyncMutex<()>,
    chrome: Arc<Chrome>,
    safari: Arc<Safari>,
    viewers: Arc<Viewers>,
    idle_after: Duration,
    idle: Mutex<Option<JoinHandle<()>>>,
}

/// The agent's browser of a data folder. It closes itself when idle.
#[derive(Clone)]
pub struct Browser {
    inner: Arc<Inner>,
}

/// One viewer of the page. Frames stop being made once the last one goes.
pub struct Viewer {
    frames: broadcast::Receiver<Arc<Value>>,
    browser: Browser,
}

impl Viewer {
    /// The next frame. A viewer that fell behind gets the newest instead of the ones it missed.
    pub async fn next(&mut self) -> Option<Arc<Value>> {
        loop {
            match self.frames.recv().await {
                Ok(frame) => return Some(frame),
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    }
}

impl Drop for Viewer {
    fn drop(&mut self) {
        self.browser
            .inner
            .viewers
            .count
            .fetch_sub(1, Ordering::Relaxed);
        self.browser.sync_frames();
    }
}

impl Browser {
    /// The browser of `data_dir`. `safari_endpoint` is a running WebDriver server to use instead of safaridriver (tests).
    pub fn new(data_dir: &Path, safari_endpoint: Option<String>) -> Self {
        Self::with_idle(data_dir, safari_endpoint, IDLE)
    }

    /// The same with its own idle time (tests).
    pub fn with_idle(
        data_dir: &Path,
        safari_endpoint: Option<String>,
        idle_after: Duration,
    ) -> Self {
        let (frames, _) = broadcast::channel(FRAME_BUFFER);
        let viewers = Arc::new(Viewers {
            frames,
            count: AtomicUsize::new(0),
        });
        Self {
            inner: Arc::new(Inner {
                mode: Mutex::new(Mode::Saturn),
                busy: AsyncMutex::new(()),
                chrome: Arc::new(Chrome::new(data_dir, Arc::clone(&viewers))),
                safari: Arc::new(Safari::new(data_dir, Arc::clone(&viewers), safari_endpoint)),
                viewers,
                idle_after,
                idle: Mutex::new(None),
            }),
        }
    }

    fn mode(&self) -> Mode {
        *locked(&self.inner.mode)
    }

    /// Which browser to use from the next launch; a running browser of the other kind is closed.
    pub async fn set_mode(&self, mode: Mode) {
        if mode == self.mode() {
            return;
        }
        let _busy = self.inner.busy.lock().await;
        *locked(&self.inner.mode) = mode;
        self.inner.chrome.close().await;
        self.inner.safari.close().await;
    }

    /// What the live view shows when it opens.
    pub fn state(&self) -> Value {
        let mode = self.mode();
        let (open, page) = if mode == Mode::Safari {
            self.inner.safari.state()
        } else {
            self.inner.chrome.state()
        };
        json!({ "open": open, "mode": mode.name(), "url": page.url, "title": page.title })
    }

    /// Starts watching the page; frames come while the browser is open.
    pub fn watch(&self) -> Viewer {
        let frames = self.inner.viewers.frames.subscribe();
        self.inner.viewers.count.fetch_add(1, Ordering::Relaxed);
        self.sync_frames();
        Viewer {
            frames,
            browser: self.clone(),
        }
    }

    /// Makes frames while a viewer or a recording needs them.
    fn sync_frames(&self) {
        let chrome = Arc::clone(&self.inner.chrome);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move { chrome.sync_frames().await });
        }
        self.inner.safari.sync_frames();
    }

    /// Runs one of the browser tools.
    pub async fn run(&self, tool: &str, args: &Value) -> Result<Value, String> {
        self.touch();
        let _busy = self.inner.busy.lock().await;
        if self.mode() == Mode::Safari {
            self.inner.safari.run(tool, args).await
        } else {
            self.inner.chrome.run(tool, args, self.mode()).await
        }
    }

    /// Closes the browser, as idleness and quitting do.
    pub async fn close(&self) {
        let _busy = self.inner.busy.lock().await;
        self.inner.safari.close().await;
        self.inner.chrome.close().await;
    }

    /// Starts the idle time over.
    fn touch(&self) {
        let browser = self.clone();
        let after = self.inner.idle_after;
        let timer = tokio::spawn(async move {
            tokio::time::sleep(after).await;
            // On its own task: the next call's touch ends this timer, which must not cut a close short.
            tokio::spawn(async move { browser.close().await });
        });
        if let Some(previous) = locked(&self.inner.idle).replace(timer) {
            previous.abort();
        }
    }
}

/// The pause between an action and reading the page, so what it caused shows.
pub(crate) async fn settle(milliseconds: u64) {
    tokio::time::sleep(Duration::from_millis(milliseconds)).await;
}

/// `direction` and how many pixels a scroll goes, as [x, y].
pub(crate) fn scroll_by(args: &Value) -> (String, f64, f64) {
    use saturn_domain::js;
    let given = js::text(args.get("direction"));
    let direction = if ["up", "down", "left", "right"].contains(&given.as_str()) {
        given
    } else {
        "down".to_owned()
    };
    let pixels = js::number(args.get("pixels"));
    let amount = if pixels.is_nan() || pixels == 0.0 {
        600.0
    } else {
        pixels
    }
    .clamp(100.0, 5000.0);
    let x = match direction.as_str() {
        "left" => -amount,
        "right" => amount,
        _ => 0.0,
    };
    let y = match direction.as_str() {
        "up" => -amount,
        "down" => amount,
        _ => 0.0,
    };
    (direction, x, y)
}

/// A number as JSON has it: whole numbers without a fraction.
pub(crate) fn plain_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}
