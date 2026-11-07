//! What the research workbench reads and writes: a project's source files, with a revision so a save cannot overwrite a
//! change it has not seen, and a run's samples and logs a page at a time.
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};

use std::path::Path;
use tokio::io::AsyncReadExt;

use base64::{Engine, engine::general_purpose::STANDARD};

use saturn_domain::research::{MAX_SAMPLE_LINE, is_id, labels_agree, sample_identity, sha256_hex};
use saturn_domain::skills::workspace::Workspace;
use saturn_tools::file::inside_workspace;
use serde_json::{Value, json};

use super::freeze::is_bookkeeping;
use super::write_whole;
use crate::records::text;
use crate::{CoreError, Kernel};

/// The largest file the editor opens.
const OPEN_LIMIT: u64 = 2 * 1024 * 1024;
/// The largest notebook the editor opens: its stored images are most of it, and it still fits a save's request.
const NOTEBOOK_OPEN_LIMIT: u64 = 8 * 1024 * 1024;
/// The largest paper or figure the Workspace shows.
const DOCUMENT_LIMIT: u64 = 32 * 1024 * 1024;

/// The documents the Workspace shows rather than edits, by extension: papers and figures.
fn document_type(relative: &str) -> Option<&'static str> {
    let extension = relative.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match extension.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}
/// How much of a run's log is returned: its end.
const LOG_TAIL: u64 = 64 * 1024;
const DEFAULT_PAGE: usize = 50;
const LARGEST_PAGE: usize = 200;

impl Kernel {
    /// A path inside the source folder, as a path and how the client names it.
    pub(super) async fn source_path(
        &self,
        project: &str,
        requested: &str,
        thread: Option<&str>,
    ) -> Result<(std::path::PathBuf, String), CoreError> {
        let source = self.research_source(project, thread)?;
        let workspace = Workspace::new(&source);
        let target = inside_workspace(&workspace, requested)
            .await
            .map_err(|message| CoreError::new(403, message))?;
        let relative = workspace.relative(&target);
        if is_bookkeeping(&relative) {
            return Err(CoreError::new(
                403,
                "Saturn's records and git's own folder are not edited here.",
            ));
        }
        Ok((target, relative))
    }

    /// A folder's entries, or a text file with the revision to save it against.
    pub async fn research_source_read(
        &self,
        project: &str,
        requested: &str,
        thread: Option<&str>,
    ) -> Result<Value, CoreError> {
        let (target, relative) = self.source_path(project, requested, thread).await?;
        let info = tokio::fs::metadata(&target)
            .await
            .map_err(|_| CoreError::new(404, "No such file or folder"))?;
        if info.is_dir() {
            return read_folder_entries(&target, &relative).await;
        }
        // A paper or a figure is shown as it is, never edited: its bytes, base64, with its type.
        if let Some(mime) = document_type(&relative) {
            if info.len() > DOCUMENT_LIMIT {
                return Err(CoreError::new(413, "This file is too large to show here."));
            }
            let bytes = tokio::fs::read(&target).await?;
            return Ok(
                json!({ "kind": "document", "path": relative, "mime": mime, "size": bytes.len(), "revision": sha256_hex(&bytes), "data": STANDARD.encode(&bytes) }),
            );
        }
        let limit = if relative.to_ascii_lowercase().ends_with(".ipynb") {
            NOTEBOOK_OPEN_LIMIT
        } else {
            OPEN_LIMIT
        };
        if info.len() > limit {
            return Err(CoreError::new(413, "This file is too large to open here."));
        }
        let bytes = tokio::fs::read(&target).await?;
        let revision = sha256_hex(&bytes);
        let content = String::from_utf8(bytes).map_err(|_| {
            CoreError::new(415, "This file is not text, so it cannot be opened here.")
        })?;
        Ok(json!({ "kind": "file", "path": relative, "content": content, "revision": revision }))
    }

