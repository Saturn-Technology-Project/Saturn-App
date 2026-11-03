//! Project folders agents may work in, once the user has allowed each one.
use std::path::{Path, PathBuf};
use std::process::Stdio;

use saturn_domain::js;
use saturn_domain::new_id;
use saturn_domain::skills::workspace::Workspace;
use saturn_domain::time::{iso_time, now_millis};
use saturn_tools::file::inside_workspace;
use serde_json::{Value, json};

use crate::records::{by_id, by_id_mut, remove, text};
use crate::{CoreError, Kernel, locked, log};

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

    /// Where the default project points when there is none yet: this checkout's working folder in development, the agents' own
    /// workspace in the packaged app.
    async fn default_folder(&self) -> Result<PathBuf, CoreError> {
        let chosen = std::env::var_os("SATURN_PROJECT_PATH")
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok());
        if let Some(chosen) = chosen.filter(|folder| !inside_app_bundle(folder)) {
            return Ok(chosen);
        }
        let workspace = self.store.root().join("workspace");
        tokio::fs::create_dir_all(&workspace).await?;
        Ok(workspace)
    }

    /// The projects, making the default one on a first start and moving one saved inside an app bundle by an earlier build.
    async fn ensure_projects(&self) -> Result<Vec<Value>, CoreError> {
        if self.store.read(|state| state.projects.is_empty()) {
            let mut folder = self.default_folder().await?;
            let inner = folder
                .file_name()
                .is_some_and(|name| name == "runtime" || name == "desktop");
            if inner
                && let Some(parent) = folder
                    .parent()
                    .filter(|parent| parent.join(".git").exists())
            {
                folder = parent.to_path_buf();
            }
            let in_bundle = std::env::current_dir().is_ok_and(|dir| inside_app_bundle(&dir))
                && std::env::var_os("SATURN_PROJECT_PATH").is_none();
            let name = if in_bundle {
                "Workspace".to_owned()
            } else {
                folder.file_name().map_or("Saturn-App".to_owned(), |name| {
                    name.to_string_lossy().into_owned()
                })
            };
            let project = json!({
                "id": "proj_default",
                "name": name,
                "path": folder.to_string_lossy(),
                "gitBranch": git_branch(&folder).await,
                "description": "Primary workspace project",
                "isDefault": true,
                "lastOpenedAt": iso_time(now_millis()),
            });
            self.store
                .update(|state| {
                    state.projects.push(project);
                    state.active_project_id = Some("proj_default".to_owned());
                })
                .await?;
        }
        let saved = self.store.read(|state| {
            by_id(&state.projects, "proj_default").map(|item| text(item, "path").to_owned())
        });
        if let Some(saved) = saved.filter(|path| inside_app_bundle(Path::new(path))) {
            let workspace = self.store.root().join("workspace");
            tokio::fs::create_dir_all(&workspace).await?;
            log(
                "projects",
                "info",
                &format!("Moved the default project out of {saved}"),
            );
            let moved = workspace.to_string_lossy().into_owned();
            self.store
                .update(|state| {
                    if let Some(target) = by_id_mut(&mut state.projects, "proj_default") {
                        target["path"] = moved.as_str().into();
                        target["name"] = "Workspace".into();
                        if target.get("folders").is_some() {
                            target["folders"] = json!([moved]);
                        }
                    }
                })
                .await?;
        }
        if self.store.read(|state| state.active_project_id.is_none()) {
            self.store
                .update(|state| {
                    state.active_project_id = state
                        .projects
                        .first()
                        .map(|item| text(item, "id").to_owned())
                })
                .await?;
        }
        Ok(self.store.read(|state| state.projects.clone()))
    }

    /// Every project with its folders and the branch checked out now.
    pub async fn list_projects(&self) -> Result<Vec<Value>, CoreError> {
        let mut projects = self.ensure_projects().await?;
        for project in &mut projects {
            let path = text(project, "path").to_owned();
            if project
                .get("folders")
                .and_then(Value::as_array)
                .is_none_or(Vec::is_empty)
            {
                project["folders"] = json!([path]);
            }
            let branch = git_branch(Path::new(&path)).await;
            if !branch.is_null() {
                project["gitBranch"] = branch;
            } else if project.get("gitBranch").is_none() {
                project["gitBranch"] = Value::Null;
            }
        }
        Ok(projects)
    }

    /// One project as `list_projects` shows it.
    async fn project_view(&self, id: &str) -> Result<Value, CoreError> {
        self.list_projects()
            .await?
            .into_iter()
            .find(|item| text(item, "id") == id)
            .ok_or_else(|| CoreError::new(404, format!("Project {id} not found")))
    }

    pub async fn active_project(&self) -> Result<Value, CoreError> {
        let projects = self.list_projects().await?;
        let active = self.store.read(|state| state.active_project_id.clone());
        projects
            .iter()
            .find(|item| Some(text(item, "id")) == active.as_deref())
            .or_else(|| projects.first())
            .cloned()
            .ok_or_else(|| CoreError::new(404, "No project found"))
    }

    pub async fn set_active_project(&self, id: &str) -> Result<Value, CoreError> {
        let target = self.project_view(id).await?;
        let now = iso_time(now_millis());
        self.store
            .update(|state| {
                state.active_project_id = Some(id.to_owned());
                if let Some(project) = by_id_mut(&mut state.projects, id) {
                    project["lastOpenedAt"] = now.into();
                }
            })
            .await?;
        log(
            "projects",
            "info",
            &format!("Switched active project to {}", text(&target, "name")),
        );
        Ok(target)
    }

    /// Grants or revokes agents' access to a project's folder.
    pub async fn set_project_access(&self, id: &str, granted: bool) -> Result<Value, CoreError> {
        let now = iso_time(now_millis());
        let updated = self
            .store
            .update(|state| {
                let project = by_id_mut(&mut state.projects, id)?;
                project["access"] = if granted {
                    json!({ "grantedAt": now })
                } else {
                    Value::Null
                };
                Some(project.clone())
            })
            .await?
            .ok_or_else(|| CoreError::new(404, format!("Project {id} not found")))?;
        log(
            "projects",
            "info",
            &format!(
                "{} agent access to {}",
                if granted { "Granted" } else { "Revoked" },
                text(&updated, "name")
            ),
        );
        self.project_view(id).await
    }

    /// Changes a project's description, rules, check command, sandbox or folders.
    pub async fn update_project(&self, id: &str, patch: &Value) -> Result<Value, CoreError> {
        let folders = if patch.get("folders").is_some() {
            Some(resolve_folders(&json!({ "folders": patch.get("folders") })).await?)
        } else {
            None
        };
        if patch
            .get("name")
            .is_some_and(|name| js::trim(name.as_str().unwrap_or("")).is_empty())
        {
            return Err(CoreError::new(400, "Workspace name is required"));
        }
        let sandbox = match patch.get("sandbox") {
            Some(Value::Null) => Some(Value::Null),
            Some(value) => Some(crate::admin::check_sandbox(value)?),
            None => None,
        };
        self.store
            .update(|state| {
                let project = by_id_mut(&mut state.projects, id)
                    .ok_or_else(|| CoreError::new(404, format!("Project {id} not found")))?;
                for key in ["name", "description"] {
                    if let Some(value) = patch.get(key).and_then(Value::as_str) {
                        project[key] = js::trim(value).into();
                    }
                }
                if let Some(rules) = patch.get("rules").filter(|rules| rules.is_string()) {
                    project["rules"] = rules.clone();
                }
                if let Some(command) = patch.get("verifyCommand").and_then(Value::as_str) {
                    let command = js::trim(command);
                    if command.is_empty() {
                        remove(project, "verifyCommand");
                    } else {
                        project["verifyCommand"] = command.into();
                    }
                }
                match sandbox {
                    Some(Value::Null) => remove(project, "sandbox"),
                    Some(value) => project["sandbox"] = value,
                    None => {}
                }
                if let Some(branch) = patch.get("gitBranch") {
                    project["gitBranch"] = branch.clone();
                }
                if let Some(folders) = folders {
                    project["path"] = folders[0].as_str().into();
                    project["folders"] = folders.into();
                }
                Ok::<(), CoreError>(())
            })
            .await??;
        self.project_view(id).await
    }

    /// Removes the project and its chats from Saturn. The folder and its files are never touched.
    pub async fn delete_project(&self, id: &str) -> Result<(), CoreError> {
        let stopped: Vec<String> = self
            .store
            .update(|state| {
                state.projects.retain(|project| text(project, "id") != id);
                let gone: Vec<String> = state
                    .threads
                    .iter()
                    .filter(|thread| text(thread, "projectId") == id)
                    .map(|thread| text(thread, "id").to_owned())
                    .collect();
                state
                    .threads
                    .retain(|thread| !gone.iter().any(|item| item == text(thread, "id")));
                let in_gone = |run: &Value| gone.iter().any(|item| item == text(run, "threadId"));
                let stopped = state
                    .runs
                    .iter()
                    .filter(|run| in_gone(run))
                    .map(|run| text(run, "id").to_owned())
                    .collect();
                state.runs.retain(|run| !in_gone(run));
                if state.active_project_id.as_deref() == Some(id) {
                    state.active_project_id = state
                        .projects
                        .first()
                        .map(|project| text(project, "id").to_owned());
                }
                stopped
            })
            .await?;
        // Anything still working in those chats stops with them.
        locked(&self.stops).retain(|key, handle| {
            let stopping = stopped
                .iter()
                .any(|run| key.starts_with(&format!("{run}:")));
            if stopping {
                handle.abort();
            }
            !stopping
        });
        log(
            "projects",
            "info",
            &format!("Removed project {id} and its chats (files untouched)"),
        );
        Ok(())
    }

    /// Opens a terminal window in a project's folder.
    pub async fn open_project_terminal(&self, id: &str) -> Result<Value, CoreError> {
        let target = self.project_view(id).await?;
        let path = text(&target, "path");
        launch_terminal(Path::new(path));
        Ok(json!({ "opened": true, "cwd": path }))
    }

    /// Shows a project's folder in the file manager.
    pub async fn open_project_folder(&self, id: &str) -> Result<Value, CoreError> {
        let target = self.project_view(id).await?;
        let path = text(&target, "path");
        launch_app("the file manager", file_manager(), &[path], None);
        Ok(json!({ "opened": true, "path": path }))
    }

    /// The rules a project's editor shows, and every file the agents' prompt takes rules from.
    pub async fn project_rules_view(&self, id: &str) -> Result<Value, CoreError> {
        let target = self.project_view(id).await?;
        let root = PathBuf::from(text(&target, "path"));
        let stored = text(&target, "rules");
        let mut view = None;
        for (source, file) in [
            ("cursorrules", root.join(".cursorrules")),
            ("agents", root.join(".agents/rules/project.md")),
        ] {
            if let Ok(content) = tokio::fs::read_to_string(&file).await {
                view = Some(
                    json!({ "content": content, "source": source, "path": file.to_string_lossy() }),
                );
                break;
            }
        }
        let mut view = view.unwrap_or_else(|| {
            if stored.is_empty() {
                json!({ "content": "", "source": "none" })
            } else {
                json!({ "content": stored, "source": "stored" })
            }
        });
        view["sources"] = crate::rules::rule_sources(&root, stored).await.into();
        Ok(view)
    }

    /// Saves a project's rules, and in the file the user chose.
    pub async fn save_project_rules(
        &self,
        id: &str,
        content: &str,
        target_file: Option<&str>,
    ) -> Result<Value, CoreError> {
        let target = self.project_view(id).await?;
        let root = PathBuf::from(text(&target, "path"));
        self.update_project(id, &json!({ "rules": content }))
            .await?;
        let workspace = Workspace::new(&root);
        // A cloned repository can bring a link in the rule file's place.
        let inside = |file: &'static str| {
            let workspace = workspace.clone();
            async move {
                inside_workspace(&workspace, file)
                    .await
                    .map_err(|message| CoreError::new(400, message))
            }
        };
        match target_file {
            Some("cursorrules") => tokio::fs::write(inside(".cursorrules").await?, content).await?,
            Some("agents") => {
                let file = inside(".agents/rules/project.md").await?;
                if let Some(parent) = file.parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }
                tokio::fs::write(file, content).await?;
            }
            _ => {}
        }
        Ok(json!({ "saved": true }))
    }
}

