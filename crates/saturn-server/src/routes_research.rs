//! Research records, in the project's own folder. `docs/research-contract.md` is the contract.
use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use saturn_core::Kernel;
use serde_json::Value;

use crate::routes::{Answer, Body, Shared, body_of, created, given, ok};

async fn list(
    State(kernel): Shared,
    Path((project, collection)): Path<(String, String)>,
) -> Answer {
    ok(kernel.research_list(&project, &collection).await?)
}

async fn create(
    State(kernel): Shared,
    Path((project, collection)): Path<(String, String)>,
    body: Body,
) -> Answer {
    created(
        kernel
            .research_create(&project, &collection, &body_of(body))
            .await?,
    )
}

async fn record(
    State(kernel): Shared,
    Path((project, collection, id)): Path<(String, String, String)>,
) -> Answer {
    ok(kernel.research_record(&project, &collection, &id).await?)
}

async fn update(
    State(kernel): Shared,
    Path((project, collection, id)): Path<(String, String, String)>,
    body: Body,
) -> Answer {
    ok(kernel
        .research_update(&project, &collection, &id, &body_of(body))
        .await?)
}

async fn freeze(
    State(kernel): Shared,
    Path((project, experiment)): Path<(String, String)>,
    body: Body,
) -> Answer {
    let body = body_of(body);
    let (version, new) = kernel
        .research_freeze(&project, &experiment, given(&body, "threadId"))
        .await?;
    if new { created(version) } else { ok(version) }
}

async fn compare(
    State(kernel): Shared,
    Path(project): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Answer {
    let side = |key: &str| query.get(key).map_or("", String::as_str);
    ok(kernel
        .research_compare(&project, side("left"), side("right"))
        .await?)
}

async fn start_run(
    State(kernel): Shared,
    Path((project, version)): Path<(String, String)>,
    body: Body,
) -> Answer {
    let body = body_of(body);
    let (run, new) = kernel
        .research_start_run(
            &project,
            &version,
            given(&body, "clientId").unwrap_or(""),
            given(&body, "threadId"),
        )
        .await?;
    if new { created(run) } else { ok(run) }
}

async fn runs(State(kernel): Shared, Path(project): Path<String>) -> Answer {
    ok(kernel.research_runs(&project).await?)
}

async fn run(State(kernel): Shared, Path((project, id)): Path<(String, String)>) -> Answer {
    ok(kernel.research_run(&project, &id).await?)
}

async fn stop_run(State(kernel): Shared, Path((project, id)): Path<(String, String)>) -> Answer {
    ok(kernel.research_stop_run(&project, &id).await?)
}

async fn read_source(
    State(kernel): Shared,
    Path(project): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Answer {
    let path = query.get("path").map_or(".", String::as_str);
    let thread = query.get("threadId").map(String::as_str);
    ok(kernel.research_source_read(&project, path, thread).await?)
}

async fn write_source(State(kernel): Shared, Path(project): Path<String>, body: Body) -> Answer {
    let body = body_of(body);
    ok(kernel
        .research_source_write(
            &project,
            given(&body, "path").unwrap_or(""),
            body.get("content").and_then(Value::as_str).unwrap_or(""),
            given(&body, "expectedRevision"),
            given(&body, "threadId"),
        )
        .await?)
}

async fn samples(
    State(kernel): Shared,
    Path((project, id)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Answer {
    let number = |key: &str| query.get(key).and_then(|value| value.parse::<u64>().ok());
    ok(kernel
        .research_samples(
            &project,
            &id,
            number("cursor").unwrap_or(0),
            number("limit").map(|limit| limit as usize),
        )
        .await?)
}

async fn log(
    State(kernel): Shared,
    Path((project, id)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Answer {
    let stream = query.get("stream").map_or("stdout", String::as_str);
    ok(kernel.research_run_log(&project, &id, stream).await?)
}

async fn labels(State(kernel): Shared, Path((project, run)): Path<(String, String)>) -> Answer {
    ok(kernel.research_labels(&project, &run).await?)
}

async fn set_label(
    State(kernel): Shared,
    Path((project, run)): Path<(String, String)>,
    body: Body,
) -> Answer {
    ok(kernel
        .research_set_label(&project, &run, &body_of(body))
        .await?)
}

async fn sample_across(
    State(kernel): Shared,
    Path((project, sample)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Answer {
    let runs: Vec<&str> = query
        .get("runs")
        .map_or("", String::as_str)
        .split(',')
        .filter(|run| !run.is_empty())
        .collect();
    ok(kernel
        .research_sample_across(&project, &sample, &runs)
        .await?)
}

pub(crate) fn router(kernel: Arc<Kernel>) -> Router {
    Router::new()
        .route(
            "/projects/{id}/research/runs/{run}/labels",
            get(labels).post(set_label),
        )
        .route(
            "/projects/{id}/research/samples/{sample}",
            get(sample_across),
        )
        .route(
            "/projects/{id}/research/source",
            get(read_source).put(write_source),
        )
        .route("/projects/{id}/research/runs/{run}/samples", get(samples))
        .route("/projects/{id}/research/runs/{run}/log", get(log))
        .route("/projects/{id}/research/runs", get(runs))
        .route("/projects/{id}/research/runs/{run}", get(run))
        .route("/projects/{id}/research/runs/{run}/stop", post(stop_run))
        .route(
            "/projects/{id}/research/versions/{version}/runs",
            post(start_run),
        )
        .route("/projects/{id}/research/compare", get(compare))
        .route(
            "/projects/{id}/research/{collection}",
            get(list).post(create),
        )
        .route(
            "/projects/{id}/research/{collection}/{item}",
            get(record).patch(update),
        )
        .route(
            "/projects/{id}/research/experiments/{item}/versions",
            post(freeze),
        )
        .with_state(kernel)
}
