//! Counters and histograms, cumulative since the runtime started.
use std::collections::{BTreeMap, HashMap};
use std::sync::{LazyLock, Mutex};

use serde_json::{Value, json};

use crate::{locked, now_ms, recording};

const DURATION_BUCKETS: &[f64] = &[
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0,
];
const TOKEN_BUCKETS: &[f64] = &[
    1.0, 4.0, 16.0, 64.0, 256.0, 1024.0, 4096.0, 16384.0, 65536.0, 262144.0, 1048576.0,
];

/// One instrument.
struct Definition {
    name: &'static str,
    unit: &'static str,
    description: &'static str,
    /// Histogram buckets; none for a counter.
    buckets: Option<&'static [f64]>,
}

const fn histogram(
    name: &'static str,
    unit: &'static str,
    description: &'static str,
    buckets: &'static [f64],
) -> Definition {
    Definition {
        name,
        unit,
        description,
        buckets: Some(buckets),
    }
}

const fn counter(name: &'static str, unit: &'static str, description: &'static str) -> Definition {
    Definition {
        name,
        unit,
        description,
        buckets: None,
    }
}

const DEFINITIONS: &[Definition] = &[
    histogram(
        "http.server.request.duration",
        "s",
        "Duration of HTTP requests handled by the runtime.",
        DURATION_BUCKETS,
    ),
    histogram(
        "gen_ai.client.operation.duration",
        "s",
        "Duration of LLM calls.",
        DURATION_BUCKETS,
    ),
    histogram(
        "gen_ai.client.token.usage",
        "{token}",
        "Tokens used per LLM call, split by gen_ai.token.type.",
        TOKEN_BUCKETS,
    ),
    counter(
        "saturn.agent.runs",
        "{run}",
        "Agent runs that ended, by outcome.",
    ),
    histogram(
        "saturn.agent.run.duration",
        "s",
        "Wall time of an agent run from start to its final state.",
        DURATION_BUCKETS,
    ),
    counter(
        "saturn.tool.calls",
        "{call}",
        "Tool calls, by tool and status.",
    ),
    histogram(
        "saturn.tool.duration",
        "s",
        "Duration of tool calls.",
        DURATION_BUCKETS,
    ),
    histogram(
        "saturn.mcp.request.duration",
        "s",
        "Duration of MCP JSON-RPC requests.",
        DURATION_BUCKETS,
    ),
    counter(
        "saturn.automation.runs",
        "{run}",
        "Automation firings, by trigger and outcome.",
    ),
    histogram(
        "saturn.store.write.duration",
        "s",
        "Time to persist runtime state to disk.",
        DURATION_BUCKETS,
    ),
    counter(
        "saturn.workspace.commands",
        "{command}",
        "Workspace terminal commands, by outcome.",
    ),
];

/// One set of attributes' reading.
struct Point {
    attributes: Value,
    start: f64,
    sum: f64,
    count: u64,
    least: f64,
    most: f64,
    counts: Vec<u64>,
}

#[derive(Default)]
struct Registry {
    /// Instrument name → the points by their attributes, spelled the same whatever order they were given in.
    points: BTreeMap<&'static str, HashMap<String, Point>>,
}

type ActiveRuns = Box<dyn Fn() -> usize + Send + Sync>;

static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(Mutex::default);
static ACTIVE_RUNS: Mutex<Option<ActiveRuns>> = Mutex::new(None);
static STARTED: LazyLock<f64> = LazyLock::new(now_ms);

/// Reports how many runs are working right now, read from live state on each reading.
pub fn set_active_runs(count: impl Fn() -> usize + Send + Sync + 'static) {
    LazyLock::force(&STARTED);
    *locked(&ACTIVE_RUNS) = Some(Box::new(count));
}

/// Takes one reading.
fn observe(name: &str, value: f64, attributes: Value) {
    if !recording() {
        return;
    }
    let Some(definition) = DEFINITIONS.iter().find(|item| item.name == name) else {
        return;
    };
    let sorted: BTreeMap<String, Value> = attributes
        .as_object()
        .map_or_else(BTreeMap::new, |fields| fields.clone().into_iter().collect());
    let key = serde_json::to_string(&sorted).unwrap_or_default();
    let mut registry = locked(&REGISTRY);
    let point = registry
        .points
        .entry(definition.name)
        .or_default()
        .entry(key)
        .or_insert_with(|| Point {
            attributes,
            start: now_ms(),
            sum: 0.0,
            count: 0,
            least: f64::INFINITY,
            most: f64::NEG_INFINITY,
            counts: vec![0; definition.buckets.map_or(0, |buckets| buckets.len() + 1)],
        });
    point.sum += value;
    point.count += 1;
    point.least = point.least.min(value);
    point.most = point.most.max(value);
    if let Some(buckets) = definition.buckets {
        let at = buckets
            .iter()
            .position(|bound| value <= *bound)
            .unwrap_or(buckets.len());
        point.counts[at] += 1;
    }
}

/// Adds to a counter.
pub fn add(name: &str, amount: f64, attributes: Value) {
    observe(name, amount, attributes);
}

/// Records one value of a histogram.
pub fn record(name: &str, value: f64, attributes: Value) {
    observe(name, value, attributes);
}

/// A whole number as JSON has it.
fn plain(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

/// The current values, by name.
pub fn view() -> Vec<Value> {
    if !recording() {
        return Vec::new();
    }
    let now = now_ms();
    let registry = locked(&REGISTRY);
    let mut metrics: Vec<(String, Value)> = Vec::new();
    for definition in DEFINITIONS {
        let Some(points) = registry
            .points
            .get(definition.name)
            .filter(|points| !points.is_empty())
        else {
            continue;
        };
        let mut shown: Vec<&Point> = points.values().collect();
        shown.sort_by(|a, b| a.start.total_cmp(&b.start));
        let list: Vec<Value> = shown
            .iter()
            .map(|point| match definition.buckets {
                Some(buckets) => json!({
                    "attributes": point.attributes,
                    "startMs": point.start,
                    "timeMs": now,
                    "histogram": {
                        "count": point.count,
                        "sum": plain(point.sum),
                        "min": plain(point.least),
                        "max": plain(point.most),
                        "boundaries": buckets.iter().map(|bound| plain(*bound)).collect::<Vec<_>>(),
                        "counts": point.counts,
                    },
                }),
                None => json!({ "attributes": point.attributes, "startMs": point.start, "timeMs": now, "value": plain(point.sum) }),
            })
            .collect();
        let mut metric = json!({ "name": definition.name, "description": definition.description, "unit": definition.unit });
        if definition.buckets.is_some() {
            metric["type"] = json!("histogram");
        } else {
            metric["type"] = json!("sum");
            metric["monotonic"] = json!(true);
        }
        metric["points"] = json!(list);
        metrics.push((definition.name.to_owned(), metric));
    }
    drop(registry);
    if let Some(count) = &*locked(&ACTIVE_RUNS) {
        metrics.push((
            "saturn.agent.runs.active".to_owned(),
            json!({
                "name": "saturn.agent.runs.active",
                "description": "Runs still working.",
                "unit": "{run}",
                "type": "sum",
                "monotonic": false,
                "points": [{ "attributes": {}, "startMs": *STARTED, "timeMs": now, "value": count() }],
            }),
        ));
    }
    metrics.sort_by(|a, b| a.0.cmp(&b.0));
    metrics.into_iter().map(|(_, metric)| metric).collect()
}
