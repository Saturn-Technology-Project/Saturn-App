//! Serves the interface on a loopback port, so the page keeps the origin the runtime's cross-origin rules allow.
use std::sync::Arc;

use axum::Router;
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use tauri::AppHandle;
use tokio::net::TcpListener;

const PREFERRED_PORT: u16 = 5174;
const HOST: &str = "127.0.0.1";

/// Starts the server; answers the port it listens on, 5174 unless something else has it.
pub async fn serve(app: AppHandle) -> std::io::Result<u16> {
    let listener = match TcpListener::bind((HOST, PREFERRED_PORT)).await {
        Ok(listener) => listener,
        Err(_) => TcpListener::bind((HOST, 0)).await?,
    };
    let port = listener.local_addr()?.port();
    let router = Router::new().fallback(asset).with_state(Arc::new(app));
    tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("The interface server stopped: {error}");
        }
    });
    Ok(port)
}

/// One file of the interface, from the assets built into the app (so there is no path on disk to escape).
async fn asset(State(app): State<Arc<AppHandle>>, request: Request) -> Response {
    let path = request.uri().path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    match app.asset_resolver().get(path.to_owned()) {
        Some(asset) => ([(header::CONTENT_TYPE, asset.mime_type.clone())], asset.bytes).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
