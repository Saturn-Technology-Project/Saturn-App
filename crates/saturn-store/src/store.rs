//! The data folder as the rest of the runtime sees it: the state in memory, and every change written to disk in order.
use std::borrow::Cow;
use std::fs;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Instant;

use saturn_telemetry::{Kind, Span};
use serde_json::{Value, json};
use tokio::sync::{Mutex as AsyncMutex, watch};
use tokio::task;

use crate::secrets::{Secrets, SecretsFile, SecretsProtection};
use crate::state::AppState;
use crate::{json, set_aside, write_private};

/// A change's save, and what the change returned.
pub type Saving<'a, R> = Pin<Box<dyn Future<Output = io::Result<R>> + Send + 'a>>;

/// What changes together, under one lock.
struct Contents {
    state: AppState,
    secrets: Secrets,
    /// Whether `secrets` differs from `secrets.json`, including after a write that failed.
    secrets_changed: bool,
}

/// The state and secrets of a data folder. Changes apply at once and reach the disk in the order they were made.
pub struct FileStore {
    directory: PathBuf,
    /// What was wrong with `state.json` when it was read, for the log.
    load_problem: Option<String>,
    contents: Mutex<Contents>,
    /// Holds the writes in order; a write keeps it until finished, even if whoever asked for it stopped waiting.
    writing: Arc<AsyncMutex<SecretsFile>>,
    changes: watch::Sender<u64>,
}

impl FileStore {
    /// Reads the data folder, creating it on a first start. Uses the operating system's key store.
    pub async fn load(directory: &Path) -> io::Result<Self> {
        Self::load_with(directory, SecretsFile::new(directory)).await
    }

    /// Reads the data folder with a given secrets file (tests choose its key store with this).
    pub async fn load_with(directory: &Path, mut secrets_file: SecretsFile) -> io::Result<Self> {
        let owned = directory.to_path_buf();
        let (state, load_problem, secrets, secrets_file) = task::spawn_blocking(move || {
            fs::create_dir_all(&owned)?;
            let (state, problem) = read_state(&owned)?;
            let secrets = secrets_file.load()?;
            io::Result::Ok((state, problem, secrets, secrets_file))
        })
        .await
        .map_err(io::Error::other)??;
        Ok(Self {
            directory: directory.to_path_buf(),
            load_problem,
            contents: Mutex::new(Contents {
                state,
                secrets,
                secrets_changed: false,
            }),
            writing: Arc::new(AsyncMutex::new(secrets_file)),
            changes: watch::channel(0).0,
        })
    }

    /// What was wrong with `state.json` at the start, if anything.
    pub fn load_problem(&self) -> Option<&str> {
        self.load_problem.as_deref()
    }

    pub fn root(&self) -> &Path {
        &self.directory
    }

    fn locked(&self) -> MutexGuard<'_, Contents> {
        // A change that panicked leaves a state that is still valid JSON, which is what this lock protects.
        self.contents.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Reads the state.
    pub fn read<R>(&self, reader: impl FnOnce(&AppState) -> R) -> R {
        reader(&self.locked().state)
    }

