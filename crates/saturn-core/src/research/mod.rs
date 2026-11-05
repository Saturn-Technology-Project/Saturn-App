//! Research records: plain JSON files in the project's `.saturn/research`, shared by every chat in it.
//! `docs/research-contract.md` is the contract, and `contract/research-*.test.mjs` hold the runtime to it.
mod agent;
mod checks;
mod environment;
mod freeze;
mod inside;
mod labels;
mod manage;
mod policy;
mod resources;
mod runs;
mod skills;
mod source;

pub use labels::RunDigest;

use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use saturn_domain::research::{
    changed_record, compare_versions, id_prefix, is_id, makes_cycle, new_record, unusable, writable,
};
use saturn_domain::time::{iso_time, now_millis};
use saturn_domain::{new_id, random_hex};
use serde_json::{Value, json};
use tokio::sync::{Mutex as AsyncMutex, watch};

use crate::records::{by_id, text};
use crate::{CoreError, Kernel, locked};

/// What the runtime keeps about research records while it runs.
#[derive(Debug)]
pub struct ResearchState {
    /// One writer at a time per project's records.
    locks: Mutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>,
    /// Moves on whenever a record changes.
    changes: watch::Sender<u64>,
    /// The experiment runs this runtime has started and that have not ended.
    active: Mutex<HashMap<String, runs::ActiveRun>>,
    /// What each agent run last saw of its protected files.
    baselines: Mutex<HashMap<String, policy::Signatures>>,
    /// Set once the runtime is stopping: its runs end as interrupted, whatever their exit says.
    ending: AtomicBool,
    /// The projects whose managed environment has a job running.
    environment_jobs: Mutex<manage::RunningJobs>,
}

impl Default for ResearchState {
    fn default() -> Self {
        Self {
            locks: Mutex::default(),
            changes: watch::channel(0).0,
            active: Mutex::default(),
            baselines: Mutex::default(),
            ending: AtomicBool::new(false),
            environment_jobs: Mutex::default(),
        }
    }
}

/// The records' folder inside a project.
const RECORDS: &str = ".saturn/research";

/// Whether something at this path is a link, which records never follow.
async fn is_link(path: &Path) -> bool {
    tokio::fs::symlink_metadata(path)
        .await
        .is_ok_and(|info| info.file_type().is_symlink())
}

/// A file's new content, all of it or none: written beside it, then renamed over it.
pub(crate) async fn write_whole(path: &Path, bytes: &[u8]) -> Result<(), CoreError> {
    let folder = path
        .parent()
        .ok_or_else(|| CoreError::new(500, "A record has no folder"))?;
    let temporary = folder.join(format!(".tmp-{}", random_hex(8)?));
    let written = async {
        let mut file = tokio::fs::File::create(&temporary).await?;
        tokio::io::AsyncWriteExt::write_all(&mut file, bytes).await?;
        file.sync_all().await?;
        tokio::fs::rename(&temporary, path).await
    }
    .await;
    if written.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    Ok(written?)
}

/// A record read from its file, or why it cannot be used. `None` is a file that does not exist.
async fn read_record(path: &Path) -> Result<Option<Value>, String> {
    if is_link(path).await {
        return Err("It is a symbolic link, which Saturn does not follow.".to_owned());
    }
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let record: Value =
        serde_json::from_slice(&bytes).map_err(|error| format!("It cannot be read: {error}."))?;
    match unusable(&record) {
        Some(reason) => Err(reason),
        None => Ok(Some(record)),
    }
}

/// The records in a folder, and those that cannot be used.
async fn read_folder(folder: &Path) -> Result<(Vec<Value>, Vec<Value>), CoreError> {
    let mut items = Vec::new();
    let mut problems = Vec::new();
    let mut entries = match tokio::fs::read_dir(folder).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok((items, problems)),
        Err(error) => return Err(error.into()),
    };
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".json").filter(|id| is_id(id)) else {
            continue;
        };
        match read_record(&entry.path()).await {
            Ok(Some(record)) => items.push(record),
            Ok(None) => {}
            Err(error) => problems.push(json!({ "id": id, "error": error })),
        }
    }
    items.sort_by_key(|item| {
        (
            item.get("createdAt")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            item.get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        )
    });
    Ok((items, problems))
}

