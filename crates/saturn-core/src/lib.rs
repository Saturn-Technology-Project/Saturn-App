//! The agent loop: a model's turns, its tool calls and approvals, hooks, compaction, sub-agents and checkpoints.
//! `contract/loop.test.mjs` drives it over HTTP. Stopping a run aborts its task: what it
//! was waiting for is dropped, and a command it was running ends with its whole process group.
use std::collections::{HashMap, HashSet};
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use saturn_browser::Browser;
/// How often the browser's live view sends a viewer a frame.
pub use saturn_browser::Pace;
use saturn_computer::Computer;
use saturn_llm::{Broker, Http, LlmError};
use saturn_mcp::{McpClient, McpError};
use saturn_store::FileStore;
use saturn_tools::jobs::JobTable;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::AbortHandle;

pub mod admin;
pub mod agent_programs;
mod agent_sessions;
pub mod agent_tools;
pub mod automations;
pub mod builtins;
pub mod catalog;
pub mod checkpoints;
mod claude_code;
pub mod cli_install;
mod codex;
pub mod completions;
pub mod context;
pub mod events;
pub mod groups;
pub mod hooks;
pub mod index;
pub mod logger;
pub mod marketplace;
pub mod memory;
mod origin;
pub mod permissions;
pub mod plugins;
pub mod projects;
pub mod pull_requests;
pub mod recordings;
pub mod records;
pub mod research;
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

impl From<McpError> for CoreError {
    fn from(error: McpError) -> Self {
        Self::new(400, error.to_string())
    }
}

/// Where providers send the browser back after an MCP sign-in.
fn oauth_redirect() -> String {
    let host = std::env::var("SATURN_RUNTIME_HOST").unwrap_or_else(|_| "127.0.0.1".to_owned());
    let port = std::env::var("SATURN_RUNTIME_PORT").unwrap_or_else(|_| "4700".to_owned());
    format!("http://{host}:{port}/oauth/callback")
}

/// Opens a web address in the user's browser. Only a web address: a server's metadata names this one.
fn open_in_browser(address: &str) {
    if !(address.starts_with("https://") || address.starts_with("http://")) {
        log(
            "mcp",
            "warning",
            "Refused to open a sign-in page that is not a web address",
        );
        return;
    }
    if cfg!(target_os = "macos") {
        projects::launch_app("the browser", "open", &[address], None);
    } else if cfg!(windows) {
        projects::launch_app(
            "the browser",
            "rundll32",
            &["url.dll,FileProtocolHandler", address],
            None,
        );
    } else {
        projects::launch_app("the browser", "xdg-open", &[address], None);
    }
}

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
    pub mcp: McpClient,
    /// Background commands agents started.
    pub jobs: JobTable,
    /// The agent's browser; it closes itself when idle.
    pub browser: Browser,
    /// The computer-use tools, which remember the element ids they handed out.
    pub computer: Computer,
    /// Claude Code and Codex: downloads, waiting cards, and what runs for them.
    pub programs: agent_programs::ProgramState,
    /// The running pass of each run, by "<run>:<generation>", so stopping can abort it.
    stops: Mutex<HashMap<String, AbortHandle>>,
    /// One capture at a time per run, so parallel tool calls on one file keep the first original.
    checkpoint_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    /// Folders outside git too big to snapshot, until when (in milliseconds) they are not tried again.
    too_big: Mutex<HashMap<PathBuf, i64>>,
    /// What each sealed run's samples add up to, so that a large file is read once.
    run_digests: Mutex<HashMap<PathBuf, Arc<research::RunDigest>>>,
    /// Held while a digest is made, so that two screens asking together do not read a large file twice.
    digesting: AsyncMutex<()>,
    tracked_jobs: Mutex<HashMap<String, Arc<TrackedJob>>>,
    /// Chats whose memory is being extracted.
    extracting: Mutex<HashSet<String>>,
    /// The newest message waiting for a member that is still on its turn, by "<group>:<agent>".
    group_queue: Mutex<HashMap<String, serde_json::Value>>,
    /// The projects' code indexes.
    index: index::IndexState,
    /// Chats whose pull request is being looked at.
    checking_pull_requests: Mutex<HashSet<String>>,
    /// The projects' research records.
    research: research::ResearchState,
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
            mcp: McpClient::new(
                Arc::clone(&store),
                oauth_redirect(),
                Arc::new(open_in_browser),
            )?,
            computer: Computer::new(store.root()),
            browser: Browser::new(store.root(), std::env::var("SATURN_SAFARI_ENDPOINT").ok()),
            store,
            jobs: JobTable::new(),
            programs: agent_programs::ProgramState::default(),
            stops: Mutex::default(),
            checkpoint_locks: Mutex::default(),
            too_big: Mutex::default(),
            run_digests: Mutex::default(),
            digesting: AsyncMutex::new(()),
            tracked_jobs: Mutex::default(),
            extracting: Mutex::default(),
            group_queue: Mutex::default(),
            index: index::IndexState::default(),
            checking_pull_requests: Mutex::default(),
            research: research::ResearchState::default(),
        }))
    }
}
