//! The operating system's sandbox around the `code` tool's commands. `workspace-write` lets a command write only inside
//! the workspace (and the usual temporary and cache folders); `read-only` lets it write nowhere; `off` runs it as the
//! runtime itself. macOS uses seatbelt (`sandbox-exec`), Linux bubblewrap when it is installed; Windows has no sandbox,
//! and the result says so.
//!
//! Seatbelt profiles do not nest: this works because the packaged app does not carry the App Sandbox entitlement. A build
//! that adds `com.apple.security.app-sandbox` would need another way.
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::shell::{Env, Invocation};

/// The system a command runs on; tests name the others.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Mac,
    Linux,
    Windows,
}

impl Platform {
    /// The system this is running on.
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Mac
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

/// How far a command's writes may reach.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxMode {
    WorkspaceWrite,
    ReadOnly,
    Off,
}

impl SandboxMode {
    /// The mode a setting or a tool call names, if it names one.
    pub fn from_value(value: Option<&Value>) -> Option<Self> {
        match value?.as_str()? {
            "workspace-write" => Some(Self::WorkspaceWrite),
            "read-only" => Some(Self::ReadOnly),
            "off" => Some(Self::Off),
            _ => None,
        }
    }
}

/// The sandbox a command runs in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxSettings {
    pub mode: SandboxMode,
    pub network: bool,
}

/// What a command gets when nothing was set.
pub const DEFAULT_SANDBOX: SandboxSettings = SandboxSettings {
    mode: SandboxMode::WorkspaceWrite,
    network: true,
};

/// A command to start, inside the sandbox or not.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxPlan {
    pub invocation: Invocation,
    /// The command runs under the OS sandbox.
    pub sandboxed: bool,
    /// When not sandboxed although a mode asked for it: why.
    pub reason: Option<String>,
}

/// Whether this computer can sandbox commands at all, and with what.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SandboxSupport {
    Available(&'static str),
    Unavailable(&'static str),
}

pub(crate) fn is_executable(file: &Path) -> bool {
    #[cfg(unix)]
    {
        use rustix::fs::{Access, access};
        access(file, Access::EXEC_OK).is_ok() && file.is_file()
    }
    #[cfg(not(unix))]
    {
        file.is_file()
    }
}

pub(crate) fn bwrap_path(env: &Env) -> Option<PathBuf> {
    let default = OsStr::new("/usr/bin:/bin");
    let folders = env.get(OsStr::new("PATH")).map_or(default, |path| path);
    std::env::split_paths(folders)
        .map(|folder| folder.join("bwrap"))
        .find(|candidate| is_executable(candidate))
}

/// Whether this computer can sandbox commands at all, and with what.
pub fn sandbox_support(platform: Platform, env: &Env) -> SandboxSupport {
    match platform {
        Platform::Mac if is_executable(Path::new("/usr/bin/sandbox-exec")) => {
            SandboxSupport::Available("seatbelt")
        }
        Platform::Mac => SandboxSupport::Unavailable("sandbox-exec is missing"),
        Platform::Linux if bwrap_path(env).is_some() => SandboxSupport::Available("bubblewrap"),
        Platform::Linux => SandboxSupport::Unavailable("bubblewrap (bwrap) is not installed"),
        Platform::Windows => SandboxSupport::Unavailable("Windows has no sandbox for commands"),
    }
}

/// The folder with symlinks resolved; a missing one is written out as it is.
pub(crate) fn real(folder: &Path) -> String {
    let resolved = std::fs::canonicalize(folder)
        .or_else(|_| std::path::absolute(folder))
        .unwrap_or_else(|_| folder.to_path_buf());
    resolved.to_string_lossy().into_owned()
}

/// Folders tools cache into under the home folder; writable so npm, pip, cargo and friends keep working.
pub(crate) fn cache_folders(home: &Path, platform: Platform) -> Vec<PathBuf> {
    let common = [
        ".npm",
        ".cache",
        ".yarn",
        ".pnpm-store",
        ".bun",
        ".cargo/registry",
        ".cargo/git",
        ".gradle",
        ".m2",
        ".nuget",
        "go/pkg",
        ".local/share/pnpm",
    ];
    let extra: &[&str] = if platform == Platform::Mac {
        &["Library/Caches"]
    } else {
        &[]
    };
    common
        .iter()
        .chain(extra)
        .map(|item| home.join(item))
        .collect()
}

/// The folders a command may write to under `workspace-write`: the workspace, temp, and the caches.
pub fn writable_folders(
    root: &str,
    extra: &[String],
    env: &Env,
    platform: Platform,
) -> Vec<String> {
    let home = env
        .get(OsStr::new("HOME"))
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .or_else(std::env::home_dir)
        .unwrap_or_default();
    let mut folders: Vec<PathBuf> = vec![PathBuf::from(root)];
    folders.extend(extra.iter().map(PathBuf::from));
    folders.extend([
        std::env::temp_dir(),
        PathBuf::from("/tmp"),
        PathBuf::from("/private/tmp"),
    ]);
    if let Some(temporary) = env.get(OsStr::new("TMPDIR")).filter(|dir| !dir.is_empty()) {
        folders.push(PathBuf::from(temporary));
    }
    folders.extend(cache_folders(&home, platform));
    let mut unique = Vec::with_capacity(folders.len());
    for folder in folders.iter().map(|folder| real(folder)) {
        if !unique.contains(&folder) {
            unique.push(folder);
        }
    }
    unique
}

pub(crate) fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// A seatbelt profile: everything allowed, then writes limited to `writable` (none for read-only), then the network.
pub fn seatbelt_profile(mode: SandboxMode, writable: &[String], network: bool) -> String {
    seatbelt_profile_hiding(mode, writable, network, &[])
}

/// Whether `path` lies strictly inside `folder`.
fn strictly_inside(path: &str, folder: &str) -> bool {
    path != folder && Path::new(path).starts_with(Path::new(folder))
}

/// The writable folders that lie inside a hidden one, such as the agent's private workspace inside Saturn's data
/// folder: opened again after the hidden one is closed.
fn reopened<'a>(writable: &'a [String], hidden: &[String]) -> Vec<&'a String> {
    writable
        .iter()
        .filter(|folder| hidden.iter().any(|path| strictly_inside(folder, path)))
        .collect()
}

