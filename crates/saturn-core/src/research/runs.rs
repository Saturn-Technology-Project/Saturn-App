//! Experiment runs: a process per run, saved before it exists, identified so a restart can find it, and sealed when it
//! ends. `docs/research-contract.md` says what each status means.
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use saturn_domain::new_id;
use saturn_domain::research::{
    MAX_SAMPLE_LINE, SCHEMA_VERSION, is_id, run_is_active, sample_identity,
};
use saturn_domain::time::{iso_time, now_millis};
use saturn_tools::{force, in_own_group, terminate};
use serde_json::{Value, json};
#[cfg(not(windows))]
use tokio::process::Command;

use super::evidence;
use super::freeze::hash_file;
use super::{ResearchState, isolation, pretty, read_record, write_whole};
use crate::records::text;
use crate::{CoreError, Kernel, locked};

/// A process that has been asked to stop gets this long before it is ended by force.
const GRACE: Duration = Duration::from_secs(3);
/// How many bad lines a run records.
const PROBLEMS_KEPT: usize = 20;
/// The process's id and start time, written by Saturn as soon as it starts, so a runtime that dies later still knows
/// which process was the run's.
const IDENTITY_FILE: &str = "process.identity";
/// Starts the command. Saturn alone writes the identity: the program cannot run `ps` in the macOS sandbox, and in the
/// Linux one its own id is not the one Saturn started, so a second writer could only replace the right record.
#[cfg(not(windows))]
const WRAPPER: &str = r#"exec /bin/sh -c "$SATURN_RUN_COMMAND""#;

/// The line the system's shell is given to start a version's command: on macOS and Linux one that hands over to a
/// shell of the command's own, and on Windows the command itself, since cmd takes its line as written and has no
/// `exec`.
fn starting_line(command: &str) -> &str {
    #[cfg(windows)]
    {
        command
    }
    #[cfg(not(windows))]
    {
        let _ = command;
        WRAPPER
    }
}

/// A run this runtime started and has not finished.
#[derive(Debug)]
pub(super) struct ActiveRun {
    pid: u32,
    thread: Option<String>,
    project: String,
}

/// What a samples file holds once its process has ended.
#[derive(Debug)]
pub(super) struct Scan {
    pub(super) samples: u64,
    infrastructure_errors: u64,
    pub(super) problems: Vec<Value>,
    partial_line: bool,
}

/// Reads a samples file line by line, without holding it in memory.
pub(super) fn scan_samples(path: &Path) -> std::io::Result<Scan> {
    let mut scan = Scan {
        samples: 0,
        infrastructure_errors: 0,
        problems: Vec::new(),
        partial_line: false,
    };
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(scan),
        Err(error) => return Err(error),
    };
    let mut reader = BufReader::new(file);
    let mut seen = HashSet::new();
    let mut line = Vec::new();
    let mut number = 0;
    loop {
        line.clear();
        let read = (&mut reader)
            .take(MAX_SAMPLE_LINE + 1)
            .read_until(b'\n', &mut line)?;
        if read == 0 {
            return Ok(scan);
        }
        number += 1;
        if line.last() != Some(&b'\n') {
            if read as u64 > MAX_SAMPLE_LINE {
                scan.problems
                    .push(json!({ "line": number, "reason": "The line is too long." }));
            } else {
                scan.partial_line = true;
                scan.problems
                    .push(json!({ "line": number, "reason": "The last line was not finished." }));
            }
            return Ok(scan);
        }
        let parsed = serde_json::from_slice::<Value>(&line)
            .map_err(|error| format!("It is not JSON: {error}."))
            .and_then(|value| sample_identity(&value).map(|identity| (value, identity)))
            .and_then(|(value, identity)| {
                if seen.insert(identity) {
                    Ok(value)
                } else {
                    Err("This sample, trial and model already appeared.".to_owned())
                }
            });
        match parsed {
            Ok(value) => {
                scan.samples += 1;
                if value.pointer("/error/kind").and_then(Value::as_str) == Some("infrastructure") {
                    scan.infrastructure_errors += 1;
                }
            }
            Err(reason) => {
                if scan.problems.len() < PROBLEMS_KEPT {
                    scan.problems
                        .push(json!({ "line": number, "reason": reason }));
                }
            }
        }
    }
}

/// What ended a run says about it, from its exit code and samples.
fn status_after(exit: Option<i32>, scan: &Scan) -> &'static str {
    match exit {
        Some(0) if scan.problems.is_empty() && scan.samples > 0 => "completed",
        Some(0) => "protocol_error",
        _ => "failed",
    }
}

/// The start time the system reports for a process, or nothing if it is gone.
#[cfg(windows)]
async fn process_start_time(pid: u32) -> Option<String> {
    tokio::task::spawn_blocking(move || saturn_tools::process_started(pid))
        .await
        .ok()
        .flatten()
}

/// The start time the system reports for a process, or nothing if it is gone.
#[cfg(not(windows))]
async fn process_start_time(pid: u32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .output()
        .await
        .ok()?;
    let printed = String::from_utf8_lossy(&output.stdout);
    let printed = printed.split_whitespace().collect::<Vec<_>>().join(" ");
    (!printed.is_empty()).then_some(printed)
}