    /// Changes the state at once and returns the save to wait for. When saving fails the change stays in memory and the next save
    /// writes it too, as it does if the save is dropped before it starts.
    pub fn update<'a, R: Send + 'a>(
        &'a self,
        change: impl FnOnce(&mut AppState) -> R,
    ) -> Saving<'a, R> {
        self.apply(|contents| change(&mut contents.state))
    }

    /// A secret's value. Never log it or return it to a client.
    pub fn secret(&self, id: &str) -> Option<String> {
        self.locked().secrets.get(id).cloned()
    }

    pub fn put_secret<'a>(&'a self, id: &str, value: &str) -> Saving<'a, ()> {
        self.apply(|contents| {
            contents.secrets.insert(id.to_owned(), value.to_owned());
            contents.secrets_changed = true;
        })
    }

    pub fn delete_secret<'a>(&'a self, id: &str) -> Saving<'a, ()> {
        self.apply(|contents| {
            contents.secrets_changed |= contents.secrets.remove(id).is_some();
        })
    }

    /// How API keys and tokens are protected on disk.
    pub async fn secrets_protection(&self) -> SecretsProtection {
        self.writing.lock().await.protection()
    }

    /// Follows saved changes, for the event streams: the value moves on after each one.
    pub fn changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    /// Applies a change and returns its save.
    fn apply<'a, R: Send + 'a>(&'a self, change: impl FnOnce(&mut Contents) -> R) -> Saving<'a, R> {
        let result = change(&mut self.locked());
        Box::pin(async move {
            self.save().await?;
            Ok(result)
        })
    }

    /// Writes what is in memory now, so a later save always holds at least what an earlier one did. The state is written every
    /// time; the secrets, whose key may live behind a system tool, only when they changed.
    async fn save(&self) -> io::Result<()> {
        let runs = self.read(|state| state.runs.len());
        let span = Span::start(
            "store.persist",
            Kind::Internal,
            json!({ "saturn.store.runs": runs }),
        );
        let started = Instant::now();
        let saved = span.scope(self.write_out()).await;
        match &saved {
            Ok(()) => saturn_telemetry::record(
                "saturn.store.write.duration",
                started.elapsed().as_secs_f64(),
                json!({}),
            ),
            Err(error) => span.fail(&error.to_string(), "Error"),
        }
        saved
    }

    /// The save itself.
    async fn write_out(&self) -> io::Result<()> {
        let mut secrets_file = Arc::clone(&self.writing).lock_owned().await;
        let (state_text, changed_secrets) = {
            let mut contents = self.locked();
            let state_text = serde_json::to_string_pretty(&contents.state)?;
            let changed_secrets = contents.secrets_changed.then(|| contents.secrets.clone());
            contents.secrets_changed = false;
            (state_text, changed_secrets)
        };
        let directory = self.directory.clone();
        let failed_secrets = changed_secrets.is_some();
        let written = task::spawn_blocking(move || {
            write_private(&directory.join("state.json"), state_text.as_bytes())?;
            match changed_secrets {
                Some(secrets) => secrets_file.save(&secrets),
                None => Ok(()),
            }
        })
        .await
        .map_err(io::Error::other)?;
        if let Err(error) = written {
            eprintln!(
                "[store] Could not save state to {}: {error}",
                self.directory.display()
            );
            self.locked().secrets_changed |= failed_secrets;
            return Err(error);
        }
        self.changes.send_modify(|count| *count += 1);
        Ok(())
    }
}

/// `state.json`'s contents. A missing file is a first start. An unusable one would be overwritten by the next save, so a copy
/// is kept next to it and the loss is logged. An error means it could not be read at all, and starting empty would destroy it.
fn read_state(directory: &Path) -> io::Result<(AppState, Option<String>)> {
    let file = directory.join("state.json");
    let raw = match fs::read(&file) {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok((AppState::default(), None));
        }
        Err(error) => return Err(error),
    };
    let mut clipped = false;
    let parsed = std::str::from_utf8(&raw)
        .map_err(|error| error.to_string())
        .and_then(|text| {
            let within_depth = json::clip_deep_values(text);
            clipped = matches!(within_depth, Cow::Owned(_));
            json::parse::<Value>(&within_depth).map_err(|error| error.to_string())
        });
    let (state, problem) = match parsed {
        Ok(Value::Object(saved)) => {
            let (state, damaged) = AppState::from_saved(&saved);
            let problem = if damaged {
                Some("has a part of the wrong type".to_owned())
            } else {
                clipped.then(|| format!("nests values deeper than {} levels", json::MAX_DEPTH))
            };
            (state, problem)
        }
        Ok(_) => (AppState::default(), Some("is not a JSON object".to_owned())),
        Err(error) => (
            AppState::default(),
            Some(format!("is not valid JSON ({error})")),
        ),
    };
    let problem = problem.map(|problem| {
        let kept =
            set_aside(&file, "unreadable").unwrap_or_else(|| "(no copy could be made)".to_owned());
        format!(
            "state.json {problem}; what could not be read starts empty or is cut off. The old file was kept as {kept}"
        )
    });
    Ok((state, problem))
}
