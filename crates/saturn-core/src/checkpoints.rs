//! Checkpoints for agent edits in project folders. Before a run first writes a file, its original bytes are stored under
//! `<data>/checkpoints/<runId>/` by sha256 (a missing file is recorded as null), and the run's state lists each file with its
//! before and after hashes. Reverting writes the original bytes back, or deletes a file the run created. The user's git state is
//! never touched.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use saturn_domain::diff::unified_diff;
use saturn_domain::js;
use saturn_domain::skills::workspace::Workspace;
use saturn_domain::time::now_millis;
use saturn_tools::file::{CaptureFuture, FileCheckpoint, inside_workspace};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::process::Command;
use tokio::sync::Mutex as AsyncMutex;

use crate::records::{by_id_mut, remove, text};
use crate::{CoreError, Kernel, locked, log};

/// Files already changed before a shell command, kept so the command's own changes can be undone.
const COMMAND_SNAPSHOT_LIMIT: usize = 2000;
const COMMAND_FILE_LIMIT: u64 = 10 * 1024 * 1024;
/// A folder outside git taking longer than this to snapshot is not tracked (for a while).
const SHADOW_TIMEOUT: Duration = Duration::from_secs(8);
const TOO_BIG_FOR_MS: i64 = 10 * 60_000;
/// Left out of a folder's private snapshots: dependencies, builds, caches.
const SHADOW_EXCLUDES: [&str; 16] = [
    "node_modules/",
    ".venv/",
    "venv/",
    "__pycache__/",
    "dist/",
    "build/",
    "target/",
    ".next/",
    ".nuxt/",
    ".cache/",
    ".turbo/",
    ".gradle/",
    "Pods/",
    "DerivedData/",
    "*.log",
    ".DS_Store",
];
/// Diffs longer than this are cut in API answers; reverting still restores every byte.
const DIFF_LIMIT: usize = 200_000;

/// What a project folder's files were just before a shell command. In a git folder: git's view, plus the bytes of files already
/// changed. Elsewhere: a tree in a private git repository Saturn keeps for that folder in its own data, never in the folder.
#[derive(Clone, Debug)]
pub enum CommandSnapshot {
    Git {
        root: PathBuf,
        prefix: String,
        dirty: BTreeMap<String, Option<String>>,
    },
    Shadow {
        root: PathBuf,
        git_dir: PathBuf,
        tree: String,
    },
}

/// A failed git command; a timeout says so.
#[derive(Debug)]
struct GitFailure {
    timed_out: bool,
    message: String,
}

