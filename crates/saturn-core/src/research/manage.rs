//! A managed Python environment in the project: made with `uv` when it is on this computer, else with `python3 -m
//! venv`, and filled with kits of packages, one that Saturn's own helpers need and others the person picks. Every
//! change is a job whose output is kept, and nothing is installed without being asked.
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use saturn_domain::new_id;
use saturn_domain::research::SCHEMA_VERSION;
use saturn_domain::time::{iso_time, now_millis};
use saturn_tools::{in_own_group, launch_env, terminate};
use serde_json::{Value, json};
use tokio::process::Command;

use super::{pretty, read_record, write_whole};
use crate::records::text;
use crate::{CoreError, Kernel, locked};

/// Where the managed environment lives in the project.
pub(super) const VENV: &str = ".venv";
/// The job's record and log in the research folder.
const JOB_FILE: &str = "environment-job.json";
const LOG_FILE: &str = "environment-job.log";
/// How many lines of the log a reading gives.
const LOG_TAIL: usize = 40;

/// A kit of packages: what it is for, and what it holds.
pub(super) struct Kit {
    pub id: &'static str,
    pub title: &'static str,
    pub what: &'static str,
    pub packages: &'static [&'static str],
    /// Installed with the environment unless declined: Saturn's own helpers need it.
    pub bundled: bool,
}

pub(super) const KITS: [Kit; 5] = [
    Kit {
        id: "core",
        title: "What Saturn's helpers need",
        what: "Looking inside a model and the environment check load models with these. Installed with the environment unless you say not to.",
        packages: &["torch", "transformers", "numpy"],
        bundled: true,
    },
    Kit {
        id: "interpretability",
        title: "Interpretability",
        what: "TransformerLens for hooks and patching, SAELens for sparse autoencoders, einops for the tensor shapes.",
        packages: &["transformer_lens", "sae_lens", "einops"],
        bundled: false,
    },
    Kit {
        id: "training",
        title: "Post-training",
        what: "TRL for SFT and DPO, PEFT for adapters, datasets and accelerate underneath them.",
        packages: &["trl", "peft", "datasets", "accelerate"],
        bundled: false,
    },
    Kit {
        id: "analysis",
        title: "Analysis",
        what: "pandas and matplotlib for tables and figures from a run's samples.",
        packages: &["pandas", "matplotlib"],
        bundled: false,
    },
    Kit {
        id: "notebooks",
        title: "Notebooks",
        what: "Jupyter and a kernel, for notebooks beside the code.",
        packages: &["jupyter", "ipykernel"],
        bundled: false,
    },
];

/// The first place on PATH that has a program.
fn on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|folder| folder.join(name))
        .find(|candidate| candidate.is_file())
}

/// The managed interpreter's path inside the project, as the record says it.
fn venv_python() -> String {
    if cfg!(windows) {
        format!("{VENV}/Scripts/python.exe")
    } else {
        format!("{VENV}/bin/python")
    }
}

/// A package name as a command-line word: letters, digits, `-`, `_`, `.`, and a version pin after them.
fn clean_package(name: &str) -> Result<&str, CoreError> {
    let allowed =
        |character: char| character.is_ascii_alphanumeric() || "-_.[]=<>!~,".contains(character);
    if name.is_empty() || name.len() > 100 || !name.chars().all(allowed) || name.starts_with('-') {
        return Err(CoreError::new(
            400,
            format!("{name:?} is not a package name."),
        ));
    }
    Ok(name)
}

/// A shell word with no interpretation.
fn quoted(word: &str) -> String {
    format!("'{}'", word.replace('\'', "'\\''"))
}

impl Kernel {
    /// Which tools this computer has for making environments, and whether the project's managed one exists.
    pub(super) fn environment_tools(&self, source: &Path) -> Value {
        let python = source.join(venv_python());
        json!({
            "uv": on_path("uv").map(|path| path.to_string_lossy().into_owned()),
            "python3": on_path("python3").map(|path| path.to_string_lossy().into_owned()),
            "managed": { "path": VENV, "python": venv_python(), "exists": python.is_file() },
        })
    }

    /// The kits, each package with the version the last check reported, when the check was of the managed interpreter.
    pub(super) fn environment_kits(record: &Value) -> Value {
        let checked_managed = text(record, "checkedWith") == venv_python();
        let installed = record
            .get("report")
            .and_then(|report| report.get("packages"));
        json!(
            KITS.iter()
                .map(|kit| {
                    json!({
                        "id": kit.id,
                        "title": kit.title,
                        "what": kit.what,
                        "bundled": kit.bundled,
                        "packages": kit.packages.iter().map(|name| json!({
                            "name": name,
                            "installed": if checked_managed { installed.and_then(|found| found.get(*name)).cloned().unwrap_or(Value::Null) } else { Value::Null },
                        })).collect::<Vec<_>>(),
                    })
                })
                .collect::<Vec<_>>()
        )
    }

