//! The agent loop: a model's turns, its tool calls and approvals, hooks, compaction, sub-agents and checkpoints. Behaviour
//! matches `runtime/src/application`; `contract/loop.test.mjs` drives both over HTTP. Stopping a run aborts its task: what it
//! was waiting for is dropped, and a command it was running ends with its whole process group.
use std::collections::{HashMap, HashSet};
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use saturn_llm::{Broker, Http, LlmError};
use saturn_store::FileStore;
use saturn_tools::jobs::JobTable;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::AbortHandle;

pub mod admin;
pub mod builtins;
pub mod catalog;
pub mod checkpoints;
pub mod context;
pub mod events;
pub mod hooks;
pub mod logger;
pub mod memory;
pub mod permissions;
pub mod projects;
pub mod records;
pub mod rules;
pub mod run_images;
pub mod runs;
pub mod skill_files;
pub mod usage;
pub mod verify;
pub mod worktrees;

pub mod history;
mod tool_runs;

/// A failure an API answer can carry: its status and a message for the user.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoreError {
    pub status: u16,
    pub message: String,
}

impl CoreError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CoreError {}

impl From<io::Error> for CoreError {
    fn from(error: io::Error) -> Self {
        Self::new(500, error.to_string())
    }
}

impl From<LlmError> for CoreError {
    fn from(error: LlmError) -> Self {
        // A provider's own status says what happened there, not what this API call did.
        Self::new(
            if error.status == Some(409) { 409 } else { 400 },
            error.message,
        )
    }
}

pub use logger::log;

/// A run's background command whose file changes are recorded, against the snapshot taken when it started.
pub(crate) struct TrackedJob {
    pub run_id: String,
    pub snapshot: checkpoints::CommandSnapshot,
    pub action_id: String,
}

/// Shared local runtime state.
pub struct Kernel {
    pub store: Arc<FileStore>,
    pub broker: Broker<FileStore>,
    /// Background commands agents started.
    pub jobs: JobTable,
    /// The running pass of each run, by "<run>:<generation>", so stopping can abort it.
    stops: Mutex<HashMap<String, AbortHandle>>,
    /// One capture at a time per run, so parallel tool calls on one file keep the first original.
    checkpoint_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    /// Folders outside git too big to snapshot, until when (in milliseconds) they are not tried again.
    too_big: Mutex<HashMap<PathBuf, i64>>,
    tracked_jobs: Mutex<HashMap<String, Arc<TrackedJob>>>,
    /// Chats whose memory is being extracted.
    extracting: Mutex<HashSet<String>>,
}

/// Locks a table; a panic elsewhere leaves it usable.
pub(crate) fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Kernel {
    /// The runtime over a loaded data folder.
    pub fn new(store: Arc<FileStore>) -> Result<Arc<Self>, CoreError> {
        Self::with_http(store, Http::new()?)
    }

    /// The same with a given HTTP client (tests shorten its retries).
    pub fn with_http(store: Arc<FileStore>, http: Http) -> Result<Arc<Self>, CoreError> {
        Ok(Arc::new(Self {
            broker: Broker::new(Arc::clone(&store), http),
            store,
            jobs: JobTable::new(),
            stops: Mutex::default(),
            checkpoint_locks: Mutex::default(),
            too_big: Mutex::default(),
            tracked_jobs: Mutex::default(),
            extracting: Mutex::default(),
        }))
    }
}
