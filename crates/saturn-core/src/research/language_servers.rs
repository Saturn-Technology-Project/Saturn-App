//! Local language servers for the person's source editor. Rust owns the child, protocol framing and project boundary;
//! the desktop speaks JSON messages over authenticated HTTP. No assistant tool can launch or reach these sessions.
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use saturn_domain::new_id;
use saturn_tools::{force, in_own_group, terminate};
use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex as AsyncMutex, mpsc, watch};
use url::Url;

use crate::records::text;
use crate::{CoreError, Kernel, locked};

const MAX_MESSAGE: usize = 8 * 1024 * 1024;
const MAX_HISTORY: usize = 16 * 1024 * 1024;
const IDLE: Duration = Duration::from_secs(90);
/// The largest installed-package source file a definition opens to.
const MAX_LIBRARY_FILE: u64 = 4 * 1024 * 1024;

/// What the selected Python is asked for its import path: -E ignores PYTHON* variables.
const IMPORT_PATH: [&str; 3] = ["-E", "-c", "import json, sys; print(json.dumps(sys.path))"];

/// The folders a session's installed packages live in, outside the project: the selected Python's import path (asked
/// with `probe`, the interpreter in the project's sandbox), or the Rust toolchains' and crates' sources. A definition
/// there opens read-only; nothing else outside the project does.
async fn library_roots(language: &str, probe: Option<Command>, root: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = Vec::new();
    match (language, probe) {
        ("python", Some(mut command)) => {
            // A neutral folder keeps the project's own modules off the path.
            command
                .current_dir(std::env::temp_dir())
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            if let Ok(Ok(output)) =
                tokio::time::timeout(Duration::from_secs(5), command.output()).await
                && let Ok(paths) = serde_json::from_slice::<Vec<String>>(&output.stdout)
            {
                found.extend(
                    paths
                        .into_iter()
                        .filter(|path| !path.is_empty())
                        .map(PathBuf::from),
                );
            }
        }
        ("rust", _) => {
            let home = std::env::var_os("HOME").map(PathBuf::from);
            let rustup = std::env::var_os("RUSTUP_HOME")
                .map(PathBuf::from)
                .or_else(|| home.as_ref().map(|home| home.join(".rustup")));
            let cargo = std::env::var_os("CARGO_HOME")
                .map(PathBuf::from)
                .or_else(|| home.as_ref().map(|home| home.join(".cargo")));
            found.extend(rustup.map(|folder| folder.join("toolchains")));
            if let Some(cargo) = cargo {
                found.push(cargo.join("registry").join("src"));
                found.push(cargo.join("git").join("checkouts"));
            }
        }
        _ => {}
    }
    let root = tokio::fs::canonicalize(root)
        .await
        .unwrap_or_else(|_| root.to_path_buf());
    let mut roots = Vec::new();
    for folder in found {
        let Ok(real) = tokio::fs::canonicalize(&folder).await else {
            continue;
        };
        // Never the whole disk, the project, or a folder that holds the project.
        if real.is_dir()
            && real.parent().is_some()
            && !real.starts_with(&root)
            && !root.starts_with(&real)
        {
            roots.push(real);
        }
    }
    roots
}

/// Sessions belong to the client that started them and are never stored in research records.
#[derive(Debug, Default)]
pub(super) struct LanguageServers {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// Invalidates starts awaiting filesystem work when access, folders or interpreters change.
    changes: AtomicU64,
}

/// A server process and the bounded replay of its output, so initialization cannot race the event subscription.
#[derive(Debug)]
struct Session {
    project: String,
    root: PathBuf,
    root_uri: String,
    language: String,
    settings: Value,
    /// Where definitions outside the project may be read from, read-only.
    library: Vec<PathBuf>,
    input: AsyncMutex<Option<ChildStdin>>,
    output: Mutex<Output>,
    moved: watch::Sender<u64>,
    stop: watch::Sender<bool>,
    listeners: AtomicUsize,
    touched: Mutex<Instant>,
}