/// Runs git in `cwd`. GIT_OPTIONAL_LOCKS=0: reading the status must not take the index lock the agent's own git may need.
async fn git(
    cwd: &Path,
    args: &[&str],
    env: &[(&str, &Path)],
    timeout: Option<Duration>,
) -> Result<Vec<u8>, GitFailure> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    for (key, value) in env {
        command.env(key, value);
    }
    let waiting = command.output();
    let output = match timeout {
        Some(limit) => tokio::time::timeout(limit, waiting)
            .await
            .map_err(|_| GitFailure {
                timed_out: true,
                message: "timed out".to_owned(),
            })?,
        None => waiting.await,
    }
    .map_err(|error| GitFailure {
        timed_out: false,
        message: error.to_string(),
    })?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(GitFailure {
            timed_out: false,
            message: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

/// Paths git reports as changed or untracked under `cwd` (ignored files are left out), relative to the repository.
async fn changed_paths(cwd: &Path) -> Result<Vec<String>, GitFailure> {
    let out = git(
        cwd,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--",
            ".",
        ],
        &[],
        None,
    )
    .await?;
    let text = String::from_utf8_lossy(&out);
    let parts: Vec<&str> = text.split('\0').collect();
    let mut paths = Vec::new();
    let mut index = 0;
    while index < parts.len() {
        let entry = parts[index];
        index += 1;
        if entry.len() < 4 {
            continue;
        }
        paths.push(entry[3..].to_owned());
        // A rename or copy is followed by its old path.
        if entry.starts_with(['R', 'C']) {
            paths.push(parts.get(index).copied().unwrap_or("").to_owned());
            index += 1;
        }
    }
    paths.retain(|path| !path.is_empty());
    Ok(paths)
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A file's bytes, or nothing when it is missing or not a file.
async fn read_bytes(target: &Path) -> Option<Vec<u8>> {
    if !tokio::fs::metadata(target).await.ok()?.is_file() {
        return None;
    }
    tokio::fs::read(target).await.ok()
}

/// Forward slashes, as saved paths are written on every platform.
fn saved_path(path: &str) -> String {
    path.replace(std::path::MAIN_SEPARATOR, "/")
}

/// A run's checkpoint hooks, tagging each write with the tool step that makes it.
pub(crate) struct StepCheckpoint {
    pub kernel: Arc<Kernel>,
    pub run_id: String,
    pub workspace: Workspace,
    pub action_id: String,
}

impl StepCheckpoint {
    /// The path as saved in the checkpoint; writes outside the folder are not tracked.
    fn relative(&self, target: &Path) -> Option<String> {
        let resolved = self.workspace.resolve(&target.to_string_lossy()).ok()?;
        if resolved == self.workspace.root() {
            return None;
        }
        Some(saved_path(&self.workspace.relative(&resolved)))
    }
}

impl FileCheckpoint for StepCheckpoint {
    fn before<'a>(&'a self, target: &'a Path) -> CaptureFuture<'a> {
        Box::pin(async move {
            if let Some(file) = self.relative(target) {
                self.kernel
                    .capture_before(&self.run_id, self.workspace.root(), &file, &self.action_id)
                    .await
                    .map_err(std::io::Error::other)?;
            }
            Ok(())
        })
    }

    fn after<'a>(&'a self, target: &'a Path) -> CaptureFuture<'a> {
        Box::pin(async move {
            if let Some(file) = self.relative(target) {
                self.kernel
                    .capture_after(&self.run_id, self.workspace.root(), &file)
                    .await
                    .map_err(std::io::Error::other)?;
            }
            Ok(())
        })
    }
}

/// Sets `root` as the run's checkpoint folder and returns the checkpoint.
fn checkpoint_in<'a>(run: &'a mut Value, root: &str) -> &'a mut Value {
    if run
        .get("checkpoint")
        .is_none_or(|checkpoint| text(checkpoint, "root") != root)
    {
        run["checkpoint"] = json!({ "root": root, "files": [] });
    }
    &mut run["checkpoint"]
}

fn entry_mut<'a>(checkpoint: &'a mut Value, file: &str) -> Option<&'a mut Value> {
    checkpoint
        .get_mut("files")?
        .as_array_mut()?
        .iter_mut()
        .find(|item| text(item, "path") == file)
}

fn push(list: &mut Value, key: &str, item: Value) {
    if !list.get(key).is_some_and(Value::is_array) {
        list[key] = json!([]);
    }
    if let Some(items) = list[key].as_array_mut() {
        items.push(item);
    }
}

impl Kernel {
    fn checkpoint_dir(&self, run_id: &str) -> PathBuf {
        self.store.root().join("checkpoints").join(run_id)
    }

    fn folders_dir(&self) -> PathBuf {
        self.store.root().join("checkpoints").join("folders")
    }

    /// Runs `work` as the run's only capture right now.
    async fn one_at_a_time<R>(&self, run_id: &str, work: impl Future<Output = R>) -> R {
        let lock = {
            let mut locks = locked(&self.checkpoint_locks);
            Arc::clone(
                locks
                    .entry(run_id.to_owned())
                    .or_insert_with(|| Arc::new(AsyncMutex::new(()))),
            )
        };
        let result = {
            let _turn = lock.lock().await;
            work.await
        };
        let mut locks = locked(&self.checkpoint_locks);
        // Two owners left: the table and this call. Nobody else is waiting.
        if locks
            .get(run_id)
            .is_some_and(|held| Arc::strong_count(held) == 2)
        {
            locks.remove(run_id);
        }
        result
    }

    /// Stores bytes by hash (once) and returns the hash; nothing for a missing file.
    async fn save_blob(
        &self,
        run_id: &str,
        bytes: Option<&[u8]>,
    ) -> Result<Option<String>, CoreError> {
        let Some(bytes) = bytes else {
            return Ok(None);
        };
        let hash = sha256(bytes);
        let folder = self.checkpoint_dir(run_id);
        let target = folder.join(&hash);
        if tokio::fs::metadata(&target).await.is_err() {
            tokio::fs::create_dir_all(&folder).await?;
            tokio::fs::write(&target, bytes).await?;
        }
        Ok(Some(hash))
    }

