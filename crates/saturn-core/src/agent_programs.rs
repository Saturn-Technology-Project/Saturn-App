//! The programs Saturn downloads rather than ships: Claude Code and Codex, the official programs behind the providers of
//! those names, and uv, which makes Python environments and can install Python itself. Saturn finds one on the system, or
//! downloads the exact package its tests pinned (the npm registry for the two programs, uv's GitHub release for uv), checks
//! it against the pinned sha512 and unpacks it into `<data>/tools`. Settings shows a download button for a program until
//! one is found, and the sign-in once it is; Environment does the same for uv.
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use saturn_domain::js;
use saturn_telemetry::network::{SendNoted, client_builder};
use serde_json::{Value, json};
use sha2::{Digest, Sha512};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{Notify, oneshot};

use crate::agent_sessions::SkillsBridge;
use crate::records::text;
use crate::{CoreError, Kernel, locked, log};

/// The packages Saturn downloads, by program and platform. Written by
/// `scripts/agent-programs-manifest.mjs`.
const PINNED_PACKAGES: &str = include_str!("agent-programs.json");
/// Attempts at a download before it waits for the user's next click.
const DOWNLOAD_ATTEMPTS: u32 = 5;
/// A connection that sends nothing for this long is treated as dropped, and the download resumes.
const DOWNLOAD_STALL: Duration = Duration::from_secs(60);
/// How long a program gets to answer a question about itself.
const QUESTION_TIMEOUT: Duration = Duration::from_secs(20);

/// A download in progress, or how the last one ended.
#[derive(Clone)]
struct Progress {
    state: &'static str,
    received: u64,
    total: u64,
    error: Option<String>,
}

/// One sign-in being carried out by `codex login`.
pub(crate) struct SignIn {
    pub(crate) info: Arc<Mutex<Value>>,
    pub(crate) cancel: Arc<Notify>,
}

/// What the runtime keeps for the two programs while it runs.
#[derive(Default)]
pub struct ProgramState {
    installs: Mutex<HashMap<String, Arc<Mutex<Progress>>>>,
    versions: Mutex<HashMap<String, Option<String>>>,
    /// Approvals waiting on the user, by `run:action`.
    pub(crate) pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    /// Saturn skills endpoints open for running Codex turns, by the token each turn holds.
    pub(crate) bridges: Mutex<HashMap<String, Arc<SkillsBridge>>>,
    pub(crate) sign_in: Mutex<Option<SignIn>>,
    pub(crate) last_sign_in: Mutex<Option<Value>>,
    /// Programs running for a turn or a sign-in, so they end with the runtime.
    pub(crate) running: Mutex<HashSet<u32>>,
}

/// The programs, in the order the list gives them.
const PROGRAMS: [&str; 3] = ["claude-code", "codex", "uv"];

/// One of the programs by id, or the 404 for anything else.
pub fn program_id(value: &str) -> Result<&'static str, CoreError> {
    PROGRAMS
        .iter()
        .copied()
        .find(|id| *id == value)
        .ok_or_else(|| CoreError::new(404, "Unknown program; use claude-code, codex or uv"))
}

fn label(id: &str) -> &'static str {
    match id {
        "codex" => "Codex",
        "uv" => "uv",
        _ => "Claude Code",
    }
}

fn executable(id: &str) -> String {
    let name = match id {
        "codex" => "codex",
        "uv" => "uv",
        _ => "claude",
    };
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}

/// This computer as the npm packages name it.
pub(crate) fn platform() -> String {
    let system = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let architecture = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    format!("{system}-{architecture}")
}