/// Protocol messages kept for a reconnect. Missing a message ends a connection rather than corrupting its state.
#[derive(Debug, Default)]
struct Output {
    messages: VecDeque<(u64, String)>,
    bytes: usize,
    next: u64,
    ended: bool,
}

impl Session {
    /// Publish one message without writing source text or protocol payloads to the runtime's log.
    fn publish(&self, message: Value) {
        let mut output = locked(&self.output);
        let sequence = output.next;
        let line = json!({ "seq": sequence, "message": message }).to_string();
        output.bytes += line.len();
        output.messages.push_back((sequence, line));
        output.next += 1;
        while output.bytes > MAX_HISTORY && output.messages.len() > 1 {
            if let Some((_, line)) = output.messages.pop_front() {
                output.bytes -= line.len();
            }
        }
        self.moved.send_replace(output.next);
    }

    /// Write a complete frame under one lock, preserving the order of document updates and subsequent requests.
    async fn write(&self, message: &Value) -> Result<(), CoreError> {
        let bytes = serde_json::to_vec(message)
            .map_err(|_| CoreError::new(400, "Invalid language-server JSON."))?;
        let mut input = self.input.lock().await;
        let input = input
            .as_mut()
            .ok_or_else(|| CoreError::new(410, "The language server has stopped."))?;
        let frame = format!("Content-Length: {}\r\n\r\n", bytes.len());
        tokio::time::timeout(Duration::from_secs(10), async {
            input.write_all(frame.as_bytes()).await?;
            input.write_all(&bytes).await?;
            input.flush().await
        })
        .await
        .map_err(|_| CoreError::new(504, "The language server stopped reading requests."))??;
        Ok(())
    }

