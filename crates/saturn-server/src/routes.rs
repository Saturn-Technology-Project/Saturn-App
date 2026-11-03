//! The agent loop's routes: agents, models, projects, chats, runs and permission rules, answering as `runtime/` does.
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use futures_util::stream::Stream;
use saturn_core::events::{EventWatch, run_fingerprint};
use saturn_core::run_images::parse_images;
use saturn_core::runs::StartOptions;
use saturn_core::{CoreError, Kernel};
use saturn_domain::permissions::{Scope, suggested_pattern};
use saturn_domain::prompt::RunMode;
use saturn_domain::time::{iso_time, now_millis};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

/// Live updates are worked out at most this often.
const THROTTLE: Duration = Duration::from_millis(120);

pub(crate) type Shared = State<Arc<Kernel>>;
/// A route's answer, or the status and message of why not.
pub(crate) type Answer = Result<Response, Failure>;
pub(crate) type Body = Option<Json<Value>>;
type QueryText = Query<std::collections::HashMap<String, String>>;

/// A failure as the API answers it.
pub(crate) struct Failure(CoreError);

impl From<CoreError> for Failure {
    fn from(error: CoreError) -> Self {
        Self(error)
    }
}

impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.0.status).unwrap_or(StatusCode::BAD_REQUEST);
        (status, Json(json!({ "error": self.0.message }))).into_response()
    }
}

pub(crate) fn ok(body: impl serde::Serialize) -> Answer {
    Ok(Json(json!(body)).into_response())
}

pub(crate) fn created(body: impl serde::Serialize) -> Answer {
    Ok((StatusCode::CREATED, Json(json!(body))).into_response())
}

/// A request's JSON body, or an empty object.
pub(crate) fn body_of(body: Body) -> Value {
    body.map_or_else(|| json!({}), |Json(value)| value)
}

/// A text field that holds something.
pub(crate) fn given<'a>(body: &'a Value, key: &str) -> Option<&'a str> {
    body.get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

pub(crate) fn layers_json(layers: &[saturn_core::permissions::LayerView]) -> Vec<Value> {
    layers
        .iter()
        .map(saturn_core::permissions::LayerView::to_json)
        .collect()
}

async fn list_agents(State(kernel): Shared) -> Answer {
    ok(kernel.list_agents().await?)
}

async fn create_agent(State(kernel): Shared, body: Body) -> Answer {
    created(kernel.create_agent(&body_of(body)).await?)
}

async fn get_agent(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    ok(kernel.get_agent(&id)?)
}

async fn agent_messages(
    State(kernel): Shared,
    Path(id): Path<String>,
    Query(query): QueryText,
) -> Answer {
    ok(kernel.messages_for(
        &id,
        query
            .get("threadId")
            .map(String::as_str)
            .filter(|id| !id.is_empty()),
    )?)
}

async fn list_models(State(kernel): Shared) -> Answer {
    ok(kernel.list_models())
}

async fn create_model(State(kernel): Shared, body: Body) -> Answer {
    created(kernel.create_model(&body_of(body)).await?)
}

async fn create_project(State(kernel): Shared, body: Body) -> Answer {
    created(kernel.create_project(&body_of(body)).await?)
}

async fn list_projects(State(kernel): Shared) -> Answer {
    ok(kernel.list_projects().await?)
}

async fn update_agent(State(kernel): Shared, Path(id): Path<String>, body: Body) -> Answer {
    ok(kernel.update_agent(&id, &body_of(body)).await?)
}

