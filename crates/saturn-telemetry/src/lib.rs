//! The runtime's telemetry, in OpenTelemetry's shape and written by hand: a span, a counter and a log line are small enough
//! not to need the SDKs. What is recorded stays here for the Telemetry page and `telemetry.json`, unless an exporter is set:
//! - "local": recorded and saved only (the default);
//! - "otlp" / "console": also exported, over OTLP/HTTP with JSON or to stdout;
//! - "disabled" (OTEL_SDK_DISABLED=true): nothing is recorded or saved.
//!
//! The record of requests sent (`network`) is separate and always on.
mod buffer;
mod export;
pub mod formats;
mod metrics;
pub mod network;
mod span;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use saturn_domain::time::{iso_time, now_millis};
use serde_json::{Value, json};

pub use buffer::Buffer;
pub use metrics::{add, record, set_active_runs};
pub use span::{Context, Kind, Span, carry, current};

/// The scope and version every record carries.
pub(crate) const SCOPE: &str = "saturn-runtime";
pub(crate) const VERSION: &str = "0.1.0";
/// How long after real work the file is saved.
const SAVE_DELAY_MS: u64 = 5000;

/// Which of the modes is on, and where things go.
#[derive(Clone)]
pub(crate) struct Status {
    pub mode: String,
    pub service: String,
    pub endpoint: Option<String>,
    pub file: Option<PathBuf>,
    pub saved_at: Option<String>,
}

pub(crate) struct Global {
    /// Off until `start`, so a test or a tool using these crates alone records nothing.
    pub recording: AtomicBool,
    pub buffer: Mutex<Buffer>,
    pub status: Mutex<Status>,
    pub save_timer: AtomicBool,
    /// One save at a time.
    pub saving: tokio::sync::Mutex<()>,
}

pub(crate) static GLOBAL: LazyLock<Global> = LazyLock::new(|| Global {
    recording: AtomicBool::new(false),
    buffer: Mutex::new(Buffer::default()),
    status: Mutex::new(Status {
        mode: "disabled".to_owned(),
        service: SCOPE.to_owned(),
        endpoint: None,
        file: None,
        saved_at: None,
    }),
    save_timer: AtomicBool::new(false),
    saving: tokio::sync::Mutex::new(()),
});

/// Locks shared state; a panic elsewhere leaves it usable.
pub(crate) fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Milliseconds since the epoch, with their fraction.
pub(crate) fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0)
}

/// Whether anything is being recorded.
pub(crate) fn recording() -> bool {
    GLOBAL.recording.load(Ordering::Relaxed)
}

/// Which mode the environment asks for. Unset, it is "otlp" when any OTEL_EXPORTER_OTLP_*ENDPOINT is set and local only
/// otherwise, so a plain local run never tries to reach a collector.
pub fn telemetry_mode(variable: &dyn Fn(&str) -> Option<String>, names: &[String]) -> &'static str {
    if variable("OTEL_SDK_DISABLED").as_deref() == Some("true") {
        return "disabled";
    }
    match variable("SATURN_OTEL")
        .map(|chosen| chosen.trim().to_lowercase())
        .as_deref()
    {
        Some("otlp") => return "otlp",
        Some("console") => return "console",
        Some("off") => return "local",
        _ => {}
    }
    let endpoint = names.iter().any(|name| {
        name.strip_prefix("OTEL_EXPORTER_OTLP_")
            .and_then(|rest| rest.strip_suffix("ENDPOINT"))
            .is_some_and(|middle| {
                middle.is_empty()
                    || middle.strip_suffix('_').is_some_and(|word| {
                        !word.is_empty()
                            && word.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                    })
            })
            && variable(name).is_some_and(|value| !value.is_empty())
    });
    if endpoint { "otlp" } else { "local" }
}

/// Starts telemetry in `directory`, from the environment: restores `telemetry.json` and starts any exporter. Says what it did
/// for the log, or what is wrong.
pub async fn start(directory: &std::path::Path) -> Result<String, String> {
    let variable = |name: &str| std::env::var(name).ok();
    let names: Vec<String> = std::env::vars_os()
        .map(|(name, _)| name.to_string_lossy().into_owned())
        .collect();
    let mode = telemetry_mode(&variable, &names);
    let service = variable("OTEL_SERVICE_NAME")
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| SCOPE.to_owned());
    let file = (mode != "disabled").then(|| directory.join("telemetry.json"));
    {
        let mut status = locked(&GLOBAL.status);
        status.mode = mode.to_owned();
        status.service.clone_from(&service);
        status.endpoint = (mode == "otlp").then(export::endpoint);
        status.file.clone_from(&file);
    }
    let Some(file) = file else {
        return Err(
            "OTEL_SDK_DISABLED=true: no traces, metrics or logs are recorded or saved".to_owned(),
        );
    };
    let note = restore(&file).await;
    GLOBAL.recording.store(true, Ordering::Relaxed);
    if mode == "otlp" || mode == "console" {
        export::start(mode);
    }
    if let Some(note) = note {
        return Err(note);
    }
    let shown = file.display();
    Ok(match mode {
        "otlp" => format!(
            "Recording to {shown} and exporting over OTLP to {}",
            export::endpoint()
        ),
        "console" => format!("Recording to {shown} and printing to the console"),
        _ => format!("Recording to {shown}; set OTEL_EXPORTER_OTLP_ENDPOINT to export"),
    })
}