    async fn blob(&self, run_id: &str, hash: Option<&str>) -> Result<Option<Vec<u8>>, CoreError> {
        let Some(hash) = hash else {
            return Ok(None);
        };
        read_bytes(&self.checkpoint_dir(run_id).join(hash))
            .await
            .map(Some)
            .ok_or_else(|| CoreError::new(410, "This checkpoint's saved copy is missing"))
    }

    pub(crate) async fn capture_before(
        &self,
        run_id: &str,
        root: &Path,
        file: &str,
        action_id: &str,
    ) -> Result<(), CoreError> {
        self.one_at_a_time(run_id, async {
            let Some(run) = self.find_run(run_id) else {
                return Ok(());
            };
            let shown = root.to_string_lossy().into_owned();
            let on_disk = read_bytes(&root.join(file)).await;
            let checkpoint = run
                .get("checkpoint")
                .filter(|checkpoint| text(checkpoint, "root") == shown);
            let stepped = checkpoint
                .and_then(|checkpoint| checkpoint.get("steps"))
                .and_then(Value::as_array)
                .is_some_and(|steps| {
                    steps.iter().any(|item| {
                        text(item, "actionId") == action_id && text(item, "path") == file
                    })
                });
            if !stepped {
                // The file as it is just before one tool step writes it, the first time that step does.
                let hash = self.save_blob(run_id, on_disk.as_deref()).await?;
                let place = shown.clone();
                self.store
                    .update(|state| {
                        if let Some(current) = by_id_mut(&mut state.runs, run_id) {
                            let checkpoint = checkpoint_in(current, &place);
                            push(
                                checkpoint,
                                "steps",
                                json!({ "actionId": action_id, "path": file, "hash": hash }),
                            );
                        }
                    })
                    .await?;
            }
            let existing = checkpoint.and_then(|checkpoint| {
                checkpoint
                    .get("files")?
                    .as_array()?
                    .iter()
                    .find(|item| text(item, "path") == file)
                    .cloned()
            });
            if existing
                .as_ref()
                .is_some_and(|entry| text(entry, "review") != "reverted")
            {
                return Ok(());
            }
            // A reverted file is back to its original, so the run's next write starts from the same `before`.
            let hash = match &existing {
                Some(entry) => entry.get("before").cloned().unwrap_or(Value::Null),
                None => json!(self.save_blob(run_id, on_disk.as_deref()).await?),
            };
            self.store
                .update(|state| {
                    if let Some(current) = by_id_mut(&mut state.runs, run_id) {
                        let checkpoint = checkpoint_in(current, &shown);
                        match entry_mut(checkpoint, file) {
                            Some(entry) => remove(entry, "review"),
                            None => push(
                                checkpoint,
                                "files",
                                json!({ "path": file, "before": hash, "after": hash }),
                            ),
                        }
                    }
                })
                .await?;
            Ok(())
        })
        .await
    }

    pub(crate) async fn capture_after(
        &self,
        run_id: &str,
        root: &Path,
        file: &str,
    ) -> Result<(), CoreError> {
        self.one_at_a_time(run_id, async {
            let shown = root.to_string_lossy().into_owned();
            let known = self.find_run(run_id).and_then(|run| {
                let checkpoint = run.get("checkpoint")?;
                (text(checkpoint, "root") == shown
                    && checkpoint
                        .get("files")?
                        .as_array()?
                        .iter()
                        .any(|item| text(item, "path") == file))
                .then_some(())
            });
            if known.is_none() {
                return Ok(());
            }
            let hash = self
                .save_blob(run_id, read_bytes(&root.join(file)).await.as_deref())
                .await?;
            self.store
                .update(|state| {
                    if let Some(entry) = by_id_mut(&mut state.runs, run_id)
                        .and_then(|run| run.get_mut("checkpoint"))
                        .and_then(|checkpoint| entry_mut(checkpoint, file))
                    {
                        entry["after"] = json!(hash);
                    }
                })
                .await?;
            Ok(())
        })
        .await
    }

