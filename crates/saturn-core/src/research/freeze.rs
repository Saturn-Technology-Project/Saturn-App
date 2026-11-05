//! Freezing an experiment: what a run would really compute, as a version that never changes.
use std::path::{Path, PathBuf};

use saturn_domain::new_id;
use saturn_domain::research::{SCHEMA_VERSION, fingerprint, hex, sha256_hex};
use saturn_domain::skills::workspace::Workspace;
use saturn_domain::time::{iso_time, now_millis};
use saturn_tools::file::inside_workspace;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

use super::{RECORDS, pretty, read_folder, read_record, write_whole};
use crate::records::text;
use crate::worktrees::run_git;
use crate::{CoreError, Kernel};

/// The largest file saved as a copy.
const COPY_LIMIT: u64 = 5 * 1024 * 1024;
/// How much one version saves as copies; files after that are kept by hash.
const COPIES_LIMIT: u64 = 200 * 1024 * 1024;
/// The kinds of input an experiment declares, in the order a version lists them.
const INPUT_ROLES: [&str; 4] = ["code", "data", "scorer", "environment"];

/// An input a version cannot be made with.
fn unusable_input(message: impl Into<String>) -> CoreError {
    CoreError::new(422, message)
}

/// The SHA-256 and size of a file, without holding it in memory.
pub(crate) async fn hash_file(path: &Path) -> std::io::Result<(String, u64)> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 64 * 1024];
    let mut size = 0;
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            return Ok((hex(&hash.finalize()), size));
        }
        hash.update(&buffer[..read]);
        size += read as u64;
    }
}

/// Whether a path, from a project's folder, is the records themselves or git's own.
pub(super) fn is_bookkeeping(relative: &str) -> bool {
    relative == ".git"
        || relative.starts_with(".git/")
        || relative == RECORDS
        || relative.starts_with(&format!("{RECORDS}/"))
}

/// The files at a path from `source`, without following links: itself, or everything under a folder, in order.
pub(super) async fn files_under(source: &Path, relative: &str) -> std::io::Result<Vec<String>> {
    let mut found = Vec::new();
    let mut waiting = vec![relative.trim_end_matches('/').to_owned()];
    while let Some(next) = waiting.pop() {
        let path = source.join(&next);
        let info = tokio::fs::symlink_metadata(&path).await?;
        if !info.is_dir() {
            found.push(next);
            continue;
        }
        let mut entries = tokio::fs::read_dir(&path).await?;
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            let child = if next == "." {
                name
            } else {
                format!("{next}/{name}")
            };
            if !is_bookkeeping(&child) {
                waiting.push(child);
            }
        }
    }
    found.sort();
    Ok(found)
}

/// How a version's changed files are saved as copies.
struct Copies {
    objects: PathBuf,
    used: u64,
}

impl Copies {
    /// Describes a file that differs from its commit, keeping a copy when it is small enough.
    async fn entry(
        &mut self,
        source: &Path,
        relative: &str,
        state: &str,
    ) -> Result<Value, CoreError> {
        let path = source.join(relative);
        let Ok(info) = tokio::fs::symlink_metadata(&path).await else {
            return Ok(json!({
                "path": relative, "state": "deleted", "sha256": null, "size": null, "saved": false,
            }));
        };
        if info.file_type().is_symlink() {
            // A link's target is its content: what it points at may be outside the project.
            let target = tokio::fs::read_link(&path).await?;
            let target = target.to_string_lossy();
            return Ok(json!({
                "path": relative, "state": "link", "sha256": sha256_hex(target.as_bytes()),
                "size": target.len(), "saved": false,
            }));
        }
        let size = info.len();
        if size > COPY_LIMIT || self.used + size > COPIES_LIMIT {
            let (sha256, size) = hash_file(&path).await?;
            return Ok(json!({
                "path": relative, "state": state, "sha256": sha256, "size": size, "saved": false,
            }));
        }
        let bytes = tokio::fs::read(&path).await?;
        let sha256 = sha256_hex(&bytes);
        tokio::fs::create_dir_all(&self.objects).await?;
        let object = self.objects.join(&sha256);
        if !tokio::fs::try_exists(&object).await? {
            write_whole(&object, &bytes).await?;
        }
        self.used += bytes.len() as u64;
        Ok(json!({
            "path": relative, "state": state, "sha256": sha256, "size": bytes.len(), "saved": true,
        }))
    }
}

