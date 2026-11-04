//! Sends telemetry on: to a collector over OTLP/HTTP with JSON, or to stdout. Header values may be secrets and are never logged.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

use crate::formats::{otlp_logs, otlp_metrics, otlp_traces};
use crate::network::send_without_span;
use crate::{GLOBAL, VERSION, locked};

const DEFAULT_ENDPOINT: &str = "http://localhost:4318";
const DEFAULT_BATCH_MS: u64 = 5000;
const DEFAULT_METRICS_MS: u64 = 60_000;
/// Records held back for a collector that cannot be reached, oldest dropped first.
const QUEUE_LIMIT: usize = 4096;

#[derive(Default)]
struct Queue {
    spans: Vec<Value>,
    logs: Vec<Value>,
}

static QUEUE: LazyLock<Mutex<Queue>> = LazyLock::new(Mutex::default);
static EXPORTING: AtomicBool = AtomicBool::new(false);
static MODE: Mutex<String> = Mutex::new(String::new());
/// So a collector that is down is said once, not on every batch.
static WARNED: AtomicBool = AtomicBool::new(false);

fn variable(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

/// Where traces go, as the Telemetry page shows it.
pub(crate) fn endpoint() -> String {
    variable("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
        .or_else(|| variable("OTEL_EXPORTER_OTLP_ENDPOINT"))
        .unwrap_or_else(|| DEFAULT_ENDPOINT.to_owned())
}

/// Where a signal goes: its own address as given, or the path under the shared one.
fn signal_endpoint(signal: &str) -> String {
    variable(&format!(
        "OTEL_EXPORTER_OTLP_{}_ENDPOINT",
        signal.to_uppercase()
    ))
    .unwrap_or_else(|| {
        let base =
            variable("OTEL_EXPORTER_OTLP_ENDPOINT").unwrap_or_else(|| DEFAULT_ENDPOINT.to_owned());
        format!("{}/v1/{signal}", base.trim_end_matches('/'))
    })
}

/// A signal's headers: "name=value,name=value", the signal's own over the shared ones.
fn headers(signal: &str) -> Vec<(String, String)> {
    let mut found: Vec<(String, String)> = Vec::new();
    for source in [
        "OTEL_EXPORTER_OTLP_HEADERS".to_owned(),
        format!("OTEL_EXPORTER_OTLP_{}_HEADERS", signal.to_uppercase()),
    ] {
        for pair in variable(&source).unwrap_or_default().split(',') {
            let Some((name, value)) = pair.split_once('=') else {
                continue;
            };
            let name = name.trim().to_owned();
            found.retain(|(known, _)| *known != name);
            found.push((name, value.trim().to_owned()));
        }
    }
    found
}

fn delay(name: &str, fallback: u64) -> Duration {
    Duration::from_millis(
        variable(name)
            .and_then(|value| value.parse().ok())
            .filter(|ms| *ms > 0)
            .unwrap_or(fallback),
    )
}

fn push(list: &mut Vec<Value>, record: &Value) {
    if list.len() >= QUEUE_LIMIT {
        list.remove(0);
    }
    list.push(record.clone());
}

/// Queues a finished span for the exporter, if one runs.
pub(crate) fn queue_span(record: &Value) {
    if EXPORTING.load(Ordering::Relaxed) {
        push(&mut locked(&QUEUE).spans, record);
    }
}

/// Queues a log line for the exporter, if one runs.
pub(crate) fn queue_log(line: &Value) {
    if EXPORTING.load(Ordering::Relaxed) {
        push(&mut locked(&QUEUE).logs, line);
    }
}

fn wrapped(field: &str, records: Value) -> Value {
    let service = locked(&GLOBAL.status).service.clone();
    let mut document = json!({ "service": { "name": service, "version": VERSION } });
    document[field] = records;
    document
}

/// Sends one body on.
async fn deliver(signal: &str, body: Value) {
    let mode = locked(&MODE).clone();
    if mode == "console" {
        println!("{body}");
        return;
    }
    // A collector is reached directly, as every other request here: a system proxy is not asked to carry them.
    let Ok(client) = reqwest::Client::builder().no_proxy().build() else {
        return;
    };
    let mut request = client
        .post(signal_endpoint(signal))
        .timeout(Duration::from_secs(10))
        .header("content-type", "application/json")
        .body(body.to_string());
    for (name, value) in headers(signal) {
        request = request.header(name, value);
    }
    let answer = send_without_span(request).await;
    let refused = match answer {
        Ok(response) if response.status().is_success() => None,
        Ok(response) => Some(format!("status {}", response.status().as_u16())),
        // Without the error's own words: they could quote the address with a key in it.
        Err(_) => Some("no connection".to_owned()),
    };
    if let Some(reason) = refused {
        if !WARNED.swap(true, Ordering::Relaxed) {
            eprintln!("[telemetry] Could not send {signal} to the collector ({reason})");
        }
    } else {
        WARNED.store(false, Ordering::Relaxed);
    }
}

async fn send_spans() {
    let spans = std::mem::take(&mut locked(&QUEUE).spans);
    if !spans.is_empty() {
        deliver(
            "traces",
            otlp_traces(&wrapped("traces", json!([{ "spans": spans }]))),
        )
        .await;
    }
}

async fn send_logs() {
    let logs = std::mem::take(&mut locked(&QUEUE).logs);
    if !logs.is_empty() {
        deliver("logs", otlp_logs(&wrapped("logs", json!(logs)))).await;
    }
}

async fn send_metrics() {
    let metrics = crate::metrics::view();
    if !metrics.is_empty() {
        deliver("metrics", otlp_metrics(&wrapped("metrics", json!(metrics)))).await;
    }
}

/// Starts sending, each kind at its own pace.
pub(crate) fn start(mode: &str) {
    *locked(&MODE) = mode.to_owned();
    EXPORTING.store(true, Ordering::Relaxed);
    tokio::spawn(async {
        let mut spans = tokio::time::interval(delay("OTEL_BSP_SCHEDULE_DELAY", DEFAULT_BATCH_MS));
        let mut logs = tokio::time::interval(delay("OTEL_BLRP_SCHEDULE_DELAY", DEFAULT_BATCH_MS));
        let mut metrics =
            tokio::time::interval(delay("OTEL_METRIC_EXPORT_INTERVAL", DEFAULT_METRICS_MS));
        spans.tick().await;
        logs.tick().await;
        metrics.tick().await;
        loop {
            tokio::select! {
                _ = spans.tick() => send_spans().await,
                _ = logs.tick() => send_logs().await,
                _ = metrics.tick() => send_metrics().await,
            }
        }
    });
}

/// Sends what is left, when the runtime stops.
pub(crate) async fn flush() {
    if EXPORTING.load(Ordering::Relaxed) {
        send_spans().await;
        send_logs().await;
        send_metrics().await;
    }
}