    /// Answer server requests here. Workspace edits and executable commands are never delegated to the interface.
    async fn receive(&self, message: Value) -> Result<(), CoreError> {
        if let (Some(id), Some(method)) = (
            message.get("id"),
            message.get("method").and_then(Value::as_str),
        ) {
            let result = match method {
                "workspace/configuration" => {
                    let items = message.pointer("/params/items").and_then(Value::as_array).cloned().unwrap_or_default();
                    json!(items.iter().map(|item| {
                        let section = text(item, "section");
                        if section.is_empty() { return self.settings.clone(); }
                        section.split('.').fold(&self.settings, |value, part| value.get(part).unwrap_or(&Value::Null)).clone()
                    }).collect::<Vec<_>>())
                }
                "workspace/workspaceFolders" => json!([{ "uri": self.root_uri, "name": "Saturn" }]),
                "client/registerCapability" | "client/unregisterCapability" | "window/workDoneProgress/create" => Value::Null,
                "workspace/diagnostic/refresh" => {
                    self.publish(json!({ "jsonrpc": "2.0", "method": "workspace/diagnostic/refresh", "params": {} }));
                    Value::Null
                }
                "workspace/applyEdit" => json!({ "applied": false, "failureReason": "Workspace edits are not enabled in Saturn's language client." }),
                _ => return self.write(&json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Client request not supported" } })).await,
            };
            self.write(&json!({ "jsonrpc": "2.0", "id": id, "result": result }))
                .await
        } else {
            self.publish(message);
            Ok(())
        }
    }
}

/// The file names a program may have on this system: its own on macOS and Linux, and on Windows an `.exe` or the
/// `.cmd` npm writes for a package's program.
fn spellings(name: &str) -> Vec<String> {
    if cfg!(windows) {
        vec![format!("{name}.exe"), format!("{name}.cmd")]
    } else {
        vec![name.to_owned()]
    }
}

/// The program by one of its spellings in a folder.
fn program_in(folder: &Path, name: &str) -> Option<PathBuf> {
    spellings(name)
        .into_iter()
        .map(|spelling| folder.join(spelling))
        .find(|path| path.is_file())
}

/// Resolve a program using the runtime's launch PATH, without a shell or project-supplied command arguments.
fn program(name: &str, nearby: Option<&Path>) -> Option<PathBuf> {
    nearby
        .and_then(|folder| program_in(folder, name))
        .or_else(|| {
            std::env::var_os("PATH").and_then(|path| {
                std::env::split_paths(&path).find_map(|folder| program_in(&folder, name))
            })
        })
}

/// The `package.json` of the package a compiler belongs to. On macOS and Linux the program is a link into the package's
/// `bin`; on Windows it is a `.cmd` in `node_modules/.bin`, or beside a `node_modules` for one installed for everyone.
fn compiler_package(candidate: &Path) -> Option<PathBuf> {
    if cfg!(windows) {
        let folder = candidate.parent()?;
        [
            folder.parent()?.join("typescript"),
            folder.join("node_modules").join("typescript"),
        ]
        .into_iter()
        .map(|package| package.join("package.json"))
        .find(|package| package.is_file())
    } else {
        let executable = std::fs::canonicalize(candidate).ok()?;
        Some(executable.parent()?.parent()?.join("package.json"))
    }
}

/// TypeScript 7 ships its own LSP and no tsserver.js. Prefer the project's compiler, then one installed on PATH.
fn native_typescript(root: &Path) -> Option<PathBuf> {
    let local = program_in(&root.join("node_modules").join(".bin"), "tsc");
    let candidates = [local, program("tsc", None)];
    candidates.into_iter().flatten().find_map(|candidate| {
        let package = compiler_package(&candidate)?;
        let metadata: Value = serde_json::from_slice(&std::fs::read(package).ok()?).ok()?;
        let version = text(&metadata, "version")
            .split('.')
            .next()?
            .parse::<u32>()
            .ok()?;
        (text(&metadata, "name") == "typescript" && version >= 7).then_some(candidate)
    })
}

/// Decode one stdio frame, measuring UTF-8 bytes and bounding both headers and payload before allocation.
async fn read_message(reader: &mut (impl AsyncBufRead + Unpin)) -> Result<Value, CoreError> {
    let mut size = None;
    let mut total = 0;
    loop {
        let mut line = Vec::new();
        let read = (&mut *reader)
            .take(8193)
            .read_until(b'\n', &mut line)
            .await?;
        total += read;
        if read == 0 || total > 8192 || !line.ends_with(b"\r\n") {
            return Err(CoreError::new(502, "Invalid language-server frame."));
        }
        if line == b"\r\n" {
            break;
        }
        let line = std::str::from_utf8(&line)
            .map_err(|_| CoreError::new(502, "Invalid language-server header."))?;
        if let Some((key, value)) = line.split_once(':')
            && key.eq_ignore_ascii_case("content-length")
        {
            if size.is_some() {
                return Err(CoreError::new(502, "Repeated language-server length."));
            }
            size = value.trim().parse::<usize>().ok();
        }
    }
    let size = size
        .filter(|size| *size > 0 && *size <= MAX_MESSAGE)
        .ok_or_else(|| CoreError::new(502, "Invalid language-server message size."))?;
    let mut bytes = vec![0; size];
    reader.read_exact(&mut bytes).await?;
    let message: Value = serde_json::from_slice(&bytes)
        .map_err(|_| CoreError::new(502, "Invalid language-server JSON."))?;
    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(CoreError::new(502, "Invalid language-server message."));
    }
    Ok(message)
}

/// Own and reap the server. Lost windows expire, and a protocol failure ends the whole process group.
async fn supervise(session: Arc<Session>, mut child: Child) {
    let pid = child.id();
    let mut stopping = session.stop.subscribe();
    let reading = child.stdout.take().map(|stdout| {
        let session = Arc::clone(&session);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            while let Ok(message) = read_message(&mut reader).await {
                if session.receive(message).await.is_err() {
                    break;
                }
            }
            session.stop.send_replace(true);
        })
    });
    let errors = child.stderr.take().map(|mut stderr| {
        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
        })
    });
    let mut interval = tokio::time::interval(Duration::from_secs(5));
    let exited = loop {
        if *stopping.borrow() {
            break false;
        }
        tokio::select! {
            _ = child.wait() => break true,
            _ = stopping.changed() => break false,
            _ = interval.tick() => {
                if session.listeners.load(Ordering::Relaxed) == 0 && locked(&session.touched).elapsed() > IDLE { break false; }
            }
        }
    };
    if !exited {
        if let Some(pid) = child.id() {
            terminate(pid);
        }
        if tokio::time::timeout(Duration::from_secs(1), child.wait())
            .await
            .is_err()
        {
            if let Some(pid) = child.id() {
                force(pid);
            }
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    } else if let Some(pid) = pid {
        force(pid);
    }
    if let Some(reading) = reading {
        reading.abort();
    }
    if let Some(errors) = errors {
        errors.abort();
    }
    session.input.lock().await.take();
    locked(&session.output).ended = true;
    session.moved.send_modify(|sequence| *sequence += 1);
}

