//! Project folders agents may work in, once the user has allowed each one.
use std::path::{Path, PathBuf};

use saturn_domain::new_id;
use saturn_domain::time::{iso_time, now_millis};
use serde_json::{Value, json};

use crate::records::{by_id, by_id_mut, text};
use crate::{CoreError, Kernel, log};

/// `~` and `~/…` as the home folder.
fn resolve_home(path: &str) -> PathBuf {
    let home = std::env::home_dir();
    match (path.strip_prefix('~'), home) {
        (Some(""), Some(home)) => home,
        (Some(rest), Some(home)) if rest.starts_with(['/', '\\']) => home.join(&rest[1..]),
        _ => {
            let path = Path::new(path);
            if path.is_absolute() {
                path.to_path_buf()
            } else {
                std::env::current_dir().map_or_else(|_| path.to_path_buf(), |dir| dir.join(path))
            }
        }
    }
}

/// The folders a request names, each checked to exist.
async fn resolve_folders(input: &Value) -> Result<Vec<String>, CoreError> {
    let raw: Vec<&str> = match input.get("folders").and_then(Value::as_array) {
        Some(folders) => folders.iter().filter_map(Value::as_str).collect(),
        None => vec![text(input, "path")],
    };
    let mut folders = Vec::new();
    for item in raw {
        if saturn_domain::js::trim(item).is_empty() {
            continue;
        }
        let resolved = resolve_home(item);
        let shown = resolved.to_string_lossy().into_owned();
        let info = tokio::fs::metadata(&resolved)
            .await
            .map_err(|_| CoreError::new(400, format!("Folder not found: {shown}")))?;
        if !info.is_dir() {
            return Err(CoreError::new(400, format!("Not a folder: {shown}")));
        }
        if !folders.contains(&shown) {
            folders.push(shown);
        }
    }
    if folders.is_empty() {
        return Err(CoreError::new(
            400,
            "Add at least one folder to the workspace",
        ));
    }
    Ok(folders)
}

/// The branch checked out in a folder, read without running git.
async fn git_branch(folder: &Path) -> Value {
    let Ok(content) = tokio::fs::read_to_string(folder.join(".git/HEAD")).await else {
        return Value::Null;
    };
    let content = saturn_domain::js::trim(&content);
    match content.strip_prefix("ref: refs/heads/") {
        Some(branch) => branch.into(),
        None => saturn_domain::js::prefix(content, 7).into(),
    }
}

impl Kernel {
    /// Adds a folder as a project, or returns the project it already is. `grant` is the user allowing agents in.
    pub async fn create_project(&self, input: &Value) -> Result<Value, CoreError> {
        let folders = resolve_folders(input).await?;
        let resolved = folders[0].clone();
        let grant = input.get("grant").and_then(Value::as_bool) == Some(true);
        let now = iso_time(now_millis());
        let named_folders = input.get("folders").is_some_and(Value::is_array);
        let existing = self.store.read(|state| {
            state
                .projects
                .iter()
                .find(|project| text(project, "path") == resolved && !named_folders)
                .map(|project| text(project, "id").to_owned())
        });
        if let Some(id) = existing {
            let moment = now.clone();
            let chosen = id.clone();
            return Ok(self
                .store
                .update(move |state| {
                    state.active_project_id = Some(chosen.clone());
                    let project = by_id_mut(&mut state.projects, &chosen)?;
                    if grant && project.get("access").is_none_or(Value::is_null) {
                        project["access"] = json!({ "grantedAt": moment });
                    }
                    project["lastOpenedAt"] = moment.into();
                    if project
                        .get("folders")
                        .and_then(Value::as_array)
                        .is_none_or(Vec::is_empty)
                    {
                        project["folders"] = json!([resolved]);
                    }
                    Some(project.clone())
                })
                .await?
                .unwrap_or(Value::Null));
        }
        let path = Path::new(&resolved);
        let given = saturn_domain::js::trim(text(input, "name"));
        let base = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned());
        let name = if given.is_empty() {
            base.unwrap_or_else(|| "New Workspace".to_owned())
        } else {
            given.to_owned()
        };
        let project = json!({
            "id": new_id("proj")?,
            "name": name,
            "path": resolved,
            "folders": folders,
            "gitBranch": git_branch(path).await,
            "description": saturn_domain::js::trim(text(input, "description")),
            "rules": saturn_domain::js::trim(text(input, "rules")),
            "lastOpenedAt": now,
            "isDefault": false,
            // Choosing the folder in the picker and confirming the access prompt is the user's grant.
            "access": if grant { json!({ "grantedAt": now }) } else { Value::Null },
        });
        let saved = project.clone();
        self.store
            .update(move |state| {
                state.active_project_id = Some(text(&saved, "id").to_owned());
                state.projects.insert(0, saved);
            })
            .await?;
        log("projects", "info", &format!("Created workspace {name}"));
        Ok(project)
    }

    /// The folder a project's chats work in. Refuses until the user has granted access, so an agent never touches a folder the
    /// user did not explicitly allow.
    pub fn workdir(&self, project_id: &str) -> Result<PathBuf, CoreError> {
        let project = self
            .store
            .read(|state| by_id(&state.projects, project_id).cloned())
            .ok_or_else(|| {
                CoreError::new(
                    404,
                    "This chat's project was removed. Add the folder again to keep working in it.",
                )
            })?;
        if project.get("access").is_none_or(Value::is_null) {
            return Err(CoreError::new(
                403,
                format!(
                    "Saturn doesn't have access to {} yet. Allow access to {} to work in it.",
                    text(&project, "name"),
                    text(&project, "path")
                ),
            ));
        }
        Ok(PathBuf::from(text(&project, "path")))
    }

    /// Where a chat's agent works: the chat's own worktree when it has one, else the project folder, else nothing.
    pub fn workdir_for(&self, thread: Option<&Value>) -> Result<Option<PathBuf>, CoreError> {
        let Some(thread) = thread.filter(|thread| !text(thread, "projectId").is_empty()) else {
            return Ok(None);
        };
        let root = self.workdir(text(thread, "projectId"))?;
        Ok(Some(self.worktree_path(thread).unwrap_or(root)))
    }
}