/// The program inside an unpacked platform package: claude at its root, codex under vendor/<target>/bin, and uv at the
/// root (the Windows zip) or in the one folder its tar.gz holds (`uv-<target>/uv`).
fn binary_in(id: &str, package: &Path) -> Option<PathBuf> {
    let folders = match id {
        "codex" => std::fs::read_dir(package.join("vendor"))
            .ok()?
            .flatten()
            .map(|entry| entry.path().join("bin"))
            .collect(),
        "uv" => std::iter::once(package.to_path_buf())
            .chain(
                std::fs::read_dir(package)
                    .ok()?
                    .flatten()
                    .map(|entry| entry.path()),
            )
            .collect(),
        _ => vec![package.to_path_buf()],
    };
    folders
        .into_iter()
        .map(|folder| folder.join(executable(id)))
        .find(|file| file.is_file())
}

/// A program's answer to a question about itself.
pub(crate) struct Answer {
    /// None when it could not start or ran out of time.
    pub(crate) code: Option<i32>,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

/// Runs a program and waits for its answer. Dropping the future ends it.
pub(crate) async fn ask_program(
    file: &Path,
    args: &[&str],
    configure: impl FnOnce(&mut Command),
    timeout: Duration,
) -> Answer {
    let mut command = Command::new(file);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    configure(&mut command);
    saturn_tools::no_window(&mut command);
    match tokio::time::timeout(timeout, command.output()).await {
        Ok(Ok(output)) => Answer {
            code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        },
        Ok(Err(error)) => Answer {
            code: None,
            stdout: String::new(),
            stderr: error.to_string(),
        },
        Err(_) => Answer {
            code: None,
            stdout: String::new(),
            stderr: "it did not answer in time".to_owned(),
        },
    }
}

impl Kernel {
    fn program_root(&self, id: &str) -> PathBuf {
        self.store.root().join("tools").join(id)
    }

    /// The package to download on this computer; SATURN_PROGRAM_PACKAGES points tests at their own pins.
    fn program_package(&self, id: &str) -> Option<Value> {
        let packages: Value = match std::env::var_os("SATURN_PROGRAM_PACKAGES") {
            Some(file) => std::fs::read(file)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or(Value::Null),
            None => serde_json::from_str(PINNED_PACKAGES).unwrap_or(Value::Null),
        };
        packages.get(id)?.get(platform()).cloned()
    }

    /// The program on the user's PATH. On Windows only a real .exe counts: npm's .cmd shims cannot start without a shell.
    fn system_program(id: &str) -> Option<PathBuf> {
        let path = std::env::var_os("PATH")?;
        std::env::split_paths(&path)
            .map(|folder| folder.join(executable(id)))
            .find(|file| file.is_file())
    }

    /// Saturn's own download first (the tested version), then the system's.
    pub(crate) fn resolve_program(&self, id: &str) -> Option<(PathBuf, &'static str)> {
        let saturn = self.program_package(id).and_then(|item| {
            binary_in(
                id,
                &self
                    .program_root(id)
                    .join(text(&item, "version"))
                    .join("package"),
            )
        });
        saturn
            .map(|file| (file, "saturn"))
            .or_else(|| Self::system_program(id).map(|file| (file, "system")))
    }

    /// The program to run, or a 409 that says where to get it.
    pub(crate) fn program_path(&self, id: &str) -> Result<PathBuf, CoreError> {
        self.resolve_program(id).map(|(file, _)| file).ok_or_else(|| {
            let name = label(id);
            CoreError::new(
                409,
                format!("{name} is not installed. Download it in Saturn Settings → General → {name}."),
            )
        })
    }

    /// What the program itself reports (`--version`), once per copy of it.
    async fn program_version(&self, file: &Path) -> Option<String> {
        let stamp = std::fs::metadata(file)
            .and_then(|meta| meta.modified())
            .ok()?
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos());
        let key = format!("{}:{stamp}", file.display());
        if let Some(known) = locked(&self.programs.versions).get(&key) {
            return known.clone();
        }
        let answer = ask_program(file, &["--version"], |_| {}, Duration::from_secs(15)).await;
        let version = (answer.code == Some(0))
            .then(|| {
                answer
                    .stdout
                    .lines()
                    .next()
                    .map(|line| line.trim().to_owned())
            })
            .flatten()
            .filter(|line| !line.is_empty());
        locked(&self.programs.versions).insert(key, version.clone());
        version
    }