async fn delete_agent(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    kernel.delete_agent(&id).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// "Always allow" on a waiting card: saves an allow rule for that tool where the user chose, then approves the call.
async fn allow_always(
    State(kernel): Shared,
    Path((id, action_id)): Path<(String, String)>,
    body: Body,
) -> Answer {
    let run = kernel.get_run(&id)?;
    let action = run
        .get("actions")
        .and_then(Value::as_array)
        .and_then(|actions| {
            actions.iter().find(|item| {
                item.get("id").and_then(Value::as_str) == Some(&action_id)
                    && item.get("status").and_then(Value::as_str) == Some("waiting_approval")
            })
        })
        .ok_or_else(|| CoreError::new(409, "This approval is no longer waiting"))?;
    let body = body_of(body);
    let default_scope = json!("project");
    let chosen = body.get("scope").unwrap_or(&default_scope);
    let scope = scope_of(Some(chosen))?;
    let tool = action.get("toolId").and_then(Value::as_str).unwrap_or("");
    let given_pattern = saturn_domain::js::trim(given(&body, "pattern").unwrap_or(""));
    let arguments = action
        .get("arguments")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let pattern = if given_pattern.is_empty() {
        suggested_pattern(tool, &arguments)
    } else {
        given_pattern.to_owned()
    };
    let project = kernel.thread_project(&run);
    if scope == Scope::Project && project.is_none() {
        return Err(CoreError::new(
            400,
            "This chat is not in a project; choose Everywhere or This agent.",
        )
        .into());
    }
    let agent = run.get("agentId").and_then(Value::as_str);
    let rule = json!({ "tool": tool, "pattern": pattern, "effect": "allow" });
    kernel
        .add_permission_rule(scope, &rule, project.as_deref(), agent)
        .await?;
    kernel.decide(&id, &action_id, true).await?;
    ok(json!({ "ok": true, "rule": rule, "scope": chosen }))
}

/// An image the user attached to a message, for the chat to show.
async fn run_image(State(kernel): Shared, Path((id, index)): Path<(String, usize)>) -> Answer {
    let run = kernel.get_run(&id)?;
    let relative = run
        .get("inputImages")
        .and_then(|images| images.get(index))
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::new(404, "This message has no such image"))?;
    let (kind, bytes) = saturn_core::run_images::read_image(kernel.store.root(), relative)
        .await
        .ok_or_else(|| CoreError::new(404, "The image file is gone"))?;
    Ok(([(axum::http::header::CONTENT_TYPE, kind)], bytes).into_response())
}

async fn list_threads(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    ok(kernel.list_threads(&id).await?)
}

async fn create_thread(State(kernel): Shared, Path(id): Path<String>, body: Body) -> Answer {
    let body = body_of(body);
    created(
        kernel
            .create_thread(&id, given(&body, "title"), given(&body, "projectId"))
            .await?,
    )
}

async fn rename_thread(State(kernel): Shared, Path(id): Path<String>, body: Body) -> Answer {
    let body = body_of(body);
    ok(kernel
        .rename_thread(&id, given(&body, "title").unwrap_or(""))
        .await?)
}

async fn delete_thread(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    kernel.delete_thread(&id).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn thread_context(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    ok(kernel.context_usage(&id)?)
}

async fn compact_thread(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    ok(kernel.compact_thread(&id).await?)
}

async fn create_worktree(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    created(kernel.create_worktree(&id).await?)
}

async fn worktree_status(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    ok(kernel.worktree_status(&id).await?)
}

async fn finish_worktree(State(kernel): Shared, Path(id): Path<String>, body: Body) -> Answer {
    let body = body_of(body);
    let how = given(&body, "how").unwrap_or("");
    if !matches!(how, "merge" | "keep" | "discard") {
        return Err(CoreError::new(400, "how must be merge, keep or discard").into());
    }
    ok(kernel
        .finish_worktree(&id, how, given(&body, "message"))
        .await?)
}

async fn thread_jobs(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    ok(kernel.jobs.list(Some(&id)))
}

async fn stop_thread_job(State(kernel): Shared, Path((id, job)): Path<(String, String)>) -> Answer {
    let found = kernel.jobs.get(&job).filter(|item| item.scope == id);
    let found =
        found.ok_or_else(|| CoreError::new(404, "No such background command in this chat"))?;
    ok(kernel
        .jobs
        .stop(&found.id)
        .map_err(|message| CoreError::new(400, message))?)
}

async fn start_run(State(kernel): Shared, Path(id): Path<String>, body: Body) -> Answer {
    let body = body_of(body);
    let mode = match body.get("mode") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        Some(value) => Some(
            RunMode::parse(value.as_str())
                .ok_or_else(|| CoreError::new(400, "mode must be agent, ask or plan"))?,
        ),
    };
    let options = StartOptions {
        images: parse_images(body.get("images"))?,
        mode,
        ..StartOptions::default()
    };
    let input = saturn_domain::js::text(body.get("input"));
    created(
        kernel
            .start_run(
                &id,
                &input,
                given(&body, "threadId"),
                given(&body, "projectId"),
                options,
            )
            .await?,
    )
}

