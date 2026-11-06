//! A semantic index of each project's code, kept on this machine: files are split into chunks (one per function or class
//! where the language has them), each chunk gets an embedding, and everything is stored in a SQLite file under the data
//! directory, the same file earlier versions of Saturn wrote. A search embeds the question and ranks chunks by
//! cosine similarity.
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OptionalExtension, params};
use saturn_domain::chunks::chunk_file;
use saturn_domain::time::{iso_time, now_millis};
use saturn_embed::{
    BuiltinEmbedders, DEFAULT_BUILTIN_MODEL, EmbedError, EmbedKind, Embedder, OpenAiEmbedder,
    builtin_model,
};
use serde_json::{Map, Value, json};
use sha1::{Digest, Sha1};
use tokio::task::AbortHandle;

use crate::catalog::connection_of;
use crate::records::text;
use crate::{CoreError, Kernel, locked, log};

/// Folders never indexed.
const SKIP_DIRS: [&str; 18] = [
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
    "venv",
    "__pycache__",
    "target",
    ".artifacts",
    "release",
    ".staging",
    "Pods",
    "DerivedData",
];
/// Only text files of these kinds are indexed.
const EXTENSIONS: [&str; 41] = [
    "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "kts",
    "rb", "php", "swift", "cs", "c", "h", "cc", "cpp", "hpp", "m", "mm", "md", "mdx", "txt",
    "json", "yaml", "yml", "toml", "sql", "sh", "css", "scss", "html", "vue", "svelte", "graphql",
    "proto",
];
const MAX_FILE_BYTES: u64 = 1_000_000;
/// Chunks embedded per request to the embedding model.
const BATCH: usize = 32;
/// The default LM Studio embedding model, when the LM Studio source is chosen without naming one.
const DEFAULT_EMBEDDING_MODEL: &str = "text-embedding-nomic-embed-text-v1.5";
const DEFAULT_OPENAI_EMBEDDING_MODEL: &str = "text-embedding-3-small";
const MAX_DEPTH: usize = 12;

/// One pass over a project.
struct Job {
    id: u64,
    pending: Arc<AtomicUsize>,
    abort: Option<AbortHandle>,
}

/// What the code index keeps while the runtime runs.
#[derive(Default)]
pub struct IndexState {
    databases: Mutex<HashMap<String, Arc<Mutex<Connection>>>>,
    building: Mutex<HashMap<String, Job>>,
    errors: Mutex<HashMap<String, String>>,
    builtins: BuiltinEmbedders,
    next_job: AtomicU64,
}

/// Ends a pass however it stops, a cancel included.
struct PassEnd {
    kernel: Arc<Kernel>,
    project_id: String,
    job: u64,
}

impl Drop for PassEnd {
    fn drop(&mut self) {
        let mut building = locked(&self.kernel.index.building);
        if building
            .get(&self.project_id)
            .is_some_and(|job| job.id == self.job)
        {
            building.remove(&self.project_id);
        }
    }
}

fn database_failed(error: &rusqlite::Error) -> CoreError {
    CoreError::new(500, format!("The code index could not be read: {error}"))
}

/// Runs work on an index file off the async threads.
async fn with_database<T: Send + 'static>(
    database: &Arc<Mutex<Connection>>,
    work: impl FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
) -> Result<T, CoreError> {
    let database = Arc::clone(database);
    tokio::task::spawn_blocking(move || work(&mut locked(&database)))
        .await
        .map_err(|error| CoreError::new(500, error.to_string()))?
        .map_err(|error| database_failed(&error))
}

fn meta(connection: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    connection
        .query_row("SELECT value FROM meta WHERE key = ?", [key], |row| {
            row.get(0)
        })
        .optional()
}

/// Which embedder built this index ("model" alone on indexes from before there was a choice: LM Studio).
fn built_with(connection: &Connection) -> rusqlite::Result<Option<String>> {
    if let Some(embedder) = meta(connection, "embedder")? {
        return Ok(Some(embedder));
    }
    Ok(meta(connection, "model")?.map(|model| format!("lmstudio:{model}")))
}

fn forget(connection: &Connection, relative: &str) -> rusqlite::Result<()> {
    connection.execute("DELETE FROM chunks WHERE path = ?", [relative])?;
    connection.execute("DELETE FROM files WHERE path = ?", [relative])?;
    Ok(())
}

/// Whether a file name is a kind of text indexed; a name with no dot counts as its own extension.
fn indexed_kind(name: &str) -> bool {
    let extension = name.rsplit('.').next().unwrap_or(name).to_lowercase();
    EXTENSIONS.contains(&extension.as_str())
}

