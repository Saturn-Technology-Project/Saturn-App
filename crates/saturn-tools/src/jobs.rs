//! Background commands: a dev server, a watcher, a long build an agent starts with `code` and `background: true`, then
//! reads with `code_output` and ends with `code_stop`. Jobs belong to a scope (the chat, or the agent outside one) and
//! outlive the turn that started them; they end with the chat, the runtime, or on request.
use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use saturn_domain::time::{iso_time, now_millis};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Child;
use tokio::sync::watch;

use crate::process;
use crate::shell::Invocation;

/// Bytes of a job's most recent output kept for reading.
pub const OUTPUT_LIMIT: usize = 64 * 1024;
/// Jobs one scope may have at once.
pub const MAX_JOBS: usize = 8;
/// A finished job stays readable this long, in milliseconds.
const KEEP_FINISHED_MILLIS: i64 = 60 * 60 * 1000;
/// The longest one read waits for more.
const LONGEST_WAIT: Duration = Duration::from_secs(30);

/// What is known about a background command.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub id: String,
    pub scope: String,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    /// Once it ended: its exit code, or null when a signal ended it or it never started.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<Option<i32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<Option<String>>,
    pub running: bool,
    /// Bytes of output seen so far (the last OUTPUT_LIMIT are kept).
    pub bytes: u64,
}

/// A job's view and the output kept for reading.
#[derive(Debug)]
struct Recorded {
    view: JobView,
    ended_millis: i64,
    chunks: VecDeque<Vec<u8>>,
    kept: usize,
}

#[derive(Debug)]
struct Job {
    recorded: Mutex<Recorded>,
    /// Counts what happened, so a reader can wait for more output or the end.
    changes: watch::Sender<u64>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Job {
    fn view(&self) -> JobView {
        locked(&self.recorded).view.clone()
    }

    fn take(&self, chunk: &[u8]) {
        {
            let mut recorded = locked(&self.recorded);
            recorded.view.bytes += chunk.len() as u64;
            recorded.chunks.push_back(chunk.to_vec());
            recorded.kept += chunk.len();
            while recorded.kept > OUTPUT_LIMIT && recorded.chunks.len() > 1 {
                if let Some(dropped) = recorded.chunks.pop_front() {
                    recorded.kept -= dropped.len();
                }
            }
        }
        self.changes.send_modify(|count| *count += 1);
    }

    fn end(&self, code: Option<i32>, signal: Option<String>) {
        {
            let mut recorded = locked(&self.recorded);
            if !recorded.view.running {
                return;
            }
            let now = now_millis();
            recorded.ended_millis = now;
            recorded.view.running = false;
            recorded.view.exit_code = Some(code);
            recorded.view.signal = Some(signal);
            recorded.view.ended_at = Some(iso_time(now));
        }
        self.changes.send_modify(|count| *count += 1);
    }

    /// Ends the command's process group, by force if it does not end in a moment.
    fn kill(self: &Arc<Self>) {
        let view = self.view();
        let (true, Some(pid)) = (view.running, view.pid) else {
            return;
        };
        process::terminate(pid);
        let job = Arc::clone(self);
        process::force_after_grace(pid, move || job.view().running);
    }
}

/// The background commands of this runtime.
#[derive(Clone, Debug, Default)]
pub struct JobTable {
    jobs: Arc<Mutex<Vec<Arc<Job>>>>,
}

impl JobTable {
    /// A table with no jobs.
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts a command. One that cannot start is a job that already ended, with the reason as its output.
    pub fn start(
        &self,
        scope: &str,
        command: &str,
        invocation: &Invocation,
        cwd: &Path,
        env: &[(OsString, OsString)],
    ) -> Result<JobView, String> {
        self.reap();
        let running = self
            .list(Some(scope))
            .iter()
            .filter(|job| job.running)
            .count();
        if running >= MAX_JOBS {
            return Err(format!(
                "This chat already runs {MAX_JOBS} background commands; stop one with code_stop first."
            ));
        }
        let id = saturn_domain::new_id("job").map_err(|error| error.to_string())?;
        let spawned = process::command(invocation, cwd, env).spawn();
        let pid = spawned.as_ref().ok().and_then(Child::id);
        let job = Arc::new(Job {
            recorded: Mutex::new(Recorded {
                view: JobView {
                    id,
                    scope: scope.to_owned(),
                    command: command.to_owned(),
                    pid,
                    started_at: iso_time(now_millis()),
                    ended_at: None,
                    exit_code: None,
                    signal: None,
                    running: true,
                    bytes: 0,
                },
                ended_millis: 0,
                chunks: VecDeque::new(),
                kept: 0,
            }),
            changes: watch::Sender::new(0),
        });
        match spawned {
            Ok(mut child) => {
                if let Some(stdout) = child.stdout.take() {
                    tokio::spawn(read_into(Arc::clone(&job), stdout));
                }
                if let Some(stderr) = child.stderr.take() {
                    tokio::spawn(read_into(Arc::clone(&job), stderr));
                }
                tokio::spawn(wait_for_end(Arc::clone(&job), child));
            }
            Err(error) => {
                job.take(format!("{error}\n").as_bytes());
                job.end(None, None);
            }
        }
        let view = job.view();
        locked(&self.jobs).push(job);
        Ok(view)
    }