/// The hidden paths inside a folder opened again, such as a token in a shared cache: closed once more after it.
fn hidden_again<'a>(hidden: &'a [String], opened: &[&String]) -> Vec<&'a String> {
    hidden
        .iter()
        .filter(|path| opened.iter().any(|folder| strictly_inside(path, folder)))
        .collect()
}

/// The seatbelt profile, with `hidden` (resolved) neither read nor written: Saturn's own data and the usual credential
/// folders. A writable folder inside a hidden one is opened again, and a hidden one inside that is closed again; rules
/// later in a profile win. Names and sizes can still be looked up, as every path's can; contents and listings cannot.
pub fn seatbelt_profile_hiding(
    mode: SandboxMode,
    writable: &[String],
    network: bool,
    hidden: &[String],
) -> String {
    let mut lines = vec![
        "(version 1)".to_owned(),
        "(allow default)".to_owned(),
        "(deny file-write*)".to_owned(),
        // Pseudo-devices every shell touches.
        "(allow file-write* (literal \"/dev/null\") (literal \"/dev/zero\") (regex #\"^/dev/tty\") (regex #\"^/dev/fd/\") (literal \"/dev/dtracehelper\"))".to_owned(),
    ];
    let temporary = real(&std::env::temp_dir());
    let allowed: Vec<&String> = writable
        .iter()
        .filter(|folder| {
            mode == SandboxMode::WorkspaceWrite
                || **folder == temporary
                || *folder == "/tmp"
                || *folder == "/private/tmp"
        })
        .collect();
    if !allowed.is_empty() {
        let paths: Vec<String> = allowed
            .iter()
            .map(|folder| format!("(subpath {})", quote(folder)))
            .collect();
        lines.push(format!("(allow file-write* {})", paths.join(" ")));
    }
    let subpaths = |paths: &[&String]| -> String {
        paths
            .iter()
            .map(|path| format!("(subpath {})", quote(path)))
            .collect::<Vec<_>>()
            .join(" ")
    };
    if !hidden.is_empty() {
        let all: Vec<&String> = hidden.iter().collect();
        lines.push(format!(
            "(deny file-read-data file-read-xattr file-write* {})",
            subpaths(&all)
        ));
        let opened = reopened(writable, hidden);
        if !opened.is_empty() {
            lines.push(format!(
                "(allow file-read-data file-read-xattr {})",
                subpaths(&opened)
            ));
            let writes: Vec<&String> = opened
                .iter()
                .copied()
                .filter(|folder| allowed.contains(folder))
                .collect();
            if !writes.is_empty() {
                lines.push(format!("(allow file-write* {})", subpaths(&writes)));
            }
            let again = hidden_again(hidden, &opened);
            if !again.is_empty() {
                lines.push(format!(
                    "(deny file-read-data file-read-xattr file-write* {})",
                    subpaths(&again)
                ));
            }
        }
    }
    // Read-only means the workspace too, even when it sits under a temp folder (the last matching rule wins).
    if mode == SandboxMode::ReadOnly {
        let first = writable.first().map_or("/nonexistent", String::as_str);
        lines.push(format!("(deny file-write* (subpath {}))", quote(first)));
    }
    if !network {
        lines.push("(deny network*)".to_owned());
        lines.push("(allow network* (local unix-socket))".to_owned());
    }
    format!("{}\n", lines.join("\n"))
}

