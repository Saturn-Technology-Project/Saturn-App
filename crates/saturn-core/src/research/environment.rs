//! The Python a project's experiments run in: which interpreter, what it has, and the lock files that pin it. Kept
//! as one record beside the project's other research records, and checked by asking the interpreter itself.
use std::path::Path;
use std::process::Stdio;

use saturn_domain::research::SCHEMA_VERSION;
use saturn_domain::time::{iso_time, now_millis};
use saturn_tools::launch_env;
use serde_json::{Value, json};
use tokio::process::Command;

use super::freeze::hash_file;
use super::{pretty, read_record, write_whole};
use crate::records::text;
use crate::{CoreError, Kernel};

/// The script that reports on an interpreter. It goes to the interpreter on standard input.
const REPORT: &str = include_str!("environment.py");
/// The record's file in the project's research folder.
const FILE: &str = "environment.json";
/// Files that pin an environment, looked for at the project's root.
const LOCK_FILES: [&str; 7] = [
    "uv.lock",
    "poetry.lock",
    "Pipfile.lock",
    "requirements.txt",
    "requirements.lock",
    "pyproject.toml",
    "environment.yml",
];

/// A command's first word when it is a Python.
pub(super) fn python_of(command: &str) -> Option<&str> {
    let first = command.split_whitespace().next()?;
    let name = Path::new(first).file_name()?.to_string_lossy();
    name.starts_with("python").then_some(first)
}

impl Kernel {
    /// The environment record: the interpreter the person set, what it last reported, and the lock files found now.
    pub async fn research_environment(&self, project: &str) -> Result<Value, CoreError> {
        let records = self.records_folder(project).await?;
        let mut record = read_record(&records.join(FILE))
            .await
            .map_err(|reason| CoreError::new(422, reason))?
            .unwrap_or_else(|| json!({ "schemaVersion": SCHEMA_VERSION, "revision": 0, "python": null, "report": null }));
        let source = self.research_source(project, None)?;
        let mut found = Vec::new();
        for name in LOCK_FILES {
            let path = source.join(name);
            if let Ok((hash, size)) = hash_file(&path).await {
                found.push(json!({ "path": name, "sha256": hash, "size": size }));
            }
        }
        record["lockFiles"] = json!(found);
        if record.get("python").and_then(Value::as_str).is_none() {
            record["suggestedPython"] = json!(self.suggested_python(project).await);
        }
        record["tools"] = self.environment_tools(&source);
        record["kits"] = Self::environment_kits(&record);
        record["job"] = self.environment_job(&records).await?;
        Ok(record)
    }

    /// The interpreter to use: the one set, else the one the newest experiment's command starts with.
    pub(super) async fn research_python(&self, project: &str) -> Result<String, CoreError> {
        let records = self.records_folder(project).await?;
        let set = read_record(&records.join(FILE))
            .await
            .ok()
            .flatten()
            .and_then(|record| {
                record
                    .get("python")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .filter(|python| !python.is_empty());
        if let Some(python) = set {
            return Ok(python);
        }
        self.suggested_python(project).await.ok_or_else(|| {
            CoreError::new(
                422,
                "No Python is set for this project. Set one under Environment, or give the experiment a command that starts with its Python, such as \".venv/bin/python probe.py\".",
            )
        })
    }

    /// The managed interpreter when it exists, else the Python the newest experiment's command starts with.
    async fn suggested_python(&self, project: &str) -> Option<String> {
        if let Ok(source) = self.research_source(project, None)
            && self.environment_tools(&source).pointer("/managed/exists")
                == Some(&Value::Bool(true))
        {
            return Some(if cfg!(windows) {
                format!("{}/Scripts/python.exe", super::manage::VENV)
            } else {
                format!("{}/bin/python", super::manage::VENV)
            });
        }
        let drafts = self.research_list(project, "experiments").await.ok()?;
        drafts
            .get("items")
            .and_then(Value::as_array)?
            .iter()
            .rev()
            .find_map(|draft| python_of(text(draft, "command")).map(str::to_owned))
    }

    /// Sets the interpreter. An empty path forgets it.
    pub async fn research_set_environment(
        &self,
        project: &str,
        request: &Value,
    ) -> Result<Value, CoreError> {
        let python = text(request, "python").trim().to_owned();
        if python.contains('\n') {
            return Err(CoreError::new(400, "A Python is one path."));
        }
        let records = self.records_for_writing(project).await?;
        let lock = self.records_lock(&records);
        let _writing = lock.lock().await;
        let mut record = read_record(&records.join(FILE))
            .await
            .map_err(|reason| CoreError::new(422, reason))?
            .unwrap_or_else(
                || json!({ "schemaVersion": SCHEMA_VERSION, "revision": 0, "report": null }),
            );
        let revision = record.get("revision").and_then(Value::as_u64).unwrap_or(0);
        record["python"] = if python.is_empty() {
            Value::Null
        } else {
            json!(python)
        };
        record["revision"] = json!(revision + 1);
        record["updatedAt"] = json!(iso_time(now_millis()));
        write_whole(&records.join(FILE), &pretty(&record)?).await?;
        drop(_writing);
        self.research_changed();
        self.research_environment(project).await
    }

    /// Asks the interpreter what it is and has, and keeps the answer in the record.
    pub async fn research_check_environment(&self, project: &str) -> Result<Value, CoreError> {
        if cfg!(windows) {
            return Err(CoreError::new(
                501,
                "Checking an environment is not supported on Windows yet.",
            ));
        }
        let python = self.research_python(project).await?;
        let source = self.research_source(project, None)?;
        let mut command = Command::new(&python);
        launch_env(&mut command);
        for (name, _) in std::env::vars_os() {
            if name.to_string_lossy().starts_with("SATURN_") {
                command.env_remove(&name);
            }
        }
        let mut child = command
            .arg("-")
            .current_dir(&source)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| CoreError::new(422, format!("{python} could not start: {error}")))?;
        if let Some(mut stdin) = child.stdin.take() {
            tokio::io::AsyncWriteExt::write_all(&mut stdin, REPORT.as_bytes()).await?;
            drop(stdin);
        }
        let output = child.wait_with_output().await?;
        if !output.status.success() {
            let log = String::from_utf8_lossy(&output.stderr);
            let tail: Vec<&str> = log.lines().rev().take(8).collect();
            return Err(CoreError::new(
                422,
                format!(
                    "{python} ended with {}.\n{}",
                    output.status,
                    tail.into_iter().rev().collect::<Vec<_>>().join("\n")
                ),
            ));
        }
        let report: Value = serde_json::from_slice(&output.stdout).map_err(|error| {
            CoreError::new(422, format!("The report could not be read: {error}"))
        })?;

        let records = self.records_for_writing(project).await?;
        let lock = self.records_lock(&records);
        let _writing = lock.lock().await;
        let mut record = read_record(&records.join(FILE))
            .await
            .map_err(|reason| CoreError::new(422, reason))?
            .unwrap_or_else(
                || json!({ "schemaVersion": SCHEMA_VERSION, "revision": 0, "python": null }),
            );
        let revision = record.get("revision").and_then(Value::as_u64).unwrap_or(0);
        record["report"] = report;
        record["checkedAt"] = json!(iso_time(now_millis()));
        record["checkedWith"] = json!(python);
        record["revision"] = json!(revision + 1);
        record["updatedAt"] = json!(iso_time(now_millis()));
        write_whole(&records.join(FILE), &pretty(&record)?).await?;
        drop(_writing);
        self.research_changed();
        self.research_environment(project).await
    }
}