impl Kernel {
    /// Start one local server. Installations are explicit; opening an editor never downloads packages.
    pub async fn research_lsp_start(
        &self,
        project: &str,
        language: &str,
    ) -> Result<Value, CoreError> {
        let configuration = self
            .research
            .language_servers
            .changes
            .load(Ordering::SeqCst);
        let root = self.research_source(project, None)?;
        let python = if language == "python" {
            Some(self.research_python(project).await?)
        } else {
            None
        };
        let python = python.map(|python| {
            let path = PathBuf::from(&python);
            if path.is_absolute() {
                path
            } else if path.components().count() > 1 {
                root.join(path)
            } else {
                program(&python, None).unwrap_or(path)
            }
        });
        if python.as_deref().is_some_and(|path| !path.is_file()) {
            return Err(CoreError::new(
                422,
                "The selected Python could not be found. Choose an existing interpreter under Environment.",
            ));
        }
        let nearby = python.as_deref().and_then(Path::parent);
        let managed =
            root.join(super::manage::VENV)
                .join(if cfg!(windows) { "Scripts" } else { "bin" });
        let (name, executable, args): (&str, PathBuf, &[&str]) = match language {
            "python" => {
                if let Some(path) = nearby
                    .and_then(|folder| program_in(folder, "basedpyright-langserver"))
                    .or_else(|| program("basedpyright-langserver", Some(&managed)))
                {
                    ("basedpyright", path, &["--stdio"])
                } else if let Some(path) = program("pyright-langserver", nearby) {
                    ("pyright", path, &["--stdio"])
                } else {
                    return Err(CoreError::new(
                        422,
                        "Install the Python language server kit under Environment, or install basedpyright-langserver / pyright-langserver on PATH.",
                    ));
                }
            }
            "typescript" => {
                if let Some(path) = native_typescript(&root) {
                    ("typescript-native", path, &["--lsp", "--stdio"])
                } else {
                    ("typescript-language-server", program("typescript-language-server", None).ok_or_else(|| CoreError::new(422, "Install TypeScript 7 (tsc), or typescript-language-server with TypeScript 6, on PATH."))?, &["--stdio"])
                }
            }
            "rust" => (
                "rust-analyzer",
                program("rust-analyzer", None).ok_or_else(|| {
                    CoreError::new(
                        422,
                        "Install rust-analyzer on PATH with rustup component add rust-analyzer.",
                    )
                })?,
                &[],
            ),
            _ => {
                return Err(CoreError::new(
                    400,
                    "Supported language servers are python, typescript and rust.",
                ));
            }
        };
        let root_uri = Url::from_directory_path(&root)
            .map_err(|()| CoreError::new(422, "The project has no file URI."))?
            .to_string();
        let settings = json!({
            "python": { "pythonPath": python, "analysis": { "typeCheckingMode": "basic", "diagnosticMode": "openFilesOnly" } },
            "basedpyright": { "analysis": { "typeCheckingMode": "basic", "diagnosticMode": "openFilesOnly" } },
            "rust-analyzer": { "checkOnSave": false, "cargo": { "buildScripts": { "enable": false } }, "procMacro": { "enable": false } }
        });
        // The interpreter and the server both come from the project's environment (pip installs basedpyright into
        // .venv/bin), which a cloned folder can bring: they run in the project's command sandbox.
        let probe = python.as_deref().map(|python| {
            let words: Vec<String> = IMPORT_PATH.iter().map(|word| (*word).to_owned()).collect();
            self.research_command(project, &python.to_string_lossy(), &words, &root, &[])
        });
        let library = library_roots(language, probe, &root).await;
        let words: Vec<String> = args.iter().map(|word| (*word).to_owned()).collect();
        let mut command =
            self.research_command(project, &executable.to_string_lossy(), &words, &root, &[]);
        command
            .current_dir(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        in_own_group(&mut command);
        let id = new_id("lsp")?;
        let mut sessions = locked(&self.research.language_servers.sessions);
        // Check again under the insertion lock: revocation must either precede a start or collect its process.
        if self.research.ending.load(Ordering::SeqCst) {
            return Err(CoreError::new(503, "The runtime is stopping."));
        }
        if configuration
            != self
                .research
                .language_servers
                .changes
                .load(Ordering::SeqCst)
            || self.research_source(project, None)? != root
        {
            return Err(CoreError::new(
                409,
                "Language-service configuration changed. Restart the connection.",
            ));
        }
        sessions.retain(|_, session| !locked(&session.output).ended);
        if sessions
            .values()
            .filter(|session| session.project == project)
            .count()
            >= 6
        {
            return Err(CoreError::new(
                429,
                "Close an existing language-server session first.",
            ));
        }
        let mut child = command.spawn().map_err(|_| {
            CoreError::new(
                422,
                format!("{name} could not start. Check its installation under Environment."),
            )
        })?;
        let session = Arc::new(Session {
            project: project.to_owned(),
            root,
            root_uri: root_uri.clone(),
            language: language.to_owned(),
            settings,
            library,
            input: AsyncMutex::new(child.stdin.take()),
            output: Mutex::default(),
            moved: watch::channel(0).0,
            stop: watch::channel(false).0,
            listeners: AtomicUsize::new(0),
            touched: Mutex::new(Instant::now()),
        });
        sessions.insert(id.clone(), Arc::clone(&session));
        tokio::spawn(supervise(session, child));
        Ok(
            json!({ "id": id, "rootUri": root_uri, "server": name, "language": language, "python": python }),
        )
    }

    /// A definition's source file outside the project, read-only: only from the session's installed packages, only a
    /// source file of its language, and never through a link that leads elsewhere.
    pub async fn research_lsp_library(
        &self,
        project: &str,
        id: &str,
        uri: &str,
    ) -> Result<Value, CoreError> {
        let session = self.lsp_session(project, id)?;
        let path = Url::parse(uri)
            .ok()
            .filter(|url| url.scheme() == "file")
            .and_then(|url| url.to_file_path().ok())
            .ok_or_else(|| CoreError::new(400, "A definition is opened by its file address."))?;
        let real = tokio::fs::canonicalize(&path)
            .await
            .map_err(|_| CoreError::new(404, "The definition's file is not there."))?;
        let extensions: &[&str] = match session.language.as_str() {
            "python" => &["py", "pyi"],
            "rust" => &["rs"],
            _ => &[],
        };
        let source = real
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extensions.contains(&extension));
        if !source
            || !session
                .library
                .iter()
                .any(|folder| real.starts_with(folder))
        {
            return Err(CoreError::new(
                403,
                "Only source files of the packages this language server uses open outside the project.",
            ));
        }
        let info = tokio::fs::metadata(&real).await?;
        if !info.is_file() || info.len() > MAX_LIBRARY_FILE {
            return Err(CoreError::new(
                413,
                "The definition's file is too large to show.",
            ));
        }
        let content = String::from_utf8(tokio::fs::read(&real).await?)
            .map_err(|_| CoreError::new(415, "The definition's file is not text."))?;
        Ok(json!({ "path": real.to_string_lossy(), "content": content }))
    }