    /// Before a shell command in `root`: when it is a git folder, the files already changed there, with their bytes. Nothing
    /// (nothing tracked) when too many files are already changed to keep a copy of.
    pub(crate) async fn before_command(
        &self,
        run_id: &str,
        root: &Path,
    ) -> Option<CommandSnapshot> {
        let Ok(prefix) = git(root, &["rev-parse", "--show-prefix"], &[], None).await else {
            return self.shadow_snapshot(root).await;
        };
        let prefix = js::trim(&String::from_utf8_lossy(&prefix)).to_owned();
        let dirty = changed_paths(root).await.ok()?;
        if dirty.len() > COMMAND_SNAPSHOT_LIMIT {
            log(
                "agent",
                "info",
                &format!(
                    "Shell changes in {} are not tracked for this command: {} files were already changed",
                    root.display(),
                    dirty.len()
                ),
            );
            return None;
        }
        let mut kept = BTreeMap::new();
        for file in dirty {
            let bytes =
                read_bytes(&root.join(file.strip_prefix(prefix.as_str()).unwrap_or(&file))).await;
            if bytes
                .as_ref()
                .is_some_and(|bytes| bytes.len() as u64 > COMMAND_FILE_LIMIT)
            {
                continue;
            }
            kept.insert(file, self.save_blob(run_id, bytes.as_deref()).await.ok()?);
        }
        Some(CommandSnapshot::Git {
            root: root.to_path_buf(),
            prefix,
            dirty: kept,
        })
    }

    /// After a shell command: every file it added, changed or deleted joins the run's checkpoint like a files-tool write, with
    /// the original from the snapshot (a file changed before) or from git (a file that was clean).
    pub(crate) async fn after_command(
        &self,
        run_id: &str,
        snapshot: &CommandSnapshot,
        action_id: &str,
    ) -> Result<(), CoreError> {
        let (root, prefix, dirty) = match snapshot {
            CommandSnapshot::Shadow {
                root,
                git_dir,
                tree,
            } => {
                return self
                    .after_shadow(run_id, root, git_dir, tree, action_id)
                    .await;
            }
            CommandSnapshot::Git {
                root,
                prefix,
                dirty,
            } => (root, prefix, dirty),
        };
        let Ok(now) = changed_paths(root).await else {
            return Ok(());
        };
        let mut candidates: Vec<String> = dirty.keys().cloned().collect();
        let mut seen: HashSet<String> = candidates.iter().cloned().collect();
        candidates.extend(now.into_iter().filter(|file| seen.insert(file.clone())));
        for file in candidates {
            let Some(relative) = file.strip_prefix(prefix.as_str()) else {
                continue;
            };
            let current = read_bytes(&root.join(relative)).await;
            if current
                .as_ref()
                .is_some_and(|bytes| bytes.len() as u64 > COMMAND_FILE_LIMIT)
            {
                continue;
            }
            let before = match dirty.get(&file) {
                Some(hash) => hash.clone(),
                None => {
                    // Clean before the command: the working copy matched git's index.
                    let original = git(root, &["show", &format!(":{file}")], &[], None)
                        .await
                        .ok();
                    self.save_blob(run_id, original.as_deref()).await?
                }
            };
            let after = self.save_blob(run_id, current.as_deref()).await?;
            self.record_change(
                run_id,
                root,
                &saved_path(relative),
                before,
                after,
                action_id,
            )
            .await?;
        }
        Ok(())
    }

    /// A private git repository for a folder outside git, in Saturn's data; its index makes repeat snapshots fast.
    async fn shadow_snapshot(&self, root: &Path) -> Option<CommandSnapshot> {
        if locked(&self.too_big)
            .get(root)
            .is_some_and(|until| *until > now_millis())
        {
            return None;
        }
        let name = sha256(root.to_string_lossy().as_bytes());
        let git_dir = self.folders_dir().join(&name[..16]);
        match self.open_shadow(root, &git_dir).await {
            Ok(tree) => Some(CommandSnapshot::Shadow {
                root: root.to_path_buf(),
                git_dir,
                tree,
            }),
            Err(failure) => {
                locked(&self.too_big).insert(root.to_path_buf(), now_millis() + TOO_BIG_FOR_MS);
                let why = if failure.timed_out {
                    "the folder is too big to snapshot quickly"
                } else {
                    &failure.message
                };
                log(
                    "agent",
                    "info",
                    &format!(
                        "Shell changes in {} are not tracked for now: {why}",
                        root.display()
                    ),
                );
                None
            }
        }
    }

    async fn open_shadow(&self, root: &Path, git_dir: &Path) -> Result<String, GitFailure> {
        if read_bytes(&git_dir.join("HEAD")).await.is_none() {
            let failed = |error: std::io::Error| GitFailure {
                timed_out: false,
                message: error.to_string(),
            };
            tokio::fs::create_dir_all(git_dir).await.map_err(failed)?;
            let place = git_dir.to_string_lossy();
            git(root, &["--git-dir", &place, "init", "-q"], &[], None).await?;
            tokio::fs::create_dir_all(git_dir.join("info"))
                .await
                .map_err(failed)?;
            tokio::fs::write(
                git_dir.join("info/exclude"),
                format!("{}\n", SHADOW_EXCLUDES.join("\n")),
            )
            .await
            .map_err(failed)?;
            // Which folder this is, for Settings → Storage.
            tokio::fs::write(
                git_dir.join("saturn-folder"),
                root.to_string_lossy().as_bytes(),
            )
            .await
            .map_err(failed)?;
        }
        shadow_tree(root, git_dir).await
    }

