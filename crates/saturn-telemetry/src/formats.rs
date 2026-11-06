//! Turns telemetry.json into formats other tools read:
//! - OTLP/JSON lines: one TracesData, LogsData and MetricsData object per line, the encoding the OpenTelemetry Collector's file
//!   exporter writes and its otlpjsonfile receiver reads.
//! - SIEM: one ECS-style event per line (NDJSON) for Elastic, Splunk, Sentinel and similar.
use saturn_domain::time::iso_time;
use serde_json::{Map, Value, json};

/// AGGREGATION_TEMPORALITY_CUMULATIVE: the runtime's metrics count up from process start.
const CUMULATIVE: u8 = 2;

/// What a format is called in a download: its file extension and content type.
pub fn details(format: &str) -> (&'static str, &'static str) {
    match format {
        "otlp" => ("jsonl", "application/x-ndjson"),
        "siem" => ("ndjson", "application/x-ndjson"),
        _ => ("json", "application/json"),
    }
}

/// The document in a format; "saturn", or anything unknown, is the file itself.
pub fn render(document: &Value, format: &str) -> String {
    match format {
        "otlp" => to_otlp_lines(document),
        "siem" => to_siem(document),
        _ => serde_json::to_string_pretty(document).unwrap_or_default(),
    }
}

fn number(value: &Value, name: &str) -> f64 {
    value[name].as_f64().unwrap_or(0.0)
}

fn items<'a>(value: &'a Value, name: &str) -> &'a [Value] {
    value[name].as_array().map_or(&[], Vec::as_slice)
}

/// OTLP/JSON encodes 64-bit integers as decimal strings.
fn nanos(ms: f64) -> String {
    let whole = ms.floor();
    let fraction = ms % 1.0;
    let total = (whole as i128) * 1_000_000 + (fraction * 1e6).round() as i128;
    total.to_string()
}

fn any_value(value: &Value) -> Value {
    match value {
        Value::Array(list) => {
            json!({ "arrayValue": { "values": list.iter().map(any_value).collect::<Vec<_>>() } })
        }
        Value::Bool(flag) => json!({ "boolValue": flag }),
        Value::Number(figure) => {
            let parsed = figure.as_f64().unwrap_or(0.0);
            if parsed.fract() == 0.0 {
                json!({ "intValue": (parsed as i64).to_string() })
            } else {
                json!({ "doubleValue": parsed })
            }
        }
        Value::String(text) => json!({ "stringValue": text }),
        Value::Null => json!({ "stringValue": "" }),
        Value::Object(_) => json!({ "stringValue": "[object Object]" }),
    }
}

fn key_values(attributes: &Value) -> Vec<Value> {
    attributes.as_object().map_or_else(Vec::new, |fields| {
        fields
            .iter()
            .map(|(key, value)| json!({ "key": key, "value": any_value(value) }))
            .collect()
    })
}

fn resource(document: &Value) -> Value {
    json!({
        "attributes": key_values(&json!({
            "service.name": document["service"]["name"],
            "service.version": document["service"]["version"],
            "telemetry.sdk.language": "rust",
            "telemetry.sdk.name": "saturn-telemetry",
        })),
    })
}

fn kind_number(kind: &Value) -> u8 {
    match kind.as_str() {
        Some("server") => 2,
        Some("client") => 3,
        Some("producer") => 4,
        Some("consumer") => 5,
        _ => 1,
    }
}

fn status_number(status: &Value) -> u8 {
    match status.as_str() {
        Some("ok") => 1,
        Some("error") => 2,
        _ => 0,
    }
}

