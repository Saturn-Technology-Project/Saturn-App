//! Starting a command in its own process group and ending the whole group, so a shell's children (the server it started)
//! go with it.
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use crate::shell::Invocation;

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