    async fn after_shadow(
        &self,
        run_id: &str,
        root: &Path,
        git_dir: &Path,
        before_tree: &str,
        action_id: &str,
    ) -> Result<(), CoreError> {
        let Ok(tree) = shadow_tree(root, git_dir).await else {
            return Ok(());
        };
        if tree == before_tree {
            return Ok(());
        }
        let env = [("GIT_DIR", git_dir)];
        let Ok(names) = git(
            root,
            &[
                "diff-tree",
                "-r",
                "-z",
                "--no-renames",
                "--name-only",
                before_tree,
                &tree,
            ],
            &env,
            None,
        )
        .await
        else {
            return Ok(());
        };
        let names = String::from_utf8_lossy(&names).into_owned();
        for file in names.split('\0').filter(|name| !name.is_empty()) {
            let original = git(
                root,
                &["cat-file", "blob", &format!("{before_tree}:{file}")],
                &env,
                None,
            )
            .await
            .ok();
            let current = read_bytes(&root.join(file)).await;
            let too_long = |bytes: &Option<Vec<u8>>| {
                bytes
                    .as_ref()
                    .is_some_and(|bytes| bytes.len() as u64 > COMMAND_FILE_LIMIT)
            };
            if too_long(&original) || too_long(&current) {
                continue;
            }
            let before = self.save_blob(run_id, original.as_deref()).await?;
            let after = self.save_blob(run_id, current.as_deref()).await?;
            self.record_change(run_id, root, file, before, after, action_id)
                .await?;
        }
        Ok(())
    }

    /// A change made outside the files tool: the run's first original of the file is kept, its latest state recorded.
    async fn record_change(
        &self,
        run_id: &str,
        root: &Path,
        file: &str,
        before: Option<String>,
        after: Option<String>,
        action_id: &str,
    ) -> Result<(), CoreError> {
        let shown = root.to_string_lossy().into_owned();
        self.one_at_a_time(run_id, async {
            self.store
                .update(|state| {
                    let Some(current) = by_id_mut(&mut state.runs, run_id) else {
                        return;
                    };
                    let known = current.get("checkpoint").is_some_and(|checkpoint| {
                        text(checkpoint, "root") == shown
                            && checkpoint
                                .get("files")
                                .and_then(Value::as_array)
                                .is_some_and(|files| {
                                    files.iter().any(|item| text(item, "path") == file)
                                })
                    });
                    // Unchanged and not seen before: nothing to record. (Seen before: it may have been changed back.)
                    if before == after && !known {
                        return;
                    }
                    let checkpoint = checkpoint_in(current, &shown);
                    let stepped = checkpoint
                        .get("steps")
                        .and_then(Value::as_array)
                        .is_some_and(|steps| {
                            steps.iter().any(|item| {
                                text(item, "actionId") == action_id && text(item, "path") == file
                            })
                        });
                    if !stepped {
                        push(
                            checkpoint,
                            "steps",
                            json!({ "actionId": action_id, "path": file, "hash": before }),
                        );
                    }
                    match entry_mut(checkpoint, file) {
                        Some(entry) => {
                            // A reverted file was back to its original, so this change starts from that same original.
                            remove(entry, "review");
                            entry["after"] = json!(after);
                        }
                        None => push(
                            checkpoint,
                            "files",
                            json!({ "path": file, "before": before, "after": after }),
                        ),
                    }
                })
                .await?;
            Ok(())
        })
        .await
    }

