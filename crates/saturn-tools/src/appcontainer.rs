//! The Windows sandbox: a command runs in an AppContainer, started by Saturn's own program as the launcher (see the
//! `saturn-appcontainer` crate). A container reads and writes nothing of the person's until a folder is opened to it,
//! the other way round from seatbelt and bubblewrap, where everything can be read until it is hidden. So here the
//! sandbox is a list of what to open: the workspace, a temporary folder, the caches, and where the programs on `PATH`
//! are. What is opened stays opened, in the folders' own access lists, for the next command with the same policy.
//!
//! Two things differ from the other systems and cannot be helped from here. A program in a container that may use
//! the network still cannot reach a server on this computer that runs outside it (`localhost`); only an administrator
//! can exempt a container. And programs ask about the folders above the one they work in (Node to resolve a script's
//! path, git to find a repository), up to the drive's top folder, which with `Users` and a program's folder under
//! Program Files is an administrator's to open. So the sandbox is used only once an administrator has run
//! `saturn-server --appcontainer-setup`, which `ready` finds out by trying; until then commands run as they did
//! before there was a sandbox, and say so.
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use saturn_appcontainer::{FLAG, Policy, Shared};
use saturn_domain::plain_path;

use crate::sandbox::real;
use crate::shell::{Env, Invocation};

/// The name of this sandbox, in results and records.
pub const MECHANISM: &str = "AppContainer";
/// The capability every Saturn sandbox holds: the caches and the programs' folders are opened to it.
const TOOLS: &str = "saturnSandboxTools";

static LAUNCHER: OnceLock<PathBuf> = OnceLock::new();

/// Names the program that starts containers: Saturn's own, which calls `saturn_appcontainer::launch` when its first
/// argument says so. A program that has not said this (a test, a tool built on these crates) has no Windows sandbox.
pub fn set_launcher(program: PathBuf) {
    let _ = LAUNCHER.set(program);
}

/// The program that starts containers, if this one named it.
pub fn launcher() -> Option<&'static Path> {
    LAUNCHER.get().map(PathBuf::as_path)
}

/// Takes away the registration of a container made for one program, once that program has ended.
pub fn forget(container: &str) {
    saturn_appcontainer::forget(container);
}

/// The argument that makes Saturn's program open, once, what only an administrator can.
pub const SETUP_FLAG: &str = "--appcontainer-setup";
/// What a command is told where the sandbox was never set up.
pub const NOT_SET_UP: &str = "the Windows sandbox is not set up: an administrator runs `saturn-server --appcontainer-setup` once (see the README)";

/// What the one-time setup opens: the folders on `PATH` and the caches, with the folders above them and above
/// `folders` (a project kept on another drive, say), as every sandbox will ask for them.
pub fn setup_policy(env: &Env, folders: &[String]) -> Policy {
    let home = home(env);
    let caches: Vec<String> =
        crate::sandbox::cache_folders(&home, crate::sandbox::Platform::Windows)
            .into_iter()
            .chain(windows_caches(&home))
            .map(|folder| plain(&folder))
            .collect();
    let mut shared = tools(env, &caches, true, &[]);
    // Named for the folders above it: a file that is not there opens nothing itself.
    shared.read.extend(
        folders
            .iter()
            .map(|folder| plain(&Path::new(folder).join(".saturn-sandbox-setup"))),
    );
    Policy {
        shared: vec![shared],
        ..Policy::default()
    }
}

/// Runs the one-time setup and says what it could not open.
pub fn setup(env: &Env, folders: &[String]) -> Result<Vec<String>, String> {
    saturn_appcontainer::prepare(&setup_policy(env, folders))
}

