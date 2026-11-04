//! The export formats give what the TypeScript runtime gave, apart from which SDK made them.
use saturn_telemetry::formats::render;
use serde_json::Value;

/// The lines of an export as values, with the SDK's own name taken out.
fn lines(text: &str) -> Vec<Value> {
    text.lines()
        .map(|line| {
            let mut value: Value = serde_json::from_str(line).unwrap();
            for key in ["resourceSpans", "resourceLogs", "resourceMetrics"] {
                let attributes = value.pointer_mut(&format!("/{key}/0/resource/attributes"));
                if let Some(attributes) = attributes.and_then(Value::as_array_mut) {
                    attributes
                        .retain(|item| !item["key"].as_str().unwrap().starts_with("telemetry.sdk"));
                }
            }
            value
        })
        .collect()
}

#[test]
fn exports_match_the_shared_cases() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../contract/cases/telemetry-formats.json"
    ))
    .unwrap();
    let document = &cases["document"];
    assert_eq!(
        lines(&render(document, "otlp")),
        lines(cases["otlp"].as_str().unwrap())
    );
    assert_eq!(
        lines(&render(document, "siem")),
        lines(cases["siem"].as_str().unwrap())
    );
    let mut empty = document.clone();
    for key in ["traces", "logs", "metrics"] {
        empty[key] = serde_json::json!([]);
    }
    assert_eq!(render(&empty, "otlp"), "");
    assert_eq!(render(&empty, "siem"), "");
    let saved: Value = serde_json::from_str(&render(document, "saturn")).unwrap();
    assert_eq!(&saved, document);
}

#[test]
fn a_trace_header_is_read_only_when_well_formed() {
    use saturn_telemetry::Context;
    let good = Context::parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01").unwrap();
    assert_eq!(good.trace, "4bf92f3577b34da6a3ce929d0e0e4736");
    assert_eq!(
        good.traceparent(),
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    );
    for bad in [
        "",
        "nonsense",
        "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
        "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
        "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01",
    ] {
        assert_eq!(Context::parse(bad), None, "{bad}");
    }
}

#[test]
fn the_mode_follows_the_environment() {
    use saturn_telemetry::telemetry_mode;
    let mode = |pairs: &[(&str, &str)]| {
        let names: Vec<String> = pairs.iter().map(|(name, _)| (*name).to_owned()).collect();
        let found = |name: &str| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        };
        telemetry_mode(&found, &names)
    };
    assert_eq!(mode(&[]), "local");
    assert_eq!(mode(&[("SATURN_OTEL", "off")]), "local");
    assert_eq!(
        mode(&[("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318")]),
        "otlp"
    );
    assert_eq!(
        mode(&[(
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
            "http://collector:4318/v1/traces"
        )]),
        "otlp"
    );
    assert_eq!(mode(&[("OTEL_EXPORTER_OTLP_ENDPOINT", "")]), "local");
    assert_eq!(mode(&[("SATURN_OTEL", "console")]), "console");
    assert_eq!(
        mode(&[("SATURN_OTEL", "console"), ("OTEL_SDK_DISABLED", "true")]),
        "disabled"
    );
}

#[test]
fn polling_is_routine_and_real_work_is_not_pushed_out_by_it() {
    use saturn_telemetry::Buffer;
    use serde_json::json;
    let span = |trace: &str, name: &str, kind: &str, method: &str, status: &str| json!({ "traceId": trace, "spanId": format!("{trace}-{name}"), "parentSpanId": null, "name": name, "kind": kind, "startMs": 1.0, "durationMs": 1.0, "status": status, "attributes": { "http.request.method": method } });
    let mut buffer = Buffer::default();
    assert!(
        !buffer.add_span(span("poll", "GET /agents", "server", "GET", "unset")),
        "polling is not worth saving"
    );
    assert!(!buffer.add_span(span("poll", "store.persist", "internal", "", "unset")));
    assert!(buffer.add_span(span("work", "POST /x", "server", "POST", "unset")));
    assert!(buffer.add_span(span("broken", "GET /y", "server", "GET", "error")));
    let (saved, _) = buffer.persistable();
    let ids: Vec<&str> = saved
        .iter()
        .map(|trace| trace["traceId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["work", "broken"]);
    for index in 0..400 {
        buffer.add_span(span(
            &format!("poll{index}"),
            "GET /agents",
            "server",
            "GET",
            "unset",
        ));
    }
    let summaries = buffer.summaries();
    assert!(
        summaries.iter().any(|trace| trace["traceId"] == "work"),
        "real work outlives polling"
    );
    assert_eq!(
        summaries
            .iter()
            .filter(|trace| trace["routine"] == true)
            .count(),
        150
    );
}