    /// Check ownership and current project access for every transport operation, including reconnects.
    fn lsp_session(&self, project: &str, id: &str) -> Result<Arc<Session>, CoreError> {
        let root = self.research_source(project, None)?;
        locked(&self.research.language_servers.sessions)
            .get(id)
            .filter(|session| session.project == project && session.root == root)
            .cloned()
            .ok_or_else(|| CoreError::new(404, "No such language-server session."))
    }

    /// Forward only editing queries and document synchronization, with all document URIs inside the granted project.
    pub async fn research_lsp_send(
        &self,
        project: &str,
        id: &str,
        messages: &Value,
    ) -> Result<Value, CoreError> {
        let session = self.lsp_session(project, id)?;
        let messages = messages
            .as_array()
            .filter(|messages| !messages.is_empty() && messages.len() <= 32)
            .ok_or_else(|| {
                CoreError::new(400, "Send between one and 32 language-server messages.")
            })?;
        let mut checked = Vec::new();
        for message in messages {
            let mut message = message.clone();
            let method = text(&message, "method").to_owned();
            if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
                || message.to_string().len() > MAX_MESSAGE
            {
                return Err(CoreError::new(400, "Invalid language-server message."));
            }
            if !matches!(
                method.as_str(),
                "initialize"
                    | "initialized"
                    | "shutdown"
                    | "exit"
                    | "$/cancelRequest"
                    | "textDocument/didOpen"
                    | "textDocument/didChange"
                    | "textDocument/didClose"
                    | "textDocument/didSave"
                    | "textDocument/completion"
                    | "completionItem/resolve"
                    | "textDocument/hover"
                    | "textDocument/signatureHelp"
                    | "textDocument/definition"
                    | "textDocument/typeDefinition"
                    | "textDocument/implementation"
                    | "textDocument/references"
                    | "textDocument/documentSymbol"
                    | "textDocument/diagnostic"
                    | "workspace/didChangeWatchedFiles"
            ) {
                return Err(CoreError::new(
                    403,
                    "This language-server operation is not enabled.",
                ));
            }
            if let Some(uri) = message
                .pointer("/params/textDocument/uri")
                .and_then(Value::as_str)
            {
                let path = Url::parse(uri)
                    .ok()
                    .and_then(|uri| uri.to_file_path().ok())
                    .ok_or_else(|| CoreError::new(403, "Only project file URIs are allowed."))?;
                self.source_path(project, &path.to_string_lossy(), None)
                    .await?;
            } else if method.starts_with("textDocument/") {
                return Err(CoreError::new(400, "Name the document URI."));
            }
            if method == "workspace/didChangeWatchedFiles" {
                let changes = message
                    .pointer("/params/changes")
                    .and_then(Value::as_array)
                    .ok_or_else(|| CoreError::new(400, "Name the changed files."))?;
                for change in changes {
                    let path = Url::parse(text(change, "uri"))
                        .ok()
                        .and_then(|uri| uri.to_file_path().ok())
                        .ok_or_else(|| {
                            CoreError::new(403, "Only project file URIs are allowed.")
                        })?;
                    self.source_path(project, &path.to_string_lossy(), None)
                        .await?;
                }
            }
            if method == "initialize" {
                if !message.get("params").is_some_and(Value::is_object) {
                    return Err(CoreError::new(
                        400,
                        "Initialize parameters must be an object.",
                    ));
                }
                if !message
                    .pointer("/params/capabilities")
                    .is_some_and(Value::is_object)
                {
                    return Err(CoreError::new(
                        400,
                        "Initialize capabilities must be an object.",
                    ));
                }
                message["params"]["rootUri"] = json!(session.root_uri);
                message["params"]["rootPath"] = json!(session.root);
                message["params"]["processId"] = Value::Null;
                message["params"]["workspaceFolders"] =
                    json!([{ "uri": session.root_uri, "name": "Saturn" }]);
                message["params"]["capabilities"]["workspace"] = json!({ "configuration": true, "workspaceFolders": true, "applyEdit": false, "diagnostics": { "refreshSupport": true } });
                message["params"]["capabilities"]["general"] =
                    json!({ "positionEncodings": ["utf-16"] });
                message["params"]["initializationOptions"] = match session.language.as_str() {
                    "rust" => session.settings["rust-analyzer"].clone(),
                    "typescript" => json!({ "disableAutomaticTypingAcquisition": true }),
                    _ => json!({}),
                };
            }
            checked.push(message);
        }
        *locked(&session.touched) = Instant::now();
        for message in checked {
            session.write(&message).await?;
        }
        Ok(json!({ "sent": messages.len() }))
    }

