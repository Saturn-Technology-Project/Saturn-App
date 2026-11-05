//! Persistent research jobs: SSH carries bounded JSON RPC; a detached Rust worker owns the remote process group.
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD};
use saturn_domain::new_id;
use saturn_domain::research::{is_id, sha256_hex};
use saturn_domain::time::{iso_time, now_millis};
use saturn_tools::shell::Invocation;
use saturn_tools::{EndOnDrop, in_own_group, launch_env, run_captured};
use serde_json::{Value, json};
use tokio::process::Command;

use super::{pretty, write_whole};
use crate::records::text;
use crate::{CoreError, Kernel, locked};

const OUTPUTS: [&str; 5] = [
    "samples.jsonl",
    "metrics.jsonl",
    "artifacts.jsonl",
    "stdout.log",
    "stderr.log",
];
const OUTPUT_LIMIT: u64 = 64 * 1024 * 1024;
const CHUNK: u64 = 128 * 1024;
const NOTE: &str = "Uses your SSH configuration and host verification. Install this version of saturn-server on the remote host first. Code and data are not uploaded: the command runs in the remote working tree, whose identity may differ from the local frozen source. Closing Saturn detaches; stopping explicitly requests cancellation.";

/// Whether this job's remote execution has a final status.
fn finished(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "stopped" | "timed_out")
}

/// A shell argument on the remote side; command contents themselves travel as JSON on stdin.
fn quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Only a host alias or user@host is accepted here; extra SSH options belong in the user's SSH configuration.
fn check_target(target: &Value) -> Result<(), CoreError> {
    let host = text(target, "host");
    if host.is_empty()
        || !host.as_bytes()[0].is_ascii_alphanumeric()
        || !host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"@._-".contains(&byte))
    {
        return Err(CoreError::new(
            400,
            "Use an SSH host alias or user@host, without options or shell syntax.",
        ));
    }
    if !Path::new(text(target, "workdir")).is_absolute()
        || text(target, "program").is_empty()
        || text(target, "program").contains(['\n', '\r', '\0'])
    {
        return Err(CoreError::new(
            400,
            "Name an absolute remote working directory and the remote saturn-server program.",
        ));
    }
    Ok(())
}

/// A time-bounded SSH exchange with no terminal, agent forwarding, stored keys or disabled host verification.
async fn rpc(target: &Value, request: &Value) -> Result<Value, CoreError> {
    check_target(target)?;
    let invocation = Invocation {
        file: "ssh".to_owned(),
        args: vec![
            "-T".into(),
            "-a".into(),
            "-oBatchMode=yes".into(),
            "-oConnectTimeout=10".into(),
            text(target, "host").into(),
            format!("exec {} --research-worker", quoted(text(target, "program"))),
        ],
        verbatim: false,
    };
    let env: Vec<_> = std::env::vars_os()
        .filter(|(name, _)| !name.to_string_lossy().starts_with("SATURN_"))
        .collect();
    let answer = run_captured(
        &invocation,
        Path::new("."),
        &env,
        request.to_string().as_bytes(),
        Duration::from_secs(20),
        2 * 1024 * 1024,
    )
    .await;
    if answer.timed_out || answer.code != Some(0) {
        return Err(CoreError::new(
            502,
            "SSH did not answer. Check the host, its installed worker, authentication and known_hosts; the remote job is not assumed stopped.",
        ));
    }
    let value: Value = serde_json::from_str(&answer.stdout).map_err(|_| {
        CoreError::new(
            502,
            "The remote worker returned an invalid or oversized response.",
        )
    })?;
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return Err(CoreError::new(502, error));
    }
    Ok(value)
}

