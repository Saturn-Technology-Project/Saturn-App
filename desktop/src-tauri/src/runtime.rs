//! Keeps a Saturn runtime running for this app: starts it, knows it apart from any other Saturn on the port, restarts it
//! when it dies, and says where it stands. The runtime holds a pipe from this app; closing it asks the runtime to stop,
//! on every system, and it closes by itself if this app crashes.
use std::collections::VecDeque;
use std::env;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Notify;
use tokio::time::{sleep, timeout};

const HOST: &str = "127.0.0.1";
/// How long the runtime gets to end its jobs, browser and programs by itself before it is ended.
const STOPPING: Duration = Duration::from_secs(4);
/// How long a start gets before it counts as failed.
const STARTING: Duration = Duration::from_secs(20);
/// Restarts in a row before the app stops trying and waits for the user.
const RESTARTS: u32 = 5;
/// A runtime that stays up this long has started cleanly: the next death starts the count again.
const STEADY: Duration = Duration::from_secs(120);
/// How many lines of the runtime's output are kept for showing why it stopped.
const LOG_LINES: usize = 60;

/// Where the runtime stands, as the interface shows it.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Status {
    /// Starting, or waiting to start again after a death.
    Starting { attempt: u32, log: Vec<String> },
    /// Answering. `own` is false for a runtime this app did not start and only watches.
    Ready { version: String, own: bool },
    /// Something else answers on the port, so this app's runtime cannot start.
    Blocked { reason: String },
    /// It kept dying; the user can ask for another try.
    Failed { reason: String, log: Vec<String> },
}

/// What the health probe says about whoever answers on the port.
struct Answering {
    instance: String,
    version: String,
}

pub struct Runtime {
    port: u16,
    data_directory: PathBuf,
    /// The id this app gives its runtime, so a health answer says whether it is this app's.
    instance: String,
    /// Whether a runtime already on the port may be used instead of starting one: only when the port was chosen
    /// on purpose, as when testing against an isolated runtime.
    adopt: bool,
    child: Mutex<Option<Child>>,
    status: Mutex<Status>,
    log: Arc<Mutex<VecDeque<String>>>,
    /// Set while the app is stopping: a runtime that ends then is not restarted.
    stopping: Mutex<bool>,
    /// Woken when the user asks for another try.
    retry: Notify,
}

/// Where the app's own files are: bundled resources when packaged, the repository in development.
pub enum Layout {
    Packaged { resources: PathBuf },
    Development { repository: PathBuf },
}

impl Runtime {
    pub fn new() -> Self {
        // SATURN_RUNTIME_PORT moves the runtime (and lets a second copy run beside another, e.g. for testing).
        let chosen_port = env::var("SATURN_RUNTIME_PORT")
            .ok()
            .and_then(|port| port.parse().ok());
        let data_directory = env::var_os("SATURN_DATA_DIR")
            .map(PathBuf::from)
            .or_else(|| env::home_dir().map(|home| home.join(".saturn-app")))
            .unwrap_or_else(|| PathBuf::from(".saturn-app"));
        Self {
            port: chosen_port.unwrap_or(4700),
            data_directory,
            instance: format!("{:x}{:x}", std::process::id(), nanos()),
            adopt: chosen_port.is_some(),
            child: Mutex::new(None),
            status: Mutex::new(Status::Starting {
                attempt: 0,
                log: Vec::new(),
            }),
            log: Arc::default(),
            stopping: Mutex::new(false),
            retry: Notify::new(),
        }
    }

    pub fn origin(&self) -> String {
        format!("http://{HOST}:{}", self.port)
    }

    /// The runtime's session token, from the private token file in its data folder.
    pub fn token(&self) -> String {
        std::fs::read_to_string(self.data_directory.join("runtime-token"))
            .map(|token| token.trim().to_owned())
            .unwrap_or_default()
    }

    pub fn status(&self) -> Status {
        self.status
            .lock()
            .expect("the status lock is not poisoned")
            .clone()
    }

    fn set_status(&self, status: Status) {
        *self.status.lock().expect("the status lock is not poisoned") = status;
    }

    fn recent_log(&self) -> Vec<String> {
        self.log
            .lock()
            .expect("the log lock is not poisoned")
            .iter()
            .cloned()
            .collect()
    }

    pub fn is_ready(&self) -> bool {
        matches!(self.status(), Status::Ready { .. })
    }

