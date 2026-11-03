//! The `files` tool: list, read, write and patch files in the workspace.
use std::future::Future;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use saturn_domain::Arguments;
use saturn_domain::js;
use saturn_domain::skills::patch::{FileChange, apply_hunks, parse_patch, split_lines};
use saturn_domain::skills::workspace::Workspace;
use serde_json::{Value, json};

use crate::{TEXT_LIMIT, ToolResult, clip, either, text};

const LEADS_OUT: &str = "Path is outside the workspace (a symbolic link leads out of it)";
const TOO_LARGE: &str = "File is too large";

/// What a checkpoint's capture returns.
pub type CaptureFuture<'a> = Pin<Box<dyn Future<Output = std::io::Result<()>> + Send + 'a>>;

/// Called around every write a tool makes to a project folder, with the absolute path: `before` keeps the original bytes
/// the first time a run touches a file, `after` records what the run left there.
pub trait FileCheckpoint: Send + Sync {
    /// Before the write.
    fn before<'a>(&'a self, target: &'a Path) -> CaptureFuture<'a>;
    /// After the write, whether it worked or not.
    fn after<'a>(&'a self, target: &'a Path) -> CaptureFuture<'a>;
}

/// A path as `Workspace::resolve` gives it, refused when a symbolic link takes it out of the workspace: a cloned repository
/// can bring one that leads to the user's other files. A path that does not exist yet is judged by the folder it would be
/// created in, and a link to nothing is refused, since writing to it would create its target.
pub async fn inside_workspace(workspace: &Workspace, requested: &str) -> Result<PathBuf, String> {
    let target = workspace.resolve(requested)?;
    let root = tokio::fs::canonicalize(workspace.root())
        .await
        .map_err(|error| error.to_string())?;
    let mut current = target.clone();
    loop {
        match tokio::fs::canonicalize(&current).await {
            Ok(real) if real.starts_with(&root) => return Ok(target),
            Ok(_) => return Err(LEADS_OUT.to_owned()),
            Err(error)
                if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) =>
            {
                let link = tokio::fs::symlink_metadata(&current).await;
                if link.is_ok_and(|info| info.file_type().is_symlink()) {
                    return Err(LEADS_OUT.to_owned());
                }
                match current.parent() {
                    Some(parent) => current = parent.to_path_buf(),
                    None => return Err(LEADS_OUT.to_owned()),
                }
            }
            Err(error) => return Err(failure(&error, requested)),
        }
    }
}

/// A file error with the path the agent knows.
fn failure(error: &std::io::Error, path: &str) -> String {
    format!("{error}: {path}")
}

/// The `files` tool for one workspace.
#[derive(Clone)]
pub struct FileSkill {
    workspace: Workspace,
    /// Keeps originals so the user can review and revert the edits (project folders only).
    checkpoint: Option<Arc<dyn FileCheckpoint>>,
}

impl FileSkill {
    /// The tool for this workspace.
    pub fn new(workspace: Workspace, checkpoint: Option<Arc<dyn FileCheckpoint>>) -> Self {
        Self {
            workspace,
            checkpoint,
        }
    }

    /// Runs one write between the checkpoint's before and after captures of the files it touches.
    async fn tracked<F: Future<Output = std::io::Result<()>>>(
        &self,
        targets: &[&Path],
        write: F,
    ) -> Result<(), String> {
        let shown = |target: &Path| self.workspace.relative(target);
        if let Some(checkpoint) = &self.checkpoint {
            for target in targets {
                checkpoint
                    .before(target)
                    .await
                    .map_err(|error| failure(&error, &shown(target)))?;
            }
        }
        let written = write.await;
        if let Some(checkpoint) = &self.checkpoint {
            for target in targets {
                checkpoint
                    .after(target)
                    .await
                    .map_err(|error| failure(&error, &shown(target)))?;
            }
        }
        written.map_err(|error| failure(&error, &shown(targets[0])))
    }

