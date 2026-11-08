//! Saturn's local HTTP API. It speaks the same API and keeps the same data folder as the TypeScript runtime it is
//! replacing; `contract/` holds what both must do and `contract/routes.json` the routes still to bring over.
mod auth;
mod guards;
mod routes;
mod routes_admin;
mod routes_language_servers;
mod routes_research;

use std::env;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::routing::get;
use axum::{Json, middleware};
use saturn_core::Kernel;
use saturn_store::FileStore;
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;

/// How long connections get to finish once the runtime is stopping.
const LAST_CONNECTIONS: std::time::Duration = std::time::Duration::from_secs(2);
/// How long stopping may take in all: a step that hangs must not keep the runtime, and whoever waits on it, running.
const STOP_LIMIT: std::time::Duration = std::time::Duration::from_secs(10);
/// Which step of stopping is under way, so a runtime that has to give up says where it was held.
static STOPPING_STEP: std::sync::Mutex<&str> = std::sync::Mutex::new("");

/// Notes the step of stopping that starts now.
fn stopping_step(step: &'static str) {
    if let Ok(mut current) = STOPPING_STEP.lock() {
        *current = step;
    }
}
/// The largest request body, which leaves room for a message's images.
const BODY_LIMIT: usize = 10 * 1024 * 1024;

/// Which runtime this is: the id its launcher gave it, or one of its own, so a launcher can tell its runtime from
/// another Saturn on the same port.
static INSTANCE: std::sync::OnceLock<String> = std::sync::OnceLock::new();

fn instance() -> &'static str {
    INSTANCE.get_or_init(|| {
        env::var("SATURN_RUNTIME_INSTANCE")
            .ok()
            .filter(|given| !given.is_empty())
            .unwrap_or_else(|| saturn_domain::random_hex(8).unwrap_or_default())
    })
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION"), "instance": instance() }))
}

/// The folder Saturn keeps its data in: `SATURN_DATA_DIR`, or `~/.saturn-app`.
fn data_directory() -> Result<PathBuf, &'static str> {
    if let Some(directory) = env::var_os("SATURN_DATA_DIR") {
        return Ok(directory.into());
    }
    env::home_dir()
        .map(|home| home.join(".saturn-app"))
        .ok_or("No home folder: set SATURN_DATA_DIR")
}

/// Ends when the system asks this process to stop.
async fn stop_requested() {
    tokio::select! {
        () = system_asks_to_stop() => {}
        () = app_is_gone() => {}
    }
}

async fn system_asks_to_stop() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut terminate =
            signal(SignalKind::terminate()).expect("the terminate signal can be watched");
        tokio::select! {
            _ = terminate.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

/// Started by the desktop app, the runtime holds a pipe from it. The pipe closes when the app asks the runtime to stop, on every
/// system, and when the app crashed or was force-quit and could not ask. Started any other way, this never ends.
async fn app_is_gone() {
    if env::var("SATURN_DESKTOP_ATTACHED").as_deref() != Ok("1") {
        return std::future::pending().await;
    }
    let mut pipe = tokio::io::stdin();
    let mut chunk = [0_u8; 256];
    while matches!(pipe.read(&mut chunk).await, Ok(read) if read > 0) {}
    saturn_core::logger::log("runtime", "info", "The Saturn app is gone; stopping");
}

/// Resumes sleeping runs whose wake time has come, including runs that slept through a restart.
fn start_wakeups(kernel: Arc<Kernel>) {
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            timer.tick().await;
            kernel.wake_due().await;
        }
    });
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<String> = env::args().collect();
    if arguments.get(1).is_some_and(|argument| {
        argument == "--research-worker" || argument == "--research-worker-execute"
    }) {
        saturn_core::research::worker_entry(
            arguments[1].as_str(),
            arguments.get(2).map(String::as_str),
        )
        .await?;
        return Ok(());
    }
    // An address or a name, as the TypeScript runtime takes it.
    let host = env::var("SATURN_RUNTIME_HOST").unwrap_or_else(|_| "127.0.0.1".to_owned());
    let port: u16 = env::var("SATURN_RUNTIME_PORT")
        .as_deref()
        .unwrap_or("4700")
        .parse()?;
    let directory = data_directory()?;
    let launcher_token = env::var("SATURN_RUNTIME_TOKEN").ok();
    let token: Arc<str> = auth::load_or_create_token(&directory, launcher_token.as_deref())?.into();

    // Before anything can send a request: every one from here on is recorded (Settings → Telemetry → Network).
    saturn_telemetry::network::start(&directory);
    let telemetry = saturn_telemetry::start(&directory).await;
    let store = Arc::new(FileStore::load(&directory).await?);
    if let Some(problem) = store.load_problem() {
        saturn_core::logger::log("store", "error", problem);
    }
    let kernel = Kernel::new(store)?;
    kernel.ensure_builtins().await?;
    if let Some(level) = kernel.settings().get("logging").and_then(Value::as_str) {
        saturn_core::logger::set_level(level);
    }
    match telemetry {
        Ok(note) => saturn_core::logger::log("telemetry", "info", &note),
        Err(note) => saturn_core::logger::log("telemetry", "warning", &note),
    }
    let counted = Arc::clone(&kernel);
    saturn_telemetry::set_active_runs(move || {
        counted.store.read(|state| {
            state
                .runs
                .iter()
                .filter(|run| {
                    matches!(
                        run.get("status").and_then(Value::as_str),
                        Some("running" | "queued")
                    )
                })
                .count()
        })
    });
    kernel.recover_interrupted().await?;
    kernel.research_recover().await;
    kernel.sweep_worktrees().await;
    start_wakeups(Arc::clone(&kernel));
    kernel.resume_group_turns();
    kernel.start_automations();
    kernel.start_pull_requests();

    let app = routes::router(Arc::clone(&kernel))
        .merge(routes_admin::router(Arc::clone(&kernel)))
        .merge(routes_research::router(Arc::clone(&kernel)))
        .merge(routes_language_servers::router(Arc::clone(&kernel)))
        .route("/health", get(health))
        .layer(middleware::from_fn(guards::trace_requests))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .layer(middleware::from_fn_with_state(token, guards::authenticate))
        .layer(middleware::from_fn(guards::cors));

    let stopping = Arc::clone(&kernel);
    let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await?;
    println!("Saturn Runtime listening on http://{host}:{port}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            stop_requested().await;
            // However the steps below go, the runtime is gone within the limit, and says which step held it.
            tokio::spawn(async {
                tokio::time::sleep(STOP_LIMIT).await;
                let step = STOPPING_STEP.lock().map(|step| *step).unwrap_or_default();
                eprintln!(
                    "Saturn Runtime: stopping took longer than {} s, at {step}; exiting",
                    STOP_LIMIT.as_secs()
                );
                std::process::exit(0);
            });
            // What runs on the runtime's behalf ends with it. A client still listening must not hold it open.
            stopping_step("jobs");
            stopping.jobs.stop_all(None);
            stopping_step("research runs");
            stopping.research_end_runs().await;
            stopping_step("notebooks");
            stopping.research_notebooks_stop_all().await;
            stopping_step("language servers");
            stopping.research_lsp_stop_all().await;
            stopping_step("agent programs");
            stopping.stop_programs();
            stopping_step("the browser");
            stopping.browser.close().await;
            stopping_step("telemetry");
            saturn_telemetry::stop().await;
            stopping_step("last connections");
            tokio::spawn(async {
                tokio::time::sleep(LAST_CONNECTIONS).await;
                std::process::exit(0);
            });
        })
        .await?;
    Ok(())
}