/// The folders a whole pass goes through: hidden ones stay out, except `.github`.
fn folder_indexed(name: &str) -> bool {
    !SKIP_DIRS.contains(&name) && (!name.starts_with('.') || name == ".github")
}

/// The project's files a whole pass indexes. Links are neither followed nor indexed.
fn walk(root: &Path) -> Vec<PathBuf> {
    fn visit(dir: &Path, depth: usize, found: &mut Vec<PathBuf>) {
        if depth > MAX_DEPTH {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') && name != ".github" {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if folder_indexed(&name) {
                    visit(&entry.path(), depth + 1, found);
                }
            } else if kind.is_file() && indexed_kind(&name) {
                found.push(entry.path());
            }
        }
    }
    let mut found = Vec::new();
    visit(root, 0, &mut found);
    found
}

/// The named files a whole pass would index too: a name that climbs out of the project, goes through a link, sits in a
/// hidden or skipped folder or is not a kind of text indexed stays out, because its text goes to the embedding model.
fn named_files(root: &Path, paths: &[String]) -> Vec<PathBuf> {
    let Ok(real) = root.canonicalize() else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for item in paths {
        let mut parts: Vec<String> = Vec::new();
        let mut inside = !Path::new(item).is_absolute();
        for component in Path::new(item).components() {
            match component {
                Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
                Component::CurDir => {}
                Component::ParentDir if parts.pop().is_some() => {}
                _ => inside = false,
            }
        }
        let Some((file, folders)) = parts.split_last() else {
            continue;
        };
        if !inside
            || file.starts_with('.')
            || !indexed_kind(file)
            || !folders.iter().all(|folder| folder_indexed(folder))
        {
            continue;
        }
        let full: PathBuf = parts
            .iter()
            .fold(root.to_path_buf(), |path, part| path.join(part));
        let expected: PathBuf = parts
            .iter()
            .fold(real.clone(), |path, part| path.join(part));
        if full.canonicalize().is_ok_and(|actual| actual == expected) {
            found.push(full);
        }
    }
    found
}

/// A file ready to embed.
struct Todo {
    relative: String,
    hash: String,
    content: String,
}

