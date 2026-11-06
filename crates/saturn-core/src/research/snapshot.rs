//! A run's own copy of what its version froze, made before the run starts and checked file by file, so editing the
//! project while it runs changes nothing it reads. What could not be fixed is listed as uncontrolled rather than
//! passed off as part of the version.
use std::path::{Path, PathBuf};

use saturn_domain::research::sha256_hex;
use saturn_domain::time::{iso_time, now_millis};
use serde_json::{Value, json};

use super::freeze::hash_file;
use crate::records::text;
use crate::worktrees::run_git;
use crate::{CoreError, Kernel};

/// Where runs' snapshots are made, in Saturn's own data folder.
const SNAPSHOTS: &str = "run-snapshots";
/// A data file larger than this is linked rather than copied where copying is not copy-on-write; it is then checked
/// before and after the run instead of being fixed.
#[cfg(not(target_os = "macos"))]
const LINK_ABOVE: u64 = 1024 * 1024 * 1024;
/// What a snapshot's files are protected by while the run reads them.
pub(super) const ISOLATION: &str = "read-only permissions";

/// A run's snapshot: the tree the command runs in, and what was observed while making it.
pub(super) struct Snapshot {
    pub tree: PathBuf,
    pub observed: Value,
}

/// One file the snapshot holds, how it got there, and whether it matched the version.
fn entry(path: &str, role: &str, sha256: &str, size: u64, how: &str) -> Value {
    json!({ "path": path, "role": role, "sha256": sha256, "size": size, "how": how })
}

/// Every regular file under a folder, by path relative to it, not following links.
pub(super) fn files_in(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut pending = vec![PathBuf::new()];
    while let Some(relative) = pending.pop() {
        let Ok(reading) = std::fs::read_dir(root.join(&relative)) else {
            continue;
        };
        for item in reading.flatten() {
            let Ok(kind) = item.file_type() else { continue };
            let path = relative.join(item.file_name());
            if kind.is_dir() {
                pending.push(path);
            } else if kind.is_file() {
                found.push(path.to_string_lossy().into_owned());
            }
        }
    }
    found.sort();
    found
}

/// Copies a file, copy-on-write where the file system can (APFS, Btrfs, XFS), and creates its folders.
fn copy_into(from: &Path, to: &Path) -> std::io::Result<()> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let _ = std::fs::remove_file(to);
    std::fs::copy(from, to).map(|_| ())
}

/// Whether a file of this size is linked instead of copied on this system.
fn links(size: u64) -> bool {
    #[cfg(target_os = "macos")]
    {
        let _ = size;
        false
    }
    #[cfg(not(target_os = "macos"))]
    {
        size > LINK_ABOVE
    }
}

/// Makes the snapshot's files read-only; its folders stay writable, so a program can still write new files there.
fn protect(tree: &Path, files: &[String]) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for file in files {
            let _ =
                std::fs::set_permissions(tree.join(file), std::fs::Permissions::from_mode(0o444));
        }
    }
    #[cfg(not(unix))]
    let _ = (tree, files);
}

impl Kernel {
    /// The folder a run's snapshot is made in.
    pub(super) fn snapshot_folder(&self, run: &str) -> PathBuf {
        self.store.root().join(SNAPSHOTS).join(run)
    }

    /// Makes the run's snapshot from the version: the commit's files from git itself, the uncommitted changes from
    /// their saved copies, and the declared inputs, each checked against the hash the version recorded. Any difference
    /// refuses the run, naming the files.
    pub(super) async fn prepare_snapshot(
        &self,
        records: &Path,
        source: &Path,
        version: &Value,
        run: &str,
    ) -> Result<Snapshot, CoreError> {
        let folder = self.snapshot_folder(run);
        let tree = folder.join("tree");
        let _ = tokio::fs::remove_dir_all(&folder).await;
        tokio::fs::create_dir_all(&tree).await?;
        let made = fill(
            Some(&records.join("objects")),
            source,
            version,
            &folder,
            &tree,
            "Freeze a new version to run them.",
        )
        .await;
        match made {
            Ok(observed) => Ok(Snapshot { tree, observed }),
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&folder).await;
                Err(error)
            }
        }
    }

    /// After the run: checks the snapshot against what it was given, keeps what the program wrote, and removes it.
    pub(super) async fn close_snapshot(
        &self,
        run: &str,
        directory: &Path,
        observed: &Value,
        source: &Path,
        remove: bool,
    ) -> Value {
        close(
            &self.snapshot_folder(run),
            &directory.join("written"),
            observed,
            source,
            remove,
        )
        .await
    }
}

