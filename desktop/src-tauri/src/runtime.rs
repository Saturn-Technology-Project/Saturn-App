//! Starts the Saturn runtime, or reuses one already answering on its port, and talks to it. The runtime holds a pipe from this app:
//! closing it asks the runtime to stop, on every system, and it closes by itself if this app crashes.
use std::env;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::{sleep, timeout};

const HOST: &str = "127.0.0.1";
/// How long the runtime gets to end its jobs, browser and programs by itself before it is ended.
const STOPPING: Duration = Duration::from_secs(4);

pub struct Runtime {
    port: u16,
    data_directory: PathBuf,
    child: Mutex<Option<Child>>,
}

/// Where the app's own files are: bundled resources when packaged, the repository in development.
pub enum Layout {
    Packaged { resources: PathBuf },
    Development { repository: PathBuf },
}

impl Runtime {
    pub fn new() -> Self {
        // SATURN_RUNTIME_PORT moves the runtime (and lets a second copy run beside another, e.g. for testing).
        let port = env::var("SATURN_RUNTIME_PORT")
            .ok()
            .and_then(|port| port.parse().ok())
            .unwrap_or(4700);
        let data_directory = env::var_os("SATURN_DATA_DIR")
            .map(PathBuf::from)
            .or_else(|| env::home_dir().map(|home| home.join(".saturn-app")))
            .unwrap_or_else(|| PathBuf::from(".saturn-app"));
        Self {
            port,
            data_directory,
            child: Mutex::new(None),
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

    /// Makes sure a runtime answers: reuses a running one, or starts one and waits up to 10 seconds.
    pub async fn ensure_started(&self, layout: &Layout) {
        if self.healthy().await {
            return;
        }
        match spawn(layout, self.port) {
            Ok(child) => {
                *self.child.lock().expect("the runtime lock is not poisoned") = Some(child)
            }
            Err(error) => {
                eprintln!("Saturn Runtime did not start. {error}");
                return;
            }
        }
        for _ in 0..40 {
            if self.healthy().await {
                return;
            }
            sleep(Duration::from_millis(250)).await;
        }
        eprintln!("Saturn Runtime did not become ready.");
    }

    /// Stops the runtime if this app started it.
    pub fn stop(&self) {
        let Some(mut child) = self
            .child
            .lock()
            .expect("the runtime lock is not poisoned")
            .take()
        else {
            return;
        };
        drop(child.stdin.take());
        let began = std::time::Instant::now();
        while began.elapsed() < STOPPING {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
    }

    async fn healthy(&self) -> bool {
        self.request("GET", "/health", Duration::from_millis(500))
            .await
            .is_some()
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

fn spawn(layout: &Layout, port: u16) -> std::io::Result<Child> {
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
        .env("SATURN_RUNTIME_HOST", HOST)
        .env("SATURN_RUNTIME_PORT", port.to_string())
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
}