/// The process id and start time on record for a run's process.
async fn recorded_identity(directory: &Path) -> Option<(u32, String)> {
    let text = tokio::fs::read_to_string(directory.join(IDENTITY_FILE))
        .await
        .ok()?;
    let mut lines = text.lines();
    let pid = lines.next()?.trim().parse().ok()?;
    let started = lines
        .next()?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    Some((pid, started))
}

/// Asks a process group to end, then ends it by force after a moment if it has not, and waits until it is gone.
pub(super) async fn end_group(pid: u32) {
    terminate(pid);
    let deadline = tokio::time::Instant::now() + GRACE;
    while tokio::time::Instant::now() < deadline {
        if !group_exists(pid) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    force(pid);
}

/// Whether any process of the group is still there.
pub(super) fn group_exists(pid: u32) -> bool {
    saturn_tools::group_alive(pid)
}

/// Whichever test hook holds a run at a moment a crash could happen.
async fn test_hold(moment: &str) {
    if std::env::var("SATURN_RESEARCH_TEST_HOLD").is_ok_and(|held| held == moment) {
        // A test may let the run go on by creating this file; otherwise the hold outlasts the test.
        let release = std::env::var_os("SATURN_RESEARCH_TEST_RELEASE").map(PathBuf::from);
        for _ in 0..12_000 {
            if release.as_ref().is_some_and(|file| file.exists()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

impl ResearchState {
    fn holds_thread(&self, thread: &str) -> bool {
        locked(&self.active)
            .values()
            .any(|run| run.thread.as_deref() == Some(thread))
    }
}

impl Kernel {
    /// A chat's worktree stays while an experiment runs in it.
    pub(crate) fn refuse_if_running_experiment(&self, thread: &str) -> Result<(), CoreError> {
        if self.research.holds_thread(thread) {
            return Err(CoreError::new(
                409,
                "An experiment is running in this chat's folder. Stop it first.",
            ));
        }
        Ok(())
    }

    /// Every run of a project, newest last, each ended run saying whether its samples still match their seal. The
    /// check is by size and time once a run's file has been hashed, so a long list stays quick.
    pub async fn research_runs(&self, project: &str) -> Result<Value, CoreError> {
        let records = self.records_folder(project).await?;
        let (mut items, problems) = read_runs(&records).await?;
        for run in &mut items {
            if let Some(intact) = self.seal_intact(&records, run).await {
                run["sealIntact"] = json!(intact);
            }
        }
        Ok(json!({ "items": items, "problems": problems }))
    }

    /// One run.
    pub async fn research_run(&self, project: &str, id: &str) -> Result<Value, CoreError> {
        if !is_id(id) {
            return Err(not_found());
        }
        let records = self.records_folder(project).await?;
        let mut run = read_record(&run_file(&records, id))
            .await
            .map_err(|reason| super::cannot_use(id, &reason))?
            .ok_or_else(not_found)?;
        if let Some(intact) = self.seal_intact(&records, &run).await {
            run["sealIntact"] = json!(intact);
        }
        Ok(run)
    }

    /// Whether an ended run's samples still match the hash they were sealed with; nothing for a run with no seal.
    /// A changed file no longer stands for the run's results, wherever it is read.
    pub(super) async fn seal_intact(&self, records: &Path, run: &Value) -> Option<bool> {
        let sealed = run.get("samplesSha256").and_then(Value::as_str)?;
        if run_is_active(text(run, "status")) || sealed.is_empty() {
            return None;
        }
        let path = records
            .join("runs")
            .join(text(run, "id"))
            .join("samples.jsonl");
        let info = tokio::fs::metadata(&path).await.ok()?;
        let modified = info.modified().ok()?;
        if let Some((size, time, intact)) = locked(&self.research.seals).get(&path)
            && *size == info.len()
            && *time == modified
        {
            return Some(*intact);
        }
        let end = run.get("samplesSize").and_then(Value::as_u64).unwrap_or(0);
        let intact = info.len() == end
            && hash_file(&path)
                .await
                .is_ok_and(|(sha256, _)| sha256 == sealed);
        locked(&self.research.seals).insert(path, (info.len(), modified, intact));
        Some(intact)
    }

    /// Starts a version's command, unless this `clientId` already did.
    pub async fn research_start_run(
        self: &Arc<Self>,
        project: &str,
        version_id: &str,
        client_id: &str,
        thread: Option<&str>,
    ) -> Result<(Value, bool), CoreError> {
        self.start_research_run(project, version_id, client_id, thread, None)
            .await
    }

    /// Starts a run of a version, new or taking over from a run that ended before its work was done.
    async fn start_research_run(
        self: &Arc<Self>,
        project: &str,
        version_id: &str,
        client_id: &str,
        thread: Option<&str>,
        resume: Option<Resume>,
    ) -> Result<(Value, bool), CoreError> {
        if client_id.is_empty() {
            return Err(CoreError::new(
                400,
                "A start needs a \"clientId\", so repeating it starts nothing.",
            ));
        }
        let version = self
            .research_record(project, "versions", version_id)
            .await?;
        if version.get("imported").and_then(Value::as_bool) == Some(true)
            || version["archived"] == true
        {
            return Err(CoreError::new(
                409,
                "Imported versions describe past results. Set a command and freeze a new version to execute it.",
            ));
        }
        let source = self.research_source(project, thread)?;
        let records = self.records_for_writing(project).await?;
        if let Some(existing) = run_with_client(&records, client_id).await? {
            return Ok((existing, false));
        }
        let content = self.frozen_content(&records, &source, &version).await?;
        if saturn_domain::research::fingerprint(&content) != text(&version, "fingerprint")
            && saturn_domain::research::fingerprint(&before_model_identity(&content))
                != text(&version, "fingerprint")
        {
            return Err(CoreError::new(
                409,
                "The code, data or models changed since this version was frozen. Freeze a new version to run them.",
            ));
        }

        let lock = self.records_lock(&records);
        let writing = lock.lock().await;
        if let Some(existing) = run_with_client(&records, client_id).await? {
            return Ok((existing, false));
        }
        let id = new_id("run")?;
        let now = iso_time(now_millis());
        let directory = records.join("runs").join(&id);
        tokio::fs::create_dir_all(&directory).await?;
        let carried = match &resume {
            Some(resume) => Some(carry(resume, &version, &directory).await?),
            None => None,
        };
        let mut run = json!({
            "schemaVersion": SCHEMA_VERSION,
            "id": id,
            "revision": 1,
            "versionId": version_id,
            "experimentId": text(&version, "experimentId"),
            "clientId": client_id,
            "threadId": thread,
            "status": "starting",
            "kind": version.get("kind").cloned().unwrap_or(json!("evaluation")),
            "createdAt": now,
            "updatedAt": now,
        });
        if let (Some(resume), Some(carried)) = (&resume, &carried) {
            run["resumes"] = json!(resume.from);
            run["carried"] = carried.clone();
        }
        write_whole(&directory.join("run.json"), &pretty(&run)?).await?;
        drop(writing);
        self.research_changed();

        // The run reads its own copy of the version, checked file by file, never the folder being edited.
        let snapshot = match self
            .prepare_snapshot(&records, &source, &version, &id)
            .await
        {
            Ok(snapshot) => snapshot,
            Err(error) => {
                let reason = error.to_string();
                let _ = evidence::write(&directory, &evidence::refused(&version, &reason)).await;
                let refused = self
                    .settle_run(&records, &id, |run| {
                        run["status"] = json!("failed");
                        run["refused"] = json!(true);
                        run["error"] = json!(reason);
                        run["endedAt"] = json!(iso_time(now_millis()));
                    })
                    .await?;
                return Ok((refused, true));
            }
        };
        let seeds = seeds_of(&version);
        let mut observed = snapshot.observed;
        observed["source"] = json!(source);
        let mut starting = evidence::starting(&version, &observed, &seeds, &content["models"]);
        // What a resumed run took over is part of what Saturn saw, beside the snapshot it ran from.
        if let Some(carried) = &carried {
            starting["observed"]["resume"] = carried.clone();
        }
        evidence::write(&directory, &starting).await?;
        test_hold("before-process").await;

        let working_folder = snapshot.tree.join(text(&version, "cwd"));
        let mut sources = vec![source.clone()];
        if let Ok(project_folder) = self.workdir(project)
            && project_folder != source
        {
            sources.push(project_folder);
        }
        let started = self
            .spawn_run(
                &id,
                &version,
                &sources,
                &working_folder,
                &directory,
                Handed {
                    seeds: &seeds,
                    resume: resume.as_ref(),
                },
            )
            .await;
        let mut child = match started {
            Ok((child, sandbox)) => {
                evidence::sandboxed(&directory, &sandbox).await;
                if sandbox["isolation"] == "sandbox" {
                    observed["isolation"] = json!("sandbox");
                }
                child
            }
            Err(error) => {
                let closed = self
                    .close_snapshot(&id, &directory, &observed, &source, true)
                    .await;
                let failed = self
                    .settle_ended(&records, &id, Some(&closed), |run| {
                        run["status"] = json!("failed");
                        run["error"] = json!(format!("The command could not start: {error}"));
                    })
                    .await?;
                return Ok((failed, true));
            }
        };
        let pid = child.id().unwrap_or(0);
        // Recorded at once, before anything else can stop the runtime.
        if let Some(started) = process_start_time(pid).await {
            let _ = write_whole(
                &directory.join(IDENTITY_FILE),
                format!("{pid}\n{started}\n").as_bytes(),
            )
            .await;
        }
        locked(&self.research.active).insert(
            id.clone(),
            ActiveRun {
                pid,
                thread: thread.map(str::to_owned),
                project: project.to_owned(),
            },
        );
        self.sample_resources(pid, directory.clone());
        test_hold("after-process").await;
        let running = self
            .settle_run(&records, &id, |run| {
                run["status"] = json!("running");
                run["pid"] = json!(pid);
                run["startedAt"] = json!(iso_time(now_millis()));
            })
            .await?;

        let kernel = Arc::clone(self);
        let finishing = FinishingRun {
            project: project.to_owned(),
            records,
            source,
            directory,
            id,
            version,
            observed,
            pid,
        };
        tokio::spawn(async move {
            let exit = child.wait().await.ok().and_then(|status| status.code());
            kernel.finish_run(finishing, exit).await;
        });
        Ok((running, true))
    }

    /// The version's command in its own process group, in the sandbox the version asks for, with its output in the
    /// run's folder. Also what was recorded about the sandbox.
    async fn spawn_run(
        &self,
        id: &str,
        version: &Value,
        sources: &[PathBuf],
        working_folder: &Path,
        directory: &Path,
        handed: Handed<'_>,
    ) -> std::io::Result<(tokio::process::Child, Value)> {
        let Handed { seeds, resume } = handed;
        let stdout = tokio::fs::File::create(directory.join("stdout.log"))
            .await?
            .into_std()
            .await;
        let stderr = tokio::fs::File::create(directory.join("stderr.log"))
            .await?
            .into_std()
            .await;
        let snapshot = self.snapshot_folder(id);
        let placement = isolation::Placement {
            tree: snapshot.join("tree"),
            temporary: snapshot.join("tmp"),
            records: directory.to_path_buf(),
            protected: ["run.json", evidence::EVIDENCE, "resources.jsonl"]
                .iter()
                .map(|name| directory.join(name))
                .collect(),
            sources: sources.to_vec(),
            readable: resume
                .map(|resume| {
                    std::iter::once(resume.directory.clone())
                        .chain(resume.checkpoint.clone())
                        .collect()
                })
                .unwrap_or_default(),
        };
        let (mut command, sandbox) = isolation::command(
            version,
            &placement,
            &isolation::data_folders(self.store.root()),
            working_folder,
            starting_line(text(version, "command")),
        )
        .await?;
        command
            .env("SATURN_RUN_COMMAND", text(version, "command"))
            .env("SATURN_RUN_ID", id)
            .env("SATURN_RUN_TOKEN", saturn_domain::random_hex(16)?)
            .env("SATURN_RUN_VERSION", text(version, "id"))
            .env("SATURN_RUN_DIRECTORY", directory)
            .env("SATURN_RUN_SAMPLES", directory.join("samples.jsonl"))
            .env("SATURN_RUN_METRICS", directory.join("metrics.jsonl"))
            .env("SATURN_RUN_ARTIFACTS", directory.join("artifacts.jsonl"))
            .env("SATURN_RUN_REPORT", directory.join(evidence::REPORT))
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr);
        // What a resumed run takes over from. Its samples are already in SATURN_RUN_SAMPLES; the program skips those and
        // restores its state from SATURN_RESUME_FROM, as its report then says.
        if let Some(resume) = resume {
            command
                .env("SATURN_RESUME_RUN", &resume.from)
                .env("SATURN_RESUME_DIRECTORY", &resume.directory);
            if let Some(checkpoint) = &resume.checkpoint {
                command.env("SATURN_RESUME_FROM", checkpoint);
            }
        }
        // Passed, not applied: whether the program used a seed is for its report to say.
        if let Some(first) = seeds.first() {
            command
                .env("SATURN_RUN_SEED", first)
                .env("SATURN_RUN_SEEDS", seeds.join(","));
        }
        in_own_group(&mut command);
        Ok((command.spawn()?, sandbox))
    }

    /// Asks a run to stop. A run that already ended stays as it ended.
    pub async fn research_stop_run(
        self: &Arc<Self>,
        project: &str,
        id: &str,
    ) -> Result<Value, CoreError> {
        let current = self.research_run(project, id).await?;
        if current.get("remote").is_some() {
            return self.research_remote_stop(project, id).await;
        }
        let records = self.records_folder(project).await?;
        let pid = locked(&self.research.active).get(id).map(|run| run.pid);
        let Some(pid) = pid else {
            return Ok(current);
        };
        let stopping = self
            .change_active_run(&records, id, |run| run["status"] = json!("stopping"))
            .await?;
        terminate(pid);
        let kernel = Arc::clone(self);
        let run = id.to_owned();
        tokio::spawn(async move {
            tokio::time::sleep(GRACE).await;
            if locked(&kernel.research.active).contains_key(&run) {
                force(pid);
            }
        });
        Ok(stopping)
    }

    /// Pauses a running run's whole process where it is. It keeps its memory and devices, a GPU's included, and is still
    /// going: it can be continued or stopped, and a restart of Saturn ends it as it would a running one.
    pub async fn research_pause_run(
        self: &Arc<Self>,
        project: &str,
        id: &str,
    ) -> Result<Value, CoreError> {
        let current = self.research_run(project, id).await?;
        if current.get("remote").is_some() {
            return Err(CoreError::new(
                501,
                "A remote run cannot be paused yet. Stop it, or let it finish.",
            ));
        }
        match text(&current, "status") {
            "paused" => return Ok(current),
            "running" => {}
            status => {
                return Err(CoreError::new(
                    409,
                    format!("Only a running run can be paused; this one is {status}."),
                ));
            }
        }
        let pid = locked(&self.research.active).get(id).map(|run| run.pid);
        let records = self.records_folder(project).await?;
        if !pid.is_some_and(saturn_tools::pause_group) {
            return Err(CoreError::new(
                409,
                if cfg!(windows) {
                    "Runs cannot be paused on Windows."
                } else {
                    "The run's process has already ended."
                },
            ));
        }
        self.change_active_run(&records, id, |run| {
            if run["status"] == "running" {
                run["status"] = json!("paused");
                run["pausedAt"] = json!(iso_time(now_millis()));
            }
        })
        .await
    }

    /// Lets a paused run go on from where it was, adding the pause to the time it spent paused.
    pub async fn research_continue_run(
        self: &Arc<Self>,
        project: &str,
        id: &str,
    ) -> Result<Value, CoreError> {
        let current = self.research_run(project, id).await?;
        match text(&current, "status") {
            "running" => return Ok(current),
            "paused" => {}
            status => {
                return Err(CoreError::new(
                    409,
                    format!("Only a paused run can be continued; this one is {status}."),
                ));
            }
        }
        let pid = locked(&self.research.active).get(id).map(|run| run.pid);
        let records = self.records_folder(project).await?;
        if !pid.is_some_and(saturn_tools::continue_group) {
            return Err(CoreError::new(409, "The run's process has already ended."));
        }
        let now = now_millis();
        self.change_active_run(&records, id, |run| {
            if run["status"] != "paused" {
                return;
            }
            let since = run["pausedAt"]
                .as_str()
                .and_then(saturn_domain::time::parse_iso)
                .unwrap_or(now);
            let before = run["pausedSeconds"].as_f64().unwrap_or(0.0);
            run["pausedSeconds"] = json!(before + (now - since).max(0) as f64 / 1000.0);
            run["status"] = json!("running");
            if let Some(fields) = run.as_object_mut() {
                fields.remove("pausedAt");
            }
        })
        .await
    }

    /// Starts the same version again, taking over from a run that stopped, was interrupted or failed before its work was
    /// done. The samples it finished are already in the new run's samples file for the program to skip; a training run's
    /// program restores from `checkpoint`, by default the last one the run listed, and its metrics up to that step come
    /// along. A resumed run is a new run that says which one it resumes.
    pub async fn research_resume_run(
        self: &Arc<Self>,
        project: &str,
        id: &str,
        client_id: &str,
        checkpoint: Option<&str>,
        step: Option<u64>,
        thread: Option<&str>,
    ) -> Result<(Value, bool), CoreError> {
        let previous = self.research_run(project, id).await?;
        if previous.get("remote").is_some() {
            return Err(CoreError::new(
                501,
                "A remote run is resumed by starting it again on its host with resumeFrom.",
            ));
        }
        let status = text(&previous, "status");
        if !matches!(status, "stopped" | "interrupted" | "failed") {
            return Err(CoreError::new(
                409,
                format!(
                    "Only a run that stopped, was interrupted or failed can be resumed; this one is {status}. A paused run is continued."
                ),
            ));
        }
        let records = self.records_folder(project).await?;
        let directory = tokio::fs::canonicalize(records.join("runs").join(id)).await?;
        let mut allowed = vec![directory.clone()];
        allowed.extend(
            self.workdir(project)
                .ok()
                .and_then(|folder| std::fs::canonicalize(folder).ok()),
        );
        let (checkpoint, step) = match checkpoint.filter(|given| !given.is_empty()) {
            Some(given) => {
                let path = within(&directory.join(given), &allowed).ok_or_else(|| {
                    CoreError::new(
                        400,
                        "The checkpoint must be a file or folder in the run it resumes or in the project.",
                    )
                })?;
                (Some(path), step)
            }
            None => match newest_checkpoint(&directory, &allowed).await {
                Some((path, listed)) => (Some(path), step.or(listed)),
                None => (None, step),
            },
        };
        let resume = Resume {
            from: id.to_owned(),
            directory,
            checkpoint,
            step,
        };
        self.start_research_run(
            project,
            text(&previous, "versionId"),
            client_id,
            thread,
            Some(resume),
        )
        .await
    }

    /// Changes a run's saved record, whatever its status.
    async fn settle_run(
        &self,
        records: &Path,
        id: &str,
        change: impl FnOnce(&mut Value),
    ) -> Result<Value, CoreError> {
        let lock = self.records_lock(records);
        let _writing = lock.lock().await;
        let file = run_file(records, id);
        let mut run = read_record(&file)
            .await
            .map_err(|reason| super::cannot_use(id, &reason))?
            .ok_or_else(not_found)?;
        change(&mut run);
        run["revision"] = json!(run["revision"].as_u64().unwrap_or(0) + 1);
        run["updatedAt"] = json!(iso_time(now_millis()));
        write_whole(&file, &pretty(&run)?).await?;
        self.research_changed();
        Ok(run)
    }

    /// Ends a run's record. Its evidence is completed first, so whoever reads the run as ended reads whole evidence.
    async fn settle_ended(
        &self,
        records: &Path,
        id: &str,
        closed: Option<&Value>,
        change: impl FnOnce(&mut Value),
    ) -> Result<Value, CoreError> {
        let lock = self.records_lock(records);
        let _writing = lock.lock().await;
        let file = run_file(records, id);
        let mut run = read_record(&file)
            .await
            .map_err(|reason| super::cannot_use(id, &reason))?
            .ok_or_else(not_found)?;
        let was_active = run_is_active(text(&run, "status"));
        change(&mut run);
        run["revision"] = json!(run["revision"].as_u64().unwrap_or(0) + 1);
        run["updatedAt"] = json!(iso_time(now_millis()));
        if was_active && !run_is_active(text(&run, "status")) {
            evidence::finish(&records.join("runs").join(id), &run, closed).await;
        }
        write_whole(&file, &pretty(&run)?).await?;
        self.research_changed();
        Ok(run)
    }

    /// Changes a run's record only if it has not ended.
    async fn change_active_run(
        &self,
        records: &Path,
        id: &str,
        change: impl FnOnce(&mut Value),
    ) -> Result<Value, CoreError> {
        self.settle_run(records, id, |run| {
            if run_is_active(text(run, "status")) {
                change(run);
            }
        })
        .await
    }

    /// Seals a run whose process has ended.
    async fn finish_run(&self, finishing: FinishingRun, exit: Option<i32>) {
        let FinishingRun {
            project,
            records,
            source,
            directory,
            id,
            version,
            observed,
            pid,
        } = finishing;
        // What the process left running must not keep writing after the seal.
        if group_exists(pid) {
            end_group(pid).await;
        }
        if self.research.ending.load(Ordering::SeqCst) {
            return;
        }
        let closed = self
            .close_snapshot(&id, &directory, &observed, &source, true)
            .await;
        let changed = closed["changed"].clone();
        let metric_path = directory.join("metrics.jsonl");
        let metrics =
            tokio::task::spawn_blocking(move || super::imports::metric_output(&metric_path))
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or((0, false));
        let training = version["kind"] == "training";
        let sealed = seal(&directory).await;
        let (per_model, warnings) = self.drift_check(&project, &version, &directory).await;
        let saved = self
            .settle_ended(&records, &id, Some(&closed), |run| {
                if !run_is_active(text(run, "status")) {
                    return;
                }
                let stopped = text(run, "status") == "stopping";
                match &sealed {
                    Ok((scan, fields)) => {
                        run["status"] = json!(if stopped {
                            "stopped"
                        } else if exit == Some(0) && !metrics.1 {
                            "protocol_error"
                        } else if exit == Some(0)
                            && training
                            && scan.problems.is_empty()
                            && metrics.0 > 0
                        {
                            "completed"
                        } else {
                            status_after(exit, scan)
                        });
                        if !metrics.1 {
                            run["error"] =
                                json!("The training metrics stream is malformed or incomplete.");
                        }
                        merge(run, fields);
                    }
                    Err(error) => {
                        run["status"] = json!("failed");
                        run["error"] = json!(format!("The samples could not be read: {error}"));
                    }
                }
                run["exitCode"] = json!(exit);
                run["endedAt"] = json!(iso_time(now_millis()));
                run["inputsChanged"] = json!(changed);
                run["samplesPerModel"] = json!(per_model);
                // Only a whole run is compared; a partial one would warn about its own stopping.
                run["warnings"] = if text(run, "status") == "completed" {
                    json!(warnings)
                } else {
                    json!([])
                };
            })
            .await;
        if let Err(error) = saved {
            eprintln!("Could not save the end of research run {id}: {error}");
        }
        locked(&self.research.active).remove(&id);
    }

    /// Ends this runtime's runs because it is stopping: each one is interrupted, its samples kept.
    pub async fn research_end_runs(&self) {
        self.research.ending.store(true, Ordering::SeqCst);
        let active: Vec<(String, u32, String)> = locked(&self.research.active)
            .iter()
            .map(|(id, run)| (id.clone(), run.pid, run.project.clone()))
            .collect();
        for (id, pid, project) in active {
            end_group(pid).await;
            if let Ok(records) = self.records_folder(&project).await {
                self.interrupt(&records, &id, "ended").await;
            }
        }
    }

    /// Runs a runtime that died left behind: those still on record as active become interrupted. A process is ended
    /// only when it is confirmed to be the same one.
    pub async fn research_recover(self: &Arc<Self>) {
        self.follow_task_reports();
        let projects: Vec<String> = self.store.read(|state| {
            state
                .projects
                .iter()
                .map(|project| text(project, "id").to_owned())
                .collect()
        });
        for project in projects {
            let Ok(records) = self.records_folder(&project).await else {
                continue;
            };
            let Ok((runs, _)) = read_runs(&records).await else {
                continue;
            };
            for run in runs.iter().filter(|run| run_is_active(text(run, "status"))) {
                let id = text(run, "id");
                if run.get("remote").is_some() {
                    self.follow_remote(project.clone(), id.to_owned());
                    continue;
                }
                let directory = records.join("runs").join(id);
                let process = match recorded_identity(&directory).await {
                    None => "none",
                    Some((pid, started)) => match process_start_time(pid).await {
                        Some(now) if now == started => {
                            // A sandboxed program is in the group of the sandbox that started it.
                            end_group(saturn_tools::group_of(pid).unwrap_or(pid)).await;
                            "ended"
                        }
                        Some(_) => "gone",
                        None if group_exists(pid) => {
                            // The leader is gone but something of its group lives; it is the same group only if it
                            // has not been reused, which cannot be told apart here.
                            "unconfirmed"
                        }
                        None => "gone",
                    },
                };
                self.interrupt(&records, id, process).await;
            }
        }
    }

    /// Seals a run as interrupted, saying what became of its process.
    async fn interrupt(&self, records: &Path, id: &str, process: &str) {
        let directory = records.join("runs").join(id);
        let sealed = seal(&directory).await;
        // A snapshot left by the interrupted run is checked and removed; its evidence is kept.
        let observed = super::read_record(&directory.join(evidence::EVIDENCE))
            .await
            .ok()
            .flatten()
            .map(|evidence| evidence["observed"].clone())
            .unwrap_or(Value::Null);
        let closed = if observed.get("snapshot").is_some() {
            let source = PathBuf::from(text(&observed["snapshot"], "source"));
            // Only a process known to have ended has let go of its snapshot.
            let remove = matches!(process, "ended" | "none");
            Some(
                self.close_snapshot(id, &directory, &observed["snapshot"], &source, remove)
                    .await,
            )
        } else {
            None
        };
        let saved = self
            .settle_ended(records, id, closed.as_ref(), |run| {
                if !run_is_active(text(run, "status")) {
                    return;
                }
                run["status"] = json!("interrupted");
                run["process"] = json!(process);
                run["endedAt"] = json!(iso_time(now_millis()));
                if let Ok((_, fields)) = &sealed {
                    merge(run, fields);
                }
            })
            .await;
        if let Err(error) = saved {
            eprintln!("Could not save research run {id} as interrupted: {error}");
        }
        locked(&self.research.active).remove(id);
    }
}

/// What a run is handed beside its version: the seeds to pass, and what it resumes, if it does.
struct Handed<'a> {
    seeds: &'a [String],
    resume: Option<&'a Resume>,
}

/// What a resumed run takes over from: the run, its folder (which the program may read), the checkpoint its program
/// restores, and the step that checkpoint was saved at.
struct Resume {
    from: String,
    directory: PathBuf,
    checkpoint: Option<PathBuf>,
    step: Option<u64>,
}

/// A path, made whole, if it lies in one of these folders.
fn within(path: &Path, folders: &[PathBuf]) -> Option<PathBuf> {
    let path = std::fs::canonicalize(path).ok()?;
    folders
        .iter()
        .any(|folder| path.starts_with(folder))
        .then_some(path)
}

/// The last checkpoint a run listed in its artifacts manifest that is still there, with the step it says it was saved at.
async fn newest_checkpoint(
    directory: &Path,
    allowed: &[PathBuf],
) -> Option<(PathBuf, Option<u64>)> {
    let manifest = tokio::fs::read_to_string(directory.join("artifacts.jsonl"))
        .await
        .ok()?;
    manifest.lines().rev().find_map(|line| {
        let entry: Value = serde_json::from_str(line).ok()?;
        if entry["kind"] != "checkpoint" {
            return None;
        }
        let path = within(&directory.join(entry["path"].as_str()?), allowed)?;
        let step = entry["step"]
            .as_u64()
            .or_else(|| entry["metadata"]["step"].as_u64());
        Some((path, step))
    })
}

/// Copies into a resumed run's folder what the run it takes over finished: an evaluation's whole samples, or a training
/// run's metrics up to the checkpoint's step. Only whole lines come along. What was carried, and its hash.
async fn carry(resume: &Resume, version: &Value, directory: &Path) -> Result<Value, CoreError> {
    let training = version["kind"] == "training";
    let name = if training {
        "metrics.jsonl"
    } else {
        "samples.jsonl"
    };
    let keep = |line: &Value| {
        if training {
            resume
                .step
                .is_some_and(|step| line["step"].as_u64().is_some_and(|at| at <= step))
        } else {
            line.get("sampleId").is_some()
        }
    };
    let text = tokio::fs::read(resume.directory.join(name))
        .await
        .unwrap_or_default();
    let mut kept = Vec::new();
    let mut lines = 0_u64;
    for line in text.split_inclusive(|byte| *byte == b'\n') {
        if line.last() != Some(&b'\n') {
            break;
        }
        if serde_json::from_slice::<Value>(line).is_ok_and(|value| keep(&value)) {
            kept.extend_from_slice(line);
            lines += 1;
        }
    }
    if !kept.is_empty() {
        write_whole(&directory.join(name), &kept).await?;
    }
    Ok(json!({
        "run": resume.from,
        "samples": if training { 0 } else { lines },
        "metrics": if training { lines } else { 0 },
        "sha256": saturn_domain::research::sha256_hex(&kept),
        "checkpoint": resume.checkpoint,
        "step": resume.step,
    }))
}

/// What finishing a run needs to know.
struct FinishingRun {
    project: String,
    records: PathBuf,
    source: PathBuf,
    directory: PathBuf,
    id: String,
    version: Value,
    /// What was observed making the run's snapshot.
    observed: Value,
    pid: u32,
}

/// A version's content as it was fingerprinted before models had a revision kind and a weights hash, so a version
/// frozen then still starts when nothing it held has changed. Its models are not pinned by those fields.
fn before_model_identity(content: &Value) -> Value {
    let mut old = content.clone();
    for model in old["models"].as_array_mut().into_iter().flatten() {
        if let Some(fields) = model.as_object_mut() {
            fields.remove("revisionKind");
            fields.remove("weightsSha256");
            let named = fields
                .get("weightsRevision")
                .and_then(Value::as_str)
                .is_some_and(|revision| !revision.is_empty());
            fields.insert("floating".to_owned(), json!(!named));
        }
    }
    old
}

/// The version's seeds as text, in order.
fn seeds_of(version: &Value) -> Vec<String> {
    version["seeds"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|seed| match seed {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .collect()
}

/// What a run records about its samples file when it ends; the hash and size fix what counts as its samples.
async fn seal(directory: &Path) -> std::io::Result<(Scan, Value)> {
    let path = directory.join("samples.jsonl");
    // An empty file is no samples, as a missing one is: a sandboxed run's file is made empty before it starts.
    let (sha256, size) = match hash_file(&path).await {
        Ok((_, 0)) => (String::new(), 0),
        Ok(found) => found,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (String::new(), 0),
        Err(error) => return Err(error),
    };
    let scanned = path.clone();
    let scan = tokio::task::spawn_blocking(move || scan_samples(&scanned))
        .await
        .map_err(std::io::Error::other)??;
    let fields = json!({
        "samples": scan.samples,
        "infrastructureErrors": scan.infrastructure_errors,
        "problems": scan.problems,
        "partialLine": scan.partial_line,
        "samplesSha256": sha256,
        "samplesSize": size,
    });
    Ok((scan, fields))
}

/// Copies an object's fields onto a record.
fn merge(run: &mut Value, fields: &Value) {
    if let (Some(run), Some(fields)) = (run.as_object_mut(), fields.as_object()) {
        run.extend(
            fields
                .iter()
                .map(|(key, value)| (key.clone(), value.clone())),
        );
    }
}

fn run_file(records: &Path, id: &str) -> PathBuf {
    records.join("runs").join(id).join("run.json")
}

fn not_found() -> CoreError {
    CoreError::new(404, "No such run")
}

/// Every run in a project's records, and the ones that cannot be used.
pub(super) async fn read_runs(records: &Path) -> Result<(Vec<Value>, Vec<Value>), CoreError> {
    let mut items = Vec::new();
    let mut problems = Vec::new();
    let mut entries = match tokio::fs::read_dir(records.join("runs")).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((items, problems)),
        Err(error) => return Err(error.into()),
    };
    while let Some(entry) = entries.next_entry().await? {
        let id = entry.file_name().to_string_lossy().into_owned();
        if !is_id(&id) {
            continue;
        }
        match read_record(&entry.path().join("run.json")).await {
            Ok(Some(run)) => items.push(run),
            Ok(None) => {}
            Err(error) => problems.push(json!({ "id": id, "error": error })),
        }
    }
    items.sort_by_key(|item| {
        (
            text(item, "createdAt").to_owned(),
            text(item, "id").to_owned(),
        )
    });
    Ok((items, problems))
}

/// The run an earlier start with this `clientId` made.
async fn run_with_client(records: &Path, client: &str) -> Result<Option<Value>, CoreError> {
    let (runs, _) = read_runs(records).await?;
    Ok(runs.into_iter().find(|run| text(run, "clientId") == client))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_frozen_before_model_identity_is_read_as_it_was_fingerprinted() {
        let now = json!({ "command": "run", "models": [
            { "modelId": "model_a", "weightsRevision": "main", "floating": true, "revisionKind": "name" },
            { "modelId": "model_b", "weightsRevision": null, "floating": true, "revisionKind": "none", "weightsSha256": "ff" },
        ] });
        let old = before_model_identity(&now);
        assert_eq!(
            old["models"],
            json!([
                { "modelId": "model_a", "weightsRevision": "main", "floating": false },
                { "modelId": "model_b", "weightsRevision": null, "floating": true },
            ])
        );
        assert_eq!(old["command"], "run");
    }
}
