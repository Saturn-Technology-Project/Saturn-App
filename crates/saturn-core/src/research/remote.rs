//! Persistent research jobs: SSH carries bounded JSON RPC; a detached Rust worker owns the remote process group.
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
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

const OUTPUTS: [&str; 8] = [
    "samples.jsonl",
    "report.jsonl",
    "snapshot.json",
    "metrics.jsonl",
    "artifacts.jsonl",
    "stdout.log",
    "stderr.log",
    "resources.jsonl",
];
const OUTPUT_LIMIT: u64 = 64 * 1024 * 1024;
const CHUNK: u64 = 128 * 1024;
const NOTE: &str = "Uses your SSH configuration and host verification. Install this version of saturn-server on the remote host first. Code and data are not uploaded: the host builds the run's snapshot from its own working tree and checks every file against the version, and a difference refuses the run before anything starts. Closing Saturn detaches; stopping explicitly requests cancellation.";
/// What a refused remote run is told to do.
const REMOTE_HINT: &str = "Bring the host's working folder to the version (with git, say), or freeze a new version, then start again.";

/// Whether this job's remote execution has a final status.
/// The record of what this computer's runtime launched remotely, in Saturn's own data folder. A project's files say
/// what a run was, but they may come from anyone, so only this decides whether Saturn connects to a run, where to, and
/// whether it may still start it.
const LEDGER: &str = "remote-launches.json";

/// Said of a run whose remote record came with the project rather than from this runtime.
const NOT_LAUNCHED_HERE: &str = "Saturn did not start this remote run from this computer, so it does not connect to it or start it. Its record came with the project's files.";

/// Errors that will not go away by trying again: the job is gone or was never recorded, the run is gone, the request
/// is refused, or an output is too large. Anything else, such as SSH not answering, may be temporary.
fn final_remote_error(status: u16) -> bool {
    matches!(status, 400 | 403 | 404 | 410 | 413 | 422)
}

fn finished(status: &str) -> bool {
    matches!(
        status,
        "completed" | "failed" | "stopped" | "timed_out" | "refused"
    )
}