/// Whether a program in a container can ask about the folders above the home folder, which is what the setup makes
/// possible. Tried once, with cmd in a container that is opened to nothing.
pub fn ready(env: &Env) -> Result<(), &'static str> {
    static READY: OnceLock<bool> = OnceLock::new();
    let Some(launcher) = launcher() else {
        return Err("this program cannot start a Windows sandbox");
    };
    let tried = *READY.get_or_init(|| {
        let home = plain(&home(env));
        let checks: Vec<String> = Path::new(&home)
            .ancestors()
            .map(|folder| {
                format!(
                    "if not exist \"{}\\\" exit 9",
                    folder.to_string_lossy().trim_end_matches('\\')
                )
            })
            .collect();
        let policy = Policy {
            shared: vec![Shared {
                name: TOOLS.to_owned(),
                write: Vec::new(),
                read: Vec::new(),
            }],
            ..Policy::default()
        };
        let shell = crate::shell::shell_invocation(
            &checks.join(" & "),
            "",
            crate::sandbox::Platform::Windows,
            env,
        );
        let wrapped = wrapped(launcher, &policy, shell);
        let mut command = std::process::Command::new(&wrapped.file);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            for argument in &wrapped.args {
                command.raw_arg(argument);
            }
            // No console window of its own.
            command.creation_flags(0x0800_0000);
        }
        #[cfg(not(windows))]
        command.args(&wrapped.args);
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    });
    if tried { Ok(()) } else { Err(NOT_SET_UP) }
}

/// A path resolved and written the way people write it, which is how an access list is asked for it.
pub(crate) fn plain(path: &Path) -> String {
    plain_path(PathBuf::from(real(path)))
        .to_string_lossy()
        .into_owned()
}

/// Whether `path` is `folder` or lies inside it. Windows does not tell upper case from lower in a path.
pub(crate) fn within(path: &str, folder: &str) -> bool {
    let (path, folder) = (path.to_lowercase(), folder.to_lowercase());
    Path::new(&path).starts_with(Path::new(&folder))
}

/// A variable's value, whatever case its name is written in.
fn variable<'a>(env: &'a Env, name: &str) -> Option<&'a OsStr> {
    env.iter()
        .find(|(key, value)| key.to_string_lossy().eq_ignore_ascii_case(name) && !value.is_empty())
        .map(|(_, value)| value.as_os_str())
}

/// The person's home folder, as the environment names it.
pub(crate) fn home(env: &Env) -> PathBuf {
    variable(env, "USERPROFILE")
        .or_else(|| variable(env, "HOME"))
        .map(PathBuf::from)
        .or_else(std::env::home_dir)
        .unwrap_or_default()
}

/// The folders tools cache into on Windows, beside the ones they use everywhere.
pub(crate) fn windows_caches(home: &Path) -> Vec<PathBuf> {
    [
        "AppData/Local/npm-cache",
        "AppData/Local/pip/Cache",
        "AppData/Local/uv/cache",
        "AppData/Local/Yarn/Cache",
        "AppData/Local/pnpm-cache",
        "AppData/Local/go-build",
    ]
    .iter()
    .map(|item| home.join(item))
    .collect()
}

/// What every Saturn sandbox shares: the folders on `PATH` to read, so the programs a command names can be found and
/// run, and the caches. Windows's own folders are left out, being open to containers already, and so is a folder that
/// holds something hidden or the home folder itself, which would open far more than a program.
pub(crate) fn tools(env: &Env, caches: &[String], writes: bool, hidden: &[String]) -> Shared {
    let home = plain(&home(env));
    let system = variable(env, "SystemRoot").map_or_else(
        || "C:\\Windows".to_owned(),
        |root| root.to_string_lossy().into_owned(),
    );
    let mut read: Vec<String> = Vec::new();
    for folder in variable(env, "PATH")
        .map(|path| std::env::split_paths(path).collect::<Vec<_>>())
        .unwrap_or_default()
    {
        if !folder.is_absolute() {
            continue;
        }
        let folder = plain(&folder);
        let too_wide = within(&home, &folder) || hidden.iter().any(|path| within(path, &folder));
        if !too_wide && !within(&folder, &system) && !read.contains(&folder) {
            read.push(folder);
        }
    }
    let mut shared = Shared {
        name: TOOLS.to_owned(),
        write: Vec::new(),
        read,
    };
    if writes {
        shared.write = caches.to_vec();
    } else {
        shared.read.extend(caches.iter().cloned());
    }
    shared
}

/// The hidden paths that lie inside something the policy opens: closed again.
pub(crate) fn closed(policy: &Policy, hidden: &[String]) -> Vec<String> {
    let opened: Vec<&String> = policy
        .write
        .iter()
        .chain(&policy.read)
        .chain(
            policy
                .shared
                .iter()
                .flat_map(|shared| shared.write.iter().chain(&shared.read)),
        )
        .collect();
    let mut closed: Vec<String> = Vec::new();
    for path in hidden {
        let inside = opened
            .iter()
            .any(|folder| within(path, folder) && !within(folder, path));
        if inside && !closed.contains(path) {
            closed.push(path.clone());
        }
    }
    closed
}