impl Kernel {
    /// Reads or sets the project's explicit remote execution target; credentials remain with SSH.
    pub async fn research_remote(
        &self,
        project: &str,
        target: Option<&Value>,
    ) -> Result<Value, CoreError> {
        let records = if target.is_some() {
            self.records_for_writing(project).await?
        } else {
            self.records_folder(project).await?
        };
        if let Some(target) = target {
            check_target(target)?;
            let value = json!({ "host": target["host"], "workdir": target["workdir"], "program": target["program"] });
            write_whole(&records.join("remote.json"), &pretty(&value)?).await?;
        }
        let target = match tokio::fs::read(safe_child(&records, "remote.json").await?).await {
            Ok(bytes) => serde_json::from_slice::<Value>(&bytes).ok(),
            Err(_) => None,
        };
        Ok(json!({ "target": target, "note": NOTE }))
    }

    /// Checks a configured host without starting a job or changing SSH trust.
    pub async fn research_remote_check(&self, project: &str) -> Result<Value, CoreError> {
        let settings = self.research_remote(project, None).await?;
        rpc(
            &settings["target"],
            &json!({ "action": "check", "workdir": settings["target"]["workdir"] }),
        )
        .await
    }

    /// Saves a remote launch intent before SSH runs. Retrying the same client/version cannot submit twice.
    pub async fn research_remote_start(
        self: &Arc<Self>,
        project: &str,
        request: &Value,
    ) -> Result<Value, CoreError> {
        let client = text(request, "clientId");
        if client.is_empty() {
            return Err(CoreError::new(400, "A remote start needs clientId."));
        }
        let version = self
            .research_record(project, "versions", text(request, "versionId"))
            .await?;
        if version.get("imported") == Some(&json!(true)) {
            return Err(CoreError::new(
                409,
                "Set a command and freeze a new executable version before starting a remote job.",
            ));
        }
        let timeout = request
            .get("timeoutSeconds")
            .and_then(Value::as_u64)
            .unwrap_or(3600);
        if !(1..=604800).contains(&timeout) {
            return Err(CoreError::new(
                400,
                "Choose a wall-clock limit from 1 second to 7 days.",
            ));
        }
        let settings = self.research_remote(project, None).await?;
        check_target(&settings["target"])?;
        let records = self.records_for_writing(project).await?;
        let lock = self.records_lock(&records);
        let _writing = lock.lock().await;
        let runs = self.research_runs(project).await?;
        if let Some(run) = runs["items"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|run| text(run, "clientId") == client)
        {
            if run["versionId"] != version["id"] {
                return Err(CoreError::new(
                    409,
                    "This clientId already belongs to another version.",
                ));
            }
            return Ok(run.clone());
        }
        let id = new_id("run")?;
        let now = iso_time(now_millis());
        let run = json!({ "schemaVersion": 1, "revision": 1, "id": id, "createdAt": now, "updatedAt": now, "status": "starting", "clientId": client,
            "experimentId": version["experimentId"], "versionId": version["id"], "kind": version.get("kind").cloned().unwrap_or(json!("evaluation")),
            "remote": settings["target"], "timeoutSeconds": timeout, "resumeFrom": request.get("resumeFrom"), "remoteConnection": "connecting", "warnings": [NOTE] });
        let folder = Self::collection_folder(&records, "runs").await?.join(&id);
        tokio::fs::create_dir_all(&folder).await?;
        write_whole(&folder.join("run.json"), &pretty(&run)?).await?;
        self.follow_remote(project.to_owned(), id);
        self.research_changed();
        Ok(run)
    }

    /// Explicit cancellation is persisted even while a host is disconnected; the next exchange delivers it.
    pub async fn research_remote_stop(&self, project: &str, id: &str) -> Result<Value, CoreError> {
        let records = self.records_folder(project).await?;
        let lock = self.records_lock(&records);
        let _writing = lock.lock().await;
        let mut run = self.research_run(project, id).await?;
        if !matches!(text(&run, "status"), "starting" | "running" | "stopping") {
            return Ok(run);
        }
        run["status"] = json!("stopping");
        run["cancelRequested"] = json!(true);
        write_whole(
            &records.join("runs").join(id).join("run.json"),
            &pretty(&run)?,
        )
        .await?;
        self.research_changed();
        Ok(run)
    }