/// The spans as TracesData, by the scope that recorded them.
pub fn otlp_traces(document: &Value) -> Value {
    let mut scopes: Vec<(String, Value, Vec<Value>)> = Vec::new();
    for trace in items(document, "traces") {
        for span in items(trace, "spans") {
            let start = number(span, "startMs");
            let mut encoded = json!({ "traceId": span["traceId"], "spanId": span["spanId"] });
            if span["parentSpanId"]
                .as_str()
                .is_some_and(|parent| !parent.is_empty())
            {
                encoded["parentSpanId"] = span["parentSpanId"].clone();
            }
            encoded["name"] = span["name"].clone();
            encoded["kind"] = json!(kind_number(&span["kind"]));
            encoded["startTimeUnixNano"] = json!(nanos(start));
            encoded["endTimeUnixNano"] = json!(nanos(start + number(span, "durationMs")));
            encoded["attributes"] = json!(key_values(&span["attributes"]));
            encoded["events"] = json!(
                items(span, "events")
                    .iter()
                    .map(|event| json!({
                        "timeUnixNano": nanos(number(event, "timeMs")),
                        "name": event["name"],
                        "attributes": key_values(&event["attributes"]),
                    }))
                    .collect::<Vec<_>>()
            );
            let mut status = json!({ "code": status_number(&span["status"]) });
            if span["statusMessage"]
                .as_str()
                .is_some_and(|message| !message.is_empty())
            {
                status["message"] = span["statusMessage"].clone();
            }
            encoded["status"] = status;
            let key = format!(
                "{}@{}",
                span["scope"].as_str().unwrap_or_default(),
                span["scopeVersion"].as_str().unwrap_or_default()
            );
            match scopes.iter_mut().find(|(name, _, _)| *name == key) {
                Some((_, _, spans)) => spans.push(encoded),
                None => {
                    let mut scope = json!({ "name": span["scope"] });
                    if span["scopeVersion"]
                        .as_str()
                        .is_some_and(|version| !version.is_empty())
                    {
                        scope["version"] = span["scopeVersion"].clone();
                    }
                    scopes.push((key, scope, vec![encoded]));
                }
            }
        }
    }
    json!({
        "resourceSpans": [{
            "resource": resource(document),
            "scopeSpans": scopes.into_iter().map(|(_, scope, spans)| json!({ "scope": scope, "spans": spans })).collect::<Vec<_>>(),
        }],
    })
}

/// The log lines as LogsData.
pub fn otlp_logs(document: &Value) -> Value {
    let records: Vec<Value> = items(document, "logs")
        .iter()
        .map(|line| {
            let time = nanos(number(line, "timeMs"));
            let mut record = json!({
                "timeUnixNano": time,
                "observedTimeUnixNano": time,
                "severityNumber": line["severityNumber"],
                "severityText": line["severity"],
                "body": { "stringValue": line["body"] },
                "attributes": key_values(&line["attributes"]),
            });
            if line["traceId"].is_string() {
                record["traceId"] = line["traceId"].clone();
            }
            if line["spanId"].is_string() {
                record["spanId"] = line["spanId"].clone();
            }
            record
        })
        .collect();
    json!({
        "resourceLogs": [{
            "resource": resource(document),
            "scopeLogs": [{ "scope": { "name": "saturn-runtime", "version": document["service"]["version"] }, "logRecords": records }],
        }],
    })
}

fn otlp_metric(metric: &Value) -> Value {
    let times = |point: &Value| {
        json!({
            "attributes": key_values(&point["attributes"]),
            "startTimeUnixNano": nanos(number(point, "startMs")),
            "timeUnixNano": nanos(number(point, "timeMs")),
        })
    };
    let mut base = json!({ "name": metric["name"], "description": metric["description"], "unit": metric["unit"] });
    if metric["type"] == "histogram" {
        let points: Vec<Value> = items(metric, "points")
            .iter()
            .map(|point| {
                let histogram = &point["histogram"];
                let mut encoded = times(point);
                encoded["count"] = json!(histogram["count"].as_u64().unwrap_or(0).to_string());
                encoded["sum"] = if histogram["sum"].is_number() {
                    histogram["sum"].clone()
                } else {
                    json!(0)
                };
                if histogram["min"].is_number() {
                    encoded["min"] = histogram["min"].clone();
                }
                if histogram["max"].is_number() {
                    encoded["max"] = histogram["max"].clone();
                }
                encoded["bucketCounts"] = json!(
                    items(histogram, "counts")
                        .iter()
                        .map(|count| count.to_string())
                        .collect::<Vec<_>>()
                );
                encoded["explicitBounds"] = json!(items(histogram, "boundaries"));
                encoded
            })
            .collect();
        base["histogram"] = json!({ "aggregationTemporality": CUMULATIVE, "dataPoints": points });
        return base;
    }
    let points: Vec<Value> = items(metric, "points")
        .iter()
        .map(|point| {
            let mut encoded = times(point);
            encoded["asDouble"] = if point["value"].is_number() {
                point["value"].clone()
            } else {
                json!(0)
            };
            encoded
        })
        .collect();
    if metric["type"] == "sum" {
        base["sum"] = json!({ "aggregationTemporality": CUMULATIVE, "isMonotonic": metric["monotonic"].as_bool().unwrap_or(false), "dataPoints": points });
    } else {
        base["gauge"] = json!({ "dataPoints": points });
    }
    base
}