    /// Subscribe from a sequence number. A disconnect releases the listener immediately and abandoned servers expire.
    pub async fn research_lsp_events(
        &self,
        project: &str,
        id: &str,
        after: Option<u64>,
    ) -> Result<mpsc::Receiver<String>, CoreError> {
        let session = self.lsp_session(project, id)?;
        let next = match after {
            Some(sequence) => sequence
                .checked_add(1)
                .ok_or_else(|| CoreError::new(400, "Invalid language-server event sequence."))?,
            None => 0,
        };
        session.listeners.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel(4);
        tokio::spawn(async move {
            let mut changed = session.moved.subscribe();
            let mut next = next;
            loop {
                let (lines, ended, lost) = {
                    let output = locked(&session.output);
                    (
                        output
                            .messages
                            .iter()
                            .filter(|(sequence, _)| *sequence >= next)
                            .cloned()
                            .collect::<Vec<_>>(),
                        output.ended,
                        output
                            .messages
                            .front()
                            .is_some_and(|(first, _)| next < *first),
                    )
                };
                if lost || ended {
                    let _ = sender.send(json!({ "closed": true, "reason": if lost { "Language-server messages were missed. Restart the connection." } else { "The language server stopped. Restart the connection." } }).to_string()).await;
                    break;
                }
                for (sequence, line) in lines {
                    if sender.send(line).await.is_err() {
                        break;
                    }
                    next = sequence + 1;
                }
                tokio::select! { _ = sender.closed() => break, result = changed.changed() => if result.is_err() { break; } }
            }
            session.listeners.fetch_sub(1, Ordering::Relaxed);
            *locked(&session.touched) = Instant::now();
        });
        Ok(receiver)
    }

