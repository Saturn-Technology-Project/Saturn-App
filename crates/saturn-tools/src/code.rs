//! The `code` tool and its two companions for background commands.
use std::path::Path;
use std::time::Duration;

use saturn_domain::Arguments;
use saturn_domain::js;
use saturn_domain::skills::workspace::Workspace;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::file::inside_workspace;
use crate::jobs::JobTable;
use crate::sandbox::{
    DEFAULT_SANDBOX, Platform, SandboxMode, SandboxPlan, SandboxSettings, sandbox_hint,
    wrap_command,
};
use crate::shell::{command_env, process_env, shell_invocation};
use crate::{TEXT_LIMIT, ToolResult, clip, either, process, text};

const CODE_TIMEOUT: i64 = 15_000;
const CODE_TIMEOUT_MAX: i64 = 30_000;
const LONGEST_WAIT: i64 = 30_000;
/// How long a background command gets to fail at once, so its error comes back with the job id.
const FIRST_LOOK: Duration = Duration::from_millis(300);
const NO_JOBS: &str = "Background commands are not available here";

/// What a command runs under.
#[derive(Clone, Debug, Default)]
pub struct CodeOptions {
    /// The sandbox the command runs in; the call's own `sandbox: "off"` (approved by then) turns it off.
    pub sandbox: Option<SandboxSettings>,
    /// Folders outside the workspace the command may also write to (the agent's private workspace, say).
    pub writable: Vec<String>,
    /// Background commands for this chat (`background: true`, `code_output`, `code_stop`).
    pub jobs: Option<ScopedJobs>,
}

/// A job table and the chat whose jobs these are.
#[derive(Clone, Debug)]
pub struct ScopedJobs {
    pub table: JobTable,
    pub scope: String,
}

/// A chat's jobs are its own: one holding another chat's job id gets the answer for a job that does not exist.
fn own_job(jobs: &ScopedJobs, id: &str) -> Result<(), String> {
    match jobs.table.get(id) {
        Some(job) if job.scope != jobs.scope => Err(format!("No background command {id}")),
        _ => Ok(()),
    }
}