async fn recent_runs(State(kernel): Shared, Query(query): QueryText) -> Answer {
    let limit = query
        .get("limit")
        .and_then(|limit| limit.parse().ok())
        .filter(|limit| *limit != 0)
        .unwrap_or(20);
    ok(kernel.recent_runs(query.get("projectId").map(String::as_str), limit))
}

async fn pending_tasks(State(kernel): Shared) -> Answer {
    ok(kernel.pending_tasks())
}

async fn get_run(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    let run = kernel.get_run(&id)?;
    ok(kernel.with_children(run))
}

async fn revise_run(State(kernel): Shared, Path(id): Path<String>, body: Body) -> Answer {
    let input = saturn_domain::js::text(body_of(body).get("input"));
    ok(kernel.revise_run(&id, &input).await?)
}

async fn stop_run(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    ok(kernel.stop_run(&id).await?)
}

async fn wake_run(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    ok(kernel.wake_run(&id).await?)
}

async fn decide(
    State(kernel): Shared,
    Path((id, action)): Path<(String, String)>,
    body: Body,
) -> Answer {
    let allow = body_of(body).get("allow") == Some(&Value::Bool(true));
    kernel.decide(&id, &action, allow).await?;
    ok(json!({ "ok": true }))
}

async fn run_changes(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    ok(kernel.run_changes(&id).await?)
}

async fn change_content(
    State(kernel): Shared,
    Path(id): Path<String>,
    Query(query): QueryText,
) -> Answer {
    let before = query.get("side").is_some_and(|side| side == "before");
    ok(kernel
        .change_content(&id, query.get("path").map_or("", String::as_str), before)
        .await?)
}

async fn revert_changes(State(kernel): Shared, Path(id): Path<String>, body: Body) -> Answer {
    let body = body_of(body);
    ok(kernel
        .revert_run(&id, body.get("path").and_then(Value::as_str))
        .await?)
}

async fn keep_changes(State(kernel): Shared, Path(id): Path<String>, body: Body) -> Answer {
    let body = body_of(body);
    ok(kernel
        .keep_run(&id, body.get("path").and_then(Value::as_str))
        .await?)
}

async fn restore(State(kernel): Shared, Path(id): Path<String>, body: Body) -> Answer {
    let body = body_of(body);
    match body.get("actionId").and_then(Value::as_str) {
        Some(action) => ok(kernel.restore_to_step(&id, action).await?),
        None => ok(kernel.restore_to(&id).await?),
    }
}

/// A permission scope a request names.
fn scope_of(value: Option<&Value>) -> Result<Scope, Failure> {
    value
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .ok_or_else(|| {
            CoreError::new(
                400,
                "scope must be one of user, project, agent, project-file, claude-file",
            )
            .into()
        })
}

async fn permission_layers(State(kernel): Shared, Query(query): QueryText) -> Answer {
    let text = |key: &str| {
        query
            .get(key)
            .map(String::as_str)
            .filter(|id| !id.is_empty())
    };
    ok(layers_json(
        &kernel
            .permission_layers(text("agentId"), text("projectId"))
            .await,
    ))
}

async fn add_rule(State(kernel): Shared, body: Body) -> Answer {
    let body = body_of(body);
    let rule = body.get("rule").cloned().unwrap_or(Value::Null);
    let layers = kernel
        .add_permission_rule(
            scope_of(body.get("scope"))?,
            &rule,
            given(&body, "projectId"),
            given(&body, "agentId"),
        )
        .await?;
    created(layers_json(&layers))
}

async fn remove_rule(State(kernel): Shared, body: Body) -> Answer {
    let body = body_of(body);
    let rule = body.get("rule").cloned().unwrap_or(Value::Null);
    let layers = kernel
        .remove_permission_rule(
            scope_of(body.get("scope"))?,
            &rule,
            given(&body, "projectId"),
            given(&body, "agentId"),
        )
        .await?;
    ok(layers_json(&layers))
}

/// An event for a stream.
fn event(name: &str, data: &Value) -> Event {
    Event::default().event(name).data(data.to_string())
}

/// A server-sent event stream fed by a task. The task ends when the client goes, since its sends then fail.
fn stream_of(rx: mpsc::Receiver<Event>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    use futures_util::StreamExt;
    Sse::new(ReceiverStream::new(rx).map(Ok)).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(20))
            .text("keep-alive"),
    )
}