/// The paths in `git status` output that are inside this folder, each with its state.
fn parse_status(output: &str, prefix: &str) -> Vec<(String, &'static str)> {
    let mut found = Vec::new();
    let mut parts = output.split('\0').filter(|part| !part.is_empty());
    while let Some(part) = parts.next() {
        let (kind, path) = match part.as_bytes().first() {
            Some(b'?') => ("untracked", part.get(2..)),
            Some(b'1') => ("modified", part.splitn(9, ' ').nth(8)),
            Some(b'2') => {
                // A rename: the original follows it, and is gone from where it was.
                if let Some(original) = parts.next() {
                    found.push((original.to_owned(), "modified"));
                }
                ("modified", part.splitn(10, ' ').nth(9))
            }
            Some(b'u') => ("modified", part.splitn(11, ' ').nth(10)),
            _ => continue,
        };
        if let Some(path) = path {
            found.push((path.to_owned(), kind));
        }
    }
    found
        .into_iter()
        .filter_map(|(path, kind)| {
            path.strip_prefix(prefix)
                .map(|relative| (relative.to_owned(), kind))
        })
        .collect()
}

impl Kernel {
    /// Where a request's code is: the project's folder, or the worktree of a chat in that project.
    pub(crate) fn research_source(
        &self,
        project: &str,
        thread: Option<&str>,
    ) -> Result<PathBuf, CoreError> {
        let Some(id) = thread else {
            return self.workdir(project);
        };
        let thread = self
            .find_thread(id)
            .ok_or_else(|| CoreError::new(404, "No such chat"))?;
        if text(&thread, "projectId") != project {
            return Err(CoreError::new(403, "This chat belongs to another project"));
        }
        self.workdir_for(Some(&thread))?
            .ok_or_else(|| CoreError::new(404, "This chat has no folder"))
    }

    /// The commit, and what differs from it, as a version records them.
    async fn source_state(
        &self,
        source: &Path,
        copies: &mut Copies,
        code_inputs: &[String],
    ) -> Result<(Value, Vec<Value>), CoreError> {
        let mut changed = Vec::new();
        let in_git = run_git(source, &["rev-parse", "--is-inside-work-tree"])
            .await
            .is_ok();
        if !in_git {
            let mut paths = Vec::new();
            for input in code_inputs {
                paths.extend(files_under(source, input).await?);
            }
            paths.sort();
            paths.dedup();
            for path in paths {
                changed.push(copies.entry(source, &path, "untracked").await?);
            }
            return Ok((json!({ "commit": null }), changed));
        }
        let commit = run_git(source, &["rev-parse", "--verify", "-q", "HEAD"])
            .await
            .ok();
        let prefix = run_git(source, &["rev-parse", "--show-prefix"])
            .await
            .unwrap_or_default();
        let status = run_git(
            source,
            &[
                "status",
                "--porcelain=v2",
                "-z",
                "--untracked-files=all",
                "--no-renames",
                "--",
                ".",
            ],
        )
        .await
        .map_err(|message| CoreError::new(409, format!("git status failed: {message}")))?;
        let mut paths = parse_status(&status, &prefix);
        paths.retain(|(path, _)| !is_bookkeeping(path));
        paths.sort();
        paths.dedup();
        for (path, state) in paths {
            changed.push(copies.entry(source, &path, state).await?);
        }
        Ok((json!({ "commit": commit }), changed))
    }

    /// Every declared input's size and hash, or which one cannot be used.
    async fn input_hashes(
        source: &Path,
        declared: &Value,
    ) -> Result<(Vec<Value>, Vec<String>), CoreError> {
        let workspace = Workspace::new(source);
        let mut hashes = Vec::new();
        let mut code = Vec::new();
        for role in INPUT_ROLES {
            for path in crate::records::strings(declared, role) {
                let target = inside_workspace(&workspace, &path).await.map_err(|error| {
                    unusable_input(format!("The {role} input {path} cannot be used: {error}"))
                })?;
                let relative = workspace.relative(&target);
                if is_bookkeeping(&relative) {
                    return Err(unusable_input(format!(
                        "The {role} input {path} is inside Saturn's records or git's own folder."
                    )));
                }
                let files = files_under(source, &relative).await.map_err(|error| {
                    unusable_input(format!("The {role} input {path} cannot be read: {error}"))
                })?;
                for file in files {
                    let (sha256, size) = hash_file(&source.join(&file)).await.map_err(|error| {
                        unusable_input(format!("The {role} input {file} cannot be read: {error}"))
                    })?;
                    hashes.push(
                        json!({ "role": role, "path": file, "sha256": sha256, "size": size }),
                    );
                }
                if role == "code" {
                    code.push(relative);
                }
            }
        }
        Ok((hashes, code))
    }

