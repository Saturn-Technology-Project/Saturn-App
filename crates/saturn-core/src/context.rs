//! Turns the "@" attachments of a message into the text the agent reads: files and folder listings from the project, its
//! uncommitted git changes, a public web page, the last commands agents ran in it, and the output of its check command. Paths
//! never leave the project folder, and a symbolic link counts as where it points.
use std::path::{Path, PathBuf};
use std::process::Stdio;

use saturn_domain::js;
use saturn_domain::skills::workspace::Workspace;
use saturn_tools::file::inside_workspace;
use saturn_tools::web::WebSkill;
use serde_json::{Value, json};
use tokio::process::Command;

use crate::records::text;
use crate::{CoreError, Kernel};

/// Characters of attached context in one message.
pub const ATTACH_BUDGET: usize = 60_000;
const FILE_LIMIT: usize = 30_000;
const DIFF_LIMIT: usize = 40_000;
const LISTING_LIMIT: usize = 400;
const SKIP_DIRS: [&str; 11] = [
    "node_modules",
    ".git",
    "dist",
    "out",
    "build",
    ".next",
    ".cache",
    "coverage",
    "vendor",
    ".venv",
    "__pycache__",
];

/// A git command's output.
async fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

fn relative(root: &Path, full: &Path) -> String {
    full.strip_prefix(root).map_or_else(
        |_| String::new(),
        |path| path.to_string_lossy().replace('\\', "/"),
    )
}

/// Collects attachments within the budget.
#[derive(Default)]
struct Attached {
    parts: Vec<String>,
    used: usize,
}

impl Attached {
    fn push(&mut self, text: &str) {
        let room = ATTACH_BUDGET.saturating_sub(self.used);
        if room <= 200 {
            return;
        }
        let clipped = if js::length(text) > room {
            format!("{}\n…(truncated)", js::prefix(text, room))
        } else {
            text.to_owned()
        };
        self.used += js::length(&clipped);
        self.parts.push(clipped);
    }
}

/// The folder's files, from git when it is a repository (so ignored files are left out), else a walk.
async fn listing(folder: &Path, limit: usize) -> Vec<String> {
    if let Ok(out) = git(
        folder,
        &["ls-files", "--cached", "--others", "--exclude-standard"],
    )
    .await
    {
        let files: Vec<String> = out
            .split('\n')
            .filter(|file| !file.is_empty())
            .take(limit)
            .map(str::to_owned)
            .collect();
        if !files.is_empty() {
            return files;
        }
    }
    let mut found = Vec::new();
    let mut pending: Vec<(PathBuf, usize)> = vec![(folder.to_path_buf(), 0)];
    while let Some((current, depth)) = pending.pop() {
        if depth > 8 || found.len() >= limit {
            continue;
        }
        let Ok(mut entries) = tokio::fs::read_dir(&current).await else {
            continue;
        };
        let mut names = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            names.push(entry);
        }
        names.sort_by_key(tokio::fs::DirEntry::file_name);
        for entry in names {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || found.len() >= limit {
                continue;
            }
            let Ok(kind) = entry.file_type().await else {
                continue;
            };
            if kind.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    pending.push((entry.path(), depth + 1));
                }
            } else if kind.is_file() {
                found.push(relative(folder, &entry.path()));
            }
        }
    }
    found
}

impl Kernel {
    /// The attachments as text, and what each one was.
    pub async fn expand_context(
        &self,
        project_id: &str,
        items: &[Value],
    ) -> Result<Value, CoreError> {
        let root = self.workdir(project_id)?;
        let workspace = Workspace::new(&root);
        let mut attached = Attached::default();
        let mut sources: Vec<String> = Vec::new();
        for item in items.iter().take(20) {
            if let Err(message) = self
                .attach(
                    project_id,
                    &root,
                    &workspace,
                    item,
                    &mut attached,
                    &mut sources,
                )
                .await
            {
                let label = if text(item, "label").is_empty() {
                    text(item, "kind")
                } else {
                    text(item, "label")
                };
                attached.push(&format!("<error item=\"{label}\">{message}</error>"));
            }
        }
        Ok(json!({ "text": attached.parts.join("\n"), "sources": sources }))
    }