    async fn change_view(
        &self,
        run_id: &str,
        root: &str,
        entry: &Value,
    ) -> Result<Value, CoreError> {
        let path = text(entry, "path");
        let before_hash = entry.get("before").and_then(Value::as_str);
        let after_hash = entry.get("after").and_then(Value::as_str);
        let before = self.blob(run_id, before_hash).await?;
        let after = self.blob(run_id, after_hash).await?;
        let result = unified_diff(path, before.as_deref(), after.as_deref(), 3);
        let current = read_bytes(&Path::new(root).join(path))
            .await
            .map(|bytes| sha256(&bytes));
        let review = match text(entry, "review") {
            "" => "pending",
            other => other,
        };
        let truncated = js::length(&result.diff) > DIFF_LIMIT;
        let expected = if review == "reverted" {
            before_hash
        } else {
            after_hash
        };
        Ok(json!({
            "path": path,
            "status": if before_hash.is_none() { "added" } else if after_hash.is_none() { "deleted" } else { "modified" },
            "before": before_hash,
            "after": after_hash,
            "additions": result.additions,
            "deletions": result.deletions,
            "binary": result.binary,
            "diff": if truncated { js::prefix(&result.diff, DIFF_LIMIT) } else { &result.diff },
            "truncated": truncated,
            "review": review,
            "modifiedSince": current.as_deref() != expected,
        }))
    }