/// The folder of a collection that exists, or a 404.
fn known(collection: &str) -> Result<&'static str, CoreError> {
    id_prefix(collection).ok_or_else(|| CoreError::new(404, "No such kind of research record"))
}

fn not_found() -> CoreError {
    CoreError::new(404, "No such research record")
}

fn cannot_use(id: &str, reason: &str) -> CoreError {
    CoreError::new(422, format!("The record {id} was left as it is. {reason}"))
}

impl Kernel {
    /// The records' folder of a project the user has allowed; a link anywhere on the way is refused.
    async fn records_folder(&self, project: &str) -> Result<PathBuf, CoreError> {
        let folder = self.workdir(project)?;
        let parent = folder.join(".saturn");
        let records = folder.join(RECORDS);
        if is_link(&parent).await || is_link(&records).await {
            return Err(CoreError::new(
                409,
                "The project's .saturn/research is a symbolic link, which Saturn does not follow. Remove it to keep records here.",
            ));
        }
        Ok(records)
    }

    /// The records' folder, made ready for writing.
    async fn records_for_writing(&self, project: &str) -> Result<PathBuf, CoreError> {
        let records = self.records_folder(project).await?;
        tokio::fs::create_dir_all(&records).await?;
        let ignore = records.join(".gitignore");
        if !tokio::fs::try_exists(&ignore).await? {
            write_whole(&ignore, b"*\n").await?;
        }
        Ok(records)
    }

    /// A collection's folder inside the records, which must not be a link either.
    async fn collection_folder(records: &Path, collection: &str) -> Result<PathBuf, CoreError> {
        let folder = records.join(collection);
        if is_link(&folder).await {
            return Err(CoreError::new(
                409,
                format!(
                    "The records' {collection} folder is a symbolic link, which Saturn does not follow."
                ),
            ));
        }
        Ok(folder)
    }

    /// The lock for writing to these records.
    fn records_lock(&self, records: &Path) -> Arc<AsyncMutex<()>> {
        Arc::clone(
            locked(&self.research.locks)
                .entry(records.to_path_buf())
                .or_default(),
        )
    }

    /// Tells whoever is watching that a record changed.
    fn research_changed(&self) {
        self.research.changes.send_modify(|count| *count += 1);
    }

    /// A count that moves on whenever a research record changes.
    pub fn research_changes(&self) -> watch::Receiver<u64> {
        self.research.changes.subscribe()
    }

    /// A collection's usable records, and which ones are not.
    pub async fn research_list(&self, project: &str, collection: &str) -> Result<Value, CoreError> {
        known(collection)?;
        let records = self.records_folder(project).await?;
        let folder = Self::collection_folder(&records, collection).await?;
        let (items, problems) = read_folder(&folder).await?;
        Ok(json!({ "items": items, "problems": problems }))
    }

    /// One record.
    pub async fn research_record(
        &self,
        project: &str,
        collection: &str,
        id: &str,
    ) -> Result<Value, CoreError> {
        known(collection)?;
        if !is_id(id) {
            return Err(not_found());
        }
        let records = self.records_folder(project).await?;
        let folder = Self::collection_folder(&records, collection).await?;
        read_record(&folder.join(format!("{id}.json")))
            .await
            .map_err(|reason| cannot_use(id, &reason))?
            .ok_or_else(not_found)
    }