    /// Whether a program is installed, where from, and what a download would bring.
    pub async fn program_status(&self, id: &str) -> Value {
        let found = self.resolve_program(id);
        let item = self.program_package(id);
        // A snapshot: the download keeps running while the version is asked for below.
        let current = locked(&self.programs.installs)
            .get(id)
            .map(|progress| locked(progress).clone());
        let version = match &found {
            Some((file, _)) => self.program_version(file).await,
            None => None,
        };
        let mut status = json!({
            "id": id,
            "label": label(id),
            "installed": found.is_some(),
            "source": found.as_ref().map(|(_, source)| *source),
            "path": found.as_ref().map(|(file, _)| file.to_string_lossy()),
            "version": version,
            "downloadVersion": item.as_ref().map(|item| text(item, "version")),
            "downloadSize": item.as_ref().and_then(|item| item.get("size")).cloned().unwrap_or_else(|| json!(0)),
        });
        if let Some(progress) = current.filter(|progress| progress.state != "done") {
            let mut install = json!({
                "state": progress.state,
                "received": progress.received,
                "total": progress.total,
            });
            if let Some(error) = progress.error {
                install["error"] = json!(error);
            }
            status["install"] = install;
        }
        status
    }

    /// Every program.
    pub async fn program_statuses(&self) -> Value {
        let mut statuses = Vec::with_capacity(PROGRAMS.len());
        for id in PROGRAMS {
            statuses.push(self.program_status(id).await);
        }
        Value::Array(statuses)
    }

    /// Starts the download in the background; the status reports its progress.
    pub async fn install_program(self: &Arc<Self>, id: &'static str) -> Result<Value, CoreError> {
        let downloading = locked(&self.programs.installs)
            .get(id)
            .is_some_and(|progress| {
                matches!(
                    locked(progress).state,
                    "downloading" | "verifying" | "unpacking"
                )
            });
        if downloading {
            return Ok(self.program_status(id).await);
        }
        let Some(item) = self.program_package(id) else {
            return Err(CoreError::new(
                409,
                format!("{} has no download for {}.", label(id), platform()),
            ));
        };
        let progress = Arc::new(Mutex::new(Progress {
            state: "downloading",
            received: 0,
            total: item.get("size").and_then(Value::as_u64).unwrap_or(0),
            error: None,
        }));
        locked(&self.programs.installs).insert(id.to_owned(), Arc::clone(&progress));
        let kernel = Arc::clone(self);
        tokio::spawn(async move {
            if let Err(error) = kernel.download_program(id, &item, &progress).await {
                log(
                    "admin",
                    "warning",
                    &format!("Downloading {} failed: {error}", label(id)),
                );
                let mut progress = locked(&progress);
                progress.state = "failed";
                progress.error = Some(error);
            }
        });
        Ok(self.program_status(id).await)
    }

    async fn download_program(
        &self,
        id: &str,
        item: &Value,
        progress: &Arc<Mutex<Progress>>,
    ) -> Result<(), String> {
        let describe = |error: std::io::Error| error.to_string();
        let root = self.program_root(id);
        tokio::fs::create_dir_all(&root).await.map_err(describe)?;
        let version = text(item, "version");
        let archive = root.join(format!("{version}.tgz.part"));
        let unpacking = root.join(format!("{version}.unpacking"));
        let target = root.join(version);
        log(
            "admin",
            "info",
            &format!("Downloading {} {version}", label(id)),
        );
        fetch_resumable(item, &archive, progress).await?;

        locked(progress).state = "verifying";
        let expected = text(item, "integrity").trim_start_matches("sha512-");
        if sha512_of(&archive).await.map_err(describe)? != expected {
            let _ = tokio::fs::remove_file(&archive).await;
            return Err("the download does not match the checksum Saturn pinned for it, so it was discarded".to_owned());
        }

        locked(progress).state = "unpacking";
        let unpacked = unpack(id, &archive, &unpacking, &target, &root, version).await;
        let _ = tokio::fs::remove_file(&archive).await;
        let _ = tokio::fs::remove_dir_all(&unpacking).await;
        unpacked?;
        locked(progress).state = "done";
        log(
            "admin",
            "info",
            &format!("{} {version} is installed", label(id)),
        );
        Ok(())
    }

