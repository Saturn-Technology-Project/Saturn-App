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

/// The program to start for an interpreter, or a refusal when it is not there, as starting it would refuse: the sandbox
/// would start and only then fail to find it, with a less helpful message. On macOS and Linux it is the
/// interpreter as it was named: a path is looked for from `cwd`, where the program starts, and a bare name on PATH. On
/// Windows it is the whole path of the file found. A program there is looked for from the folder of the process that
/// starts it, not from the one it is started in, so `.venv/Scripts/python.exe` would be looked for beside Saturn; a
/// name may be written without its `.exe`; and PATH holds empty `python.exe` files that only open the Store.
pub(super) fn interpreter_program(python: &str, cwd: &Path) -> Result<String, CoreError> {
    let given = Path::new(python);
    let found = if given.is_absolute() || given.components().count() > 1 {
        let place = cwd.join(given);
        if cfg!(windows) {
            let spelled = if place.extension().is_some() {
                place
            } else {
                place.with_extension("exe")
            };
            spelled.is_file().then_some(spelled)
        } else {
            place.is_file().then(|| given.to_path_buf())
        }
    } else if cfg!(windows) {
        super::manage::on_path(python)
    } else {
        std::env::var_os("PATH")
            .is_some_and(|path| {
                std::env::split_paths(&path).any(|folder| folder.join(given).is_file())
            })
            .then(|| given.to_path_buf())
    };
    found
        .map(|program| program.to_string_lossy().into_owned())
        .ok_or_else(|| {
            CoreError::new(
                422,
                format!(
                    "{python} could not start: it is not there. Choose an existing interpreter under Environment."
                ),
            )
        })
}

impl Kernel {
    /// A program Saturn starts for a project's research, in the project's command sandbox (see `research_invocation`),
    /// with the user's environment but none of Saturn's own variables. `writable` adds folders it may write to.
    pub(super) fn research_command(
        &self,
        project: &str,
        program: &str,
        args: &[String],
        source: &Path,
        writable: &[String],
    ) -> Command {
        let invocation = super::isolation::research_invocation(
            self.project_sandbox(project),
            self.store.root(),
            program,
            args.to_vec(),
            source,
            writable,
            &[],
        );
        let mut command = Command::new(&invocation.file);
        command.args(&invocation.args);
        launch_env(&mut command);
        saturn_tools::no_window(&mut command);
        for (name, _) in std::env::vars_os() {
            if name.to_string_lossy().starts_with("SATURN_") {
                command.env_remove(&name);
            }
        }
        command
    }

    /// The project's interpreter with `args`, sandboxed like any other research program. The interpreter is named in the
    /// project's own files, which a cloned repository brings, and even an installed one runs the `.pth` files of the
    /// environment it belongs to as it starts: the sandbox, not the choice of interpreter, is what keeps it from Saturn's
    /// data and the user's credentials.
    pub(super) fn interpreter_command(
        &self,
        project: &str,
        python: &str,
        args: &[String],
        cwd: &Path,
    ) -> Result<Command, CoreError> {
        let program = interpreter_program(python, cwd)?;
        let source = self.research_source(project, None)?;
        Ok(self.research_command(project, &program, args, &source, &[]))
    }
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
        self.research_lsp_stop_project(project).await;
        self.research_changed();
        self.research_environment(project).await
    }

    /// Asks the interpreter what it is and has, and keeps the answer in the record.
    pub async fn research_check_environment(&self, project: &str) -> Result<Value, CoreError> {
        let python = self.research_python(project).await?;
        let source = self.research_source(project, None)?;
        let mut command = self.interpreter_command(project, &python, &["-".to_owned()], &source)?;
        let mut child = command
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