/// The metrics as MetricsData.
pub fn otlp_metrics(document: &Value) -> Value {
    json!({
        "resourceMetrics": [{
            "resource": resource(document),
            "scopeMetrics": [{
                "scope": { "name": "saturn-runtime", "version": document["service"]["version"] },
                "metrics": items(document, "metrics").iter().map(otlp_metric).collect::<Vec<_>>(),
            }],
        }],
    })
}

/// One object per line, each kind only when there is any.
pub fn to_otlp_lines(document: &Value) -> String {
    let mut lines = Vec::new();
    if !items(document, "traces").is_empty() {
        lines.push(otlp_traces(document).to_string());
    }
    if !items(document, "logs").is_empty() {
        lines.push(otlp_logs(document).to_string());
    }
    if !items(document, "metrics").is_empty() {
        lines.push(otlp_metrics(document).to_string());
    }
    if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    }
}

fn iso(ms: f64) -> String {
    iso_time(ms.floor() as i64)
}

fn service(document: &Value) -> Value {
    json!({ "name": document["service"]["name"], "version": document["service"]["version"] })
}

/// Whether JavaScript counts an attribute as there.
fn present(value: &Value) -> bool {
    saturn_domain::js::truthy(Some(value))
}

fn span_event(document: &Value, span: &Value) -> Value {
    let start = number(span, "startMs");
    let kind = span["kind"].as_str().unwrap_or_default();
    let status = span["status"].as_str().unwrap_or_default();
    let attributes = &span["attributes"];
    let mut event = Map::new();
    event.insert("@timestamp".to_owned(), json!(iso(start)));
    event.insert("message".to_owned(), span["name"].clone());
    event.insert(
        "event".to_owned(),
        json!({
            "kind": "event",
            "dataset": "saturn.traces",
            "module": "saturn",
            "action": span["name"],
            "category": if kind == "server" || kind == "client" { ["web"] } else { ["process"] },
            "type": ["info"],
            "outcome": match status { "error" => "failure", "ok" => "success", _ => "unknown" },
            "start": iso(start),
            "end": iso(start + number(span, "durationMs")),
            "duration": (number(span, "durationMs") * 1e6).round() as i64,
        }),
    );
    event.insert("service".to_owned(), service(document));
    event.insert("trace".to_owned(), json!({ "id": span["traceId"] }));
    event.insert("span".to_owned(), json!({ "id": span["spanId"] }));
    if span["parentSpanId"]
        .as_str()
        .is_some_and(|parent| !parent.is_empty())
    {
        event.insert("parent".to_owned(), json!({ "id": span["parentSpanId"] }));
    }
    // The attributes ECS has fields for; everything else stays under otel.attributes.
    let (method, code) = (
        &attributes["http.request.method"],
        &attributes["http.response.status_code"],
    );
    if present(method) || present(code) {
        let mut http = Map::new();
        if present(method) {
            http.insert("request".to_owned(), json!({ "method": method }));
        }
        if present(code) {
            http.insert("response".to_owned(), json!({ "status_code": code }));
        }
        event.insert("http".to_owned(), Value::Object(http));
    }
    if present(&attributes["url.path"]) {
        event.insert("url".to_owned(), json!({ "path": attributes["url.path"] }));
    }
    let mut error = Map::new();
    if present(&attributes["error.type"]) {
        error.insert("type".to_owned(), attributes["error.type"].clone());
    }
    let exception = items(span, "events")
        .iter()
        .find(|item| item["name"] == "exception");
    let message = span["statusMessage"]
        .as_str()
        .filter(|message| !message.is_empty());
    if exception.is_some() || message.is_some() {
        let thrown = exception.and_then(|item| item["attributes"]["exception.message"].as_str());
        error.insert(
            "message".to_owned(),
            json!(thrown.or(message).unwrap_or_default()),
        );
        if let Some(stack) = exception
            .map(|item| &item["attributes"]["exception.stacktrace"])
            .filter(|stack| present(stack))
        {
            error.insert("stack_trace".to_owned(), stack.clone());
        }
    }
    if !error.is_empty() {
        event.insert("error".to_owned(), Value::Object(error));
    }
    event.insert(
        "otel".to_owned(),
        json!({ "kind": kind, "status": status, "scope": span["scope"], "attributes": attributes }),
    );
    Value::Object(event)
}

