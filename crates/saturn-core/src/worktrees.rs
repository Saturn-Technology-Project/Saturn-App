//! One git worktree per isolated chat: the agent works on its own branch in its own checkout, so several agents can change the
//! same project at once without stepping on each other or on the user's working copy. Finishing a chat merges its branch into
//! the base, keeps it for a pull request, or throws it away.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use saturn_domain::js;
use serde_json::{Value, json};
use tokio::process::Command;

use crate::records::{by_id, by_id_mut, remove, text};
use crate::{CoreError, Kernel, log};

/// Isolated chats open at once per project, so a busy afternoon does not fill the disk with checkouts.
const MAX_WORKTREES: usize = 6;
const GIT_TIMEOUT: Duration = Duration::from_secs(120);

/// Runs git, giving its trimmed output or the last line of what it complained about.
async fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(GIT_TIMEOUT, command.output())
        .await
        .map_err(|_| "timed out".to_owned())?
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        return Ok(js::trim(&String::from_utf8_lossy(&output.stdout)).to_owned());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(js::trim(&stderr).lines().last().unwrap_or("").to_owned())
}

/// The output, or nothing when git failed.
pub(crate) async fn git_or_empty(cwd: &Path, args: &[&str]) -> String {
    run_git(cwd, args).await.unwrap_or_default()
}

/// The output; a failure is refused with what git said.
async fn git_checked(cwd: &Path, args: &[&str]) -> Result<String, CoreError> {
    run_git(cwd, args).await.map_err(|message| {
        CoreError::new(
            409,
            format!("git {} failed: {message}", args.first().unwrap_or(&"")),
        )
    })
}

impl Kernel {
    fn worktrees_dir(&self) -> PathBuf {
        self.store.root().join("worktrees")
    }

    /// The thread's worktree folder, once it has one.
    pub fn worktree_path(&self, thread: &Value) -> Option<PathBuf> {
        thread.get("worktree").filter(|tree| !tree.is_null())?;
        Some(self.worktrees_dir().join(text(thread, "id")))
    }

    fn thread_or_missing(&self, thread_id: &str) -> Result<Value, CoreError> {
        self.find_thread(thread_id)
            .ok_or_else(|| CoreError::new(404, "Chat not found"))
    }

    /// The repository folder that holds a worktree's git data (its common .git), which sandboxed commits must reach.
    pub(crate) async fn git_common_dir(folder: &Path) -> Option<String> {
        Some(
            git_or_empty(
                folder,
                &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            )
            .await,
        )
        .filter(|dir| !dir.is_empty())
    }

    /// Gives the thread its own worktree and branch, cut from the project's current branch.
    pub async fn create_worktree(&self, thread_id: &str) -> Result<Value, CoreError> {
        let thread = self.thread_or_missing(thread_id)?;
        if thread.get("worktree").is_some_and(|tree| !tree.is_null()) {
            return self.worktree_status(thread_id).await;
        }
        let project = text(&thread, "projectId");
        if project.is_empty() {
            return Err(CoreError::new(
                409,
                "Only a chat in a project can work in its own worktree",
            ));
        }
        let root = self.workdir(project)?;
        if git_or_empty(&root, &["rev-parse", "--is-inside-work-tree"]).await != "true" {
            let name = root
                .file_name()
                .map_or_else(String::new, |name| name.to_string_lossy().into_owned());
            return Err(CoreError::new(
                409,
                format!(
                    "{name} is not a git repository, so a chat cannot work on its own branch there"
                ),
            ));
        }
        let open = self.store.read(|state| {
            state
                .threads
                .iter()
                .filter(|item| {
                    text(item, "projectId") == project
                        && item.get("worktree").is_some_and(|tree| !tree.is_null())
                })
                .count()
        });
        if open >= MAX_WORKTREES {
            return Err(CoreError::new(
                409,
                format!(
                    "{open} chats already work in their own worktrees of this project; finish one first"
                ),
            ));
        }
        let mut base = git_or_empty(&root, &["symbolic-ref", "--short", "HEAD"]).await;
        if base.is_empty() {
            base = git_checked(&root, &["rev-parse", "--short", "HEAD"]).await?;
        }
        let branch = format!(
            "saturn/{}",
            thread_id.strip_prefix("thread_").unwrap_or(thread_id)
        );
        let target = self.worktrees_dir().join(thread_id);
        tokio::fs::create_dir_all(self.worktrees_dir()).await?;
        git_checked(
            &root,
            &[
                "worktree",
                "add",
                "-b",
                &branch,
                &target.to_string_lossy(),
                "HEAD",
            ],
        )
        .await?;
        let (saved_branch, saved_base) = (branch.clone(), base);
        self.store
            .update(|state| {
                if let Some(current) = by_id_mut(&mut state.threads, thread_id) {
                    current["worktree"] = json!({ "branch": saved_branch, "base": saved_base });
                }
            })
            .await?;
        log(
            "worktrees",
            "info",
            &format!("Chat {thread_id} works on {branch} in its own worktree"),
        );
        self.worktree_status(thread_id).await
    }

