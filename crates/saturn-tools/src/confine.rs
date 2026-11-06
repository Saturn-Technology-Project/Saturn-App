//! The operating system's sandbox around an experiment run's program, stricter than the one around the `code` tool:
//! the program writes only to the folders it is given, cannot read the folders hidden from it (the project it was
//! copied from, Saturn's own data, the usual credential folders), and reaches the network only when allowed. macOS
//! uses seatbelt (`sandbox-exec`), Linux bubblewrap; where neither works the run is not confined, and the caller says
//! why.
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::sandbox::{Platform, bwrap_path, cache_folders, is_executable, quote, real};
use crate::shell::{Env, Invocation};

/// What a confined program may reach.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Confinement {
    /// Folders the program may write in (and read).
    pub writable: Vec<PathBuf>,
    /// Files and folders inside a writable folder that the program may only read: its supervisor's own records.
    pub protected: Vec<PathBuf>,
    /// Folders and files the program may not read.
    pub hidden: Vec<PathBuf>,
    /// Folders and files inside a hidden one that the program may read again, such as its own snapshot.
    pub visible: Vec<PathBuf>,
    /// Whether the program may use the network.
    pub network: bool,
}

/// What a sandbox hides, relative to the home folder: where credentials are usually kept.
pub const CREDENTIAL_FOLDERS: [&str; 22] = [
    ".ssh",
    ".aws",
    ".azure",
    ".gnupg",
    ".kube",
    ".docker",
    ".config/gcloud",
    ".config/gh",
    ".config/hub",
    ".password-store",
    ".netrc",
    ".git-credentials",
    ".npmrc",
    ".pypirc",
    ".codex",
    ".claude",
    ".claude.json",
    "Library/Keychains",
    ".kaggle",
    ".huggingface/token",
    ".cache/huggingface/token",
    ".cache/huggingface/stored_tokens",
];

/// The credential folders under `home`.
pub fn credential_folders(home: &Path) -> Vec<PathBuf> {
    CREDENTIAL_FOLDERS
        .iter()
        .map(|item| home.join(item))
        .collect()
}

/// The shared caches a confined program may write in, so libraries keep finding what they downloaded before.
pub fn shared_caches(home: &Path, platform: Platform) -> Vec<PathBuf> {
    let mut folders = cache_folders(home, platform);
    folders.extend([".triton", ".matplotlib", ".keras"].map(|item| home.join(item)));
    folders
}

/// The hidden paths that lie inside a folder the program may write or read, such as a token kept in a shared cache:
/// hidden again after that folder is opened.
fn nested_hidden(confinement: &Confinement) -> Vec<PathBuf> {
    let mut open = resolved(&confinement.writable);
    open.extend(resolved(&confinement.visible));
    resolved(&confinement.hidden)
        .into_iter()
        .filter(|hidden| {
            open.iter()
                .any(|folder| hidden != folder && Path::new(hidden).starts_with(Path::new(folder)))
        })
        .map(PathBuf::from)
        .collect()
}

/// The paths, resolved, without repeats; ones that do not exist are left as they are written.
fn resolved(paths: &[PathBuf]) -> Vec<String> {
    let mut unique: Vec<String> = Vec::with_capacity(paths.len());
    for path in paths.iter().map(|path| real(path)) {
        if !unique.contains(&path) {
            unique.push(path);
        }
    }
    unique
}