/// True for a path inside a macOS app bundle, such as the packaged runtime's own folder.
fn inside_app_bundle(folder: &Path) -> bool {
    folder
        .components()
        .any(|part| part.as_os_str().to_string_lossy().ends_with(".app"))
}

/// The program that shows a folder or opens a link on this system.
fn file_manager() -> &'static str {
    if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer.exe"
    } else {
        "xdg-open"
    }
}

/// Starts a desktop program detached from the runtime. A program that is not there is logged, not an error.
pub fn launch_app(what: &str, program: &str, args: &[&str], cwd: Option<&Path>) {
    let mut command = std::process::Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    match command.spawn() {
        // Reaped in the background, since nothing waits for a window to close.
        Ok(mut child) => {
            std::thread::spawn(move || child.wait());
        }
        Err(error) => log(
            "projects",
            "warning",
            &format!("Could not launch {what}: {error}"),
        ),
    }
}

/// Opens a terminal window in a folder. On Windows the folder is the program's working directory and never part of a command
/// line, where cmd would read an `&` in the folder's name as a second command.
pub fn launch_terminal(folder: &Path) {
    let shown = folder.to_string_lossy();
    if cfg!(target_os = "macos") {
        launch_app("a terminal", "open", &["-a", "Terminal", &shown], None);
    } else if cfg!(windows) {
        launch_app(
            "a terminal",
            "cmd.exe",
            &["/c", "start", "cmd.exe"],
            Some(folder),
        );
    } else {
        launch_app(
            "a terminal",
            "x-terminal-emulator",
            &["--working-directory", &shown],
            None,
        );
    }
}