/// Fetches an explicitly requested small analysis output, never a credential or an arbitrary remote path.
pub(super) async fn artifact_bytes(run: &Value, path: &str) -> Result<Vec<u8>, CoreError> {
    if run["archived"] == true {
        return Err(CoreError::new(
            409,
            "Archived remote references are not automatically reconnected.",
        ));
    }
    let mut bytes = Vec::new();
    let mut expected = None;
    loop {
        let response = rpc(&run["remote"], &json!({ "action": "artifact", "workdir": run["remote"]["workdir"], "id": run["id"], "path": path, "cursor": bytes.len() })).await?;
        if response["size"]
            .as_u64()
            .is_none_or(|size| size > 16 * 1024 * 1024)
        {
            return Err(CoreError::new(
                413,
                "Remote artifact snapshots are limited to 16 MiB.",
            ));
        }
        if bytes.is_empty() {
            expected = response
                .get("sha256")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        let chunk = STANDARD
            .decode(text(&response, "data"))
            .map_err(|_| CoreError::new(502, "Invalid artifact encoding."))?;
        if chunk.len() as u64 > CHUNK || (chunk.is_empty() && response["next"].is_number()) {
            return Err(CoreError::new(502, "Invalid artifact chunk."));
        }
        bytes.extend(chunk);
        if bytes.len() > 16 * 1024 * 1024 {
            return Err(CoreError::new(
                413,
                "Remote artifact snapshot is too large.",
            ));
        }
        if response["next"].is_null() {
            if expected.as_deref() != Some(sha256_hex(&bytes).as_str())
                || response["sha256"].as_str() != expected.as_deref()
            {
                return Err(CoreError::new(
                    409,
                    "The remote artifact changed during transfer.",
                ));
            }
            return Ok(bytes);
        }
        if response["next"].as_u64() != Some(bytes.len() as u64) {
            return Err(CoreError::new(502, "Invalid artifact cursor."));
        }
    }
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
        // The worker says how it failed, so that a job that is gone is not mistaken for a host that is away.
        let status = value
            .get("status")
            .and_then(Value::as_u64)
            .and_then(|status| u16::try_from(status).ok())
            .filter(|status| (400..600).contains(status))
            .unwrap_or(502);
        return Err(CoreError::new(status, error));
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
        if version.get("imported") == Some(&json!(true)) || version["archived"] == true {
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
        // Recorded here first: a run whose record exists only in the project is never connected to.
        self.set_launch(
            project,
            &id,
            Some(json!({ "target": settings["target"], "launched": false })),
        )
        .await?;
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
        if !saturn_domain::research::run_is_active(text(&run, "status")) {
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
                    Ok(true) => {
                        let _ = kernel.set_launch(&project, &id, None).await;
                        break;
                    }
                    Ok(false) => {}
                    Err(error) if final_remote_error(error.status) => {
                        let _ = kernel.remote_ended(&project, &id, &error).await;
                        break;
                    }
                    Err(_) => {
                        let _ = kernel.remote_disconnected(&project, &id).await;
                    }
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            locked(&kernel.research.remote).remove(&id);
        });
    }

    /// What this runtime recorded of a remote launch, if it made one.
    async fn launch(&self, project: &str, id: &str) -> Option<Value> {
        let _reading = self.research.remote_ledger.lock().await;
        let ledger = tokio::fs::read(self.store.root().join(LEDGER)).await.ok()?;
        let ledger: Value = serde_json::from_slice(&ledger).ok()?;
        ledger.get(format!("{project}/{id}")).cloned()
    }

    /// Records a remote launch, or forgets it once its run has ended.
    async fn set_launch(
        &self,
        project: &str,
        id: &str,
        entry: Option<Value>,
    ) -> Result<(), CoreError> {
        let _writing = self.research.remote_ledger.lock().await;
        let path = self.store.root().join(LEDGER);
        let mut ledger: Value = match tokio::fs::read(&path).await {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({})),
            Err(_) => json!({}),
        };
        if !ledger.is_object() {
            ledger = json!({});
        }
        let key = format!("{project}/{id}");
        match entry {
            Some(entry) => ledger[&key] = entry,
            None => {
                if let Some(entries) = ledger.as_object_mut() {
                    entries.remove(&key);
                }
            }
        }
        write_whole(&path, &pretty(&ledger)?).await
    }

    /// A remote run that cannot go on: it says why, and it is no longer followed. A run that is gone stays gone.
    async fn remote_ended(
        &self,
        project: &str,
        id: &str,
        error: &CoreError,
    ) -> Result<(), CoreError> {
        let _ = self.set_launch(project, id, None).await;
        let records = self.records_folder(project).await?;
        let lock = self.records_lock(&records);
        let _writing = lock.lock().await;
        let mut run = self.research_run(project, id).await?;
        if !saturn_domain::research::run_is_active(text(&run, "status")) {
            return Ok(());
        }
        // Not started here, or its job is gone: it may have run, so it is interrupted rather than failed.
        run["status"] = json!(if matches!(error.status, 403 | 410) {
            "interrupted"
        } else {
            "failed"
        });
        run["remoteConnection"] = json!("ended");
        run["remoteError"] = json!(error.message);
        run["endedAt"] = json!(iso_time(now_millis()));
        run["updatedAt"] = run["endedAt"].clone();
        write_whole(
            &records.join("runs").join(id).join("run.json"),
            &pretty(&run)?,
        )
        .await?;
        self.research_changed();
        Ok(())
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
        if !saturn_domain::research::run_is_active(text(&run, "status")) {
            return Ok(true);
        }
        let version = self
            .research_record(project, "versions", text(&run, "versionId"))
            .await?;
        let launch = self
            .launch(project, id)
            .await
            .ok_or_else(|| CoreError::new(403, NOT_LAUNCHED_HERE))?;
        let target = &launch["target"];
        let launched = launch["launched"] == true;
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
        let mut request = json!({ "action": "sync", "workdir": target["workdir"], "id": id, "cancel": run.get("cancelRequested").and_then(Value::as_bool).unwrap_or(false), "cursors": cursors });
        // Only the first exchange may start the job. After that a job the worker no longer has is reported, not resent.
        if !launched {
            // What the host must hold, so that it checks its own files against the version before it runs anything.
            let expected = json!({ "number": version["number"], "git": version["git"], "changedFiles": version["changedFiles"], "inputs": version["inputs"], "cwd": version["cwd"], "seeds": version["seeds"], "sandbox": version.get("sandbox").cloned().unwrap_or(Value::Null), "envNames": version.get("envNames").cloned().unwrap_or_else(|| json!([])) });
            request["start"] = json!({ "command": version["command"], "kind": run["kind"], "timeoutSeconds": run["timeoutSeconds"], "resumeFrom": run["resumeFrom"], "versionId": version["id"], "expected": expected });
        }
        let response = rpc(target, &request).await?;
        if !launched {
            self.set_launch(
                project,
                id,
                Some(json!({ "target": target, "launched": true })),
            )
            .await?;
        }
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
        if state["system"].is_object() {
            current["remoteSystem"] = state["system"].clone();
        }
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
                "failed" | "refused" => "failed",
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
            if remote_status == "refused" {
                current["refused"] = json!(true);
                current["error"] = state["error"].clone();
            }
            current["inputsChanged"] = state
                .pointer("/afterRun/changed")
                .cloned()
                .unwrap_or(json!([]));
            super::evidence::remote_finished(&folder, &version, state, &current).await;
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
        // Out of the SSH session first: when that connection closes, the system ends what is still in its session.
        let result = match saturn_tools::leave_session() {
            Ok(()) => execute_worker(folder).await,
            Err(error) => Err(CoreError::new(
                500,
                format!("The worker could not leave the SSH session: {error}"),
            )),
        };
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
        Err(error) => json!({ "error": error.message, "status": error.status }),
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
    if text(request, "action") == "artifact" {
        let requested = text(request, "path");
        if [
            "start.json",
            "state.json",
            "launch.claim",
            "execute.claim",
            "cancel.request",
        ]
        .contains(&requested)
        {
            return Err(CoreError::new(
                403,
                "Worker control files are not analysis artifacts.",
            ));
        }
        let path = saturn_tools::file::inside_workspace(
            &saturn_domain::skills::workspace::Workspace::new(&folder),
            requested,
        )
        .await
        .map_err(|message| CoreError::new(403, message))?;
        if [
            "start.json",
            "state.json",
            "launch.claim",
            "execute.claim",
            "cancel.request",
        ]
        .iter()
        .any(|name| path == folder.join(name))
        {
            return Err(CoreError::new(
                403,
                "Worker control files are not analysis artifacts.",
            ));
        }
        let mut file = std::fs::File::open(&path)?;
        let size = file.metadata()?.len();
        if size > 16 * 1024 * 1024 {
            return Err(CoreError::new(
                413,
                "Remote artifact snapshots are limited to 16 MiB.",
            ));
        }
        let cursor = request["cursor"].as_u64().unwrap_or(0);
        if cursor > size {
            return Err(CoreError::new(409, "The artifact was truncated."));
        }
        file.seek(SeekFrom::Start(cursor))?;
        let mut bytes = Vec::new();
        file.take(CHUNK).read_to_end(&mut bytes)?;
        let end = cursor + bytes.len() as u64;
        let hash = if cursor == 0 || end == size {
            Some(super::freeze::hash_file(&path).await?.0)
        } else {
            None
        };
        return Ok(
            json!({ "data": STANDARD.encode(bytes), "size": size, "sha256": hash, "next": if end < size { json!(end) } else { Value::Null } }),
        );
    }
    let state_file = safe_child(&folder, "state.json").await?;
    if !tokio::fs::try_exists(&state_file).await? {
        if request.get("start").is_none_or(Value::is_null) {
            return Err(CoreError::new(
                410,
                "This job is not on the remote host: its folder is gone, or it was never started. Saturn does not start it again; start a new run.",
            ));
        }
        let claim = safe_child(&folder, "launch.claim").await?;
        tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(claim)
            .await
            .map_err(|_| {
                CoreError::new(
                    410,
                    "A launch was claimed but never recorded, so it may or may not have run. It is not submitted again; start a new run.",
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
            // Started directly, not through nohup: macOS's nohup refuses to run inside an SSH session ("can't detach
            // from console"). The worker leaves the session itself, which also takes it out of reach of hangups.
            let mut child = Command::new(std::env::current_exe()?);
            launch_env(&mut child);
            child
                .arg("--research-worker-execute")
                .arg(&folder)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            // Not in its own group: it leaves the session itself, which a group leader cannot do.
            if child.spawn().is_err() {
                write_whole(&state_file, &pretty(&json!({ "schemaVersion": 1, "status": "failed", "endedAt": iso_time(now_millis()), "error": "The detached worker could not be started." }))?).await?;
            } else {
                // Answer only once it has left this SSH session, or the session could end it first.
                let claimed = folder.join("execute.claim");
                for _ in 0..100 {
                    if tokio::fs::try_exists(&claimed).await.unwrap_or(false) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
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
    let workdir = PathBuf::from(text(&start, "workdir"));
    // The snapshot is built and checked before anything runs; a difference ends the job without running it.
    let snapshot_folder = folder.join("snapshot");
    let mut working = workdir.clone();
    let mut observed = Value::Null;
    if spec["expected"].is_object() {
        let tree = snapshot_folder.join("tree");
        let _ = tokio::fs::remove_dir_all(&snapshot_folder).await;
        tokio::fs::create_dir_all(&tree).await?;
        match super::snapshot::fill(
            None,
            &workdir,
            &spec["expected"],
            &snapshot_folder,
            &tree,
            REMOTE_HINT,
        )
        .await
        {
            Ok(made) => {
                observed = made;
                working = tree.join(text(&spec["expected"], "cwd"));
            }
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&snapshot_folder).await;
                let now = iso_time(now_millis());
                write_whole(&folder.join("state.json"), &pretty(&json!({ "schemaVersion": 1, "status": "refused", "error": error.message, "createdAt": now, "endedAt": now }))?).await?;
                return Ok(());
            }
        }
    }
    let seeds: Vec<String> = spec["expected"]["seeds"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|seed| {
            seed.as_str()
                .map_or_else(|| seed.to_string(), str::to_owned)
        })
        .collect();
    let git = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&workdir)
        .output()
        .await
        .ok();
    let source = json!({ "workdir": start["workdir"], "gitCommit": git.filter(|result| result.status.success()).map(|result| String::from_utf8_lossy(&result.stdout).trim().to_owned()), "note": "Remote source is observed, not uploaded or certified identical to local frozen files." });
    // A job with a snapshot runs in the sandbox its version asks for, as a local run does; one sent by a Saturn from
    // before snapshots runs in the working folder, as it did then.
    let (mut command, sandbox) = if observed.is_null() {
        let mut command = Command::new("/bin/sh");
        launch_env(&mut command);
        for (name, _) in std::env::vars_os() {
            if name.to_string_lossy().starts_with("SATURN_") {
                command.env_remove(name);
            }
        }
        command
            .args(["-c", text(spec, "command")])
            .current_dir(&working);
        (command, Value::Null)
    } else {
        let placement = super::isolation::Placement {
            tree: snapshot_folder.join("tree"),
            temporary: snapshot_folder.join("tmp"),
            records: folder.to_path_buf(),
            protected: [
                "start.json",
                "state.json",
                "launch.claim",
                "execute.claim",
                "snapshot.json",
                "resources.jsonl",
            ]
            .iter()
            .map(|name| folder.join(name))
            .collect(),
            sources: vec![workdir.clone()],
            readable: Vec::new(),
        };
        let data = super::isolation::data_folders(&super::isolation::home().join(".saturn-app"));
        super::isolation::command(
            &spec["expected"],
            &placement,
            &data,
            &working,
            text(spec, "command"),
        )
        .await?
    };
    if !observed.is_null() {
        if sandbox["isolation"] == "sandbox" {
            observed["isolation"] = json!("sandbox");
        }
        // Written once, before the command runs, and brought back with the outputs.
        write_whole(&folder.join("snapshot.json"), &pretty(&observed)?).await?;
    }
    command
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
        .env("SATURN_RUN_REPORT", folder.join("report.jsonl"))
        .env("SATURN_RESUME_FROM", text(spec, "resumeFrom"));
    if let Some(first) = seeds.first() {
        command
            .env("SATURN_RUN_SEED", first)
            .env("SATURN_RUN_SEEDS", seeds.join(","));
    }
    in_own_group(&mut command);
    let mut child = command.spawn()?;
    let pid = child.id().unwrap_or(0);
    let mut guard = EndOnDrop::new(child.id());
    // The job's processor, memory and GPUs, sampled on this host as a local run is, and synced back with the outputs.
    let stop_sampling = Arc::new(AtomicBool::new(false));
    let sampler = tokio::spawn(super::resources::sample_until(
        pid,
        folder.to_path_buf(),
        Some(Arc::clone(&stop_sampling)),
    ));
    let begin = tokio::time::Instant::now();
    let limit = Duration::from_secs(spec["timeoutSeconds"].as_u64().unwrap_or(3600));
    let mut state = json!({ "schemaVersion": 1, "status": "running", "startedAt": iso_time(now_millis()), "source": source, "system": super::resources::system(), "snapshotted": !observed.is_null(), "seedsPassed": seeds, "sandbox": sandbox });
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
    stop_sampling.store(true, Ordering::SeqCst);
    let _ = sampler.await;
    if !observed.is_null() {
        state["afterRun"] = super::snapshot::close(
            &snapshot_folder,
            &folder.join("written"),
            &observed,
            &workdir,
            true,
        )
        .await;
    }
    state["status"] = json!(status);
    state["exitCode"] = json!(code);
    state["endedAt"] = json!(iso_time(now_millis()));
    write_whole(&folder.join("state.json"), &pretty(&state)?).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_errors_that_cannot_clear_end_a_remote_run() {
        for status in [400, 403, 404, 410, 413, 422] {
            assert!(final_remote_error(status), "{status}");
        }
        for status in [409, 500, 502, 503, 504] {
            assert!(!final_remote_error(status), "{status} may clear");
        }
    }
}