    fn find(&self, id: &str) -> Option<Arc<Job>> {
        locked(&self.jobs)
            .iter()
            .find(|job| locked(&job.recorded).view.id == id)
            .cloned()
    }

    /// Resolves when the job ends (at once for an ended or unknown job).
    pub async fn when_ended(&self, id: &str) {
        if let Some(job) = self.find(id) {
            let mut changes = job.changes.subscribe();
            while job.view().running {
                if changes.changed().await.is_err() {
                    return;
                }
            }
        }
    }

    /// The job with this id.
    pub fn get(&self, id: &str) -> Option<JobView> {
        self.find(id).map(|job| job.view())
    }

    /// The jobs of a scope, or all of them, oldest first.
    pub fn list(&self, scope: Option<&str>) -> Vec<JobView> {
        self.reap();
        locked(&self.jobs)
            .iter()
            .map(|job| job.view())
            .filter(|job| scope.is_none_or(|scope| job.scope == scope))
            .collect()
    }

    /// The job's recent output, after waiting up to `wait` for more output or its end.
    pub async fn output(&self, id: &str, wait: Duration) -> Result<(JobView, String), String> {
        let job = self.find(id).ok_or_else(|| {
            format!(
                "No background command {id}. It may have been stopped, or belong to another chat."
            )
        })?;
        let mut changes = job.changes.subscribe();
        if !wait.is_zero() && job.view().running {
            // Either way there is something to read back.
            let _ = tokio::time::timeout(wait.min(LONGEST_WAIT), changes.changed()).await;
        }
        let recorded = locked(&job.recorded);
        let bytes: Vec<u8> = recorded.chunks.iter().flatten().copied().collect();
        Ok((
            recorded.view.clone(),
            String::from_utf8_lossy(&bytes).into_owned(),
        ))
    }

    /// Ends a job.
    pub fn stop(&self, id: &str) -> Result<JobView, String> {
        let job = self
            .find(id)
            .ok_or_else(|| format!("No background command {id}"))?;
        job.kill();
        Ok(job.view())
    }

    /// Ends every job of a scope (the chat was deleted), or every job at all (the runtime stops). Returns how many were
    /// still running.
    pub fn stop_all(&self, scope: Option<&str>) -> usize {
        let mut jobs = locked(&self.jobs);
        let mut count = 0;
        jobs.retain(|job| {
            let view = job.view();
            if scope.is_some_and(|scope| view.scope != scope) {
                return true;
            }
            if view.running {
                count += 1;
            }
            job.kill();
            scope.is_none()
        });
        count
    }

    fn reap(&self) {
        let cutoff = now_millis() - KEEP_FINISHED_MILLIS;
        locked(&self.jobs).retain(|job| {
            let recorded = locked(&job.recorded);
            recorded.view.running || recorded.ended_millis >= cutoff
        });
    }
}

async fn read_into(job: Arc<Job>, mut stream: impl AsyncRead + Unpin) {
    let mut buffer = vec![0u8; 16 * 1024];
    while let Ok(count) = stream.read(&mut buffer).await {
        if count == 0 {
            return;
        }
        job.take(&buffer[..count]);
    }
}

async fn wait_for_end(job: Arc<Job>, mut child: Child) {
    match child.wait().await {
        Ok(status) => job.end(status.code(), signal_of(status)),
        Err(error) => {
            job.take(format!("{error}\n").as_bytes());
            job.end(None, None);
        }
    }
}

/// The name of the signal that ended a command.
#[cfg(unix)]
fn signal_of(status: std::process::ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    let number = status.signal()?;
    Some(match number {
        1 => "SIGHUP".to_owned(),
        2 => "SIGINT".to_owned(),
        3 => "SIGQUIT".to_owned(),
        6 => "SIGABRT".to_owned(),
        9 => "SIGKILL".to_owned(),
        11 => "SIGSEGV".to_owned(),
        13 => "SIGPIPE".to_owned(),
        15 => "SIGTERM".to_owned(),
        other => format!("SIG{other}"),
    })
}

/// Windows has no signals.
#[cfg(not(unix))]
fn signal_of(_status: std::process::ExitStatus) -> Option<String> {
    None
}