/// The invocation that starts `invocation` in the policy's container. What follows the policy is passed on as it is
/// written, so a line for cmd stays one.
pub(crate) fn wrapped(launcher: &Path, policy: &Policy, invocation: Invocation) -> Invocation {
    let program = if invocation.verbatim && invocation.file.contains(' ') {
        format!("\"{}\"", invocation.file)
    } else {
        invocation.file
    };
    let mut args = vec![FLAG.to_owned(), policy.encoded(), program];
    args.extend(invocation.args);
    Invocation {
        file: launcher.to_string_lossy().into_owned(),
        args,
        verbatim: invocation.verbatim,
    }
}

/// The sandbox's own temporary folder for a policy: the person's is full of other programs' files.
pub(crate) fn temporary(policy: &Policy) -> String {
    let name = policy.name();
    let folder = std::env::temp_dir()
        .join("saturn-sandbox")
        .join(name.rsplit('.').next().unwrap_or(&name));
    plain(&folder)
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs
            .iter()
            .map(|(key, value)| (OsString::from(key), OsString::from(value)))
            .collect()
    }

    #[test]
    fn inside_is_told_whatever_the_case() {
        assert!(within("C:/Users/Rick/study/data", "c:/users/rick/study"));
        assert!(within("c:/users/rick/study", "c:/users/rick/study"));
        assert!(!within("c:/users/rick/study2", "c:/users/rick/study"));
    }

    #[test]
    fn the_shared_folders_leave_out_what_would_open_too_much() {
        let separator = if cfg!(windows) { ";" } else { ":" };
        let root = if cfg!(windows) { "C:\\" } else { "/" };
        let at = |rest: &str| format!("{root}{rest}");
        let path = [
            at("tools/bin"),
            at("home/me"),
            at("home/me/.ssh/bin"),
            at("windows/system32"),
            "relative".to_owned(),
        ]
        .join(separator);
        let variables = env(&[
            ("Path", &path),
            ("USERPROFILE", &at("home/me")),
            ("SystemRoot", &at("windows")),
        ]);
        let hidden = vec![plain(Path::new(&at("home/me/.ssh")))];
        let caches = vec![plain(Path::new(&at("home/me/.npm")))];
        let shared = tools(&variables, &caches, true, &hidden);
        assert_eq!(
            shared.read,
            vec![
                plain(Path::new(&at("tools/bin"))),
                plain(Path::new(&at("home/me/.ssh/bin")))
            ]
        );
        assert_eq!(shared.write, caches);
        let reading = tools(&variables, &caches, false, &hidden);
        assert!(reading.write.is_empty());
        assert!(reading.read.contains(&caches[0]));
    }

    #[test]
    fn a_hidden_path_inside_an_opened_folder_is_closed_and_one_outside_is_left() {
        let policy = Policy {
            write: vec!["/work".to_owned()],
            shared: vec![Shared {
                name: "x".to_owned(),
                write: vec!["/home/.cache".to_owned()],
                read: Vec::new(),
            }],
            ..Policy::default()
        };
        let hidden = vec![
            "/home/.cache/huggingface/token".to_owned(),
            "/home/.ssh".to_owned(),
            "/work".to_owned(),
            "/".to_owned(),
        ];
        assert_eq!(
            closed(&policy, &hidden),
            vec!["/home/.cache/huggingface/token".to_owned()]
        );
    }

    #[test]
    fn the_launcher_gets_the_policy_and_then_the_command_as_it_was() {
        let policy = Policy::default();
        let cmd = Invocation {
            file: "C:\\Program Files\\x\\cmd.exe".to_owned(),
            args: vec!["/c".to_owned(), "\"echo hi\"".to_owned()],
            verbatim: true,
        };
        let wrapped = wrapped(Path::new("saturn-server.exe"), &policy, cmd);
        assert_eq!(wrapped.file, "saturn-server.exe");
        assert!(wrapped.verbatim);
        assert_eq!(wrapped.args[0], "--appcontainer");
        assert_eq!(Policy::decoded(&wrapped.args[1]), Some(policy));
        assert_eq!(
            &wrapped.args[2..],
            ["\"C:\\Program Files\\x\\cmd.exe\"", "/c", "\"echo hi\""]
        );
    }
}
