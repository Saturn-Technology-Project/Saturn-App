//! Research records, in the project's own folder. `docs/research-contract.md` is the contract.
use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use saturn_core::Kernel;
use saturn_core::research::DataOverlapRequest;
use serde_json::{Value, json};

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
            query.get("only").map(String::as_str),
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

async fn summary(State(kernel): Shared, Path((project, run)): Path<(String, String)>) -> Answer {
    ok(kernel.research_summary(&project, &run).await?)
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

async fn inside_saved(
    State(kernel): Shared,
    Path((project, run)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Answer {
    let request = json!({ "sampleId": query.get("sample"), "modelId": query.get("model") });
    ok(kernel
        .research_inside_saved(&project, &run, &request)
        .await?)
}

async fn look_inside(
    State(kernel): Shared,
    Path((project, run)): Path<(String, String)>,
    body: Body,
) -> Answer {
    ok(kernel
        .research_look_inside(&project, &run, &body_of(body))
        .await?)
}

/// A patch of one layer from one model into another, on a sample of a run.
async fn intervene(State(kernel): Shared, Path(project): Path<String>, body: Body) -> Answer {
    let body = body_of(body);
    let run = given(&body, "runId").unwrap_or("");
    if body.get("layer").and_then(Value::as_u64).is_none() {
        return Err(saturn_core::CoreError::new(400, "An intervention names a \"layer\".").into());
    }
    ok(kernel.research_look_inside(&project, run, &body).await?)
}

/// Prompts of the person's own looked at inside a model, with a run's Python and weights.
async fn inspection(
    State(kernel): Shared,
    Path((project, run)): Path<(String, String)>,
    body: Body,
) -> Answer {
    ok(kernel
        .research_inspection(&project, &run, &body_of(body))
        .await?)
}

async fn inside_list(
    State(kernel): Shared,
    Path((project, run)): Path<(String, String)>,
) -> Answer {
    ok(kernel.research_inside_list(&project, &run).await?)
}

async fn sweep(State(kernel): Shared, Path(project): Path<String>, body: Body) -> Answer {
    ok(kernel.research_sweep(&project, &body_of(body)).await?)
}

async fn resources(State(kernel): Shared, Path((project, run)): Path<(String, String)>) -> Answer {
    ok(kernel.research_resources(&project, &run).await?)
}

async fn environment(State(kernel): Shared, Path(project): Path<String>) -> Answer {
    ok(kernel.research_environment(&project).await?)
}

async fn set_environment(State(kernel): Shared, Path(project): Path<String>, body: Body) -> Answer {
    ok(kernel
        .research_set_environment(&project, &body_of(body))
        .await?)
}

async fn check_environment(State(kernel): Shared, Path(project): Path<String>) -> Answer {
    ok(kernel.research_check_environment(&project).await?)
}

async fn create_environment(
    State(kernel): Shared,
    Path(project): Path<String>,
    body: Body,
) -> Answer {
    ok(kernel
        .research_create_environment(&project, &body_of(body))
        .await?)
}

async fn install_packages(
    State(kernel): Shared,
    Path(project): Path<String>,
    body: Body,
) -> Answer {
    ok(kernel
        .research_install_packages(&project, &body_of(body))
        .await?)
}

async fn stop_environment_job(State(kernel): Shared, Path(project): Path<String>) -> Answer {
    ok(kernel.research_stop_environment_job(&project).await?)
}

async fn policy(State(kernel): Shared, Path(project): Path<String>) -> Answer {
    ok(kernel.research_policy(&project).await?)
}

async fn set_policy(State(kernel): Shared, Path(project): Path<String>, body: Body) -> Answer {
    ok(kernel.research_set_policy(&project, &body_of(body)).await?)
}

async fn events(State(kernel): Shared, Path(project): Path<String>) -> Answer {
    ok(kernel.research_events(&project).await?)
}

/// Every data input of the project's experiments and versions.
async fn data_list(State(kernel): Shared, Path(project): Path<String>) -> Answer {
    ok(kernel.research_data_list(&project).await?)
}

/// A page of a data file's rows.
async fn data_preview(
    State(kernel): Shared,
    Path(project): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Answer {
    let number = |key: &str| query.get(key).and_then(|value| value.parse::<u64>().ok());
    ok(kernel
        .research_data_preview(
            &project,
            query.get("path").map_or("", String::as_str),
            number("cursor").unwrap_or(0),
            number("limit").map(|limit| limit as usize),
            query.get("split").map(String::as_str),
        )
        .await?)
}

/// What a data file's columns hold.
async fn data_profile(
    State(kernel): Shared,
    Path(project): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Answer {
    ok(kernel
        .research_data_profile(
            &project,
            query.get("path").map_or("", String::as_str),
            query.get("split").map(String::as_str),
        )
        .await?)
}

/// How many rows two data files share.
async fn data_overlap(
    State(kernel): Shared,
    Path(project): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Answer {
    let given = |key: &str| query.get(key).map(String::as_str);
    let request = DataOverlapRequest {
        left: given("left").unwrap_or(""),
        right: given("right").unwrap_or(""),
        columns: given("columns")
            .unwrap_or("")
            .split(',')
            .map(str::to_owned)
            .collect(),
        left_split: given("leftSplit"),
        right_split: given("rightSplit"),
    };
    ok(kernel.research_data_overlap(&project, &request).await?)
}

pub(crate) fn router(kernel: Arc<Kernel>) -> Router {
    Router::new()
        .route("/projects/{id}/research/data", get(data_list))
        .route("/projects/{id}/research/data/preview", get(data_preview))
        .route("/projects/{id}/research/data/profile", get(data_profile))
        .route("/projects/{id}/research/data/overlap", get(data_overlap))
        .route("/projects/{id}/research/runs/{run}/summary", get(summary))
        .route(
            "/projects/{id}/research/runs/{run}/activations",
            get(inside_saved).post(look_inside),
        )
        .route(
            "/projects/{id}/research/runs/{run}/inspections",
            post(inspection),
        )
        .route("/projects/{id}/research/interventions", post(intervene))
        .route("/projects/{id}/research/interventions/sweep", post(sweep))
        .route(
            "/projects/{id}/research/runs/{run}/inside",
            get(inside_list),
        )
        .route(
            "/projects/{id}/research/runs/{run}/resources",
            get(resources),
        )
        .route(
            "/projects/{id}/research/environment",
            get(environment).put(set_environment),
        )
        .route(
            "/projects/{id}/research/environment/check",
            post(check_environment),
        )
        .route(
            "/projects/{id}/research/environment/create",
            post(create_environment),
        )
        .route(
            "/projects/{id}/research/environment/install",
            post(install_packages),
        )
        .route(
            "/projects/{id}/research/environment/job/stop",
            post(stop_environment_job),
        )
        .route(
            "/projects/{id}/research/policy",
            get(policy).put(set_policy),
        )
        .route("/projects/{id}/research/events", get(events))
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