    /// A local poller may stop at any time; only the remote worker owns the computation.
    pub(super) fn follow_remote(self: &Arc<Self>, project: String, id: String) {
        if !locked(&self.research.remote).insert(id.clone()) {
            return;
        }
        let kernel = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                if kernel.research.ending.load(Ordering::SeqCst) {
                    break;
                }
                match kernel.sync_remote(&project, &id).await {
                    Ok(true) => break,
                    Ok(false) => {}
                    Err(_) => {
                        let _ = kernel.remote_disconnected(&project, &id).await;
                    }
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            locked(&kernel.research.remote).remove(&id);
        });
    }

    /// Connection failure is not evidence that an expensive remote computation ended.
    async fn remote_disconnected(&self, project: &str, id: &str) -> Result<(), CoreError> {
        let records = self.records_folder(project).await?;
        let lock = self.records_lock(&records);
        let _writing = lock.lock().await;
        let mut run = self.research_run(project, id).await?;
        run["remoteConnection"] = json!("disconnected");
        run["remoteError"] = json!(
            "Cannot reach the remote worker. It may still be running; cancellation is pending until acknowledged."
        );
        write_whole(
            &records.join("runs").join(id).join("run.json"),
            &pretty(&run)?,
        )
        .await?;
        self.research_changed();
        Ok(())
    }

    /// Pulls append-only streams in bounded chunks and publishes completion only after they have all arrived.
    async fn sync_remote(&self, project: &str, id: &str) -> Result<bool, CoreError> {
        let run = self.research_run(project, id).await?;
        if !matches!(text(&run, "status"), "starting" | "running" | "stopping") {
            return Ok(true);
        }
        let version = self
            .research_record(project, "versions", text(&run, "versionId"))
            .await?;
        let records = self.records_folder(project).await?;
        let folder = records.join("runs").join(id);
        let mut cursors = HashMap::new();
        for name in OUTPUTS {
            cursors.insert(
                name,
                tokio::fs::metadata(folder.join(name))
                    .await
                    .map_or(0, |info| info.len()),
            );
        }
        let response = rpc(&run["remote"], &json!({ "action": "sync", "workdir": run["remote"]["workdir"], "id": id, "cancel": run.get("cancelRequested").and_then(Value::as_bool).unwrap_or(false),
            "cursors": cursors, "start": { "command": version["command"], "kind": run["kind"], "timeoutSeconds": run["timeoutSeconds"], "resumeFrom": run["resumeFrom"], "versionId": version["id"] } })).await?;
        let lock = self.records_lock(&records);
        let _writing = lock.lock().await;
        let mut current = self.research_run(project, id).await?;
        for chunk in response["files"].as_array().into_iter().flatten() {
            let name = text(chunk, "name");
            if !OUTPUTS.contains(&name) {
                return Err(CoreError::new(
                    502,
                    "The worker named an unexpected output.",
                ));
            }
            let bytes = STANDARD
                .decode(text(chunk, "data"))
                .map_err(|_| CoreError::new(502, "Invalid output encoding."))?;
            if bytes.len() as u64 > CHUNK {
                return Err(CoreError::new(502, "Oversized remote output chunk."));
            }
            let offset = chunk["offset"]
                .as_u64()
                .ok_or_else(|| CoreError::new(502, "Missing remote cursor."))?;
            let target = folder.join(name);
            let mut file = tokio::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(false)
                .open(&target)
                .await?;
            if chunk["reset"] == true {
                file.set_len(0).await?;
            }
            if file.metadata().await?.len() != offset {
                return Err(CoreError::new(409, "Remote stream cursor changed."));
            }
            use tokio::io::{AsyncSeekExt, AsyncWriteExt};
            file.seek(SeekFrom::Start(offset)).await?;
            file.write_all(&bytes).await?;
        }
        let state = &response["state"];
        let remote_status = text(state, "status");
        current["remoteStatus"] = json!(remote_status);
        current["remoteConnection"] = json!(if response["unresponsive"] == true {
            "unresponsive"
        } else {
            "connected"
        });
        current["remoteError"] = if response["unresponsive"] == true {
            json!(
                "The worker heartbeat is stale. Its computation may still be running; no automatic resubmission is attempted."
            )
        } else {
            Value::Null
        };
        current["remoteSource"] = state["source"].clone();
        current["updatedAt"] = json!(iso_time(now_millis()));
        let complete = finished(remote_status) && response["more"] == false;
        if complete {
            let bytes = tokio::fs::read(folder.join("samples.jsonl")).await?;
            for name in OUTPUTS {
                let (hash, _) = super::freeze::hash_file(&folder.join(name)).await?;
                if response["hashes"][name] != hash {
                    return Err(CoreError::new(
                        409,
                        "A remote output changed during synchronization; completion is not certified.",
                    ));
                }
            }
            let scan = super::runs::scan_samples(&folder.join("samples.jsonl"))?;
            let count = scan.samples;
            let mut protocol_error = !scan.problems.is_empty();
            let (metric_count, metrics_valid) =
                super::imports::metric_output(&folder.join("metrics.jsonl"))?;
            let has_metrics = metric_count > 0;
            protocol_error |= !metrics_valid;
            let status = match remote_status {
                "stopped" | "timed_out" => "stopped",
                "failed" => "failed",
                _ if protocol_error
                    || (count == 0 && !(current["kind"] == "training" && has_metrics)) =>
                {
                    "protocol_error"
                }
                _ => "completed",
            };
            current["status"] = json!(status);
            current["samples"] = json!(count);
            current["samplesSize"] = json!(bytes.len());
            current["samplesSha256"] = json!(sha256_hex(&bytes));
            current["exitCode"] = state["exitCode"].clone();
            current["endedAt"] = state["endedAt"].clone();
        } else if current.get("cancelRequested") != Some(&json!(true)) {
            current["status"] = json!(if remote_status == "starting" {
                "starting"
            } else {
                "running"
            });
        }
        write_whole(&folder.join("run.json"), &pretty(&current)?).await?;
        self.research_changed();
        Ok(complete)
    }
}

