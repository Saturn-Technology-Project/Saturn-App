//! Saturn's local HTTP API. It speaks the same API and keeps the same data folder as the TypeScript runtime it is
//! replacing; `contract/` holds what both must do and `contract/routes.json` the routes still to bring over.
mod auth;
mod guards;

use std::env;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::routing::get;
use axum::{Json, Router, middleware};
use serde_json::{Value, json};

async fn health() -> Json<Value> {
    Json(json!({ "ok": true }))
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

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let host: IpAddr = env::var("SATURN_RUNTIME_HOST")
        .as_deref()
        .unwrap_or("127.0.0.1")
        .parse()?;
    let port: u16 = env::var("SATURN_RUNTIME_PORT")
        .as_deref()
        .unwrap_or("4700")
        .parse()?;
    let directory = data_directory()?;
    let launcher_token = env::var("SATURN_RUNTIME_TOKEN").ok();
    let token: Arc<str> = auth::load_or_create_token(&directory, launcher_token.as_deref())?.into();

    let app = Router::new()
        .route("/health", get(health))
        .layer(middleware::from_fn_with_state(token, guards::authenticate))
        .layer(middleware::from_fn(guards::cors));

    let listener = tokio::net::TcpListener::bind((host, port)).await?;
    println!("Saturn Runtime listening on http://{host}:{port}");
    axum::serve(listener, app)
        .with_graceful_shutdown(stop_requested())
        .await?;
    Ok(())
}