    /// Where a chat's worktree stands against its base.
    /// Commits whatever the chat's worktree has pending (as Saturn) and pushes its branch to origin. Gives whether anything was
    /// committed, and the head. The pull request flow and the CI follow-up both push through here.
    pub(crate) async fn push_worktree(
        &self,
        thread_id: &str,
        message: &str,
    ) -> Result<(bool, String), CoreError> {
        let thread = self.thread_or_missing(thread_id)?;
        let worktree = thread
            .get("worktree")
            .filter(|worktree| worktree.is_object());
        let (Some(worktree), Some(folder)) = (worktree, self.worktree_path(&thread)) else {
            return Err(CoreError::new(
                404,
                "This chat has no worktree branch to push",
            ));
        };
        let dirty = git_or_empty(&folder, &["status", "--porcelain"]).await;
        if !dirty.is_empty() {
            git_checked(&folder, &["add", "-A"]).await?;
            git_checked(
                &folder,
                &[
                    "-c",
                    "user.name=Saturn",
                    "-c",
                    "user.email=saturn@localhost",
                    "commit",
                    "-q",
                    "-m",
                    message,
                ],
            )
            .await?;
        }
        git_checked(&folder, &["push", "-u", "origin", text(worktree, "branch")]).await?;
        let head = git_checked(&folder, &["rev-parse", "HEAD"]).await?;
        Ok((!dirty.is_empty(), head))
    }

    pub async fn worktree_status(&self, thread_id: &str) -> Result<Value, CoreError> {
        let thread = self.thread_or_missing(thread_id)?;
        let folder = self
            .worktree_path(&thread)
            .ok_or_else(|| CoreError::new(404, "This chat has no worktree"))?;
        let tree = &thread["worktree"];
        let base = text(tree, "base");
        let ahead: u64 = git_or_empty(&folder, &["rev-list", "--count", &format!("{base}..HEAD")])
            .await
            .parse()
            .unwrap_or(0);
        let porcelain = git_or_empty(&folder, &["status", "--porcelain"]).await;
        let changed: Vec<String> = porcelain
            .split('\n')
            .filter_map(|line| line.get(3..))
            .map(|file| js::trim(file).to_owned())
            .filter(|file| !file.is_empty())
            .collect();
        let mut files: Vec<String> = Vec::new();
        if ahead > 0 {
            let committed =
                git_or_empty(&folder, &["diff", "--name-only", &format!("{base}...HEAD")]).await;
            files.extend(
                committed
                    .split('\n')
                    .filter(|file| !file.is_empty())
                    .map(str::to_owned),
            );
        }
        for file in &changed {
            if !files.contains(file) {
                files.push(file.clone());
            }
        }
        Ok(json!({
            "threadId": thread_id,
            "path": folder.to_string_lossy(),
            "branch": text(tree, "branch"),
            "base": base,
            "ahead": ahead,
            "dirty": changed.len(),
            "changedFiles": files,
        }))
    }