    /// The run's changed files with a unified diff each; files it wrote back unchanged are left out.
    pub async fn run_changes(&self, run_id: &str) -> Result<Value, CoreError> {
        let run = self.get_run(run_id)?;
        let Some(checkpoint) = run.get("checkpoint") else {
            return Ok(json!({ "runId": run_id, "root": null, "files": [] }));
        };
        let root = text(checkpoint, "root");
        let mut files = Vec::new();
        for entry in checkpoint
            .get("files")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if entry.get("before") != entry.get("after") {
                files.push(self.change_view(run_id, root, entry).await?);
            }
        }
        Ok(json!({ "runId": run_id, "root": root, "files": files }))
    }

    /// One changed file's text before or after the run, for the editor's diff view.
    pub async fn change_content(
        &self,
        run_id: &str,
        file: &str,
        before: bool,
    ) -> Result<Value, CoreError> {
        let run = self.get_run(run_id)?;
        let entry = run
            .get("checkpoint")
            .and_then(|checkpoint| checkpoint.get("files"))
            .and_then(Value::as_array)
            .and_then(|files| files.iter().find(|item| text(item, "path") == file))
            .ok_or_else(|| CoreError::new(404, "That file is not among this run's changes"))?;
        let hash = entry
            .get(if before { "before" } else { "after" })
            .and_then(Value::as_str);
        let Some(bytes) = self.blob(run_id, hash).await? else {
            return Ok(json!({ "path": file, "content": "", "exists": false, "binary": false }));
        };
        let binary = bytes.contains(&0);
        let content = if binary {
            String::new()
        } else {
            String::from_utf8_lossy(&bytes).into_owned()
        };
        Ok(json!({ "path": file, "content": content, "exists": true, "binary": binary }))
    }

    /// Puts bytes back in the folder, or deletes the file when there were none. A symbolic link put there since (a command can
    /// make one) is not followed out of the folder.
    async fn put_back(
        workspace: &Workspace,
        file: &str,
        bytes: Option<Vec<u8>>,
    ) -> Result<(), CoreError> {
        let target = inside_workspace(workspace, file)
            .await
            .map_err(|message| CoreError::new(400, message))?;
        match bytes {
            Some(bytes) => {
                if let Some(parent) = target.parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }
                tokio::fs::write(&target, bytes).await?;
            }
            None => match tokio::fs::remove_file(&target).await {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(error.into());
                }
                _ => {}
            },
        }
        Ok(())
    }

    /// Puts back the original bytes of one file, or of every file the run changed; files the run created are deleted.
    pub async fn revert_run(&self, run_id: &str, file: Option<&str>) -> Result<Value, CoreError> {
        let run = self.get_run(run_id)?;
        assert_idle(&run)?;
        let checkpoint = run.get("checkpoint");
        let files = checkpoint
            .and_then(|checkpoint| checkpoint.get("files"))
            .and_then(Value::as_array);
        if let Some(file) = file
            && !files.is_some_and(|files| files.iter().any(|item| text(item, "path") == file))
        {
            return Err(CoreError::new(404, "This run did not change that file"));
        }
        if let (Some(checkpoint), Some(files)) = (checkpoint, files) {
            self.one_at_a_time(run_id, async {
                let workspace = Workspace::new(text(checkpoint, "root"));
                let mut reverted: Vec<String> = Vec::new();
                for entry in files {
                    let path = text(entry, "path");
                    if file.is_some_and(|only| only != path) || text(entry, "review") == "reverted"
                    {
                        continue;
                    }
                    let original = self
                        .blob(run_id, entry.get("before").and_then(Value::as_str))
                        .await?;
                    Self::put_back(&workspace, path, original).await?;
                    reverted.push(path.to_owned());
                }
                self.store
                    .update(|state| {
                        let entries = by_id_mut(&mut state.runs, run_id)
                            .and_then(|run| run.get_mut("checkpoint"))
                            .and_then(|checkpoint| checkpoint.get_mut("files"))
                            .and_then(Value::as_array_mut);
                        for entry in entries.into_iter().flatten() {
                            if reverted.iter().any(|path| path == text(entry, "path")) {
                                entry["review"] = "reverted".into();
                            }
                        }
                    })
                    .await?;
                Ok::<(), CoreError>(())
            })
            .await?;
        }
        self.run_changes(run_id).await
    }

    /// The user accepted the run's edits: the card stops offering to revert them (the checkpoint stays).
    pub async fn keep_run(&self, run_id: &str, file: Option<&str>) -> Result<Value, CoreError> {
        let run = self.get_run(run_id)?;
        if let Some(file) = file {
            let known = run
                .get("checkpoint")
                .and_then(|checkpoint| checkpoint.get("files"))
                .and_then(Value::as_array)
                .is_some_and(|files| files.iter().any(|item| text(item, "path") == file));
            if !known {
                return Err(CoreError::new(404, "This run did not change that file"));
            }
        }
        self.store
            .update(|state| {
                let entries = by_id_mut(&mut state.runs, run_id)
                    .and_then(|run| run.get_mut("checkpoint"))
                    .and_then(|checkpoint| checkpoint.get_mut("files"))
                    .and_then(Value::as_array_mut);
                for entry in entries.into_iter().flatten() {
                    if file.is_some_and(|only| only != text(entry, "path")) {
                        continue;
                    }
                    if text(entry, "review") != "reverted" {
                        entry["review"] = "kept".into();
                    }
                }
            })
            .await?;
        self.run_changes(run_id).await
    }

    /// Runs of the same chat from `upto` (exclusive) back to the newest, newest first.
    fn later_turns(&self, run: &Value, inclusive: bool) -> Vec<Value> {
        let thread = text(run, "threadId");
        let agent = text(run, "agentId");
        self.store.read(|state| {
            let index = state
                .runs
                .iter()
                .position(|item| text(item, "id") == text(run, "id"))
                .unwrap_or(0);
            let end = if inclusive { index + 1 } else { index };
            state.runs[..end]
                .iter()
                .filter(|item| {
                    text(item, "agentId") == agent
                        && if thread.is_empty() {
                            text(item, "threadId").is_empty() && text(item, "groupId").is_empty()
                        } else {
                            text(item, "threadId") == thread
                        }
                })
                .cloned()
                .collect()
        })
    }

    /// Reverts whole turns, newest first, noting which reverted something and which files.
    async fn revert_turns(
        &self,
        turns: &[Value],
        reverted: &mut Vec<String>,
        files: &mut Vec<String>,
    ) -> Result<(), CoreError> {
        for turn in turns {
            let pending: Vec<String> = turn
                .get("checkpoint")
                .and_then(|checkpoint| checkpoint.get("files"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|item| {
                    text(item, "review") != "reverted" && item.get("before") != item.get("after")
                })
                .map(|item| text(item, "path").to_owned())
                .collect();
            self.revert_run(text(turn, "id"), None).await?;
            if !pending.is_empty() {
                reverted.push(text(turn, "id").to_owned());
                for file in pending {
                    if !files.contains(&file) {
                        files.push(file);
                    }
                }
            }
        }
        Ok(())
    }

    /// Restores the chat's files to how they were before this turn: reverts this run and every later run in the chat, newest
    /// first, so each file ends at the oldest original. Messages are left as they are.
    pub async fn restore_to(&self, run_id: &str) -> Result<Value, CoreError> {
        let run = self.get_run(run_id)?;
        let turns = self.later_turns(&run, true);
        for turn in &turns {
            assert_idle(turn)?;
        }
        let (mut reverted, mut files) = (Vec::new(), Vec::new());
        self.revert_turns(&turns, &mut reverted, &mut files).await?;
        Ok(json!({ "reverted": reverted, "files": files }))
    }

    /// Puts the chat's files back to how they were just before one tool step of a run: later turns are reverted whole, then
    /// each file this run's step or a later step of it wrote gets the bytes it had before the first of those writes.
    pub async fn restore_to_step(&self, run_id: &str, action_id: &str) -> Result<Value, CoreError> {
        let run = self.get_run(run_id)?;
        let actions = run
            .get("actions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let position = actions
            .iter()
            .position(|item| text(item, "id") == action_id)
            .ok_or_else(|| CoreError::new(404, "That step is not part of this run"))?;
        let later = self.later_turns(&run, false);
        assert_idle(&run)?;
        for turn in &later {
            assert_idle(turn)?;
        }
        let (mut reverted, mut files) = (Vec::new(), Vec::new());
        self.revert_turns(&later, &mut reverted, &mut files).await?;
        let order: HashMap<&str, usize> = actions
            .iter()
            .enumerate()
            .map(|(at, item)| (text(item, "id"), at))
            .collect();
        let checkpoint = run.get("checkpoint");
        let steps = checkpoint
            .and_then(|checkpoint| checkpoint.get("steps"))
            .and_then(Value::as_array);
        if let (Some(checkpoint), Some(steps)) =
            (checkpoint, steps.filter(|steps| !steps.is_empty()))
        {
            let mut restore: BTreeMap<String, Option<String>> = BTreeMap::new();
            for step in steps {
                if order
                    .get(text(step, "actionId"))
                    .is_some_and(|at| *at >= position)
                {
                    restore
                        .entry(text(step, "path").to_owned())
                        .or_insert_with(|| {
                            step.get("hash").and_then(Value::as_str).map(str::to_owned)
                        });
                }
            }
            self.one_at_a_time(run_id, async {
                let workspace = Workspace::new(text(checkpoint, "root"));
                for (file, hash) in &restore {
                    let bytes = self.blob(run_id, hash.as_deref()).await?;
                    Self::put_back(&workspace, file, bytes).await?;
                    if !files.contains(file) {
                        files.push(file.clone());
                    }
                }
                self.store
                    .update(|state| {
                        let Some(current) = by_id_mut(&mut state.runs, run_id)
                            .and_then(|run| run.get_mut("checkpoint"))
                        else {
                            return;
                        };
                        for entry in current
                            .get_mut("files")
                            .and_then(Value::as_array_mut)
                            .into_iter()
                            .flatten()
                        {
                            let Some(hash) = restore.get(text(entry, "path")) else {
                                continue;
                            };
                            entry["after"] = json!(hash);
                            if entry.get("after") == entry.get("before") {
                                entry["review"] = "reverted".into();
                            } else {
                                remove(entry, "review");
                            }
                        }
                        if let Some(steps) = current.get_mut("steps").and_then(Value::as_array_mut)
                        {
                            steps.retain(|step| {
                                order
                                    .get(text(step, "actionId"))
                                    .is_none_or(|at| *at < position)
                            });
                        }
                    })
                    .await?;
                Ok::<(), CoreError>(())
            })
            .await?;
            if !restore.is_empty() && !reverted.iter().any(|id| id == run_id) {
                reverted.push(run_id.to_owned());
            }
        }
        Ok(json!({ "reverted": reverted, "files": files }))
    }

    /// Drops the saved originals of runs that no longer exist.
    pub(crate) async fn forget_checkpoints(&self, run_ids: &[String]) {
        for id in run_ids {
            let _ = tokio::fs::remove_dir_all(self.checkpoint_dir(id)).await;
        }
    }
}

/// A tree of what a folder holds now, written to its private repository.
async fn shadow_tree(root: &Path, git_dir: &Path) -> Result<String, GitFailure> {
    let env = [("GIT_DIR", git_dir), ("GIT_WORK_TREE", root)];
    let add = [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.quotepath=false",
        "add",
        "-A",
        "--ignore-errors",
        "--",
        ".",
    ];
    // --ignore-errors still exits 1 when a file could not be read; only a timeout means the snapshot failed.
    if let Err(failure) = git(root, &add, &env, Some(SHADOW_TIMEOUT)).await
        && failure.timed_out
    {
        return Err(failure);
    }
    let tree = git(root, &["write-tree"], &env, Some(SHADOW_TIMEOUT)).await?;
    Ok(js::trim(&String::from_utf8_lossy(&tree)).to_owned())
}

fn assert_idle(run: &Value) -> Result<(), CoreError> {
    if matches!(
        text(run, "status"),
        "running" | "queued" | "waiting_approval"
    ) {
        return Err(CoreError::new(
            409,
            "Wait for the run to finish (or stop it) before reverting its changes",
        ));
    }
    Ok(())
}