    /// Saves a text file if it is still as the client last saw it: `expected` is its revision, or none for a new file.
    pub async fn research_source_write(
        &self,
        project: &str,
        requested: &str,
        content: &str,
        expected: Option<&str>,
        thread: Option<&str>,
    ) -> Result<Value, CoreError> {
        let (target, relative) = self.source_path(project, requested, thread).await?;
        let lock = self.records_lock(&self.research_source(project, thread)?);
        let _writing = lock.lock().await;
        let link = tokio::fs::symlink_metadata(&target).await;
        if link
            .as_ref()
            .is_ok_and(|info| info.file_type().is_symlink())
        {
            return Err(CoreError::new(
                403,
                "This is a symbolic link, which is not saved through.",
            ));
        }
        let current = match tokio::fs::read(&target).await {
            Ok(bytes) => Some(sha256_hex(&bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        if current.as_deref() != expected {
            return Err(CoreError::new(
                409,
                "This file changed since it was opened. Reload it, or save again to keep your version.",
            ));
        }
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let permissions = link.ok().map(|info| info.permissions());
        write_whole(&target, content.as_bytes()).await?;
        if let Some(permissions) = permissions {
            tokio::fs::set_permissions(&target, permissions).await?;
        }
        Ok(json!({ "path": relative, "revision": sha256_hex(content.as_bytes()) }))
    }

    /// A page of a run's samples from a byte offset. An ended run's page stops at what its seal counted; a running
    /// run's stops before an unfinished line.
    pub async fn research_samples(
        &self,
        project: &str,
        id: &str,
        cursor: u64,
        limit: Option<usize>,
        only: Option<&str>,
    ) -> Result<Value, CoreError> {
        let only = only.unwrap_or("all");
        if !matches!(only, "all" | "disputed" | "errors") {
            return Err(CoreError::new(400, "only must be all, disputed or errors."));
        }
        let run = self.research_run(project, id).await?;
        let records = self.records_folder(project).await?;
        let (labels, aliases) = if only == "disputed" {
            (
                super::labels::read_labels(&records, id).await?["labels"].clone(),
                self.research_label_aliases(project, &run).await?,
            )
        } else {
            (Value::Null, Value::Null)
        };
        let only = only.to_owned();
        let path = records.join("runs").join(id).join("samples.jsonl");
        let end = run.get("samplesSize").and_then(Value::as_u64);
        let limit = limit.unwrap_or(DEFAULT_PAGE).clamp(1, LARGEST_PAGE);
        let intact = run.get("sealIntact").cloned();
        let mut page = tokio::task::spawn_blocking(move || {
            read_page(&path, cursor, end, limit, &only, &labels, &aliases)
        })
        .await
        .map_err(|error| CoreError::new(500, error.to_string()))??;
        if let Some(intact) = intact {
            page["sealIntact"] = intact;
        }
        Ok(page)
    }

    /// The end of a run's log.
    pub async fn research_run_log(
        &self,
        project: &str,
        id: &str,
        stream: &str,
    ) -> Result<Value, CoreError> {
        if !is_id(id) || !matches!(stream, "stdout" | "stderr") {
            return Err(CoreError::new(404, "No such log"));
        }
        self.research_run(project, id).await?;
        let records = self.records_folder(project).await?;
        let path = records.join("runs").join(id).join(format!("{stream}.log"));
        let bytes = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<u8>> {
            let mut file = match std::fs::File::open(&path) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
                Err(error) => return Err(error),
            };
            let size = file.metadata()?.len();
            file.seek(SeekFrom::Start(size.saturating_sub(LOG_TAIL)))?;
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)?;
            Ok(bytes)
        })
        .await
        .map_err(|error| CoreError::new(500, error.to_string()))??;
        Ok(json!({ "text": String::from_utf8_lossy(&bytes) }))
    }
}

/// The most of a file a run wrote that is handed back at once.
const OUTPUT_READ: u64 = 256 * 1024;
/// The most entries of a run's output folder listed at once.
const OUTPUT_ENTRIES: usize = 500;

impl Kernel {
    /// What a run's program wrote to `SATURN_RUN_OUTPUT`: with no path, the files in its `written/` folder; with one,
    /// that file's text, up to 256 KiB. Reading stays inside the folder, through no link, and runs nothing.
    pub async fn research_run_output(
        &self,
        project: &str,
        id: &str,
        requested: Option<&str>,
    ) -> Result<Value, CoreError> {
        if !is_id(id) {
            return Err(CoreError::new(404, "No such run"));
        }
        self.research_run(project, id).await?;
        let records = self.records_folder(project).await?;
        let written = records.join("runs").join(id).join(super::isolation::OUTPUT);
        if super::is_link(&written).await {
            return Err(CoreError::new(
                403,
                "The run's output folder is a symbolic link, which Saturn does not follow.",
            ));
        }
        let Some(requested) = requested.filter(|path| !path.trim().is_empty() && *path != ".")
        else {
            let mut files = Vec::new();
            if tokio::fs::try_exists(&written).await? {
                list_written(&written, &written, &mut files).await?;
            }
            let truncated = files.len() > OUTPUT_ENTRIES;
            files.truncate(OUTPUT_ENTRIES);
            return Ok(json!({ "runId": id, "files": files, "truncated": truncated }));
        };
        let workspace = Workspace::new(&written);
        let path = inside_workspace(&workspace, requested)
            .await
            .map_err(|message| CoreError::new(403, message))?;
        if super::is_link(&path).await {
            return Err(CoreError::new(
                403,
                "Saturn does not follow a link in a run's output.",
            ));
        }
        let relative = workspace.relative(&path);
        let info = tokio::fs::metadata(&path).await.map_err(|_| {
            CoreError::new(404, format!("The run wrote no file called {requested}."))
        })?;
        if !info.is_file() {
            return Err(CoreError::new(
                400,
                format!("{requested} is a folder; name a file in it."),
            ));
        }
        let mut bytes = Vec::new();
        tokio::fs::File::open(&path)
            .await?
            .take(OUTPUT_READ)
            .read_to_end(&mut bytes)
            .await?;
        let binary = bytes.contains(&0);
        Ok(json!({
            "runId": id,
            "path": relative,
            "size": info.len(),
            "truncated": info.len() > OUTPUT_READ,
            "binary": binary,
            "text": if binary { Value::Null } else { json!(String::from_utf8_lossy(&bytes)) },
        }))
    }
}