    async fn attach(
        &self,
        project_id: &str,
        root: &Path,
        workspace: &Workspace,
        item: &Value,
        attached: &mut Attached,
        sources: &mut Vec<String>,
    ) -> Result<(), String> {
        match text(item, "kind") {
            "file" => {
                let path = text(item, "path");
                let file = inside_workspace(workspace, path).await?;
                let content = tokio::fs::read_to_string(&file)
                    .await
                    .map_err(|error| error.to_string())?;
                if content.contains('\0') {
                    return Err(format!("{path} is not a text file"));
                }
                let shown = relative(root, &file);
                attached.push(&format!(
                    "<file path=\"{shown}\">\n{}\n</file>",
                    js::prefix(&content, FILE_LIMIT)
                ));
                sources.push(shown);
            }
            "folder" => {
                let folder = inside_workspace(workspace, text(item, "path")).await?;
                let files = listing(&folder, LISTING_LIMIT).await;
                let shown = relative(root, &folder);
                let shown = if shown.is_empty() {
                    ".".to_owned()
                } else {
                    shown
                };
                attached.push(&format!(
                    "<folder path=\"{shown}\">\n{}\n</folder>",
                    files.join("\n")
                ));
                sources.push(format!("{shown}/"));
            }
            "git" => {
                let status = git(root, &["status", "--short"]).await?;
                let diff = git(root, &["diff", "HEAD", "--stat", "--patch", "--no-color"]).await?;
                attached.push(&format!(
                    "<git_changes>\n{status}\n{}\n</git_changes>",
                    js::prefix(&diff, DIFF_LIMIT)
                ));
                sources.push("git changes".to_owned());
            }
            "web" => {
                let url = text(item, "url");
                let mut arguments = saturn_domain::Arguments::new();
                arguments.insert("url".to_owned(), url.into());
                let page = WebSkill::default().run(&arguments).await?;
                let title = text(&page, "title");
                let heading = if title.is_empty() {
                    String::new()
                } else {
                    format!("{title}\n\n")
                };
                attached.push(&format!(
                    "<web_page url=\"{url}\">\n{heading}{}\n</web_page>",
                    text(&page, "text")
                ));
                let bare = url
                    .strip_prefix("https://")
                    .or_else(|| url.strip_prefix("http://"))
                    .unwrap_or(url);
                sources.push(js::prefix(bare, 40).to_owned());
            }
            "terminal" => {
                attached.push(&format!(
                    "<terminal>\n{}\n</terminal>",
                    self.recent_commands(project_id)
                ));
                sources.push("terminal".to_owned());
            }
            "problems" => {
                attached.push(&format!(
                    "<problems>\n{}\n</problems>",
                    self.problems(project_id, root).await
                ));
                sources.push("problems".to_owned());
            }
            _ => {}
        }
        Ok(())
    }

    /// Files in the project matching a part of the path, shorter paths first, for the "@" picker.
    pub async fn project_files(
        &self,
        project_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<String>, CoreError> {
        let root = self.workdir(project_id)?;
        let needle = js::trim(query).to_lowercase();
        let mut files: Vec<String> = listing(&root, 5000)
            .await
            .into_iter()
            .filter(|item| needle.is_empty() || item.to_lowercase().contains(&needle))
            .collect();
        files.sort_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)));
        files.truncate(limit);
        Ok(files)
    }

    /// The last commands agents ran in this project, newest last.
    fn recent_commands(&self, project_id: &str) -> String {
        let mut commands: Vec<String> = Vec::new();
        self.store.read(|state| {
            let chats: Vec<&str> = state
                .threads
                .iter()
                .filter(|thread| text(thread, "projectId") == project_id)
                .map(|thread| text(thread, "id"))
                .collect();
            for run in state
                .runs
                .iter()
                .filter(|run| chats.contains(&text(run, "threadId")))
            {
                for action in run
                    .get("actions")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .rev()
                {
                    if text(action, "toolId") != "code" || commands.len() >= 5 {
                        continue;
                    }
                    let result = action.get("result").unwrap_or(&Value::Null);
                    let output = match result.get("output").and_then(Value::as_str) {
                        Some(output) => output.to_owned(),
                        None => format!("{}{}", text(result, "stdout"), text(result, "stderr")),
                    };
                    let code = result.get("exitCode").map_or_else(
                        || {
                            if text(action, "status") == "completed" {
                                "0".to_owned()
                            } else {
                                "unknown".to_owned()
                            }
                        },
                        ToString::to_string,
                    );
                    let command = action
                        .get("arguments")
                        .map_or("", |arguments| text(arguments, "command"));
                    commands.push(format!(
                        "$ {command}\nexit code: {code}\n{}",
                        js::suffix(js::trim(&output), 4000)
                    ));
                }
                if commands.len() >= 5 {
                    break;
                }
            }
        });
        if commands.is_empty() {
            return "No commands have run in this project yet.".to_owned();
        }
        commands.reverse();
        commands.join("\n\n")
    }

    /// What the project's check command reports now.
    async fn problems(&self, project_id: &str, root: &Path) -> String {
        let Some(command) = self.verify_command(project_id, root).await else {
            return "No check command is set for this project (Settings → Projects → Verify command), so there is nothing to report.".to_owned();
        };
        let result = Self::run_verification(&command, root).await;
        if result["ok"] == true {
            format!("`{command}` passed with no output of note.")
        } else {
            let code = result["code"]
                .as_i64()
                .map_or("?".to_owned(), |code| code.to_string());
            format!(
                "`{command}` failed (exit {code}):\n{}",
                text(&result, "output")
            )
        }
    }
}