    /// Keeps a runtime answering until the app stops: this never returns.
    pub async fn supervise(&self, layout: &Layout) {
        let mut attempt = 0;
        loop {
            if *self
                .stopping
                .lock()
                .expect("the stopping lock is not poisoned")
            {
                return;
            }
            match self.probe().await {
                Some(answering) if answering.instance == self.instance => {
                    // Still up from before, as after the user asked for a restart that was not needed.
                    self.set_status(Status::Ready {
                        version: answering.version,
                        own: true,
                    });
                }
                Some(answering) if self.adopt => {
                    self.set_status(Status::Ready {
                        version: answering.version,
                        own: false,
                    });
                    // A runtime this app does not own is only watched.
                    while self.probe().await.is_some() {
                        sleep(Duration::from_secs(2)).await;
                    }
                    self.set_status(Status::Starting {
                        attempt: 0,
                        log: Vec::new(),
                    });
                    continue;
                }
                Some(answering) => {
                    self.set_status(Status::Blocked {
                        reason: format!(
                            "Another Saturn runtime (version {}) is on port {}. Quit it, or start this Saturn with another SATURN_RUNTIME_PORT.",
                            answering.version, self.port
                        ),
                    });
                    tokio::select! {
                        () = sleep(Duration::from_secs(3)) => {}
                        () = self.retry.notified() => {}
                    }
                    continue;
                }
                None => {
                    attempt += 1;
                    self.set_status(Status::Starting {
                        attempt,
                        log: self.recent_log(),
                    });
                    if let Err(reason) = self.start(layout).await {
                        self.set_status(Status::Failed {
                            reason,
                            log: self.recent_log(),
                        });
                        attempt = 0;
                        self.retry.notified().await;
                        continue;
                    }
                }
            }
            let up_since = Instant::now();
            let ended = self.wait_for_exit().await;
            if *self
                .stopping
                .lock()
                .expect("the stopping lock is not poisoned")
            {
                return;
            }
            if up_since.elapsed() > STEADY {
                attempt = 0;
            }
            let reason = format!("Saturn's runtime stopped unexpectedly ({ended}).");
            eprintln!("{reason}");
            if attempt >= RESTARTS {
                self.set_status(Status::Failed {
                    reason: format!("{reason} It was restarted {attempt} times in a row."),
                    log: self.recent_log(),
                });
                attempt = 0;
                self.retry.notified().await;
                continue;
            }
            let wait = Duration::from_secs(1 << attempt.min(4));
            self.set_status(Status::Starting {
                attempt,
                log: self.recent_log(),
            });
            tokio::select! {
                () = sleep(wait) => {}
                () = self.retry.notified() => {}
            }
        }
    }

    /// Starts the runtime and waits until it answers as itself.
    async fn start(&self, layout: &Layout) -> Result<(), String> {
        self.log
            .lock()
            .expect("the log lock is not poisoned")
            .clear();
        let mut child = spawn(layout, self.port, &self.instance)
            .map_err(|error| format!("Saturn's runtime could not be started: {error}"))?;
        if let Some(stderr) = child.stderr.take() {
            let log = Arc::clone(&self.log);
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    eprintln!("{line}");
                    let mut kept = log.lock().expect("the log lock is not poisoned");
                    if kept.len() == LOG_LINES {
                        kept.pop_front();
                    }
                    kept.push_back(line);
                }
            });
        }
        *self.child.lock().expect("the runtime lock is not poisoned") = Some(child);
        let began = Instant::now();
        while began.elapsed() < STARTING {
            match self.probe().await {
                Some(answering) if answering.instance == self.instance => {
                    self.set_status(Status::Ready {
                        version: answering.version,
                        own: true,
                    });
                    return Ok(());
                }
                _ => {}
            }
            if let Some(code) = self.exited() {
                return Err(format!("Saturn's runtime ended as it started ({code})."));
            }
            sleep(Duration::from_millis(250)).await;
        }
        self.end_child();
        Err("Saturn's runtime did not answer within 20 seconds.".to_owned())
    }

    /// How the child ended, if it has.
    fn exited(&self) -> Option<String> {
        let mut held = self.child.lock().expect("the runtime lock is not poisoned");
        let status = held.as_mut()?.try_wait().ok()??;
        held.take();
        Some(status.to_string())
    }

    /// Waits until the child ends, and says how.
    async fn wait_for_exit(&self) -> String {
        loop {
            if let Some(code) = self.exited() {
                return code;
            }
            if self
                .child
                .lock()
                .expect("the runtime lock is not poisoned")
                .is_none()
            {
                // Not this app's child: watched through its health answers instead.
                if self.probe().await.is_none() {
                    return "it stopped answering".to_owned();
                }
                sleep(Duration::from_secs(2)).await;
            } else {
                sleep(Duration::from_millis(500)).await;
            }
        }
    }

    /// The user asks for another try: whatever runs is ended, and the supervisor starts again at once.
    pub fn restart(&self) {
        self.end_child();
        self.set_status(Status::Starting {
            attempt: 0,
            log: self.recent_log(),
        });
        self.retry.notify_one();
    }

    /// Stops the runtime for good, if this app started it.
    pub fn stop(&self) {
        *self
            .stopping
            .lock()
            .expect("the stopping lock is not poisoned") = true;
        self.end_child();
    }

    /// Ends the child gently, then by force.
    fn end_child(&self) {
        let Some(mut child) = self
            .child
            .lock()
            .expect("the runtime lock is not poisoned")
            .take()
        else {
            return;
        };
        drop(child.stdin.take());
        let began = Instant::now();
        while began.elapsed() < STOPPING {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
    }

    /// Who answers the health probe, if anyone.
    async fn probe(&self) -> Option<Answering> {
        let answer = self
            .request("GET", "/health", Duration::from_millis(800))
            .await?;
        Some(Answering {
            instance: answer
                .get("instance")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            version: answer
                .get("version")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned(),
        })
    }

    /// A JSON request with the token; None when the runtime does not answer or refuses.
    async fn request(&self, method: &str, route: &str, limit: Duration) -> Option<Value> {
        let exchange = async {
            let mut stream = TcpStream::connect((HOST, self.port)).await.ok()?;
            // HTTP/1.0: the answer ends when the connection does, with no chunked encoding to undo.
            let head = format!(
                "{method} {route} HTTP/1.0\r\nHost: {HOST}\r\nAuthorization: Bearer {}\r\nContent-Length: 0\r\n\r\n",
                self.token()
            );
            stream.write_all(head.as_bytes()).await.ok()?;
            let mut answer = Vec::new();
            stream.read_to_end(&mut answer).await.ok()?;
            Some(answer)
        };
        parse_answer(&timeout(limit, exchange).await.ok()??)
    }
}