    /// Removes Saturn's own copy (a system install is left alone).
    pub async fn remove_program(&self, id: &str) -> Result<Value, CoreError> {
        match tokio::fs::remove_dir_all(self.program_root(id)).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(CoreError::new(500, error.to_string())),
        }
        locked(&self.programs.installs).remove(id);
        log(
            "admin",
            "info",
            &format!("Removed Saturn's copy of {}", label(id)),
        );
        Ok(self.program_status(id).await)
    }

    /// Ends what runs for the programs, when the runtime stops.
    pub fn stop_programs(&self) {
        if let Some(current) = locked(&self.programs.sign_in).as_ref() {
            current.cancel.notify_one();
        }
        for pid in locked(&self.programs.running).drain() {
            saturn_tools::terminate(pid);
        }
    }
}

/// Unpacks a checked package, makes its program executable, and leaves only this version in the program's folder. An npm
/// tarball holds a `package` folder; uv's archive holds its files bare, so it is unpacked into one of that name.
async fn unpack(
    id: &str,
    archive: &Path,
    unpacking: &Path,
    target: &Path,
    root: &Path,
    version: &str,
) -> Result<(), String> {
    let describe = |error: std::io::Error| error.to_string();
    let _ = tokio::fs::remove_dir_all(unpacking).await;
    let into = if id == "uv" {
        unpacking.join("package")
    } else {
        unpacking.to_path_buf()
    };
    tokio::fs::create_dir_all(&into).await.map_err(describe)?;
    untar(archive, &into).await?;
    let binary = binary_in(id, &unpacking.join("package"))
        .ok_or_else(|| "the package does not contain the program".to_owned())?;
    make_executable(&binary).await.map_err(describe)?;
    let _ = tokio::fs::remove_dir_all(target).await;
    tokio::fs::rename(unpacking, target)
        .await
        .map_err(describe)?;
    // Older versions and leftovers go; only the version this Saturn uses stays.
    let mut entries = tokio::fs::read_dir(root).await.map_err(describe)?;
    while let Some(entry) = entries.next_entry().await.map_err(describe)? {
        if entry.file_name().to_string_lossy() == version {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            let _ = tokio::fs::remove_dir_all(&path).await;
        } else if path != archive {
            let _ = tokio::fs::remove_file(&path).await;
        }
    }
    Ok(())
}

#[cfg(unix)]
async fn make_executable(file: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    tokio::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).await
}