/// A seatbelt profile for a confinement. Rules later in the profile win, so the order is: no writes, writes to the
/// writable folders and the system's shared temporary folders, none to the hidden and protected ones, writes to the
/// writable folders inside them again, none to the protected files, no reading the hidden folders, reading the visible
/// and writable ones again, nothing at all of a hidden path inside those, then the network.
pub fn seatbelt_confinement(confinement: &Confinement, shared_temporary: &[PathBuf]) -> String {
    let mut lines = vec![
        "(version 1)".to_owned(),
        "(allow default)".to_owned(),
        "(deny file-write*)".to_owned(),
        "(allow file-write* (literal \"/dev/null\") (literal \"/dev/zero\") (regex #\"^/dev/tty\") (regex #\"^/dev/fd/\") (literal \"/dev/dtracehelper\"))".to_owned(),
    ];
    let subpaths = |paths: &[PathBuf]| -> Option<String> {
        let paths: Vec<String> = resolved(paths)
            .iter()
            .map(|path| format!("(subpath {})", quote(path)))
            .collect();
        (!paths.is_empty()).then(|| paths.join(" "))
    };
    let mut shared = confinement.writable.clone();
    shared.extend(shared_temporary.iter().cloned());
    if let Some(paths) = subpaths(&shared) {
        lines.push(format!("(allow file-write* {paths})"));
    }
    // The hidden and protected folders take no writes even where they sit in a shared temporary folder; the writable
    // folders inside them do, and then the protected files inside those again do not.
    let mut closed = confinement.hidden.clone();
    closed.extend(confinement.protected.iter().cloned());
    if let Some(paths) = subpaths(&closed) {
        lines.push(format!("(deny file-write* {paths})"));
    }
    if let Some(paths) = subpaths(&confinement.writable) {
        lines.push(format!("(allow file-write* {paths})"));
    }
    if let Some(paths) = subpaths(&confinement.protected) {
        lines.push(format!("(deny file-write* {paths})"));
    }
    let hidden = resolved(&confinement.hidden);
    if !hidden.is_empty() {
        let paths: Vec<String> = hidden
            .iter()
            .map(|path| format!("(subpath {})", quote(path)))
            .collect();
        // Their names and sizes can still be looked up, as every path's can; their contents and listings cannot.
        lines.push(format!(
            "(deny file-read-data file-read-xattr {})",
            paths.join(" ")
        ));
        let mut readable = confinement.visible.clone();
        readable.extend(confinement.writable.iter().cloned());
        let readable = resolved(&readable);
        if !readable.is_empty() {
            let paths: Vec<String> = readable
                .iter()
                .map(|path| format!("(subpath {})", quote(path)))
                .collect();
            lines.push(format!(
                "(allow file-read-data file-read-xattr {})",
                paths.join(" ")
            ));
        }
    }
    if let Some(paths) = subpaths(&nested_hidden(confinement)) {
        lines.push(format!(
            "(deny file-read-data file-read-xattr file-write* {paths})"
        ));
    }
    if !confinement.network {
        lines.push("(deny network*)".to_owned());
        lines.push("(allow network* (local unix-socket))".to_owned());
    }
    format!("{}\n", lines.join("\n"))
}

/// How deep a path is, so a folder is mounted before what is inside it.
fn depth(path: &str) -> usize {
    Path::new(path).components().count()
}

/// bubblewrap's arguments for a confinement, up to the `--` before the command. The whole system is read-only and
/// `/tmp` private; the hidden folders are replaced by empty ones (a hidden file by an empty file); the visible and
/// writable ones are bound back over them; a hidden path inside one of those is hidden again; the protected files are
/// bound read-only over themselves. There is no
/// `--die-with-parent`: a run outlives Saturn, as an unconfined run does, and is found again after a restart.
pub fn bubblewrap_confinement(confinement: &Confinement, working: &Path) -> Vec<String> {
    let mut args: Vec<String> = [
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
    ]
    .map(str::to_owned)
    .to_vec();
    let hide = |args: &mut Vec<String>, path: String| match std::fs::metadata(&path) {
        Ok(info) if info.is_dir() => args.extend(["--tmpfs".to_owned(), path]),
        Ok(_) => args.extend(["--ro-bind".to_owned(), "/dev/null".to_owned(), path]),
        Err(_) => {}
    };
    let mut hidden = resolved(&confinement.hidden);
    hidden.sort_by_key(|path| depth(path));
    for path in hidden {
        hide(&mut args, path);
    }
    let mut binds: Vec<(String, bool)> = resolved(&confinement.visible)
        .into_iter()
        .map(|path| (path, false))
        .collect();
    binds.extend(
        resolved(&confinement.writable)
            .into_iter()
            .map(|path| (path, true)),
    );
    binds.sort_by_key(|(path, _)| depth(path));
    for (path, writes) in binds {
        let flag = if writes {
            "--bind-try"
        } else {
            "--ro-bind-try"
        };
        args.extend([flag.to_owned(), path.clone(), path]);
    }
    for path in resolved(&nested_hidden(confinement)) {
        hide(&mut args, path);
    }
    for file in resolved(&confinement.protected) {
        args.extend(["--ro-bind-try".to_owned(), file.clone(), file]);
    }
    if !confinement.network {
        args.push("--unshare-net".to_owned());
    }
    args.extend(["--chdir".to_owned(), real(working)]);
    args
}