/// Worker entry runs before the HTTP server reads settings or credentials; no runtime is started on the remote machine.
pub async fn worker_entry(mode: &str, directory: Option<&str>) -> Result<(), CoreError> {
    if cfg!(windows) {
        return Err(CoreError::new(
            501,
            "The detached worker runs on Linux or macOS.",
        ));
    }
    if mode == "--research-worker-execute" {
        let folder =
            Path::new(directory.ok_or_else(|| CoreError::new(400, "Missing job directory."))?);
        let result = execute_worker(folder).await;
        if result.is_err() {
            write_whole(&folder.join("state.json"), &pretty(&json!({ "schemaVersion": 1, "status": "failed", "endedAt": iso_time(now_millis()), "error": "The remote command could not be started or recorded." }))?).await?;
        }
        return result;
    }
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(2 * 1024 * 1024)
        .read_to_end(&mut bytes)?;
    let request: Value = serde_json::from_slice(&bytes)
        .map_err(|_| CoreError::new(400, "Invalid worker request."))?;
    let response = match worker_rpc(&request).await {
        Ok(value) => value,
        Err(error) => json!({ "error": error.message }),
    };
    println!("{response}");
    Ok(())
}

/// A record directory must never follow an output or state symlink outside its configured root.
async fn safe_child(parent: &Path, name: &str) -> Result<PathBuf, CoreError> {
    let path = parent.join(name);
    if tokio::fs::symlink_metadata(&path)
        .await
        .is_ok_and(|info| info.file_type().is_symlink())
    {
        return Err(CoreError::new(
            403,
            "Remote state or output is a symbolic link.",
        ));
    }
    Ok(path)
}