fn relative_of(root: &Path, file: &Path) -> String {
    file.strip_prefix(root)
        .unwrap_or(file)
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// Text to embed for a file's chunk: the path and name say what the code is.
fn passage(relative: &str, chunk: &saturn_domain::chunks::Chunk) -> String {
    let name = chunk
        .name
        .as_ref()
        .map_or_else(String::new, |name| format!(" {name}"));
    format!("{relative}{name}\n{}", chunk.text)
}

fn embedding_failed(error: EmbedError) -> CoreError {
    CoreError::new(error.status.unwrap_or(500), error.message)
}

/// How similar two vectors are, from -1 to 1.
fn cosine(first: &[f32], second: &[f32]) -> f32 {
    let (mut dot, mut one, mut two) = (0.0_f32, 0.0_f32, 0.0_f32);
    for (a, b) in first.iter().zip(second) {
        dot += a * b;
        one += a * a;
        two += b * b;
    }
    if one != 0.0 && two != 0.0 {
        dot / (one * two).sqrt()
    } else {
        0.0
    }
}

impl Kernel {
    /// The project's index file, opened once and made ready.
    async fn index_database(&self, project_id: &str) -> Result<Arc<Mutex<Connection>>, CoreError> {
        if let Some(database) = locked(&self.index.databases).get(project_id) {
            return Ok(Arc::clone(database));
        }
        let dir = self.store.root().join("index");
        let safe: String = project_id
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
                    character
                } else {
                    '_'
                }
            })
            .collect();
        let file = dir.join(format!("{safe}.db"));
        let connection = tokio::task::spawn_blocking(move || -> Result<Connection, CoreError> {
            std::fs::create_dir_all(&dir)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
            }
            let connection = Connection::open(file).map_err(|error| database_failed(&error))?;
            connection
                .execute_batch(
                    "PRAGMA journal_mode = WAL;
                     CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, indexed_at TEXT NOT NULL);
                     CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, path TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, name TEXT, text TEXT NOT NULL, vector BLOB NOT NULL);
                     CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
                     CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
                )
                .map_err(|error| database_failed(&error))?;
            Ok(connection)
        })
        .await
        .map_err(|error| CoreError::new(500, error.to_string()))??;
        let mut databases = locked(&self.index.databases);
        Ok(Arc::clone(
            databases
                .entry(project_id.to_owned())
                .or_insert_with(|| Arc::new(Mutex::new(connection))),
        ))
    }

    /// What embeds the index (Settings → General): the built-in model unless the user chose LM Studio or an
    /// OpenAI-compatible connection. Settings from before the choice existed (a model name, no source) mean LM Studio.
    fn embedder(&self) -> Result<Embedder, CoreError> {
        let (settings, models) = self
            .store
            .read(|state| (Value::Object(state.settings.clone()), state.models.clone()));
        let chosen = text(&settings, "embeddingModel");
        let source = match text(&settings, "embeddingSource") {
            "" if !chosen.is_empty() && builtin_model(chosen).is_none() => "lmstudio",
            "" => "builtin",
            source => source,
        };
        match source {
            "lmstudio" => {
                let address = models
                    .iter()
                    .find(|item| text(item, "provider") == "lmstudio")
                    .map(|item| text(item, "baseUrl"))
                    .filter(|address| !address.is_empty())
                    .unwrap_or("http://127.0.0.1:1234");
                Ok(Embedder::LmStudio {
                    base_url: address.to_owned(),
                    model: if chosen.is_empty() {
                        DEFAULT_EMBEDDING_MODEL
                    } else {
                        chosen
                    }
                    .to_owned(),
                })
            }
            "openai" => {
                let wanted = text(&settings, "embeddingConnectionId");
                let connection = models
                    .iter()
                    .find(|item| text(item, "id") == wanted && !wanted.is_empty())
                    .or_else(|| models.iter().find(|item| text(item, "provider") == "openai"))
                    .ok_or_else(|| {
                        CoreError::new(
                            409,
                            "Choose the OpenAI-compatible connection for embeddings in Settings → General.",
                        )
                    })?;
                let address = text(connection, "baseUrl");
                Ok(Embedder::OpenAi(OpenAiEmbedder::new(
                    (!address.is_empty()).then(|| address.to_owned()),
                    self.broker.key_for(&connection_of(connection)),
                    if chosen.is_empty() {
                        DEFAULT_OPENAI_EMBEDDING_MODEL
                    } else {
                        chosen
                    }
                    .to_owned(),
                )))
            }
            _ => {
                let model = builtin_model(chosen)
                    .or_else(|| builtin_model(DEFAULT_BUILTIN_MODEL))
                    .ok_or_else(|| CoreError::new(500, "No built-in embedding model"))?;
                Ok(Embedder::Builtin(
                    self.index.builtins.get(self.store.root(), model),
                ))
            }
        }
    }

    /// The index's state, as the settings page shows it.
    pub async fn index_status(&self, project_id: &str) -> Result<Value, CoreError> {
        let database = self.index_database(project_id).await?;
        let (files, chunks, updated, model) = with_database(&database, |connection| {
            let count = |table: &str| -> rusqlite::Result<i64> {
                connection.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
            };
            Ok((
                count("files")?,
                count("chunks")?,
                meta(connection, "updated_at")?,
                built_with(connection)?,
            ))
        })
        .await?;
        let pending = locked(&self.index.building)
            .get(project_id)
            .map(|job| job.pending.load(Ordering::SeqCst));
        let error = locked(&self.index.errors).get(project_id).cloned();
        let state = if pending.is_some() {
            "building"
        } else if error.is_some() {
            "error"
        } else if files > 0 {
            "ready"
        } else {
            "empty"
        };
        let mut status = Map::new();
        status.insert("projectId".to_owned(), json!(project_id));
        status.insert("state".to_owned(), json!(state));
        status.insert("files".to_owned(), json!(files));
        status.insert("chunks".to_owned(), json!(chunks));
        if let Some(pending) = pending {
            status.insert("pending".to_owned(), json!(pending));
        }
        if let Some(model) = model {
            status.insert("model".to_owned(), json!(model));
        }
        if let Some(updated) = updated {
            status.insert("updatedAt".to_owned(), json!(updated));
        }
        if let Some(error) = error {
            status.insert("error".to_owned(), json!(error));
        }
        Ok(Value::Object(status))
    }

    /// Indexes the project's files that changed since last time (by content hash) and forgets files that are gone. Runs in
    /// the background; the status reports progress. `paths` limits the pass to those files.
    pub async fn build_index(
        self: &Arc<Self>,
        project_id: &str,
        paths: Option<Vec<String>>,
    ) -> Result<Value, CoreError> {
        let root = self.workdir(project_id)?;
        let database = self.index_database(project_id).await?;
        if locked(&self.index.building).contains_key(project_id) && paths.is_none() {
            return self.index_status(project_id).await;
        }
        let id = self.index.next_job.fetch_add(1, Ordering::SeqCst);
        let pending = Arc::new(AtomicUsize::new(0));
        locked(&self.index.errors).remove(project_id);
        let end = PassEnd {
            kernel: Arc::clone(self),
            project_id: project_id.to_owned(),
            job: id,
        };
        let kernel = Arc::clone(self);
        let owned_project = project_id.to_owned();
        let counter = Arc::clone(&pending);
        {
            // Listed before the pass can end, so its end always finds its entry.
            let mut building = locked(&self.index.building);
            let task = tokio::spawn(async move {
                let _end = end;
                if let Err(error) = kernel.index_pass(&root, &database, paths, &counter).await {
                    let name = root
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    log(
                        "index",
                        "warning",
                        &format!("Indexing {name} failed: {}", error.message),
                    );
                    locked(&kernel.index.errors).insert(owned_project, error.message);
                }
            });
            building.insert(
                project_id.to_owned(),
                Job {
                    id,
                    pending,
                    abort: Some(task.abort_handle()),
                },
            );
        }
        self.index_status(project_id).await
    }

    /// One pass; a cancel drops it between awaits, and a file's rows go in together.
    async fn index_pass(
        &self,
        root: &Path,
        database: &Arc<Mutex<Connection>>,
        mut paths: Option<Vec<String>>,
        pending: &AtomicUsize,
    ) -> Result<(), CoreError> {
        let embedder = self.embedder()?;
        let current = embedder.id();
        // Vectors from another model mean nothing next to this one's: start the index over.
        let previous = with_database(database, |connection| built_with(connection)).await?;
        let name = root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        if previous
            .as_ref()
            .is_some_and(|previous| *previous != current)
        {
            with_database(database, |connection| {
                connection.execute_batch("DELETE FROM chunks; DELETE FROM files;")
            })
            .await?;
            log(
                "index",
                "info",
                &format!(
                    "The embedding model changed ({} → {current}); rebuilding the index of {name}",
                    previous.as_deref().unwrap_or("")
                ),
            );
            paths = None;
        }
        let whole = paths.is_none();
        let (todo, gone) = {
            let root = root.to_path_buf();
            let known = with_database(database, |connection| {
                let mut statement = connection.prepare("SELECT path, hash FROM files")?;
                let rows = statement.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?;
                rows.collect::<rusqlite::Result<HashMap<String, String>>>()
            })
            .await?;
            tokio::task::spawn_blocking(move || changed_files(&root, paths.as_deref(), &known))
                .await
                .map_err(|error| CoreError::new(500, error.to_string()))?
        };
        if whole {
            with_database(database, move |connection| {
                for relative in &gone {
                    forget(connection, relative)?;
                }
                Ok(())
            })
            .await?;
        }
        pending.store(todo.len(), Ordering::SeqCst);
        let changed = todo.len();
        for file in todo {
            let chunks = chunk_file(&file.relative, &file.content);
            let mut vectors = Vec::with_capacity(chunks.len());
            for batch in chunks.chunks(BATCH) {
                let inputs: Vec<String> = batch
                    .iter()
                    .map(|chunk| passage(&file.relative, chunk))
                    .collect();
                vectors.extend(
                    embedder
                        .embed(&inputs, EmbedKind::Passage)
                        .await
                        .map_err(embedding_failed)?,
                );
            }
            with_database(database, move |connection| {
                let transaction = connection.transaction()?;
                forget(&transaction, &file.relative)?;
                for (chunk, vector) in chunks.iter().zip(&vectors) {
                    let bytes: Vec<u8> = vector.iter().flat_map(|value| value.to_le_bytes()).collect();
                    transaction.execute(
                        "INSERT INTO chunks (path, start, end, name, text, vector) VALUES (?, ?, ?, ?, ?, ?)",
                        params![file.relative, chunk.start as i64, chunk.end as i64, chunk.name, chunk.text, bytes],
                    )?;
                }
                transaction.execute(
                    "INSERT OR REPLACE INTO files (path, hash, indexed_at) VALUES (?, ?, ?)",
                    params![file.relative, file.hash, iso_time(now_millis())],
                )?;
                transaction.commit()
            })
            .await?;
            pending.fetch_sub(1, Ordering::SeqCst);
        }
        with_database(database, move |connection| {
            connection.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES ('updated_at', ?)",
                [iso_time(now_millis())],
            )?;
            connection.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES ('embedder', ?)",
                [current],
            )?;
            connection.execute("DELETE FROM meta WHERE key = 'model'", [])?;
            Ok(())
        })
        .await?;
        if changed > 0 {
            let files = if changed == 1 { "file" } else { "files" };
            log(
                "index",
                "info",
                &format!("Indexed {changed} changed {files} of {name}"),
            );
        }
        Ok(())
    }

    /// Stops the project's pass, if one runs.
    pub fn cancel_index(&self, project_id: &str) {
        let abort = locked(&self.index.building)
            .get_mut(project_id)
            .and_then(|job| job.abort.take());
        if let Some(abort) = abort {
            abort.abort();
        }
    }

    /// The chunks most similar to `query`, best first.
    pub async fn search_index(
        self: &Arc<Self>,
        project_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Value, CoreError> {
        let database = self.index_database(project_id).await?;
        let question = query.trim();
        if question.is_empty() {
            return Ok(json!([]));
        }
        let embedder = self.embedder()?;
        let current = embedder.id();
        let previous = with_database(&database, |connection| built_with(connection)).await?;
        if let Some(previous) = previous.filter(|previous| *previous != current) {
            self.build_index(project_id, None).await.ok();
            return Err(CoreError::new(
                409,
                format!(
                    "The code index was built with {previous}; it is being rebuilt with {current}. Search again in a moment."
                ),
            ));
        }
        let wanted = embedder
            .embed(&[question.to_owned()], EmbedKind::Query)
            .await
            .map_err(embedding_failed)?
            .pop()
            .unwrap_or_default();
        with_database(&database, move |connection| {
            let mut statement =
                connection.prepare("SELECT path, start, end, name, text, vector FROM chunks")?;
            let rows = statement.query_map([], |row| {
                let bytes: Vec<u8> = row.get(5)?;
                let vector: Vec<f32> = bytes
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|four| f32::from_le_bytes(*four))
                    .collect();
                let mut hit = Map::new();
                hit.insert("path".to_owned(), json!(row.get::<_, String>(0)?));
                hit.insert("start".to_owned(), json!(row.get::<_, i64>(1)?));
                hit.insert("end".to_owned(), json!(row.get::<_, i64>(2)?));
                if let Some(name) = row
                    .get::<_, Option<String>>(3)?
                    .filter(|name| !name.is_empty())
                {
                    hit.insert("name".to_owned(), json!(name));
                }
                hit.insert("text".to_owned(), json!(row.get::<_, String>(4)?));
                Ok((cosine(&wanted, &vector), hit))
            })?;
            let mut scored = rows.collect::<rusqlite::Result<Vec<_>>>()?;
            // Equal scores keep the order they were stored in.
            scored.sort_by(|first, second| second.0.total_cmp(&first.0));
            Ok(Value::Array(
                scored
                    .into_iter()
                    .take(limit)
                    .map(|(score, mut hit)| {
                        let rounded = (f64::from(score) * 1000.0).round() / 1000.0;
                        hit.insert("score".to_owned(), json!(rounded));
                        Value::Object(hit)
                    })
                    .collect(),
            ))
        })
        .await
    }
}

/// The files whose content changed since they were indexed, and (of a whole pass) what is gone.
fn changed_files(
    root: &Path,
    paths: Option<&[String]>,
    known: &HashMap<String, String>,
) -> (Vec<Todo>, Vec<String>) {
    let files = paths.map_or_else(|| walk(root), |paths| named_files(root, paths));
    let mut todo = Vec::new();
    let mut seen = HashSet::new();
    for file in files {
        let relative = relative_of(root, &file);
        seen.insert(relative.clone());
        let Ok(info) = std::fs::metadata(&file) else {
            continue;
        };
        if !info.is_file() || info.len() > MAX_FILE_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&file) else {
            continue;
        };
        let content = String::from_utf8_lossy(&bytes).into_owned();
        if content.contains('\0') {
            continue;
        }
        let hash = saturn_domain::research::hex(&Sha1::digest(content.as_bytes()));
        if known.get(&relative) == Some(&hash) {
            continue;
        }
        todo.push(Todo {
            relative,
            hash,
            content,
        });
    }
    let gone = known
        .keys()
        .filter(|path| !seen.contains(*path))
        .cloned()
        .collect();
    (todo, gone)
}