    /// The job record with its log's end, and whether it is still running here.
    pub(super) async fn environment_job(&self, records: &Path) -> Result<Value, CoreError> {
        let Some(mut job) = read_record(&records.join(JOB_FILE))
            .await
            .map_err(|reason| CoreError::new(422, reason))?
        else {
            return Ok(Value::Null);
        };
        let running_here = locked(&self.research.environment_jobs).contains(records);
        if text(&job, "status") == "running" && !running_here {
            // This runtime did not start it, so the process is gone with the runtime that did.
            job["status"] = json!("interrupted");
        }
        let log = tokio::fs::read_to_string(records.join(LOG_FILE))
            .await
            .unwrap_or_default();
        let lines: Vec<&str> = log.lines().collect();
        let start = lines.len().saturating_sub(LOG_TAIL);
        job["logTail"] = json!(lines[start..].join("\n"));
        job["logLines"] = json!(lines.len());
        Ok(job)
    }

    /// Makes the managed environment, with the bundled kit unless declined.
    pub async fn research_create_environment(
        self: &Arc<Self>,
        project: &str,
        request: &Value,
    ) -> Result<Value, CoreError> {
        let source = self.research_source(project, None)?;
        let tools = self.environment_tools(&source);
        let version = text(request, "python").trim().to_owned();
        if !version.is_empty()
            && !version
                .chars()
                .all(|character| character.is_ascii_digit() || character == '.')
        {
            return Err(CoreError::new(
                400,
                "A Python version is digits and dots, such as 3.12.",
            ));
        }
        let mut commands = Vec::new();
        if tools.get("uv").is_some_and(|uv| !uv.is_null()) {
            let pick = if version.is_empty() {
                String::new()
            } else {
                format!(" --python {}", quoted(&version))
            };
            commands.push(format!("uv venv{pick} {}", quoted(VENV)));
        } else if tools.get("python3").is_some_and(|python| !python.is_null()) {
            if !version.is_empty() {
                return Err(CoreError::new(
                    422,
                    "Only uv can pick a Python version. Without it, the environment is made from the python3 on this computer: leave the version empty.",
                ));
            }
            commands.push(format!("python3 -m venv {}", quoted(VENV)));
        } else {
            return Err(CoreError::new(
                422,
                "Neither uv nor python3 is on this computer's PATH. Install uv (astral.sh/uv) or Python, then try again.",
            ));
        }
        if request
            .get("withCore")
            .and_then(Value::as_bool)
            .unwrap_or(true)
        {
            let core = KITS
                .iter()
                .find(|kit| kit.bundled)
                .map(|kit| kit.packages)
                .unwrap_or(&[]);
            commands.push(self.install_command(&tools, core));
        }
        self.start_environment_job(project, "create", commands, Some(venv_python()))
            .await
    }