    /// Ends the chat's isolation. "merge": commits what is uncommitted, merges the branch into the base in the main checkout
    /// (--no-ff), and removes the worktree and branch. "keep": commits and removes the worktree but keeps the branch, for a pull
    /// request. "discard": removes everything.
    pub async fn finish_worktree(
        &self,
        thread_id: &str,
        how: &str,
        message: Option<&str>,
    ) -> Result<Value, CoreError> {
        let thread = self.thread_or_missing(thread_id)?;
        let project = text(&thread, "projectId");
        let folder = self
            .worktree_path(&thread)
            .filter(|_| !project.is_empty())
            .ok_or_else(|| CoreError::new(404, "This chat has no worktree"))?;
        let root = self.workdir(project)?;
        let tree = &thread["worktree"];
        let (branch, base, title) = (
            text(tree, "branch"),
            text(tree, "base"),
            text(&thread, "title"),
        );
        let mut merged = false;
        if how != "discard"
            && !git_or_empty(&folder, &["status", "--porcelain"])
                .await
                .is_empty()
        {
            git_checked(&folder, &["add", "-A"]).await?;
            let chosen = js::trim(message.unwrap_or(""));
            let subject = if chosen.is_empty() {
                format!("Saturn: {title}")
            } else {
                chosen.to_owned()
            };
            git_checked(
                &folder,
                &[
                    "-c",
                    "user.name=Saturn",
                    "-c",
                    "user.email=saturn@localhost",
                    "commit",
                    "-q",
                    "-m",
                    &subject,
                ],
            )
            .await?;
        }
        if how == "merge" {
            if !git_or_empty(&root, &["status", "--porcelain", "--untracked-files=no"])
                .await
                .is_empty()
            {
                return Err(CoreError::new(
                    409,
                    "The project has uncommitted changes; commit or stash them before merging a chat's branch into it",
                ));
            }
            // The merge commit is the user's when git knows who they are; otherwise it is Saturn's, like the branch's commit.
            let known = !git_or_empty(&root, &["config", "user.email"])
                .await
                .is_empty();
            let subject = format!("Merge {branch}: {title}");
            let mut args: Vec<&str> = if known {
                Vec::new()
            } else {
                vec![
                    "-c",
                    "user.name=Saturn",
                    "-c",
                    "user.email=saturn@localhost",
                ]
            };
            args.extend(["merge", "--no-ff", "-m", &subject, branch]);
            if let Err(failure) = run_git(&root, &args).await {
                let conflicts =
                    git_or_empty(&root, &["diff", "--name-only", "--diff-filter=U"]).await;
                let _ = run_git(&root, &["merge", "--abort"]).await;
                if conflicts.is_empty() {
                    return Err(CoreError::new(
                        409,
                        format!("Could not merge {branch} into {base}: {failure}"),
                    ));
                }
                let listed = conflicts.split('\n').collect::<Vec<_>>().join(", ");
                return Err(CoreError::new(
                    409,
                    format!(
                        "Merging {branch} into {base} conflicts in {listed}. Keep the branch and merge it by hand, or discard it."
                    ),
                ));
            }
            merged = true;
        }
        let _ = run_git(
            &root,
            &["worktree", "remove", "--force", &folder.to_string_lossy()],
        )
        .await;
        let _ = tokio::fs::remove_dir_all(&folder).await;
        if how != "keep" {
            let _ = run_git(&root, &["branch", "-D", branch]).await;
        }
        self.store
            .update(|state| {
                if let Some(current) = by_id_mut(&mut state.threads, thread_id) {
                    remove(current, "worktree");
                }
            })
            .await?;
        log(
            "worktrees",
            "info",
            &format!("Chat {thread_id}: {how} {branch}"),
        );
        let mut answer = json!({ "how": how, "branch": branch });
        if how == "merge" {
            answer["merged"] = merged.into();
        }
        Ok(answer)
    }

    /// Worktrees of chats that no longer exist (a crash between steps), removed at startup.
    pub async fn sweep_worktrees(&self) {
        let Ok(mut entries) = tokio::fs::read_dir(self.worktrees_dir()).await else {
            return;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            let live = self.store.read(|state| {
                by_id(&state.threads, &name).is_some_and(|thread| {
                    thread.get("worktree").is_some_and(|tree| !tree.is_null())
                })
            });
            if live || !entry.file_type().await.is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let folder = entry.path();
            let common = git_or_empty(&folder, &["rev-parse", "--git-common-dir"]).await;
            let root = common.strip_suffix("/.git").unwrap_or(&common);
            if !root.is_empty() {
                let _ = run_git(
                    Path::new(root),
                    &["worktree", "remove", "--force", &folder.to_string_lossy()],
                )
                .await;
            }
            match tokio::fs::remove_dir_all(&folder).await {
                Ok(()) => log(
                    "worktrees",
                    "info",
                    &format!("Removed the stale worktree of {name}"),
                ),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => log(
                    "worktrees",
                    "warning",
                    &format!(
                        "Could not remove the stale worktree {}: {error}",
                        folder.display()
                    ),
                ),
            }
        }
    }
}