#[cfg(not(unix))]
async fn make_executable(_file: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Downloads into `archive`, resuming after a dropped connection: what arrived stays on disk, and the next attempt (a retry here,
/// or the user's next click) asks only for the rest with an HTTP range request.
async fn fetch_resumable(
    item: &Value,
    archive: &Path,
    progress: &Arc<Mutex<Progress>>,
) -> Result<(), String> {
    let size = item.get("size").and_then(Value::as_u64).unwrap_or(0);
    let client = client_builder()
        .read_timeout(DOWNLOAD_STALL)
        .build()
        .map_err(|error| error.to_string())?;
    let mut last_error = String::new();
    for attempt in 1..=DOWNLOAD_ATTEMPTS {
        let have = tokio::fs::metadata(archive)
            .await
            .map_or(0, |meta| meta.len());
        if size > 0 && have >= size {
            return Ok(());
        }
        match fetch_once(&client, item, archive, progress, have).await {
            Ok(true) => return Ok(()),
            // Too much was kept to resume from: start over, without counting it as a wait.
            Ok(false) => last_error = "the connection closed early".to_owned(),
            Err(error) => last_error = error,
        }
        if attempt < DOWNLOAD_ATTEMPTS {
            log(
                "admin",
                "warning",
                &format!("A download was interrupted ({last_error}); resuming"),
            );
            tokio::time::sleep(Duration::from_secs(2 * u64::from(attempt))).await;
        }
    }
    Err(format!(
        "the download kept failing ({last_error}). What arrived is kept: press Download again to resume."
    ))
}

/// One request for the rest of the file. True when the whole file arrived.
async fn fetch_once(
    client: &reqwest::Client,
    item: &Value,
    archive: &Path,
    progress: &Arc<Mutex<Progress>>,
    have: u64,
) -> Result<bool, String> {
    let describe = |error: std::io::Error| error.to_string();
    let mut request = client.get(text(item, "url"));
    if have > 0 {
        request = request.header("range", format!("bytes={have}-"));
    }
    let mut response = request
        .send_noted()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    if status == 416 {
        let _ = tokio::fs::remove_file(archive).await;
        return Ok(false);
    }
    if !response.status().is_success() {
        return Err(format!("the registry answered {status}"));
    }
    let resuming = have > 0 && status == 206;
    let start = if resuming { have } else { 0 };
    let length = response.content_length().unwrap_or(0);
    {
        let mut shown = locked(progress);
        shown.total = if length > 0 {
            start + length
        } else {
            item.get("size").and_then(Value::as_u64).unwrap_or(0)
        };
        shown.received = start;
    }
    let mut options = tokio::fs::OpenOptions::new();
    options.create(true);
    if resuming {
        options.append(true);
    } else {
        options.write(true).truncate(true);
    }
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(archive).await.map_err(describe)?;
    let mut failed = None;
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                file.write_all(&chunk).await.map_err(describe)?;
                locked(progress).received += chunk.len() as u64;
            }
            Ok(None) => break,
            // What arrived stays, for the next attempt to resume from.
            Err(error) => {
                failed = Some(error.to_string());
                break;
            }
        }
    }
    file.flush().await.map_err(describe)?;
    if let Some(error) = failed {
        return Err(error);
    }
    let shown = locked(progress).clone();
    Ok(shown.total == 0 || shown.received >= shown.total)
}

/// A file's sha512, as npm's integrity strings write it.
async fn sha512_of(file: &Path) -> std::io::Result<String> {
    let mut hash = Sha512::new();
    let mut source = tokio::fs::File::open(file).await?;
    let mut chunk = vec![0_u8; 256 * 1024];
    loop {
        let read = source.read(&mut chunk).await?;
        if read == 0 {
            return Ok(STANDARD.encode(hash.finalize()));
        }
        hash.update(&chunk[..read]);
    }
}

/// Unpacks a .tgz with the system's tar (bsdtar on macOS and Windows 10+, GNU tar on Linux). bsdtar reads a .zip, uv's
/// archive on Windows, the same way: on extraction it tells the format itself and ignores -z.
async fn untar(archive: &Path, destination: &Path) -> Result<(), String> {
    let tar = if cfg!(windows) {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        PathBuf::from(root).join("System32").join("tar.exe")
    } else {
        PathBuf::from("tar")
    };
    let archive = archive.to_string_lossy();
    let destination = destination.to_string_lossy();
    let answer = ask_program(
        &tar,
        &["-xzf", &archive, "-C", &destination],
        |_| {},
        Duration::from_secs(600),
    )
    .await;
    if answer.code == Some(0) {
        return Ok(());
    }
    let detail = js::trim(&answer.stderr);
    Err(format!(
        "tar could not unpack the package: {}",
        if detail.is_empty() {
            format!("exit {}", answer.code.unwrap_or(-1))
        } else {
            detail.to_owned()
        }
    ))
}

/// The timeout for a status or sign-out question.
pub(crate) const fn question_timeout() -> Duration {
    QUESTION_TIMEOUT
}
