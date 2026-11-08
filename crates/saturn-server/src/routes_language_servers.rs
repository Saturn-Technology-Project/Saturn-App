//! The editor's authenticated stdio bridge. The core validates messages and owns every child process.
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use axum::response::sse::Event;
use axum::routing::{get, post};
use saturn_core::Kernel;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;

use crate::routes::{Answer, Body, Shared, body_of, given, ok, stream_of};

/// Start an installed server in the granted project.
async fn start(State(kernel): Shared, Path(project): Path<String>, body: Body) -> Answer {
    let body = body_of(body);
    ok(kernel
        .research_lsp_start(&project, given(&body, "language").unwrap_or(""))
        .await?)
}

/// Forward ordered JSON-RPC messages, after the core validates their methods and document URIs.
async fn send(
    State(kernel): Shared,
    Path((project, session)): Path<(String, String)>,
    body: Body,
) -> Answer {
    let body = body_of(body);
    ok(kernel
        .research_lsp_send(&project, &session, &body["messages"])
        .await?)
}

/// Close a server when its workspace closes or the person restarts the connection.
async fn stop(State(kernel): Shared, Path((project, session)): Path<(String, String)>) -> Answer {
    ok(kernel.research_lsp_stop(&project, &session).await?)
}

/// Subscribe to messages; replay closes the race between starting the process and attaching a client.
async fn events(
    State(kernel): Shared,
    Path((project, session)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Answer {
    let after = query.get("after").and_then(|value| value.parse().ok());
    let mut messages = kernel
        .research_lsp_events(&project, &session, after)
        .await?;
    let (sender, receiver) = mpsc::channel(4);
    tokio::spawn(async move {
        if sender
            .send(Event::default().event("lsp").data("{\"connected\":true}"))
            .await
            .is_err()
        {
            return;
        }
        loop {
            tokio::select! {
                _ = sender.closed() => break,
                line = messages.recv() => match line {
                    Some(line) => if sender.send(Event::default().event("lsp").data(line)).await.is_err() { break; },
                    None => break,
                }
            }
        }
    });
    Ok(stream_of(receiver).into_response())
}

/// Register the small transport surface separately from the research-record routes.
pub fn router(kernel: Arc<Kernel>) -> Router {
    Router::new()
        .route("/projects/{id}/research/lsp/start", post(start))
        .route("/projects/{id}/research/lsp/{session}/messages", post(send))
        .route("/projects/{id}/research/lsp/{session}/events", get(events))
        .route(
            "/projects/{id}/research/lsp/{session}",
            axum::routing::delete(stop),
        )
        .with_state(kernel)
}
