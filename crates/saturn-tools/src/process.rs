//! Starting a command in its own process group and ending the whole group, so a shell's children (the server it started)
//! go with it.
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::shell::Invocation;

/// The environment for a program started for the user: the runtime's own, minus what only makes sense for this process.
pub fn launch_env(command: &mut Command) {
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy();
        if name.starts_with("ELECTRON_")
            || name == "SATURN_DESKTOP_ATTACHED"
            || name == "SATURN_DESKTOP_PID"
            || name == "SATURN_RUNTIME_TOKEN"
        {
            command.env_remove(&key);
        }
    }
}

/// How long a stopped command gets to end by itself.
const GRACE: Duration = Duration::from_secs(2);

/// A command with pipes for its output and nothing to read, in a group of its own.
pub(crate) fn command(
    invocation: &Invocation,
    cwd: &Path,
    env: &[(std::ffi::OsString, std::ffi::OsString)],
) -> Command {
    let mut command = Command::new(&invocation.file);
    add_arguments(&mut command, invocation);
    command
        .current_dir(cwd)
        .env_clear()
        .envs(env.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    in_own_group(&mut command);
    command
}

#[cfg(unix)]
fn add_arguments(command: &mut Command, invocation: &Invocation) {
    command.args(&invocation.args);
}

/// cmd does not understand the \" escaping the usual quoting would add, so its arguments go as they are.
#[cfg(windows)]
fn add_arguments(command: &mut Command, invocation: &Invocation) {
    if invocation.verbatim {
        for argument in &invocation.args {
            command.raw_arg(argument);
        }
    } else {
        command.args(&invocation.args);
    }
}

#[cfg(unix)]
fn in_own_group(command: &mut Command) {
    command.process_group(0);
}

/// Windows has no process groups; a command also must not open a console window of its own.
#[cfg(windows)]
fn in_own_group(command: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

/// Asks the group to end. Sends nothing when the group is gone.
#[cfg(unix)]
pub(crate) fn terminate(pid: u32) {
    signal_group(pid, rustix::process::Signal::TERM);
}

/// Ends the group at once.
#[cfg(unix)]
pub(crate) fn force(pid: u32) {
    signal_group(pid, rustix::process::Signal::KILL);
}

#[cfg(unix)]
fn signal_group(pid: u32, signal: rustix::process::Signal) {
    let group = i32::try_from(pid)
        .ok()
        .and_then(rustix::process::Pid::from_raw);
    if let Some(group) = group {
        // Already gone is what was wanted.
        let _ = rustix::process::kill_process_group(group, signal);
    }
}

/// `taskkill /T` ends the shell and everything it started.
#[cfg(windows)]
pub(crate) fn terminate(pid: u32) {
    use std::process::Command as Plain;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    use std::os::windows::process::CommandExt;
    let _ = Plain::new("taskkill")
        .args(["/pid", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

/// `terminate` already ended it by force.
#[cfg(windows)]
pub(crate) fn force(_pid: u32) {}

/// After the grace period, ends by force what `still_running` says is left. Without a runtime (the process is ending)
/// there is nothing to wait in.
pub(crate) fn force_after_grace(pid: u32, still_running: impl FnOnce() -> bool + Send + 'static) {
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        runtime.spawn(async move {
            tokio::time::sleep(GRACE).await;
            if still_running() {
                force(pid);
            }
        });
    }
}

/// Ends a command's group when dropped, unless it finished: this is what stopping a run or a timeout does to it.
pub(crate) struct EndOnDrop {
    pid: Option<u32>,
}

impl EndOnDrop {
    pub(crate) fn new(pid: Option<u32>) -> Self {
        Self { pid }
    }

    /// The command finished by itself; what it left running on purpose stays.
    pub(crate) fn finished(&mut self) {
        self.pid = None;
    }
}

impl Drop for EndOnDrop {
    fn drop(&mut self) {
        if let Some(pid) = self.pid {
            terminate(pid);
            force_after_grace(pid, || true);
        }
    }
}

/// How a captured command ended.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Captured {
    /// The exit code; `None` when it was ended by a signal, timed out or could not start.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// Keeps the last `limit` bytes a pipe gives, as text.
async fn tail_of(mut pipe: impl AsyncRead + Unpin, limit: usize) -> String {
    let mut kept = Vec::new();
    let mut chunk = [0_u8; 8192];
    while let Ok(read) = pipe.read(&mut chunk).await {
        if read == 0 {
            break;
        }
        kept.extend_from_slice(&chunk[..read]);
        if kept.len() > limit {
            kept.drain(..kept.len() - limit);
        }
    }
    String::from_utf8_lossy(&kept).into_owned()
}

/// Runs a command that writes for someone to read afterwards (a hook, a project's check) in its own group, with `input` on its
/// stdin and the last `limit` bytes of its output kept. Dropping the future or running out of time ends the whole group.
pub async fn run_captured(
    invocation: &Invocation,
    cwd: &Path,
    env: &[(std::ffi::OsString, std::ffi::OsString)],
    input: &[u8],
    timeout: Duration,
    limit: usize,
) -> Captured {
    let mut prepared = command(invocation, cwd, env);
    prepared.stdin(Stdio::piped());
    let mut child = match prepared.spawn() {
        Ok(child) => child,
        Err(error) => {
            return Captured {
                stderr: error.to_string(),
                ..Captured::default()
            };
        }
    };
    let mut guard = EndOnDrop::new(child.id());
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let feeding = async {
        if let Some(mut stdin) = stdin {
            // A command that does not read its input is not a failure.
            let _ = stdin.write_all(input).await;
        }
    };
    let reading_out = async {
        match stdout {
            Some(pipe) => tail_of(pipe, limit).await,
            None => String::new(),
        }
    };
    let reading_error = async {
        match stderr {
            Some(pipe) => tail_of(pipe, limit).await,
            None => String::new(),
        }
    };
    let finishing = async {
        let (_, stdout, stderr, status) =
            tokio::join!(feeding, reading_out, reading_error, child.wait());
        (stdout, stderr, status)
    };
    match tokio::time::timeout(timeout, finishing).await {
        Ok((stdout, stderr, status)) => {
            guard.finished();
            Captured {
                code: status.ok().and_then(|status| status.code()),
                stdout,
                stderr,
                timed_out: false,
            }
        }
        // The guard ends the group as it goes out of scope.
        Err(_) => Captured {
            timed_out: true,
            ..Captured::default()
        },
    }
}