/// Whether a path from a record stays inside the folder it is joined to: relative, with no `..` and no root.
fn plain_path(path: &str) -> bool {
    !path.is_empty()
        && Path::new(path).components().all(|part| {
            matches!(
                part,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
}

/// Builds a snapshot in `tree` from what `expected` names (a version, or the part of one sent to a remote host): the
/// commit from `source`'s git, uncommitted files from `saved` copies when there are any or else from `source`, and
/// the declared inputs from `source`. Every file is checked against its recorded hash; any difference is an error
/// that names the files, and `hint` says what to do about it.
pub(super) async fn fill(
    saved: Option<&Path>,
    source: &Path,
    expected: &Value,
    folder: &Path,
    tree: &Path,
    hint: &str,
) -> Result<Value, CoreError> {
    let version = expected;
    {
        let mut inputs: Vec<Value> = Vec::new();
        let mut differences: Vec<String> = Vec::new();
        for item in ["changedFiles", "inputs"].iter().flat_map(|field| {
            version
                .get(*field)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        }) {
            if !plain_path(text(&item, "path")) {
                return Err(CoreError::new(
                    422,
                    format!(
                        "The version names a file outside its folder: {}",
                        text(&item, "path")
                    ),
                ));
            }
        }

        // The committed files come from git's own objects, not from the folder, which may have changed since.
        if let Some(commit) = version.pointer("/git/commit").and_then(Value::as_str) {
            let prefix = run_git(source, &["rev-parse", "--show-prefix"])
                .await
                .unwrap_or_default();
            let prefix = prefix.trim();
            let spec = if prefix.is_empty() {
                commit.to_owned()
            } else {
                format!("{commit}:{prefix}")
            };
            let archive = folder.join("commit.tar");
            let archive_path = archive.to_string_lossy().into_owned();
            run_git(
                source,
                &["archive", "--format=tar", "-o", &archive_path, &spec],
            )
            .await
            .map_err(|message| {
                CoreError::new(
                    409,
                    format!("The version's commit could not be read from git: {message}"),
                )
            })?;
            let unpacked = tokio::process::Command::new("tar")
                .args(["-xf", &archive_path, "-C"])
                .arg(tree)
                .output()
                .await?;
            let _ = tokio::fs::remove_file(&archive).await;
            if !unpacked.status.success() {
                return Err(CoreError::new(
                    500,
                    "The version's commit could not be unpacked.",
                ));
            }
        }

        // What differed from the commit when the version was frozen.
        for item in version
            .get("changedFiles")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let path = text(item, "path");
            let target = tree.join(path);
            match text(item, "state") {
                "deleted" => {
                    let _ = tokio::fs::remove_file(&target).await;
                }
                "link" => {
                    let link = tokio::fs::read_link(source.join(path)).await;
                    let matches = link.as_ref().is_ok_and(|to| {
                        item.get("sha256").and_then(Value::as_str)
                            == Some(sha256_hex(to.to_string_lossy().as_bytes()).as_str())
                    });
                    if !matches {
                        differences.push(format!("{path} (a link that points elsewhere now)"));
                        continue;
                    }
                    if let (Ok(to), Some(parent)) = (link, target.parent()) {
                        tokio::fs::create_dir_all(parent).await?;
                        let _ = tokio::fs::remove_file(&target).await;
                        #[cfg(unix)]
                        tokio::fs::symlink(&to, &target).await?;
                    }
                }
                _ => {
                    let expected = text(item, "sha256");
                    let copy = saved.filter(|_| item["saved"] == true);
                    let saved = copy.is_some();
                    let from = if let Some(objects) = copy {
                        objects.join(expected)
                    } else {
                        source.join(path)
                    };
                    let to = target.clone();
                    tokio::task::spawn_blocking(move || copy_into(&from, &to))
                        .await
                        .map_err(|error| CoreError::new(500, error.to_string()))??;
                    let (sha256, size) = hash_file(&target).await?;
                    if sha256 != expected {
                        differences.push(format!(
                            "{path} (expected {}…, found {}…)",
                            expected.get(..12).unwrap_or(expected),
                            &sha256[..12]
                        ));
                    }
                    inputs.push(entry(
                        path,
                        "uncommitted",
                        &sha256,
                        size,
                        if saved { "saved copy" } else { "copied" },
                    ));
                }
            }
        }

        // Every declared input, which may be ignored by git and so not in the commit.
        for item in version
            .get("inputs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (path, role, expected) =
                (text(item, "path"), text(item, "role"), text(item, "sha256"));
            let target = tree.join(path);
            // An uncommitted file already placed keeps how it got there.
            let placed = inputs
                .iter()
                .find(|known| text(known, "path") == path)
                .map(|known| text(known, "how").to_owned());
            let how = if let Some(placed) = placed.as_deref() {
                match placed {
                    "saved copy" => "saved copy",
                    _ => "copied",
                }
            } else if tokio::fs::try_exists(&target).await? {
                "from the commit"
            } else {
                let from = source.join(path);
                let size = tokio::fs::metadata(&from)
                    .await
                    .map(|info| info.len())
                    .unwrap_or(0);
                if links(size) {
                    if let Some(parent) = target.parent() {
                        tokio::fs::create_dir_all(parent).await?;
                    }
                    #[cfg(unix)]
                    tokio::fs::symlink(&from, &target).await?;
                    "linked"
                } else {
                    let to = target.clone();
                    tokio::task::spawn_blocking(move || copy_into(&from, &to))
                        .await
                        .map_err(|error| CoreError::new(500, error.to_string()))??;
                    "copied"
                }
            };
            let (sha256, size) = hash_file(&target).await.unwrap_or_default();
            if sha256 != expected {
                differences.push(format!(
                    "{path}, the {role} input (expected {}…, found {})",
                    expected.get(..12).unwrap_or(expected),
                    if sha256.is_empty() {
                        "nothing".to_owned()
                    } else {
                        format!("{}…", &sha256[..12])
                    }
                ));
            }
            inputs.retain(|known| text(known, "path") != path);
            inputs.push(entry(path, role, &sha256, size, how));
        }

        if !differences.is_empty() {
            return Err(CoreError::new(
                409,
                format!(
                    "This run was not started: these files differ from version {} — {}. {hint}",
                    version["number"],
                    differences.join("; ")
                ),
            ));
        }

        // What the project has beside the version, such as an environment folder git ignores, stays reachable by the
        // same path but is not part of the version: it is listed as uncontrolled.
        let mut uncontrolled = Vec::new();
        let mut reading = tokio::fs::read_dir(source).await?;
        while let Some(item) = reading.next_entry().await? {
            let name = item.file_name().to_string_lossy().into_owned();
            if name == ".git"
                || name == ".saturn"
                || tokio::fs::symlink_metadata(tree.join(&name)).await.is_ok()
            {
                continue;
            }
            #[cfg(unix)]
            tokio::fs::symlink(item.path(), tree.join(&name)).await?;
            let kind = if item.file_type().await?.is_dir() {
                "folder"
            } else {
                "file"
            };
            uncontrolled.push(json!({ "path": name, "kind": kind }));
        }
        uncontrolled.sort_by(|left, right| text(left, "path").cmp(text(right, "path")));

        // Every file the run is given, by hash: what it read is checked against this when it ends.
        let listed = {
            let tree = tree.to_path_buf();
            tokio::task::spawn_blocking(move || files_in(&tree))
                .await
                .map_err(|error| CoreError::new(500, error.to_string()))?
        };
        let mut files = Vec::with_capacity(listed.len());
        for path in &listed {
            let (sha256, size) = hash_file(&tree.join(path)).await?;
            files.push(json!({ "path": path, "sha256": sha256, "size": size }));
        }
        {
            let tree = tree.to_path_buf();
            let listed = listed.clone();
            let _ = tokio::task::spawn_blocking(move || protect(&tree, &listed)).await;
        }
        let manifest = sha256_hex(serde_json::to_string(&files).unwrap_or_default().as_bytes());
        Ok(json!({
            "at": iso_time(now_millis()),
            "isolation": ISOLATION,
            "manifestSha256": manifest,
            "files": files,
            "inputs": inputs,
            "uncontrolled": uncontrolled,
        }))
    }
}

/// After the run: checks the snapshot's files in `folder` against what it was given, moves what the program wrote
/// there into `written`, and removes the snapshot. Linked inputs are checked against their source. A snapshot a
/// process may still be using (`remove` false) is checked and left in place.
pub(super) async fn close(
    folder: &Path,
    written_to: &Path,
    observed: &Value,
    source: &Path,
    remove: bool,
) -> Value {
    {
        let tree = folder.join("tree");
        if !tokio::fs::try_exists(&tree).await.unwrap_or(false) {
            return json!({ "at": iso_time(now_millis()), "checked": false, "reason": "The snapshot was no longer there to check." });
        }
        let given: Vec<Value> = observed
            .get("files")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut changed = Vec::new();
        for file in &given {
            let path = text(file, "path");
            let now = hash_file(&tree.join(path))
                .await
                .map(|(sha256, _)| sha256)
                .unwrap_or_default();
            if now != text(file, "sha256") {
                changed.push(path.to_owned());
            }
        }
        for input in observed
            .get("inputs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if text(input, "how") != "linked" {
                continue;
            }
            let path = text(input, "path");
            let now = hash_file(&source.join(path))
                .await
                .map(|(sha256, _)| sha256)
                .unwrap_or_default();
            if now != text(input, "sha256") && !changed.iter().any(|known| known == path) {
                changed.push(path.to_owned());
            }
        }
        if !remove {
            return json!({ "at": iso_time(now_millis()), "checked": true, "changed": changed, "written": [], "kept": true });
        }
        // Files the program wrote in its working folder are its output: they are kept with the run.
        let present = {
            let tree = tree.clone();
            tokio::task::spawn_blocking(move || files_in(&tree))
                .await
                .unwrap_or_default()
        };
        let mut written = Vec::new();
        for path in present {
            if given.iter().any(|file| text(file, "path") == path) {
                continue;
            }
            let to = written_to.join(&path);
            if let Some(parent) = to.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            if tokio::fs::rename(tree.join(&path), &to).await.is_ok() {
                written.push(path);
            }
        }
        let _ = tokio::fs::remove_dir_all(folder).await;
        json!({ "at": iso_time(now_millis()), "checked": true, "changed": changed, "written": written })
    }
}
