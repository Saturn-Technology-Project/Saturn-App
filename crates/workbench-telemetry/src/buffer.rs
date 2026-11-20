//! The recent spans and logs, for the Telemetry page and the saved file. Plain JSON records, newest last.
use std::collections::HashSet;

use serde_json::{Value, json};

const TRACES: usize = 400;
const ROUTINE_TRACES: usize = 150;
const SPANS_PER_TRACE: usize = 500;
const LOGS: usize = 2000;

/// Traces in insertion order, so the oldest is evicted first, and log lines.
#[derive(Default)]
pub struct Buffer {
    traces: Vec<(String, Vec<Value>)>,
    lines: Vec<Value>,
}

/// A successful GET whose only children are state writes: what the desktop's polling produces.
fn is_routine(spans: &[Value]) -> bool {
    let mut roots = spans.iter().filter(|span| span["kind"] == "server");
    let (Some(root), None) = (roots.next(), roots.next()) else {
        return false;
    };
    if root["attributes"]["http.request.method"] != "GET" || root["status"] == "error" {
        return false;
    }
    spans.iter().all(|span| {
        span["kind"] == "server" || (span["name"] == "store.persist" && span["status"] != "error")
    })
}

impl Buffer {
    /// Adds a finished span. True when it is worth saving.
    pub fn add_span(&mut self, record: Value) -> bool {
        let id = record["traceId"].as_str().unwrap_or_default().to_owned();
        match self.traces.iter_mut().find(|(trace, _)| *trace == id) {
            Some((_, spans)) => {
                if spans.len() < SPANS_PER_TRACE {
                    spans.push(record);
                }
            }
            None => self.traces.push((id.clone(), vec![record])),
        }
        self.evict();
        self.traces
            .iter()
            .find(|(trace, _)| *trace == id)
            .is_some_and(|(_, spans)| !is_routine(spans))
    }

    /// Adds a log line. Always worth saving.
    pub fn add_log(&mut self, line: Value) -> bool {
        self.lines.push(line);
        self.trim_logs();
        true
    }

    fn trim_logs(&mut self) {
        if self.lines.len() > LOGS {
            let extra = self.lines.len() - LOGS;
            self.lines.drain(..extra);
        }
    }

    /// Drops the oldest routine traces first, then the oldest of everything, so polling never pushes out real work.
    fn evict(&mut self) {
        let mut routine = self
            .traces
            .iter()
            .filter(|(_, spans)| is_routine(spans))
            .count();
        if routine > ROUTINE_TRACES {
            self.traces.retain(|(_, spans)| {
                if routine > ROUTINE_TRACES && is_routine(spans) {
                    routine -= 1;
                    return false;
                }
                true
            });
        }
        if self.traces.len() > TRACES {
            let extra = self.traces.len() - TRACES;
            self.traces.drain(..extra);
        }
    }

    /// What is worth keeping on disk: every trace except polling, and all log records.
    pub fn persistable(&self) -> (Vec<Value>, Vec<Value>) {
        let traces = self
            .traces
            .iter()
            .filter(|(_, spans)| !is_routine(spans))
            .map(|(id, spans)| json!({ "traceId": id, "spans": spans }))
            .collect();
        (traces, self.lines.clone())
    }

    /// Puts saved traces and logs back, oldest first, ahead of anything recorded since.
    pub fn restore(&mut self, saved: &Value) {
        let live = std::mem::take(&mut self.traces);
        for trace in saved["traces"].as_array().map_or(&[][..], Vec::as_slice) {
            let (Some(id), Some(spans)) = (trace["traceId"].as_str(), trace["spans"].as_array())
            else {
                continue;
            };
            if !id.is_empty() && !spans.is_empty() {
                self.traces.push((
                    id.to_owned(),
                    spans.iter().take(SPANS_PER_TRACE).cloned().collect(),
                ));
            }
        }
        for (id, spans) in live {
            match self.traces.iter_mut().find(|(trace, _)| *trace == id) {
                Some((_, kept)) => kept.extend(spans),
                None => self.traces.push((id, spans)),
            }
        }
        self.evict();
        let mut lines: Vec<Value> = saved["logs"]
            .as_array()
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .filter(|line| line["body"].is_string())
            .cloned()
            .collect();
        lines.append(&mut self.lines);
        self.lines = lines;
        self.trim_logs();
    }

    /// One line per trace, newest first.
    pub fn summaries(&self) -> Vec<Value> {
        let number = |span: &Value, name: &str| span[name].as_f64().unwrap_or(0.0);
        let mut list: Vec<(f64, Value)> = self
            .traces
            .iter()
            .map(|(id, spans)| {
                let ids: HashSet<&str> = spans.iter().filter_map(|span| span["spanId"].as_str()).collect();
                let root = spans
                    .iter()
                    .find(|span| span["parentSpanId"].as_str().is_none_or(|parent| parent.is_empty() || !ids.contains(parent)))
                    .or_else(|| spans.first());
                let start = spans.iter().map(|span| number(span, "startMs")).fold(f64::INFINITY, f64::min);
                let end = spans.iter().map(|span| number(span, "startMs") + number(span, "durationMs")).fold(f64::NEG_INFINITY, f64::max);
                (start, json!({
                    "traceId": id,
                    "rootName": root.map_or("", |root| root["name"].as_str().unwrap_or_default()),
                    "startMs": start,
                    "durationMs": end - start,
                    "spanCount": spans.len(),
                    "errorCount": spans.iter().filter(|span| span["status"] == "error").count(),
                    "routine": is_routine(spans),
                }))
            })
            .collect();
        list.sort_by(|a, b| b.0.total_cmp(&a.0));
        list.into_iter().map(|(_, summary)| summary).collect()
    }

    /// A trace's spans by start time.
    pub fn trace(&self, id: &str) -> Option<Vec<Value>> {
        let (_, spans) = self.traces.iter().find(|(trace, _)| trace == id)?;
        let mut spans = spans.clone();
        spans.sort_by(|a, b| {
            a["startMs"]
                .as_f64()
                .unwrap_or(0.0)
                .total_cmp(&b["startMs"].as_f64().unwrap_or(0.0))
        });
        Some(spans)
    }

    /// The log lines, of a trace and from a severity up when asked.
    pub fn logs(&self, trace: Option<&str>, least_severity: Option<f64>) -> Vec<Value> {
        self.lines
            .iter()
            .filter(|line| trace.is_none_or(|id| line["traceId"] == id))
            .filter(|line| {
                least_severity
                    .is_none_or(|least| line["severityNumber"].as_f64().unwrap_or(0.0) >= least)
            })
            .cloned()
            .collect()
    }

    /// Forgets everything.
    pub fn clear(&mut self) {
        self.traces.clear();
        self.lines.clear();
    }
}
