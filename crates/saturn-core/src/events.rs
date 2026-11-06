//! Live updates for the apps: which runs changed since a subscriber last looked, and whether anything else did.
use saturn_store::AppState;
use serde_json::{Value, json};
use std::collections::HashMap;

use crate::records::{generation, text};

/// A cheap fingerprint of what a run shows; any change in it is worth a refresh.
pub fn run_fingerprint(run: &Value) -> String {
    let actions = run.get("actions").and_then(Value::as_array);
    let last = actions.and_then(|actions| actions.last());
    let files = run
        .get("checkpoint")
        .and_then(|checkpoint| checkpoint.get("files"))
        .and_then(Value::as_array);
    let verification = run
        .get("verification")
        .and_then(|verification| verification.get("ok"))
        .map_or(String::new(), ToString::to_string);
    [
        text(run, "status").to_owned(),
        generation(run).to_string(),
        actions.map_or(0, Vec::len).to_string(),
        last.map_or("", |action| text(action, "status")).to_owned(),
        u8::from(last.is_some_and(|action| action.get("result").is_some())).to_string(),
        text(run, "output").len().to_string(),
        text(run, "thinking").len().to_string(),
        text(run, "error").to_owned(),
        run.get("wake")
            .map_or("", |wake| text(wake, "at"))
            .to_owned(),
        verification,
        run.get("compacted")
            .and_then(|compacted| compacted.get("turns"))
            .map_or("0".to_owned(), ToString::to_string),
        files.map_or(0, Vec::len).to_string(),
        files.map_or(String::new(), |files| {
            files
                .iter()
                .map(|file| text(file, "review"))
                .collect::<Vec<_>>()
                .join(",")
        }),
    ]
    .join("|")
}

/// What besides runs a refresh depends on: agents, chats, projects, connections and automations.
fn other_fingerprint(state: &AppState) -> String {
    json!([
        state
            .agents
            .iter()
            .map(|agent| json!([
                agent.get("id"),
                agent.get("name"),
                agent.get("modelConnectionId"),
                agent.get("autonomy"),
                agent.get("status")
            ]))
            .collect::<Vec<_>>(),
        state
            .threads
            .iter()
            .map(|thread| json!([
                thread.get("id"),
                thread.get("title"),
                thread.get("worktree").and_then(|tree| tree.get("branch")),
                thread
                    .get("summary")
                    .and_then(|summary| summary.get("turns")),
                thread.get("pullRequest")
            ]))
            .collect::<Vec<_>>(),
        state
            .projects
            .iter()
            .map(|project| json!([
                project.get("id"),
                project.get("name"),
                project
                    .get("access")
                    .is_some_and(|access| !access.is_null())
            ]))
            .collect::<Vec<_>>(),
        state
            .models
            .iter()
            .map(|model| json!([model.get("id"), model.get("name"), model.get("effort")]))
            .collect::<Vec<_>>(),
        state
            .mcp
            .iter()
            .map(|server| json!([
                server.get("id"),
                server.get("status"),
                server.get("tools").and_then(Value::as_array).map(Vec::len)
            ]))
            .collect::<Vec<_>>(),
        state
            .automations
            .iter()
            .map(|automation| json!([
                automation.get("id"),
                automation.get("lastRunAt"),
                automation.get("enabled")
            ]))
            .collect::<Vec<_>>(),
    ])
    .to_string()
}

/// What one subscriber saw last.
#[derive(Clone, Debug, Default)]
pub struct EventWatch {
    runs: HashMap<String, String>,
    other: String,
}

impl EventWatch {
    /// A watch that starts from the state as it is now.
    pub fn new(state: &AppState) -> Self {
        let mut watch = Self::default();
        watch.changes(state);
        watch
    }

    /// What changed since the last look: `{ runs, other }`, or nothing.
    pub fn changes(&mut self, state: &AppState) -> Option<Value> {
        let mut runs = Vec::new();
        let mut next = HashMap::with_capacity(state.runs.len());
        for run in &state.runs {
            let print = run_fingerprint(run);
            if self.runs.get(text(run, "id")) != Some(&print) {
                let mut item = json!({ "id": text(run, "id") });
                if let Some(thread) = run.get("threadId").filter(|id| !id.is_null()) {
                    item["threadId"] = thread.clone();
                }
                item["agentId"] = text(run, "agentId").into();
                item["status"] = text(run, "status").into();
                if let Some(parent) = run.get("parentRunId").filter(|id| !id.is_null()) {
                    item["parentRunId"] = parent.clone();
                }
                runs.push(item);
            }
            next.insert(text(run, "id").to_owned(), print);
        }
        let removed = self.runs.keys().any(|id| !next.contains_key(id));
        self.runs = next;
        let other = other_fingerprint(state);
        let changed = other != self.other || removed;
        self.other = other;
        (!runs.is_empty() || changed).then(|| json!({ "runs": runs, "other": changed }))
    }
}