    /// Makes the folder a file goes in.
    async fn make_parent(&self, target: &Path) -> Result<(), String> {
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| failure(&error, &self.workspace.relative(parent)))?;
        }
        Ok(())
    }

    /// Runs one `files` call.
    pub async fn run(&self, arguments: &Arguments) -> ToolResult {
        tokio::fs::create_dir_all(self.workspace.root())
            .await
            .map_err(|error| error.to_string())?;
        let action = match text(arguments, "action") {
            action if js::truthy(arguments.get("action")) => action,
            _ => "list".to_owned(),
        };
        if action == "patch" {
            return self
                .apply_patch(&either(arguments, "patch", "content"))
                .await;
        }
        let path = match text(arguments, "path") {
            path if js::truthy(arguments.get("path")) => path,
            _ => ".".to_owned(),
        };
        let target = inside_workspace(&self.workspace, &path).await?;
        let shown = self.workspace.relative(&target);
        match action.as_str() {
            "list" => {
                let mut folder = tokio::fs::read_dir(&target)
                    .await
                    .map_err(|error| failure(&error, &shown))?;
                let mut entries = Vec::new();
                while let Some(entry) = folder
                    .next_entry()
                    .await
                    .map_err(|error| failure(&error, &shown))?
                {
                    let is_folder = entry.file_type().await.is_ok_and(|kind| kind.is_dir());
                    entries.push(json!({
                        "name": entry.file_name().to_string_lossy(),
                        "kind": if is_folder { "directory" } else { "file" },
                    }));
                }
                Ok(json!({ "path": shown, "entries": entries }))
            }
            "read" => {
                let bytes = tokio::fs::read(&target)
                    .await
                    .map_err(|error| failure(&error, &shown))?;
                let lines = split_lines(&String::from_utf8_lossy(&bytes));
                let count = lines.len();
                let offset = js::integer(arguments.get("offset"), 1).max(1);
                let limit = match arguments.get("limit") {
                    None | Some(Value::Null) => usize::MAX,
                    limit => {
                        let whole = i64::try_from(count).unwrap_or(i64::MAX);
                        usize::try_from(js::integer(limit, whole).max(1)).unwrap_or(usize::MAX)
                    }
                };
                let skip = usize::try_from(offset - 1).unwrap_or(usize::MAX);
                let slice: Vec<&str> = lines
                    .iter()
                    .skip(skip)
                    .take(limit)
                    .map(String::as_str)
                    .collect();
                Ok(json!({
                    "path": shown,
                    "offset": offset,
                    "lines": count,
                    "content": clip(&slice.join("\n")),
                }))
            }
            "write" => {
                let content = text(arguments, "content");
                if js::length(&content) > TEXT_LIMIT {
                    return Err(TOO_LARGE.to_owned());
                }
                self.make_parent(&target).await?;
                self.tracked(&[&target], tokio::fs::write(&target, &content))
                    .await?;
                Ok(json!({ "path": shown, "bytes": content.len() }))
            }
            _ => Err("Use list, read, write, or patch".to_owned()),
        }
    }

    async fn apply_patch(&self, patch: &str) -> ToolResult {
        let changes = parse_patch(patch)?;
        if changes.is_empty() {
            return Err("Patch has no file operations".to_owned());
        }
        let mut applied = Vec::with_capacity(changes.len());
        for change in &changes {
            applied.push(match change {
                FileChange::Add { path, lines } => {
                    let target = inside_workspace(&self.workspace, path).await?;
                    if tokio::fs::metadata(&target).await.is_ok() {
                        return Err(format!("{path} already exists"));
                    }
                    self.make_parent(&target).await?;
                    let mut content = lines.join("\n");
                    if !lines.is_empty() {
                        content.push('\n');
                    }
                    if js::length(&content) > TEXT_LIMIT {
                        return Err(TOO_LARGE.to_owned());
                    }
                    self.tracked(&[&target], tokio::fs::write(&target, &content))
                        .await?;
                    json!({ "path": self.workspace.relative(&target), "action": "add" })
                }
                FileChange::Delete { path } => {
                    let target = inside_workspace(&self.workspace, path).await?;
                    self.tracked(&[&target], tokio::fs::remove_file(&target))
                        .await?;
                    json!({ "path": self.workspace.relative(&target), "action": "delete" })
                }
                FileChange::Update {
                    path,
                    move_to,
                    hunks,
                } => {
                    let target = inside_workspace(&self.workspace, path).await?;
                    let bytes = tokio::fs::read(&target)
                        .await
                        .map_err(|error| failure(&error, path))?;
                    let next = apply_hunks(&String::from_utf8_lossy(&bytes), hunks)?;
                    if js::length(&next) > TEXT_LIMIT {
                        return Err(TOO_LARGE.to_owned());
                    }
                    let destination = match move_to {
                        Some(moved) => inside_workspace(&self.workspace, moved).await?,
                        None => target.clone(),
                    };
                    if destination == target {
                        self.tracked(&[&target], tokio::fs::write(&target, &next))
                            .await?;
                    } else {
                        self.make_parent(&destination).await?;
                        let write = async {
                            tokio::fs::write(&destination, &next).await?;
                            tokio::fs::remove_file(&target).await
                        };
                        self.tracked(&[&target, &destination], write).await?;
                    }
                    json!({
                        "path": self.workspace.relative(&destination),
                        "action": if move_to.is_some() { "move" } else { "update" },
                    })
                }
            });
        }
        Ok(json!({ "applied": applied }))
    }
}