/// Wraps a shell invocation in the sandbox for `settings.mode`. When the platform cannot sandbox, the command runs
/// unwrapped and the plan says why, so the tool result can tell the model and the user. `hidden` are folders and files
/// the command may neither read nor write (Saturn's data, the usual credential folders), unless one is the workspace's
/// own or a writable folder's parent.
pub fn wrap_command(
    invocation: Invocation,
    settings: SandboxSettings,
    root: &str,
    extra_writable: &[String],
    hidden: &[String],
    platform: Platform,
    env: &Env,
) -> SandboxPlan {
    if settings.mode == SandboxMode::Off {
        return SandboxPlan {
            invocation,
            sandboxed: false,
            reason: None,
        };
    }
    if let SandboxSupport::Unavailable(reason) = sandbox_support(platform, env) {
        return SandboxPlan {
            invocation,
            sandboxed: false,
            reason: Some(reason.to_owned()),
        };
    }
    let writable = writable_folders(root, extra_writable, env, platform);
    let mut hidden: Vec<String> = hidden.iter().map(|path| real(Path::new(path))).collect();
    hidden.dedup();
    let wrapped = if platform == Platform::Mac {
        let mut args = vec![
            "-p".to_owned(),
            seatbelt_profile_hiding(settings.mode, &writable, settings.network, &hidden),
            invocation.file,
        ];
        args.extend(invocation.args);
        Invocation {
            file: "/usr/bin/sandbox-exec".to_owned(),
            args,
            verbatim: false,
        }
    } else {
        // bubblewrap: the whole filesystem read-only, the writable folders bound read-write, no network unless allowed.
        let mut args: Vec<String> = [
            "--ro-bind",
            "/",
            "/",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "--die-with-parent",
        ]
        .map(str::to_owned)
        .to_vec();
        let writes = |folder: &String| {
            settings.mode == SandboxMode::WorkspaceWrite || folder.starts_with("/tmp")
        };
        for folder in writable.iter().filter(|folder| writes(folder)) {
            args.extend(["--bind-try".to_owned(), folder.clone(), folder.clone()]);
        }
        hide_in_bubblewrap(&mut args, &writable, &hidden, &writes);
        if !settings.network {
            args.push("--unshare-net".to_owned());
        }
        args.push("--".to_owned());
        args.push(invocation.file);
        args.extend(invocation.args);
        Invocation {
            file: bwrap_path(env)
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default(),
            args,
            verbatim: false,
        }
    };
    SandboxPlan {
        invocation: wrapped,
        sandboxed: true,
        reason: None,
    }
}

/// bubblewrap's mounts that hide `hidden`, after the writable folders are bound: a hidden folder becomes an empty
/// one and a hidden file an empty file; a writable folder inside a hidden one is bound back (read-only unless it takes
/// writes), and a hidden path inside that is hidden again. Mounts made later lie on top. The empty folders are made
/// read-only last, once the folders bound back inside them have their mount points, so a write there fails instead of
/// vanishing.
fn hide_in_bubblewrap(
    args: &mut Vec<String>,
    writable: &[String],
    hidden: &[String],
    writes: &dyn Fn(&String) -> bool,
) {
    let depth = |path: &String| Path::new(path).components().count();
    let hide = |args: &mut Vec<String>, path: &String| match std::fs::metadata(path) {
        Ok(info) if info.is_dir() => args.extend(["--tmpfs".to_owned(), path.clone()]),
        Ok(_) => args.extend(["--ro-bind".to_owned(), "/dev/null".to_owned(), path.clone()]),
        Err(_) => {}
    };
    let mut ordered: Vec<&String> = hidden.iter().collect();
    ordered.sort_by_key(|path| depth(path));
    for path in ordered {
        hide(args, path);
    }
    let mut opened = reopened(writable, hidden);
    opened.sort_by_key(|path| depth(path));
    for folder in &opened {
        let flag = if writes(folder) {
            "--bind-try"
        } else {
            "--ro-bind-try"
        };
        args.extend([flag.to_owned(), (*folder).clone(), (*folder).clone()]);
    }
    for path in hidden_again(hidden, &opened) {
        hide(args, path);
    }
    for path in hidden {
        if std::fs::metadata(path).is_ok_and(|info| info.is_dir()) {
            args.extend(["--remount-ro".to_owned(), path.clone()]);
        }
    }
}

fn pattern(text: &str) -> Regex {
    RegexBuilder::new(text)
        .case_insensitive(true)
        .build()
        .expect("the pattern is valid")
}

static BLOCKED: LazyLock<Regex> = LazyLock::new(|| {
    pattern("operation not permitted|permission denied|read-only file system|EPERM|EACCES|EROFS")
});
static OFFLINE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(
        "could not resolve|network is unreachable|connection refused|ENOTFOUND|ENETUNREACH|ECONNREFUSED|getaddrinfo",
    )
});

/// A hint for the model when a sandboxed command failed the way a blocked write or connection fails.
pub fn sandbox_hint(stderr: &str, settings: SandboxSettings) -> Option<String> {
    if BLOCKED.is_match(stderr) {
        let none = if settings.mode == SandboxMode::ReadOnly {
            " — none in read-only mode"
        } else {
            ""
        };
        return Some(format!(
            "(The sandbox allows writes only inside the workspace{none}. If this command must write elsewhere, call code with sandbox: \"off\"; that asks the user first.)"
        ));
    }
    if !settings.network && OFFLINE.is_match(stderr) {
        return Some("(The sandbox blocks network access for commands. If this command needs the network, call code with sandbox: \"off\"; that asks the user first.)".to_owned());
    }
    None
}