/// Live updates: which runs changed, and whether anything else did.
async fn events(State(kernel): Shared) -> Response {
    let (tx, rx) = mpsc::channel(32);
    let mut changes = kernel.store.changes();
    tokio::spawn(async move {
        let _ = tx
            .send(Event::default().retry(Duration::from_secs(2)).comment(""))
            .await;
        if tx
            .send(event("ready", &json!({ "at": iso_time(now_millis()) })))
            .await
            .is_err()
        {
            return;
        }
        let mut watch = kernel.store.read(EventWatch::new);
        while changes.changed().await.is_ok() {
            tokio::time::sleep(THROTTLE).await;
            changes.borrow_and_update();
            if let Some(change) = kernel.store.read(|state| watch.changes(state))
                && tx.send(event("change", &change)).await.is_err()
            {
                return;
            }
        }
    });
    stream_of(rx).into_response()
}

/// One run as it changes, with its sub-agents' changes, which show nested in its steps.
async fn run_events(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    let current = kernel.get_run(&id)?;
    let (tx, rx) = mpsc::channel(32);
    let mut changes = kernel.store.changes();
    tokio::spawn(async move {
        let _ = tx
            .send(Event::default().retry(Duration::from_secs(2)).comment(""))
            .await;
        let print = |kernel: &Kernel, run: &Value| {
            let children = kernel.children_statuses(&id);
            format!("{}{children}", run_fingerprint(run))
        };
        let mut last = print(&kernel, &current);
        if tx
            .send(event("run", &kernel.with_children(current)))
            .await
            .is_err()
        {
            return;
        }
        while changes.changed().await.is_ok() {
            tokio::time::sleep(THROTTLE).await;
            changes.borrow_and_update();
            let Ok(run) = kernel.get_run(&id) else {
                let _ = tx.send(event("gone", &json!({ "id": id }))).await;
                return;
            };
            let next = print(&kernel, &run);
            if next == last {
                continue;
            }
            last = next;
            if tx
                .send(event("run", &kernel.with_children(run)))
                .await
                .is_err()
            {
                return;
            }
        }
    });
    Ok(stream_of(rx).into_response())
}

/// The routes the agent loop needs.
pub fn router(kernel: Arc<Kernel>) -> Router {
    Router::new()
        .route("/agents", get(list_agents).post(create_agent))
        .route(
            "/agents/{id}",
            get(get_agent).patch(update_agent).delete(delete_agent),
        )
        .route("/agents/{id}/messages", get(agent_messages))
        .route(
            "/agents/{id}/threads",
            get(list_threads).post(create_thread),
        )
        .route("/agents/{id}/runs", post(start_run))
        .route("/connections/models", get(list_models).post(create_model))
        .route("/projects", get(list_projects).post(create_project))
        .route(
            "/threads/{id}",
            axum::routing::patch(rename_thread).delete(delete_thread),
        )
        .route("/threads/{id}/context", get(thread_context))
        .route("/threads/{id}/compact", post(compact_thread))
        .route(
            "/threads/{id}/worktree",
            get(worktree_status).post(create_worktree),
        )
        .route("/threads/{id}/worktree/finish", post(finish_worktree))
        .route("/threads/{id}/jobs", get(thread_jobs))
        .route("/threads/{id}/jobs/{job}/stop", post(stop_thread_job))
        .route("/tasks", get(pending_tasks))
        .route("/runs", get(recent_runs))
        .route("/runs/{id}", get(get_run).patch(revise_run))
        .route(
            "/runs/{id}/actions/{action}/allow-always",
            post(allow_always),
        )
        .route("/runs/{id}/images/{index}", get(run_image))
        .route("/runs/{id}/stop", post(stop_run))
        .route("/runs/{id}/wake", post(wake_run))
        .route("/runs/{id}/events", get(run_events))
        .route("/runs/{id}/actions/{action}/decision", post(decide))
        .route("/runs/{id}/changes", get(run_changes))
        .route("/runs/{id}/changes/file", get(change_content))
        .route("/runs/{id}/changes/revert", post(revert_changes))
        .route("/runs/{id}/changes/keep", post(keep_changes))
        .route("/runs/{id}/restore", post(restore))
        .route("/permissions", get(permission_layers))
        .route("/permissions/rules", post(add_rule).delete(remove_rule))
        .route("/events", get(events))
        .with_state(kernel)
}