    /// Installs packages into the managed environment: a kit's, named ones, or what the project's lock file says.
    pub async fn research_install_packages(
        self: &Arc<Self>,
        project: &str,
        request: &Value,
    ) -> Result<Value, CoreError> {
        let source = self.research_source(project, None)?;
        let tools = self.environment_tools(&source);
        if !tools
            .pointer("/managed/exists")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Err(CoreError::new(
                422,
                "There is no managed environment yet. Create it first.",
            ));
        }
        let mut commands = Vec::new();
        let kind;
        if request
            .get("sync")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            kind = "sync";
            commands.push(self.sync_command(&source, &tools)?);
        } else {
            kind = "install";
            let mut packages: Vec<String> = Vec::new();
            if let Some(kit_id) = request.get("kit").and_then(Value::as_str) {
                let kit = KITS
                    .iter()
                    .find(|kit| kit.id == kit_id)
                    .ok_or_else(|| CoreError::new(404, format!("No kit {kit_id:?}.")))?;
                packages.extend(kit.packages.iter().map(|name| (*name).to_owned()));
            }
            for name in request
                .get("packages")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                packages.push(clean_package(name.trim())?.to_owned());
            }
            if packages.is_empty() {
                return Err(CoreError::new(400, "Name a kit or packages to install."));
            }
            let words: Vec<&str> = packages.iter().map(String::as_str).collect();
            commands.push(self.install_command(&tools, &words));
        }
        self.start_environment_job(project, kind, commands, None)
            .await
    }

    /// Ends the running job's processes.
    pub async fn research_stop_environment_job(&self, project: &str) -> Result<Value, CoreError> {
        let records = self.records_folder(project).await?;
        let job = self.environment_job(&records).await?;
        if text(&job, "status") != "running" {
            return Err(CoreError::new(409, "No job is running."));
        }
        if let Some(pid) = job.get("pid").and_then(Value::as_u64) {
            terminate(pid as u32);
        }
        Ok(job)
    }

    /// The install command the tools allow: uv's pip against the managed interpreter, else the interpreter's own pip.
    fn install_command(&self, tools: &Value, packages: &[&str]) -> String {
        let words: Vec<String> = packages.iter().map(|name| quoted(name)).collect();
        if tools.get("uv").is_some_and(|uv| !uv.is_null()) {
            format!(
                "uv pip install --python {} {}",
                quoted(&venv_python()),
                words.join(" ")
            )
        } else {
            format!(
                "{} -m pip install --disable-pip-version-check {}",
                quoted(&venv_python()),
                words.join(" ")
            )
        }
    }

    /// The command that brings the environment to what the project's lock file says.
    fn sync_command(&self, source: &Path, tools: &Value) -> Result<String, CoreError> {
        let has = |name: &str| source.join(name).is_file();
        let uv = tools.get("uv").is_some_and(|uv| !uv.is_null());
        if uv && has("uv.lock") {
            return Ok("uv sync".to_owned());
        }
        for file in ["requirements.lock", "requirements.txt"] {
            if has(file) {
                return Ok(if uv {
                    format!(
                        "uv pip install --python {} -r {}",
                        quoted(&venv_python()),
                        quoted(file)
                    )
                } else {
                    format!(
                        "{} -m pip install --disable-pip-version-check -r {}",
                        quoted(&venv_python()),
                        quoted(file)
                    )
                });
            }
        }
        if has("pyproject.toml") {
            return Ok(if uv {
                "uv sync".to_owned()
            } else {
                format!(
                    "{} -m pip install --disable-pip-version-check -e .",
                    quoted(&venv_python())
                )
            });
        }
        Err(CoreError::new(
            422,
            "No lock file to sync from: a uv.lock, requirements.txt, requirements.lock or pyproject.toml at the project's root.",
        ))
    }

    /// Runs commands one after another in the project, recording the job and its output; one job at a time per project.
    async fn start_environment_job(
        self: &Arc<Self>,
        project: &str,
        kind: &str,
        commands: Vec<String>,
        set_python_after: Option<String>,
    ) -> Result<Value, CoreError> {
        if cfg!(windows) {
            return Err(CoreError::new(
                501,
                "Managing an environment is not supported on Windows yet.",
            ));
        }
        let source = self.research_source(project, None)?;
        let records = self.records_for_writing(project).await?;
        // The record is written before the running set is cleared, so a job whose record says it ended is over.
        let ended = read_record(&records.join(JOB_FILE))
            .await
            .ok()
            .flatten()
            .is_some_and(|job| text(&job, "status") != "running");
        {
            let mut running = locked(&self.research.environment_jobs);
            if running.contains(&records) && !ended {
                return Err(CoreError::new(
                    409,
                    "A job is already running for this project. Wait for it or stop it.",
                ));
            }
            running.insert(records.clone());
        }
        let script = commands
            .iter()
            .map(|command| format!("printf '$ %s\\n' {} && {command}", quoted(command)))
            .collect::<Vec<_>>()
            .join(" && ");
        let log = match std::fs::File::create(records.join(LOG_FILE)) {
            Ok(file) => file,
            Err(error) => {
                locked(&self.research.environment_jobs).remove(&records);
                return Err(error.into());
            }
        };
        let errors = log.try_clone()?;
        let mut command = Command::new("/bin/sh");
        launch_env(&mut command);
        for (name, _) in std::env::vars_os() {
            if name.to_string_lossy().starts_with("SATURN_") {
                command.env_remove(&name);
            }
        }
        command
            .args(["-c", &script])
            .current_dir(&source)
            .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
            .stdin(Stdio::null())
            .stdout(log)
            .stderr(errors);
        in_own_group(&mut command);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                locked(&self.research.environment_jobs).remove(&records);
                return Err(CoreError::new(
                    422,
                    format!("The job could not start: {error}"),
                ));
            }
        };
        let pid = child.id().unwrap_or(0);
        let id = new_id("job")?;
        let now = iso_time(now_millis());
        let job = json!({
            "schemaVersion": SCHEMA_VERSION,
            "id": id,
            "kind": kind,
            "commands": commands,
            "status": "running",
            "pid": pid,
            "startedAt": now,
            "endedAt": null,
            "exitCode": null,
        });
        write_whole(&records.join(JOB_FILE), &pretty(&job)?).await?;
        self.research_changed();

        let kernel = Arc::clone(self);
        let owned_project = project.to_owned();
        tokio::spawn(async move {
            let exit = child.wait().await.ok().and_then(|status| status.code());
            let mut done = job;
            done["status"] = json!(if exit == Some(0) {
                "completed"
            } else {
                "failed"
            });
            done["exitCode"] = json!(exit);
            done["endedAt"] = json!(iso_time(now_millis()));
            if let Ok(bytes) = pretty(&done) {
                let _ = write_whole(&records.join(JOB_FILE), &bytes).await;
            }
            if exit == Some(0)
                && let Some(python) = set_python_after
            {
                let _ = kernel
                    .research_set_environment(&owned_project, &json!({ "python": python }))
                    .await;
            }
            locked(&kernel.research.environment_jobs).remove(&records);
            kernel.research_changed();
        });
        self.research_environment(project).await
    }
}

/// The set of records folders with a job running, kept on the research state.
pub(super) type RunningJobs = HashSet<PathBuf>;