fn log_event(document: &Value, line: &Value) -> Value {
    let mut event = Map::new();
    event.insert("@timestamp".to_owned(), json!(iso(number(line, "timeMs"))));
    event.insert("message".to_owned(), line["body"].clone());
    event.insert(
        "log".to_owned(),
        json!({
            "level": line["severity"].as_str().unwrap_or_default().to_lowercase(),
            "logger": line["attributes"]["saturn.service"].as_str().unwrap_or("runtime"),
        }),
    );
    event.insert("event".to_owned(), json!({ "kind": "event", "dataset": "saturn.logs", "module": "saturn", "severity": line["severityNumber"] }));
    event.insert("service".to_owned(), service(document));
    if line["traceId"].is_string() {
        event.insert("trace".to_owned(), json!({ "id": line["traceId"] }));
    }
    if line["spanId"].is_string() {
        event.insert("span".to_owned(), json!({ "id": line["spanId"] }));
    }
    event.insert(
        "otel".to_owned(),
        json!({ "attributes": line["attributes"] }),
    );
    Value::Object(event)
}

fn metric_events(document: &Value, metric: &Value) -> Vec<Value> {
    items(metric, "points")
        .iter()
        .map(|point| {
            let mut figures = json!({ "name": metric["name"], "unit": metric["unit"], "type": metric["type"] });
            let histogram = &point["histogram"];
            if histogram.is_object() {
                let (count, sum) = (number(histogram, "count"), number(histogram, "sum"));
                figures["count"] = histogram["count"].clone();
                figures["sum"] = histogram["sum"].clone();
                figures["avg"] = if count > 0.0 { json!(sum / count) } else { json!(0) };
                if histogram["min"].is_number() {
                    figures["min"] = histogram["min"].clone();
                }
                if histogram["max"].is_number() {
                    figures["max"] = histogram["max"].clone();
                }
            } else {
                figures["value"] = if point["value"].is_number() { point["value"].clone() } else { json!(0) };
            }
            json!({
                "@timestamp": iso(number(point, "timeMs")),
                "message": metric["name"],
                "event": { "kind": "metric", "dataset": "saturn.metrics", "module": "saturn" },
                "service": service(document),
                "metric": figures,
                "otel": { "attributes": point["attributes"], "start": iso(number(point, "startMs")) },
            })
        })
        .collect()
}

/// One event per line, by time.
pub fn to_siem(document: &Value) -> String {
    let mut events: Vec<Value> = Vec::new();
    for trace in items(document, "traces") {
        events.extend(
            items(trace, "spans")
                .iter()
                .map(|span| span_event(document, span)),
        );
    }
    events.extend(
        items(document, "logs")
            .iter()
            .map(|line| log_event(document, line)),
    );
    for metric in items(document, "metrics") {
        events.extend(metric_events(document, metric));
    }
    events.sort_by(|a, b| a["@timestamp"].as_str().cmp(&b["@timestamp"].as_str()));
    if events.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = events.iter().map(Value::to_string).collect();
    format!("{}\n", lines.join("\n"))
}