    /// Makes a record from a request.
    pub async fn research_create(
        &self,
        project: &str,
        collection: &str,
        input: &Value,
    ) -> Result<Value, CoreError> {
        let prefix = known(collection)?;
        if !writable(collection) {
            return Err(CoreError::new(
                405,
                "These records cannot be written directly",
            ));
        }
        if collection == "models" {
            self.check_parent(project, input, None).await?;
        }
        let id = new_id(prefix)?;
        let record = new_record(collection, input, &id, &iso_time(now_millis()))
            .map_err(|message| CoreError::new(400, message))?;
        let records = self.records_for_writing(project).await?;
        let folder = Self::collection_folder(&records, collection).await?;
        tokio::fs::create_dir_all(&folder).await?;
        write_whole(&folder.join(format!("{id}.json")), &pretty(&record)?).await?;
        self.research_changed();
        Ok(record)
    }

    /// Changes a record, if it is still at the revision the change was based on.
    pub async fn research_update(
        &self,
        project: &str,
        collection: &str,
        id: &str,
        changes: &Value,
    ) -> Result<Value, CoreError> {
        known(collection)?;
        if !writable(collection) {
            return Err(CoreError::new(405, "These records never change"));
        }
        if !is_id(id) {
            return Err(not_found());
        }
        let expected = changes
            .get("expectedRevision")
            .and_then(Value::as_u64)
            .ok_or_else(|| CoreError::new(400, "A change needs its \"expectedRevision\""))?;
        let records = self.records_for_writing(project).await?;
        let folder = Self::collection_folder(&records, collection).await?;
        let lock = self.records_lock(&records);
        let _writing = lock.lock().await;
        let path = folder.join(format!("{id}.json"));
        let record = read_record(&path)
            .await
            .map_err(|reason| cannot_use(id, &reason))?
            .ok_or_else(not_found)?;
        if collection == "models" {
            self.check_parent(project, changes, Some(id)).await?;
        }
        let revision = record.get("revision").and_then(Value::as_u64).unwrap_or(0);
        if revision != expected {
            return Err(CoreError::new(
                409,
                format!(
                    "This record has changed (it is at revision {revision}). Reload it and try again."
                ),
            ));
        }
        let next = changed_record(collection, &record, changes, &iso_time(now_millis()))
            .map_err(|message| CoreError::new(400, message))?;
        write_whole(&path, &pretty(&next)?).await?;
        self.research_changed();
        Ok(next)
    }
}

impl Kernel {
    /// Refuses a model's parent that does not exist, or that would make it its own ancestor.
    async fn check_parent(
        &self,
        project: &str,
        fields: &Value,
        child: Option<&str>,
    ) -> Result<(), CoreError> {
        let Some(parent) = fields.get("parentId").and_then(Value::as_str) else {
            return Ok(());
        };
        let records = self.records_folder(project).await?;
        let (models, _) = read_folder(&Self::collection_folder(&records, "models").await?).await?;
        if !models.iter().any(|model| text(model, "id") == parent) {
            return Err(CoreError::new(
                400,
                format!("The parent model {parent} does not exist."),
            ));
        }
        let parent_of = |id: &str| {
            by_id(&models, id)
                .map(|model| text(model, "parentId").to_owned())
                .filter(|parent| !parent.is_empty())
        };
        if child.is_some_and(|child| makes_cycle(child, parent, parent_of)) {
            return Err(CoreError::new(400, "A model cannot be its own ancestor."));
        }
        Ok(())
    }

    /// Whether two versions measured the same way.
    pub async fn research_compare(
        &self,
        project: &str,
        left: &str,
        right: &str,
    ) -> Result<Value, CoreError> {
        let left = self.research_record(project, "versions", left).await?;
        let right = self.research_record(project, "versions", right).await?;
        Ok(compare_versions(&left, &right))
    }
}

/// A record as its file holds it.
fn pretty(record: &Value) -> Result<Vec<u8>, CoreError> {
    serde_json::to_vec_pretty(record).map_err(|error| CoreError::new(500, error.to_string()))
}
