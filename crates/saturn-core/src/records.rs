//! Reading and changing saved records, which stay as JSON so fields this crate does not read survive a save.
use serde_json::Value;

use crate::{CoreError, Kernel};

/// The record with this id.
pub fn by_id<'a>(list: &'a [Value], id: &str) -> Option<&'a Value> {
    list.iter().find(|item| text(item, "id") == id)
}

/// The record with this id, to change.
pub fn by_id_mut<'a>(list: &'a mut [Value], id: &str) -> Option<&'a mut Value> {
    list.iter_mut().find(|item| text(item, "id") == id)
}

/// A text field, or nothing.
pub fn text<'a>(record: &'a Value, key: &str) -> &'a str {
    record.get(key).and_then(Value::as_str).unwrap_or("")
}

/// A list of texts.
pub fn strings(record: &Value, key: &str) -> Vec<String> {
    record
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.as_str().map(str::to_owned))
        .collect()
}

/// Removes a field.
pub fn remove(record: &mut Value, key: &str) {
    if let Some(fields) = record.as_object_mut() {
        fields.shift_remove(key);
    }
}

/// A run's generation: it moves on whenever what is running should no longer write to it.
pub fn generation(run: &Value) -> u64 {
    run.get("generation").and_then(Value::as_u64).unwrap_or(0)
}

/// Whether a run's status means something may still happen.
pub fn active(run: &Value) -> bool {
    matches!(
        text(run, "status"),
        "running" | "queued" | "waiting_approval" | "sleeping"
    )
}

impl Kernel {
    pub fn get_agent(&self, id: &str) -> Result<Value, CoreError> {
        self.store
            .read(|state| by_id(&state.agents, id).cloned())
            .ok_or_else(|| CoreError::new(404, "Agent not found"))
    }

    pub fn get_run(&self, id: &str) -> Result<Value, CoreError> {
        self.find_run(id)
            .ok_or_else(|| CoreError::new(404, "Run not found"))
    }

    /// The statuses of a run's sub-agents, which a watcher of the run also follows.
    pub fn children_statuses(&self, id: &str) -> String {
        self.store.read(|state| {
            state
                .runs
                .iter()
                .filter(|run| text(run, "parentRunId") == id)
                .map(|run| text(run, "status"))
                .collect::<Vec<_>>()
                .join(",")
        })
    }

    /// The project a run's chat is in.
    pub fn thread_project(&self, run: &Value) -> Option<String> {
        self.find_thread(text(run, "threadId"))
            .map(|thread| text(&thread, "projectId").to_owned())
            .filter(|id| !id.is_empty())
    }

    pub(crate) fn find_run(&self, id: &str) -> Option<Value> {
        self.store.read(|state| by_id(&state.runs, id).cloned())
    }

    pub(crate) fn find_thread(&self, id: &str) -> Option<Value> {
        self.store.read(|state| by_id(&state.threads, id).cloned())
    }

    pub(crate) fn model_of(&self, agent: &Value) -> Option<Value> {
        self.store
            .read(|state| by_id(&state.models, text(agent, "modelConnectionId")).cloned())
    }

    /// Whether a run is still on this generation.
    pub fn alive(&self, run_id: &str, expected: u64) -> bool {
        self.store
            .read(|state| by_id(&state.runs, run_id).is_some_and(|run| generation(run) == expected))
    }

    /// Refuses when the agent is paused.
    pub fn guard(&self, agent_id: &str) -> Result<(), CoreError> {
        if text(&self.get_agent(agent_id)?, "status") == "paused" {
            return Err(CoreError::new(409, "Agent is paused"));
        }
        Ok(())
    }

    /// Changes a run at once if it is still on this generation, and returns the save, which says whether it did.
    pub(crate) fn update_run(
        &self,
        run_id: &str,
        expected: u64,
        change: impl FnOnce(&mut Value),
    ) -> saturn_store::store::Saving<'_, bool> {
        self.store
            .update(|state| match by_id_mut(&mut state.runs, run_id) {
                Some(run) if generation(run) == expected => {
                    change(run);
                    true
                }
                _ => false,
            })
    }
}
