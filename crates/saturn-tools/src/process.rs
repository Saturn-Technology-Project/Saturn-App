//! Starting a command in its own process group and ending the whole group, so a shell's children (the server it started)
//! go with it.
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::shell::Invocation;

/// Variables that only make sense for this process: the launcher's token, and how the desktop app or Electron started
/// it. No program Saturn starts gets them.
pub const OWN_VARIABLES: [&str; 3] = [
    "SATURN_DESKTOP_ATTACHED",
    "SATURN_DESKTOP_PID",
    "SATURN_RUNTIME_TOKEN",
];

/// Whether a variable is this process's alone (see `OWN_VARIABLES`).
pub fn is_own_variable(name: &str) -> bool {
    name.starts_with("ELECTRON_") || OWN_VARIABLES.contains(&name)
}

/// The environment for a program started for the user: the runtime's own, minus what only makes sense for this process.
pub fn launch_env(command: &mut Command) {
    for (key, _) in std::env::vars_os() {
        if is_own_variable(&key.to_string_lossy()) {
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
pub fn in_own_group(command: &mut Command) {
    command.process_group(0);
}

/// Leaves the session this process was started in, so that the end of that session, such as an SSH connection
/// closing, does not end it. It must not lead a process group, or the system refuses.
#[cfg(unix)]
pub fn leave_session() -> std::io::Result<()> {
    rustix::process::setsid()
        .map(|_| ())
        .map_err(std::io::Error::from)
}

/// Windows has no sessions to leave.
#[cfg(windows)]
pub fn leave_session() -> std::io::Result<()> {
    Ok(())
}

/// Keeps a program from opening a console window on Windows. The runtime has no console of its own there (the app starts
/// it without one), and a console program started by a process without a console gets a new, visible one unless told
/// not to; its output still reaches the pipes.
#[cfg(unix)]
pub fn no_window(_command: &mut Command) {}

#[cfg(windows)]
pub fn no_window(command: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

/// `no_window` for a program started with the standard library's blocking `Command`.
#[cfg(unix)]
pub fn no_window_blocking(_command: &mut std::process::Command) {}

#[cfg(windows)]
pub fn no_window_blocking(command: &mut std::process::Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::os::windows::process::CommandExt::creation_flags(command, CREATE_NO_WINDOW);
}

/// Windows has no process groups; a command also must not open a console window of its own.
#[cfg(windows)]
pub fn in_own_group(command: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

/// Whether any process of the group is still there, asked of the system directly. (`/bin/kill -0 -<group>` reads the
/// group as an option on Linux, so it always said no.)
#[cfg(unix)]
pub fn group_alive(pid: u32) -> bool {
    i32::try_from(pid)
        .ok()
        .and_then(rustix::process::Pid::from_raw)
        .is_some_and(|group| rustix::process::test_kill_process_group(group).is_ok())
}

/// The process group a process is in, if it is still there. A sandboxed program can sit in the group of the sandbox
/// that started it, so ending "its" group means ending that one.
#[cfg(unix)]
pub fn group_of(pid: u32) -> Option<u32> {
    let pid = i32::try_from(pid)
        .ok()
        .and_then(rustix::process::Pid::from_raw)?;
    rustix::process::getpgid(Some(pid))
        .ok()
        .and_then(|group| u32::try_from(group.as_raw_nonzero().get()).ok())
}

/// Windows has no process groups: a command's processes are named by the process Saturn started.
#[cfg(windows)]
pub fn group_of(pid: u32) -> Option<u32> {
    process_tree(pid).first().map(|_| pid)
}

/// Whether the process Saturn started, or anything started under it, is still there.
#[cfg(windows)]
pub fn group_alive(pid: u32) -> bool {
    !process_tree(pid).is_empty()
}

/// One process as the system lists it.
#[cfg(windows)]
struct Listed {
    parent: Option<u32>,
    /// When it started, in seconds since 1970.
    started: u64,
    /// The processor time it has used, in milliseconds.
    processor_millis: u64,
    /// Its memory in use, in bytes.
    memory: u64,
}

/// Every process on this computer, by its id.
#[cfg(windows)]
fn listed_processes() -> std::collections::HashMap<u32, Listed> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    let Ok(mut system) = System::new() else {
        return std::collections::HashMap::new();
    };
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_memory().with_cpu(),
    );
    system
        .processes()
        .iter()
        .map(|(pid, process)| {
            (
                pid.as_u32(),
                Listed {
                    parent: process.parent().map(sysinfo::Pid::as_u32),
                    started: process.start_time(),
                    processor_millis: process.accumulated_cpu_time(),
                    memory: process.memory(),
                },
            )
        })
        .collect()
}

/// The ids of the living processes of a command: the process `root` and everything started under it, outermost first.
/// A process counts as started under another only if it started no earlier, since Windows gives the id of a process
/// that ended to a new one, and a process keeps naming its parent after the parent is gone.
#[cfg(windows)]
fn tree_in(all: &std::collections::HashMap<u32, Listed>, root: u32) -> Vec<u32> {
    let mut found: Vec<u32> = all
        .contains_key(&root)
        .then_some(root)
        .into_iter()
        .collect();
    let mut parents = vec![(root, all.get(&root).map_or(0, |process| process.started))];
    while let Some((parent, parent_started)) = parents.pop() {
        for (pid, process) in all {
            if process.parent == Some(parent)
                && process.started >= parent_started
                && *pid != root
                && !found.contains(pid)
            {
                found.push(*pid);
                parents.push((*pid, process.started));
            }
        }
    }
    found
}

/// `tree_in` over the processes there are now.
#[cfg(windows)]
fn process_tree(root: u32) -> Vec<u32> {
    tree_in(&listed_processes(), root)
}

/// When the system says a process started, as text, or nothing if it is gone. With its id this tells a run's process
/// from a later one that was given the same id.
#[cfg(windows)]
pub fn process_started(pid: u32) -> Option<String> {
    listed_processes()
        .get(&pid)
        .map(|process| process.started.to_string())
}

/// What a command's processes have used: processor time so far in milliseconds, memory in bytes, and how many they
/// are. `None` when they are gone.
#[cfg(windows)]
pub fn tree_usage(root: u32) -> Option<(u64, u64, u64)> {
    let all = listed_processes();
    let tree = tree_in(&all, root);
    if tree.is_empty() {
        return None;
    }
    let of = |read: fn(&Listed) -> u64| -> u64 {
        tree.iter().filter_map(|pid| all.get(pid)).map(read).sum()
    };
    Some((
        of(|process| process.processor_millis),
        of(|process| process.memory),
        tree.len() as u64,
    ))
}

/// Asks the group to end. Sends nothing when the group is gone. A paused group is let go on as well, since a stopped
/// process only acts on the request once it runs again.
#[cfg(unix)]
pub fn terminate(pid: u32) {
    signal_group(pid, rustix::process::Signal::TERM);
    signal_group(pid, rustix::process::Signal::CONT);
}

/// Pauses the whole group where it is, as Ctrl-Z would: it keeps its memory, a GPU's included, and does nothing until
/// `continue_group`. False when the group is gone or will not take the signal.
#[cfg(unix)]
pub fn pause_group(pid: u32) -> bool {
    signal_group(pid, rustix::process::Signal::STOP)
}

/// Lets a paused group go on from where it was. False when the group is gone.
#[cfg(unix)]
pub fn continue_group(pid: u32) -> bool {
    signal_group(pid, rustix::process::Signal::CONT)
}

/// Ends the group at once.
#[cfg(unix)]
pub fn force(pid: u32) {
    signal_group(pid, rustix::process::Signal::KILL);
}

/// Sends a signal to the group; whether it got there. A group already gone is what ending it wanted, so callers that end
/// it pass over the answer.
#[cfg(unix)]
fn signal_group(pid: u32, signal: rustix::process::Signal) -> bool {
    i32::try_from(pid)
        .ok()
        .and_then(rustix::process::Pid::from_raw)
        .is_some_and(|group| rustix::process::kill_process_group(group, signal).is_ok())
}

/// Ends the process Saturn started and everything started under it, innermost first, so that nothing is left to start
/// more. Windows has no request to end that a program without a window hears, so this is at once and by force; the
/// processes are gone when it returns.
#[cfg(windows)]
pub fn terminate(pid: u32) {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    // Twice: a process may start another between the listing and its own end.
    for _ in 0..2 {
        let tree = process_tree(pid);
        if tree.is_empty() {
            return;
        }
        let ids: Vec<Pid> = tree.iter().rev().map(|id| Pid::from_u32(*id)).collect();
        let Ok(mut system) = System::new() else {
            return;
        };
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&ids),
            true,
            ProcessRefreshKind::nothing(),
        );
        for id in &ids {
            if let Some(process) = system.process(*id) {
                process.kill();
                process.wait();
            }
        }
    }
}

/// `terminate` already ended it by force.
#[cfg(windows)]
pub fn force(_pid: u32) {}

/// Pausing a group is not there on Windows.
#[cfg(windows)]
pub fn pause_group(_pid: u32) -> bool {
    false
}

/// Pausing a group is not there on Windows.
#[cfg(windows)]
pub fn continue_group(_pid: u32) -> bool {
    false
}

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
pub struct EndOnDrop {
    pid: Option<u32>,
}

impl EndOnDrop {
    pub fn new(pid: Option<u32>) -> Self {
        Self { pid }
    }

    /// The command finished by itself; what it left running on purpose stays.
    pub fn finished(&mut self) {
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

#[cfg(all(test, windows))]
mod windows_tests {
    use std::collections::HashMap;

    use super::*;

    fn listed(parent: Option<u32>, started: u64) -> Listed {
        Listed {
            parent,
            started,
            processor_millis: 0,
            memory: 0,
        }
    }

    /// A command's processes are the one Saturn started and what was started under it, and not a process that was
    /// given the id of one that ended, nor one that only names a dead parent whose id was given away.
    #[test]
    fn a_commands_processes_are_found_by_who_started_whom() {
        let all: HashMap<u32, Listed> = [
            (100, listed(Some(1), 50)),
            (101, listed(Some(100), 60)),
            (102, listed(Some(101), 70)),
            // Older than the process it names as its parent: that id was reused.
            (200, listed(Some(100), 10)),
            (300, listed(Some(1), 55)),
        ]
        .into();
        let mut tree = tree_in(&all, 100);
        tree.sort_unstable();
        assert_eq!(tree, [100, 101, 102]);
        // The first process has ended; what it started is still found.
        let mut left = tree_in(
            &[(101, listed(Some(100), 60)), (102, listed(Some(101), 70))].into(),
            100,
        );
        left.sort_unstable();
        assert_eq!(left, [101, 102]);
        assert!(tree_in(&all, 999).is_empty());
    }
}