fn nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_nanos())
        .unwrap_or(0)
}

/// The JSON body of a successful HTTP answer (Null when it is empty).
fn parse_answer(answer: &[u8]) -> Option<Value> {
    let text = std::str::from_utf8(answer).ok()?;
    let (head, body) = text.split_once("\r\n\r\n")?;
    let status: u16 = head.split_whitespace().nth(1)?.parse().ok()?;
    if !(200..400).contains(&status) {
        return None;
    }
    if body.is_empty() {
        Some(Value::Null)
    } else {
        serde_json::from_str(body).ok()
    }
}

/// The runtime's program, next to its sibling `saturn`: beside the app's own when packaged, the workspace's build in development.
fn runtime_program(folder: &Path) -> PathBuf {
    folder.join(if cfg!(windows) {
        "saturn-server.exe"
    } else {
        "saturn-server"
    })
}

fn spawn(layout: &Layout, port: u16, instance: &str) -> std::io::Result<Child> {
    let mut command = match layout {
        Layout::Packaged { resources } => {
            let app = env::current_exe()?;
            let folder = app.parent().unwrap_or(resources);
            let mut command = Command::new(runtime_program(folder));
            command.current_dir(resources);
            // The built-in embedding model for the code index ships inside the app.
            command.env("SATURN_MODELS_DIR", resources.join("models"));
            command
        }
        Layout::Development { repository } => {
            let mut command = Command::new(runtime_program(&repository.join("target/debug")));
            command.current_dir(repository);
            command
        }
    };
    command
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .env("SATURN_RUNTIME_HOST", HOST)
        .env("SATURN_RUNTIME_PORT", port.to_string())
        .env("SATURN_RUNTIME_INSTANCE", instance)
        .env("SATURN_DESKTOP_ATTACHED", "1")
        .spawn()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_successful_json_answers() {
        assert_eq!(
            parse_answer(b"HTTP/1.0 200 OK\r\nA: b\r\n\r\n{\"ok\":true}"),
            Some(serde_json::json!({ "ok": true }))
        );
        assert_eq!(
            parse_answer(b"HTTP/1.0 204 No Content\r\n\r\n"),
            Some(Value::Null)
        );
        assert_eq!(
            parse_answer(b"HTTP/1.0 401 Unauthorized\r\n\r\n{\"error\":\"x\"}"),
            None
        );
        assert_eq!(parse_answer(b"not http"), None);
    }

    #[test]
    fn a_status_is_told_apart_by_its_state() {
        let text = serde_json::to_string(&Status::Ready {
            version: "1.0.0".into(),
            own: true,
        })
        .unwrap();
        assert_eq!(text, r#"{"state":"ready","version":"1.0.0","own":true}"#);
    }
}