/// A single bounded worker exchange; repeated launch intents find the same job directory.
async fn worker_rpc(request: &Value) -> Result<Value, CoreError> {
    let root = tokio::fs::canonicalize(text(request, "workdir")).await?;
    if text(request, "action") == "check" {
        return Ok(json!({ "protocol": 1, "platform": std::env::consts::OS, "workdir": root }));
    }
    let id = text(request, "id");
    if !is_id(id) || !id.starts_with("run_") {
        return Err(CoreError::new(400, "Invalid remote job ID."));
    }
    let saturn = safe_child(&root, ".saturn").await?;
    tokio::fs::create_dir_all(&saturn).await?;
    let jobs = safe_child(&saturn, "remote-jobs").await?;
    tokio::fs::create_dir_all(&jobs).await?;
    let folder = safe_child(&jobs, id).await?;
    tokio::fs::create_dir_all(&folder).await?;
    let state_file = safe_child(&folder, "state.json").await?;
    if !tokio::fs::try_exists(&state_file).await? {
        let claim = safe_child(&folder, "launch.claim").await?;
        tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(claim)
            .await
            .map_err(|_| {
                CoreError::new(
                    409,
                    "A launch is already claimed; it will not be submitted again.",
                )
            })?;
        let start = &request["start"];
        if text(start, "command").trim().is_empty()
            || !start["timeoutSeconds"]
                .as_u64()
                .is_some_and(|seconds| (1..=604800).contains(&seconds))
        {
            return Err(CoreError::new(
                400,
                "The worker needs a command and a bounded wall-clock limit.",
            ));
        }
        write_whole(
            &folder.join("start.json"),
            &pretty(&json!({ "workdir": root, "id": id, "spec": start }))?,
        )
        .await?;
        let now = iso_time(now_millis());
        let cancel = request["cancel"] == true;
        write_whole(&state_file, &pretty(&json!({ "schemaVersion": 1, "status": if cancel { "stopped" } else { "starting" }, "createdAt": now, "endedAt": if cancel { json!(now) } else { Value::Null } }))?).await?;
        if !cancel {
            let mut child = Command::new("nohup");
            launch_env(&mut child);
            child
                .arg(std::env::current_exe()?)
                .arg("--research-worker-execute")
                .arg(&folder)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            in_own_group(&mut child);
            if child.spawn().is_err() {
                write_whole(&state_file, &pretty(&json!({ "schemaVersion": 1, "status": "failed", "endedAt": iso_time(now_millis()), "error": "The detached worker could not be started." }))?).await?;
            }
        }
    }
    if request["cancel"] == true {
        write_whole(&safe_child(&folder, "cancel.request").await?, b"cancel\n").await?;
    }
    let state: Value = serde_json::from_slice(&tokio::fs::read(&state_file).await?)
        .map_err(|_| CoreError::new(422, "Remote state is damaged."))?;
    let mut files = Vec::new();
    let mut more = false;
    for name in OUTPUTS {
        let path = safe_child(&folder, name).await?;
        let (size, mut file) = match std::fs::File::open(&path) {
            Ok(file) => (file.metadata()?.len(), Some(file)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (0, None),
            Err(error) => return Err(error.into()),
        };
        if size > OUTPUT_LIMIT {
            return Err(CoreError::new(
                413,
                "A remote output exceeded the 64 MiB synchronization limit. The job may still be running.",
            ));
        }
        let cursor = request["cursors"][name].as_u64().unwrap_or(0);
        let reset = cursor > size;
        let start = if reset { 0 } else { cursor };
        let mut bytes = Vec::new();
        if let Some(file) = file.as_mut() {
            file.seek(SeekFrom::Start(start))?;
            file.take(CHUNK).read_to_end(&mut bytes)?;
        }
        more |= start + (bytes.len() as u64) < size;
        files.push(json!({ "name": name, "offset": start, "reset": reset, "data": STANDARD.encode(&bytes) }));
    }
    let mut hashes = json!({});
    if finished(text(&state, "status")) && !more {
        for name in OUTPUTS {
            let path = safe_child(&folder, name).await?;
            hashes[name] = match super::freeze::hash_file(&path).await {
                Ok((hash, _)) => json!(hash),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    json!(sha256_hex(b""))
                }
                Err(error) => return Err(error.into()),
            };
        }
    }
    let unresponsive = !finished(text(&state, "status"))
        && state["heartbeatMs"]
            .as_i64()
            .is_some_and(|time| now_millis().saturating_sub(time) > 10_000);
    Ok(
        json!({ "state": state, "files": files, "more": more, "hashes": hashes, "unresponsive": unresponsive }),
    )
}

