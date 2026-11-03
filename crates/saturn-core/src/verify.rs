//! After an agent turn that changed files in a project: runs the project's check command and, when it fails, sends the failure
//! back to the agent as a follow-up, at most `MAX_ROUNDS` times per message from the user.
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use saturn_domain::js;
use saturn_tools::run_captured;
use saturn_tools::sandbox::Platform;
use saturn_tools::shell::{process_env, shell_invocation};
use serde_json::{Value, json};

use crate::permissions::read_json;
use crate::records::{by_id, by_id_mut, text};
use crate::runs::StartOptions;
use crate::{CoreError, Kernel, log};

/// Automatic fix rounds after one message from the user.
pub const MAX_ROUNDS: usize = 2;
const TIMEOUT: Duration = Duration::from_secs(5 * 60);
const OUTPUT_LIMIT: usize = 4000;

impl Kernel {
    /// The command to run for a project, or nothing when verification is off.
    pub(crate) async fn verify_command(&self, project_id: &str, root: &Path) -> Option<String> {
        let setting = self.store.read(|state| {
            by_id(&state.projects, project_id)
                .map(|project| js::trim(text(project, "verifyCommand")).to_owned())
                .unwrap_or_default()
        });
        if setting.is_empty() {
            return None;
        }
        if setting != "auto" {
            return Some(setting);
        }
        let package = read_json(&root.join("package.json")).await?;
        let scripts = package.get("scripts")?;
        if scripts.get("typecheck").is_some() {
            Some("npm run typecheck".to_owned())
        } else {
            scripts.get("lint").map(|_| "npm run lint".to_owned())
        }
    }

    /// Runs a project's check.
    pub(crate) async fn run_verification(command: &str, cwd: &Path) -> Value {
        let env = process_env();
        let shell = shell_invocation(command, "/bin/sh", Platform::current(), &env);
        let mut variables: Vec<_> = env.into_iter().collect();
        variables.push(("CI".into(), "1".into()));
        variables.push(("FORCE_COLOR".into(), "0".into()));
        let result = run_captured(&shell, cwd, &variables, b"", TIMEOUT, 4 * 1024 * 1024).await;
        let combined = format!("{}{}", result.stdout, result.stderr);
        json!({
            "command": command,
            "ok": result.code == Some(0),
            "code": result.code,
            "output": js::suffix(js::trim(&combined), OUTPUT_LIMIT),
        })
    }

    /// Called when a run ends. Nothing happens unless the run changed files in a project with a check command.
    pub(crate) async fn verify_after_run(self: &Arc<Self>, run: &Value) -> Result<(), CoreError> {
        let thread_id = text(run, "threadId");
        if text(run, "status") != "completed"
            || !text(run, "groupId").is_empty()
            || thread_id.is_empty()
        {
            return Ok(());
        }
        let changed = run
            .get("checkpoint")
            .and_then(|checkpoint| checkpoint.get("files"))
            .and_then(Value::as_array)
            .is_some_and(|files| {
                files.iter().any(|file| {
                    file.get("before") != file.get("after") && text(file, "review") != "reverted"
                })
            });
        if !changed {
            return Ok(());
        }
        let Some(thread) = self
            .store
            .read(|state| by_id(&state.threads, thread_id).cloned())
        else {
            return Ok(());
        };
        let project = text(&thread, "projectId");
        if project.is_empty() {
            return Ok(());
        }
        let Ok(Some(root)) = self.workdir_for(Some(&thread)) else {
            return Ok(());
        };
        let Some(command) = self.verify_command(project, &root).await else {
            return Ok(());
        };
        let result = Self::run_verification(&command, &root).await;
        let run_id = text(run, "id");
        let saved = result.clone();
        self.store
            .update(|state| {
                if let Some(current) = by_id_mut(&mut state.runs, run_id) {
                    current["verification"] = saved;
                }
            })
            .await?;
        if result["ok"] == true {
            log(
                "agent",
                "info",
                &format!("{command} passed after the agent's changes"),
            );
            return Ok(());
        }
        let rounds = self.verify_rounds(thread_id);
        if rounds >= MAX_ROUNDS {
            log(
                "agent",
                "warning",
                &format!(
                    "{command} still fails after {MAX_ROUNDS} automatic fix rounds; leaving it to the user"
                ),
            );
            return Ok(());
        }
        let code = result["code"]
            .as_i64()
            .map_or("?".to_owned(), |code| code.to_string());
        let output = text(&result, "output");
        let shown = if output.is_empty() {
            "(no output)"
        } else {
            output
        };
        log(
            "agent",
            "info",
            &format!(
                "{command} failed (exit {code}); asking the agent to fix it (round {} of {MAX_ROUNDS})",
                rounds + 1
            ),
        );
        self.start_run(
            text(run, "agentId"),
            &format!("`{command}` failed (exit {code}) after your changes:\n\n{shown}\n\nFix these, then check again."),
            Some(thread_id),
            None,
            StartOptions { automatic: true, ..StartOptions::default() },
        )
        .await?;
        Ok(())
    }

    /// Automatic runs in a chat since the user's own last message, counting every run of the chat.
    fn verify_rounds(&self, thread_id: &str) -> usize {
        self.store.read(|state| {
            state
                .runs
                .iter()
                .filter(|run| text(run, "threadId") == thread_id)
                .take_while(|run| run.get("automatic").and_then(Value::as_bool) == Some(true))
                .count()
        })
    }
}