/// Puts back what the last run saved. What it says is for the log.
async fn restore(file: &std::path::Path) -> Option<String> {
    let text = match tokio::fs::read_to_string(file).await {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            return Some(format!(
                "Could not read {} ({error}); it will be replaced on the next save",
                file.display()
            ));
        }
    };
    let Ok(saved) = serde_json::from_str::<Value>(&text) else {
        return Some(format!(
            "Could not read {}; it will be replaced on the next save",
            file.display()
        ));
    };
    if saved.get("format").and_then(Value::as_str) != Some("saturn-telemetry") {
        return Some(format!(
            "{} is not a Saturn telemetry file; it will be replaced on the next save",
            file.display()
        ));
    }
    locked(&GLOBAL.buffer).restore(&saved);
    locked(&GLOBAL.status).saved_at = saved
        .get("savedAt")
        .and_then(Value::as_str)
        .map(str::to_owned);
    None
}

/// Saves a few seconds after real work happens, once however much of it there was. Polling never gets here.
pub(crate) fn schedule_save() {
    if locked(&GLOBAL.status).file.is_none() || GLOBAL.save_timer.swap(true, Ordering::Relaxed) {
        return;
    }
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        GLOBAL.save_timer.store(false, Ordering::Relaxed);
        return;
    };
    runtime.spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(SAVE_DELAY_MS)).await;
        GLOBAL.save_timer.store(false, Ordering::Relaxed);
        if let Err(error) = save().await {
            eprintln!("[telemetry] Could not save: {error}");
        }
    });
}

/// The document the file holds: every trace except polling, all logs, and the metrics since the runtime started.
pub fn document() -> Value {
    let (traces, logs) = locked(&GLOBAL.buffer).persistable();
    let service = locked(&GLOBAL.status).service.clone();
    json!({
        "format": "saturn-telemetry",
        "version": 1,
        "service": { "name": service, "version": VERSION },
        "savedAt": iso_time(now_millis()),
        "traces": traces,
        "logs": logs,
        "metrics": metrics::view(),
    })
}

/// Writes the file now, by way of a temporary one so a crash cannot leave half a file, and returns what it holds. Without a
/// file, only the latter.
pub async fn save() -> std::io::Result<Value> {
    let _turn = GLOBAL.saving.lock().await;
    let body = document();
    let file = locked(&GLOBAL.status).file.clone();
    if let Some(file) = file {
        let temporary = file.with_extension("json.tmp");
        tokio::fs::write(&temporary, serde_json::to_string_pretty(&body)?).await?;
        tokio::fs::rename(&temporary, &file).await?;
        locked(&GLOBAL.status).saved_at = body["savedAt"].as_str().map(str::to_owned);
    }
    Ok(body)
}

/// What the Telemetry page's header shows.
pub fn status() -> Value {
    let status = locked(&GLOBAL.status).clone();
    let buffer = locked(&GLOBAL.buffer);
    let summaries = buffer.summaries();
    let errors = summaries
        .iter()
        .filter(|trace| trace["errorCount"].as_u64().unwrap_or(0) > 0)
        .count();
    json!({
        "mode": status.mode,
        "serviceName": status.service,
        "endpoint": status.endpoint,
        "file": status.file.as_ref().map(|file| file.to_string_lossy().into_owned()),
        "savedAt": status.saved_at,
        "traces": summaries.len(),
        "errorTraces": errors,
        "logs": buffer.logs(None, None).len(),
    })
}

/// The traces in memory, newest first.
pub fn summaries() -> Vec<Value> {
    locked(&GLOBAL.buffer).summaries()
}

/// One trace's spans by start time, while it is in memory.
pub fn trace(id: &str) -> Option<Vec<Value>> {
    locked(&GLOBAL.buffer).trace(id)
}

/// Current metric values.
pub fn metric_view() -> Vec<Value> {
    metrics::view()
}

/// The log records, of a trace and from a severity up when asked.
pub fn logs(trace: Option<&str>, least_severity: Option<f64>) -> Vec<Value> {
    locked(&GLOBAL.buffer).logs(trace, least_severity)
}

/// Forgets the traces and logs, and saves that.
pub async fn clear() -> std::io::Result<()> {
    locked(&GLOBAL.buffer).clear();
    if locked(&GLOBAL.status).file.is_some() {
        save().await?;
    }
    Ok(())
}

/// Mirrors a runtime log line, tied to the active span when there is one.
pub fn emit_log(service: &str, level: &str, message: &str) {
    if !recording() {
        return;
    }
    let number = match level {
        "debug" => 5,
        "warning" => 13,
        "error" => 17,
        _ => 9,
    };
    let mut line = json!({
        "timeMs": now_ms(),
        "severity": level.to_uppercase(),
        "severityNumber": number,
        "body": message,
        "attributes": { "saturn.service": service },
    });
    if let Some(context) = current() {
        line["traceId"] = json!(context.trace);
        line["spanId"] = json!(context.span);
    }
    export::queue_log(&line);
    let changed = locked(&GLOBAL.buffer).add_log(line);
    if changed {
        schedule_save();
    }
}

/// Stops: sends what is left to the exporter and saves.
pub async fn stop() {
    export::flush().await;
    if recording() {
        let _ = save().await;
    }
}