/// Whether confinement works on this computer, with what, or why not. Checked once, by confining a program that
/// does nothing: a sandbox that is installed may still be refused, as bubblewrap is where unprivileged user
/// namespaces are turned off.
pub fn confinement_support(env: &Env) -> Result<&'static str, String> {
    static CHECKED: OnceLock<Result<&'static str, String>> = OnceLock::new();
    CHECKED
        .get_or_init(|| check_support(Platform::current(), env))
        .clone()
}

fn check_support(platform: Platform, env: &Env) -> Result<&'static str, String> {
    let quiet = |command: &mut std::process::Command| {
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .output()
    };
    match platform {
        Platform::Mac => {
            let program = Path::new("/usr/bin/sandbox-exec");
            if !is_executable(program) {
                return Err("sandbox-exec is missing".to_owned());
            }
            let tried = quiet(std::process::Command::new(program).args([
                "-p",
                "(version 1)(allow default)(deny network*)",
                "/usr/bin/true",
            ]));
            match tried {
                Ok(output) if output.status.success() => Ok("seatbelt"),
                Ok(output) => Err(format!(
                    "sandbox-exec refused to start a program: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                )),
                Err(error) => Err(format!("sandbox-exec could not start: {error}")),
            }
        }
        Platform::Linux => {
            let Some(program) = bwrap_path(env) else {
                return Err("bubblewrap (bwrap) is not installed".to_owned());
            };
            let tried = quiet(std::process::Command::new(&program).args([
                "--ro-bind",
                "/",
                "/",
                "--dev",
                "/dev",
                "--proc",
                "/proc",
                "--tmpfs",
                "/tmp",
                "--unshare-net",
                "--",
                "/bin/true",
            ]));
            match tried {
                Ok(output) if output.status.success() => Ok("bubblewrap"),
                Ok(output) => Err(format!(
                    "bubblewrap is installed but cannot make a sandbox here (unprivileged user namespaces may be turned off): {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                )),
                Err(error) => Err(format!("bubblewrap could not start: {error}")),
            }
        }
        Platform::Windows => Err("Windows has no sandbox for programs".to_owned()),
    }
}

/// The system's shared temporary folders on macOS, which programs and system libraries write to whatever `TMPDIR`
/// says. On Linux `/tmp` is the sandbox's own.
fn shared_temporary(platform: Platform) -> Vec<PathBuf> {
    if platform != Platform::Mac {
        return Vec::new();
    }
    let mut folders = vec![PathBuf::from("/private/tmp"), std::env::temp_dir()];
    if let Ok(output) = std::process::Command::new("/usr/bin/getconf")
        .arg("DARWIN_USER_TEMP_DIR")
        .output()
    {
        let folder = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if !folder.is_empty() {
            folders.push(PathBuf::from(folder));
        }
    }
    folders
}

/// A program to start, confined, with what it was confined by, and the shared folders it may also write to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Confined {
    pub invocation: Invocation,
    pub mechanism: &'static str,
    pub shared_writable: Vec<String>,
}

/// Wraps `invocation` in the sandbox, or says why it cannot be. `working` is the folder it starts in.
pub fn confine(
    invocation: Invocation,
    confinement: &Confinement,
    working: &Path,
    env: &Env,
) -> Result<Confined, String> {
    let mechanism = confinement_support(env)?;
    let platform = Platform::current();
    if platform == Platform::Mac {
        let temporary = shared_temporary(platform);
        let mut args = vec![
            "-p".to_owned(),
            seatbelt_confinement(confinement, &temporary),
            invocation.file,
        ];
        args.extend(invocation.args);
        return Ok(Confined {
            invocation: Invocation {
                file: "/usr/bin/sandbox-exec".to_owned(),
                args,
                verbatim: false,
            },
            mechanism,
            shared_writable: resolved(&temporary),
        });
    }
    let program = bwrap_path(env).ok_or("bubblewrap (bwrap) is not installed")?;
    let mut args = bubblewrap_confinement(confinement, working);
    args.push("--".to_owned());
    args.push(invocation.file);
    args.extend(invocation.args);
    Ok(Confined {
        invocation: Invocation {
            file: program.to_string_lossy().into_owned(),
            args,
            verbatim: false,
        },
        mechanism,
        shared_writable: Vec::new(),
    })
}