/// The detached worker executes one command and owns its cancellation deadline and complete process group.
async fn execute_worker(folder: &Path) -> Result<(), CoreError> {
    let claim = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(folder.join("execute.claim"))
        .await;
    match claim {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    let start: Value = serde_json::from_slice(&tokio::fs::read(folder.join("start.json")).await?)
        .map_err(|_| CoreError::new(422, "Invalid remote launch record."))?;
    let spec = &start["spec"];
    let git = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(text(&start, "workdir"))
        .output()
        .await
        .ok();
    let source = json!({ "workdir": start["workdir"], "gitCommit": git.filter(|result| result.status.success()).map(|result| String::from_utf8_lossy(&result.stdout).trim().to_owned()), "note": "Remote source is observed, not uploaded or certified identical to local frozen files." });
    let mut command = Command::new("/bin/sh");
    launch_env(&mut command);
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("SATURN_") {
            command.env_remove(name);
        }
    }
    command
        .args(["-c", text(spec, "command")])
        .current_dir(text(&start, "workdir"))
        .stdin(Stdio::null())
        .stdout(
            tokio::fs::File::create(folder.join("stdout.log"))
                .await?
                .into_std()
                .await,
        )
        .stderr(
            tokio::fs::File::create(folder.join("stderr.log"))
                .await?
                .into_std()
                .await,
        )
        .env("SATURN_RUN_ID", text(&start, "id"))
        .env("SATURN_RUN_TOKEN", saturn_domain::random_hex(16)?)
        .env("SATURN_RUN_VERSION", text(spec, "versionId"))
        .env("SATURN_RUN_DIRECTORY", folder)
        .env("SATURN_RUN_SAMPLES", folder.join("samples.jsonl"))
        .env("SATURN_RUN_METRICS", folder.join("metrics.jsonl"))
        .env("SATURN_RUN_ARTIFACTS", folder.join("artifacts.jsonl"))
        .env("SATURN_RESUME_FROM", text(spec, "resumeFrom"));
    in_own_group(&mut command);
    let mut child = command.spawn()?;
    let pid = child.id().unwrap_or(0);
    let mut guard = EndOnDrop::new(child.id());
    let begin = tokio::time::Instant::now();
    let limit = Duration::from_secs(spec["timeoutSeconds"].as_u64().unwrap_or(3600));
    let mut state = json!({ "schemaVersion": 1, "status": "running", "startedAt": iso_time(now_millis()), "source": source });
    let (status, code) = loop {
        state["heartbeatMs"] = json!(now_millis());
        write_whole(&folder.join("state.json"), &pretty(&state)?).await?;
        if tokio::fs::try_exists(folder.join("cancel.request")).await? || begin.elapsed() >= limit {
            let status = if begin.elapsed() >= limit {
                "timed_out"
            } else {
                "stopped"
            };
            super::runs::end_group(pid).await;
            let code = child.wait().await.ok().and_then(|status| status.code());
            break (status, code);
        }
        if let Some(exit) = child.try_wait()? {
            break (
                if exit.success() {
                    "completed"
                } else {
                    "failed"
                },
                exit.code(),
            );
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    super::runs::end_group(pid).await;
    guard.finished();
    state["status"] = json!(status);
    state["exitCode"] = json!(code);
    state["endedAt"] = json!(iso_time(now_millis()));
    write_whole(&folder.join("state.json"), &pretty(&state)?).await?;
    Ok(())
}