/// Every file under a run's output folder, by its path from that folder, with its size. Links are listed, not followed.
async fn list_written(root: &Path, folder: &Path, files: &mut Vec<Value>) -> Result<(), CoreError> {
    let mut pending = vec![folder.to_path_buf()];
    while let Some(folder) = pending.pop() {
        let mut reading = tokio::fs::read_dir(&folder).await?;
        while let Some(entry) = reading.next_entry().await? {
            let kind = entry.file_type().await?;
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            if kind.is_dir() {
                pending.push(path);
            } else {
                let size = entry.metadata().await.map(|info| info.len()).unwrap_or(0);
                files.push(json!({ "path": relative, "size": size, "link": kind.is_symlink() }));
            }
            if files.len() > OUTPUT_ENTRIES {
                return Ok(());
            }
        }
    }
    files.sort_by(|left, right| text(left, "path").cmp(text(right, "path")));
    Ok(())
}

/// A folder's entries, folders first, without the records and git's folder.
async fn read_folder_entries(target: &Path, relative: &str) -> Result<Value, CoreError> {
    let mut entries = Vec::new();
    let mut reading = tokio::fs::read_dir(target).await?;
    while let Some(entry) = reading.next_entry().await? {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = if relative == "." {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        if is_bookkeeping(&path) {
            continue;
        }
        let kind = if entry.file_type().await?.is_dir() {
            "directory"
        } else {
            "file"
        };
        entries.push(json!({ "name": name, "path": path, "kind": kind }));
    }
    entries.sort_by_key(|entry| {
        (
            text(entry, "kind") != "directory",
            text(entry, "name").to_owned(),
        )
    });
    Ok(json!({ "kind": "directory", "path": relative, "entries": entries }))
}

/// Reads lines from `cursor`, up to `end` if the run was sealed. Never reads the file from its start.
fn read_page(
    path: &Path,
    cursor: u64,
    end: Option<u64>,
    limit: usize,
    only: &str,
    labels: &Value,
    aliases: &Value,
) -> Result<Value, CoreError> {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if cursor != 0 {
                return Err(CoreError::new(400, "This position is not in the samples."));
            }
            return Ok(json!({ "items": [], "next": null }));
        }
        Err(error) => return Err(error.into()),
    };
    let end = end.unwrap_or(file.metadata()?.len());
    if cursor > end {
        return Err(CoreError::new(400, "This position is not in the samples."));
    }
    if cursor > 0 {
        file.seek(SeekFrom::Start(cursor - 1))?;
        let mut before = [0];
        file.read_exact(&mut before)?;
        if before[0] != b'\n' {
            return Err(CoreError::new(
                400,
                "This position is not the start of a sample.",
            ));
        }
    }
    let mut reader = BufReader::new(file);
    let mut offset = cursor;
    let mut items = Vec::new();
    let mut line = Vec::new();
    while items.len() < limit && offset < end {
        line.clear();
        let room = (end - offset).min(MAX_SAMPLE_LINE + 1);
        let read = (&mut reader).take(room).read_until(b'\n', &mut line)? as u64;
        if read == 0 || line.last() != Some(&b'\n') {
            // A running run's unfinished line, or a sealed run's last one, which is on record as a problem.
            return Ok(json!({ "items": items, "next": null }));
        }
        let parsed = serde_json::from_slice::<Value>(&line)
            .map_err(|error| format!("It is not JSON: {error}."))
            .and_then(|value| sample_identity(&value).map(|_| value));
        let matches = match (&parsed, only) {
            (_, "all") => true,
            (Ok(value), "errors") => value.get("error").is_some_and(Value::is_object),
            (Ok(value), "disputed") => sample_identity(value)
                .ok()
                .and_then(|identity| labels.get(identity))
                .and_then(|label| {
                    value
                        .get("scorerLabel")
                        .and_then(Value::as_str)
                        .filter(|scored| !scored.trim().is_empty())
                        .map(|scored| !labels_agree(text(label, "label"), scored, aliases))
                })
                .unwrap_or(false),
            _ => false,
        };
        if !matches {
            offset += read;
            continue;
        }
        items.push(match parsed {
            Ok(sample) => json!({ "offset": offset, "sample": sample }),
            Err(problem) => json!({
                "offset": offset,
                "problem": problem,
                "raw": String::from_utf8_lossy(&line[..line.len().min(4096)]),
            }),
        });
        offset += read;
    }
    Ok(json!({ "items": items, "next": (offset < end).then_some(offset) }))
}