    /// An experiment's models as a version names them, each with its source and revision.
    async fn bound_models(&self, records: &Path, draft: &Value) -> Result<Vec<Value>, CoreError> {
        let mut bound = Vec::new();
        for binding in draft
            .get("models")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let id = text(binding, "modelId");
            let model = if saturn_domain::research::is_id(id) {
                read_record(&records.join("models").join(format!("{id}.json")))
                    .await
                    .ok()
                    .flatten()
            } else {
                None
            };
            let model =
                model.ok_or_else(|| unusable_input(format!("The model {id} does not exist.")))?;
            let revision =
                Some(text(&model, "weightsRevision")).filter(|revision| !revision.is_empty());
            bound.push(json!({
                "modelId": id,
                "role": text(binding, "role"),
                "source": text(&model, "source"),
                "weightsRevision": revision,
                "floating": revision.is_none(),
            }));
        }
        Ok(bound)
    }

    /// What a version made from these fields would hold, as things are now. `draft` is an experiment, or a version.
    pub(super) async fn frozen_content(
        &self,
        records: &Path,
        source: &Path,
        draft: &Value,
    ) -> Result<Value, CoreError> {
        let command = text(draft, "command");
        if command.trim().is_empty() {
            return Err(unusable_input(
                "An experiment needs a command before it can be frozen.",
            ));
        }
        let working_folder = match draft.get("cwd").and_then(Value::as_str) {
            Some(cwd) if !cwd.is_empty() => {
                let workspace = Workspace::new(source);
                let target = inside_workspace(&workspace, cwd).await.map_err(|error| {
                    unusable_input(format!("The working folder {cwd} cannot be used: {error}"))
                })?;
                workspace.relative(&target)
            }
            _ => ".".to_owned(),
        };
        let declared = draft
            .get("declaredInputs")
            .or_else(|| draft.get("inputs"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        let (inputs, code) = Self::input_hashes(source, &declared).await?;
        let models = self.bound_models(records, draft).await?;
        let mut copies = Copies {
            objects: records.join("objects"),
            used: 0,
        };
        let (git, changed_files) = self.source_state(source, &mut copies, &code).await?;
        let mut content = json!({
            "command": command,
            "cwd": working_folder,
            "seeds": draft.get("seeds").cloned().unwrap_or_else(|| json!([])),
            "envNames": draft.get("envNames").cloned().unwrap_or_else(|| json!([])),
            "evaluation": draft.get("evaluation").cloned().unwrap_or(Value::Null),
            "models": models,
            "git": git,
            "changedFiles": changed_files,
            "inputs": inputs,
            "declaredInputs": declared,
        });
        if let Some(kind) = draft.get("kind") {
            content["kind"] = kind.clone();
        }
        Ok(content)
    }

    /// The version holding an experiment's content now, made if it is new, and whether it was.
    pub async fn research_freeze(
        &self,
        project: &str,
        experiment: &str,
        thread: Option<&str>,
    ) -> Result<(Value, bool), CoreError> {
        let draft = self
            .research_record(project, "experiments", experiment)
            .await?;
        let source = self.research_source(project, thread)?;
        let records = self.records_for_writing(project).await?;
        let content = self.frozen_content(&records, &source, &draft).await?;
        let content_id = fingerprint(&content);

        let lock = self.records_lock(&records);
        let _writing = lock.lock().await;
        let folder = Self::collection_folder(&records, "versions").await?;
        let (versions, _) = read_folder(&folder).await?;
        let own: Vec<&Value> = versions
            .iter()
            .filter(|version| text(version, "experimentId") == experiment)
            .collect();
        if let Some(existing) = own.iter().find(|version| {
            version["archived"] != true && text(version, "fingerprint") == content_id
        }) {
            return Ok(((*existing).clone(), false));
        }
        let number = own
            .iter()
            .filter_map(|version| version.get("number").and_then(Value::as_u64))
            .max()
            .unwrap_or(0)
            + 1;
        let now = iso_time(now_millis());
        let id = new_id("version")?;
        let mut version = json!({
            "schemaVersion": SCHEMA_VERSION,
            "id": id,
            "revision": 1,
            "experimentId": experiment,
            "number": number,
            "fingerprint": content_id,
            "createdAt": now,
            "updatedAt": now,
        });
        if let (Some(fields), Value::Object(frozen)) = (version.as_object_mut(), content) {
            fields.extend(frozen);
        }
        tokio::fs::create_dir_all(&folder).await?;
        write_whole(&folder.join(format!("{id}.json")), &pretty(&version)?).await?;
        self.research_clear_released(&records).await?;
        self.research_changed();
        Ok((version, true))
    }
}