/// Why reading a command's output stopped early.
#[derive(Debug)]
enum Stop {
    TooMuch(&'static str),
    Failed(std::io::Error),
}

/// How a foreground command ended.
struct Finished {
    stdout: String,
    stderr: String,
    /// Exit code, when it exited by itself.
    code: Option<i32>,
    /// Why it was ended, for the model.
    reason: Option<String>,
}

/// Reads a stream until it ends or holds more text than a tool may return.
async fn read_limited(
    mut stream: impl AsyncRead + Unpin,
    name: &'static str,
    kept: &mut Vec<u8>,
) -> Result<(), Stop> {
    let mut buffer = vec![0u8; 16 * 1024];
    loop {
        let count = stream.read(&mut buffer).await.map_err(Stop::Failed)?;
        if count == 0 {
            return Ok(());
        }
        kept.extend_from_slice(&buffer[..count]);
        // A character is at most three bytes per code unit, so this bounds what is decoded here.
        if kept.len() > TEXT_LIMIT && js::length(&String::from_utf8_lossy(kept)) > TEXT_LIMIT {
            return Err(Stop::TooMuch(name));
        }
    }
}

/// Runs a command to its end, its timeout, or the limit on its output. Dropping this ends the command.
async fn run_to_end(
    plan: &SandboxPlan,
    cwd: &Path,
    env: &[(std::ffi::OsString, std::ffi::OsString)],
    timeout: Duration,
) -> std::io::Result<Finished> {
    let mut child = process::command(&plan.invocation, cwd, env).spawn()?;
    let mut guard = process::EndOnDrop::new(child.id());
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut out = Vec::new();
    let mut failure = Vec::new();
    let outcome = tokio::time::timeout(timeout, async {
        tokio::try_join!(
            async {
                match stdout {
                    Some(stream) => read_limited(stream, "stdout", &mut out).await,
                    None => Ok(()),
                }
            },
            async {
                match stderr {
                    Some(stream) => read_limited(stream, "stderr", &mut failure).await,
                    None => Ok(()),
                }
            },
            async { child.wait().await.map_err(Stop::Failed) },
        )
    })
    .await;
    let (code, reason) = match outcome {
        Ok(Ok((_, _, status))) => {
            guard.finished();
            (status.code(), None)
        }
        Ok(Err(Stop::Failed(error))) => return Err(error),
        Ok(Err(Stop::TooMuch(name))) => (
            None,
            Some(format!(
                "(The command was stopped: its {name} passed {TEXT_LIMIT} characters. Read a narrower part: filter with grep, head or tail.)"
            )),
        ),
        Err(_) => (
            None,
            Some(format!(
                "(The command was stopped after {} ms. For a server, a watcher or a long build, pass background: true.)",
                timeout.as_millis()
            )),
        ),
    };
    let decoded = |bytes: &[u8]| js::prefix(&String::from_utf8_lossy(bytes), TEXT_LIMIT).to_owned();
    Ok(Finished {
        stdout: decoded(&out),
        stderr: decoded(&failure),
        code,
        reason,
    })
}

/// `code`: runs a shell command in the workspace.
pub async fn run_code(
    workspace: &Workspace,
    arguments: &Arguments,
    options: &CodeOptions,
) -> ToolResult {
    let command = text(arguments, "command");
    if js::trim(&command).is_empty() {
        return Err("Command is empty".to_owned());
    }
    tokio::fs::create_dir_all(workspace.root())
        .await
        .map_err(|error| error.to_string())?;
    let asked = text(arguments, "cwd");
    let cwd = if asked.is_empty() {
        workspace.root().to_path_buf()
    } else {
        inside_workspace(workspace, &asked).await?
    };
    let info = tokio::fs::metadata(&cwd)
        .await
        .map_err(|error| format!("{error}: {asked}"))?;
    if !info.is_dir() {
        return Err("cwd is not a directory".to_owned());
    }
    let limit = js::integer(arguments.get("timeout"), CODE_TIMEOUT).clamp(1_000, CODE_TIMEOUT_MAX);
    let timeout = Duration::from_millis(limit.unsigned_abs());
    let mut settings = options.sandbox.unwrap_or(DEFAULT_SANDBOX);
    if SandboxMode::from_value(arguments.get("sandbox")) == Some(SandboxMode::Off) {
        settings.mode = SandboxMode::Off;
    }
    let platform = Platform::current();
    let env = process_env();
    let root = workspace.root().to_string_lossy();
    let shell = shell_invocation(&command, "/bin/sh", platform, &env);
    let plan = wrap_command(shell, settings, &root, &options.writable, platform, &env);
    let plain_env = command_env(platform, &env);
    let note = |result: &mut Map<String, Value>| {
        if let Some(reason) = &plan.reason {
            result.insert("sandbox".to_owned(), json!("unavailable"));
            result.insert("sandboxNote".to_owned(), json!(reason));
        }
    };

    if arguments.get("background") == Some(&Value::Bool(true)) {
        let jobs = options.jobs.as_ref().ok_or(NO_JOBS)?;
        let started =
            jobs.table
                .start(&jobs.scope, &command, &plan.invocation, &cwd, &plain_env)?;
        let (job, output) = jobs.table.output(&started.id, FIRST_LOOK).await?;
        let mut result = Map::new();
        result.insert("jobId".to_owned(), json!(job.id));
        if let Some(pid) = job.pid {
            result.insert("pid".to_owned(), json!(pid));
        }
        result.insert("running".to_owned(), json!(job.running));
        if !job.running {
            result.insert("exitCode".to_owned(), json!(job.exit_code.flatten()));
        }
        result.insert("output".to_owned(), json!(clip(&output)));
        result.insert("sandboxed".to_owned(), json!(plan.sandboxed));
        note(&mut result);
        result.insert("note".to_owned(), json!(format!(
            "Started in the background. Read its output with code_output {{ jobId: \"{}\" }} (wait: milliseconds to wait for more), stop it with code_stop.",
            job.id
        )));
        return Ok(Value::Object(result));
    }

    let finished = match run_to_end(&plan, &cwd, &plain_env, timeout).await {
        Ok(finished) => finished,
        Err(error) => Finished {
            stdout: String::new(),
            stderr: error.to_string(),
            code: None,
            reason: None,
        },
    };
    let mut result = Map::new();
    if finished.code == Some(0) && finished.reason.is_none() {
        result.insert("stdout".to_owned(), json!(clip(&finished.stdout)));
        result.insert("stderr".to_owned(), json!(clip(&finished.stderr)));
        result.insert("exitCode".to_owned(), json!(0));
    } else {
        let mut stderr = finished.stderr;
        if stderr.is_empty() && finished.reason.is_none() {
            stderr = format!("Command failed: {command}\n");
        }
        if let Some(reason) = finished.reason {
            stderr = format!("{}\n{reason}", js::trim_end(&stderr));
            stderr = js::trim(&stderr).to_owned();
        }
        let hint = if plan.sandboxed {
            sandbox_hint(&stderr, settings)
        } else {
            None
        };
        if let Some(hint) = hint {
            stderr = format!("{}\n{hint}", js::trim_end(&stderr));
        }
        result.insert("stdout".to_owned(), json!(clip(&finished.stdout)));
        result.insert("stderr".to_owned(), json!(clip(&stderr)));
        result.insert("exitCode".to_owned(), json!(finished.code.unwrap_or(1)));
    }
    result.insert("sandboxed".to_owned(), json!(plan.sandboxed));
    note(&mut result);
    Ok(Value::Object(result))
}

/// The job a call names.
fn job_id(arguments: &Arguments) -> Result<String, String> {
    let id = either(arguments, "jobId", "id");
    if id.is_empty() {
        return Err("Name the background command: jobId".to_owned());
    }
    Ok(id)
}

/// `code_output`: a background command's recent output and state, after waiting up to `wait` ms for more.
pub async fn code_output(arguments: &Arguments, options: &CodeOptions) -> ToolResult {
    let jobs = options.jobs.as_ref().ok_or(NO_JOBS)?;
    let id = job_id(arguments)?;
    own_job(jobs, &id)?;
    let wait = js::integer(arguments.get("wait"), 0).clamp(0, LONGEST_WAIT);
    let (job, output) = jobs
        .table
        .output(&id, Duration::from_millis(wait.unsigned_abs()))
        .await?;
    let mut result = Map::new();
    result.insert("jobId".to_owned(), json!(job.id));
    result.insert("command".to_owned(), json!(job.command));
    result.insert("running".to_owned(), json!(job.running));
    if !job.running {
        result.insert("exitCode".to_owned(), json!(job.exit_code.flatten()));
    }
    result.insert("startedAt".to_owned(), json!(job.started_at));
    if let Some(ended) = &job.ended_at {
        result.insert("endedAt".to_owned(), json!(ended));
    }
    result.insert("output".to_owned(), json!(clip(&output)));
    Ok(Value::Object(result))
}

/// `code_stop`: ends a background command.
pub fn code_stop(arguments: &Arguments, options: &CodeOptions) -> ToolResult {
    let jobs = options.jobs.as_ref().ok_or(NO_JOBS)?;
    let id = job_id(arguments)?;
    own_job(jobs, &id)?;
    let job = jobs.table.stop(&id)?;
    Ok(json!({ "jobId": job.id, "command": job.command, "stopped": true }))
}