    /// Stop and reap one session, also used by a client's restart button.
    pub async fn research_lsp_stop(&self, project: &str, id: &str) -> Result<Value, CoreError> {
        let session = self.lsp_session(project, id)?;
        stop_sessions(vec![session]).await;
        locked(&self.research.language_servers.sessions).remove(id);
        Ok(json!({ "stopped": true }))
    }

    /// End a project's servers on revocation, folder changes or removal.
    pub(crate) async fn research_lsp_stop_project(&self, project: &str) {
        self.research
            .language_servers
            .changes
            .fetch_add(1, Ordering::SeqCst);
        let sessions = {
            let mut held = locked(&self.research.language_servers.sessions);
            let ids: Vec<String> = held
                .iter()
                .filter(|(_, session)| session.project == project)
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| held.remove(id)).collect()
        };
        stop_sessions(sessions).await;
    }

    /// End every server before the runtime shuts down.
    pub async fn research_lsp_stop_all(&self) {
        self.research
            .language_servers
            .changes
            .fetch_add(1, Ordering::SeqCst);
        let sessions = locked(&self.research.language_servers.sessions)
            .drain()
            .map(|(_, session)| session)
            .collect();
        stop_sessions(sessions).await;
    }
}

/// Stop sessions together and wait for their supervisor to reap the child.
async fn stop_sessions(sessions: Vec<Arc<Session>>) {
    for session in &sessions {
        session.stop.send_replace(true);
    }
    for session in sessions {
        let mut changed = session.moved.subscribe();
        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            while !locked(&session.output).ended {
                if changed.changed().await.is_err() {
                    break;
                }
            }
        })
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frames_use_bytes_and_reject_unbounded_or_malformed_headers() {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "result": "型別 🪐" }).to_string();
        let wire = format!("Content-Length: {}\r\n\r\n{body}", body.len());
        assert_eq!(
            read_message(&mut wire.as_bytes()).await.unwrap()["result"],
            "型別 🪐"
        );
        for wire in [
            "Content-Length: 999999999\r\n\r\n",
            "Content-Length: 1\r\nContent-Length: 1\r\n\r\n0",
            "Content-Length: 1\n\n0",
            "Content-Length: 2\r\n\r\n{}",
        ] {
            assert!(
                read_message(&mut wire.as_bytes()).await.is_err(),
                "{wire:?}"
            );
        }
    }
}
