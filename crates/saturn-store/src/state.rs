//! What `state.json` holds. Records stay as JSON here, so fields this crate does not read are written back untouched; code
//! that works on a record reads the fields it needs.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The saved state, with fields in the order `runtime/` writes them.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub projects: Vec<Value>,
    pub active_project_id: Option<String>,
    pub agents: Vec<Value>,
    pub automations: Vec<Value>,
    pub models: Vec<Value>,
    pub mcp: Vec<Value>,
    pub rag: Vec<Value>,
    pub runs: Vec<Value>,
    pub threads: Vec<Value>,
    pub groups: Vec<Value>,
    pub group_messages: Vec<Value>,
    pub usage: Vec<Value>,
    pub settings: Map<String, Value>,
}

/// Settings of features Saturn no longer has, dropped when loading.
const RETIRED_SETTINGS: [&str; 2] = ["launchApp", "claudeCodeAuth"];

impl Default for AppState {
    fn default() -> Self {
        Self::from_saved(&Map::new()).0
    }
}

impl AppState {
    /// A state from `state.json`'s contents, with defaults for what is missing. The second value says whether part of it
    /// had the wrong type and was replaced by its default, which the next save would make permanent.
    pub fn from_saved(saved: &Map<String, Value>) -> (Self, bool) {
        let mut damaged = false;
        let mut list = |name: &str| match saved.get(name) {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => items.clone(),
            Some(_) => {
                damaged = true;
                Vec::new()
            }
        };
        let mut state = Self {
            projects: list("projects"),
            active_project_id: None,
            agents: list("agents"),
            automations: list("automations"),
            models: list("models"),
            mcp: list("mcp"),
            rag: list("rag"),
            runs: list("runs"),
            threads: list("threads"),
            groups: list("groups"),
            group_messages: list("groupMessages"),
            usage: list("usage"),
            settings: Map::new(),
        };
        match saved.get("activeProjectId") {
            None | Some(Value::Null) => {}
            Some(Value::String(id)) => state.active_project_id = Some(id.clone()),
            Some(_) => damaged = true,
        }
        match saved.get("settings") {
            None | Some(Value::Null) => {}
            Some(Value::Object(settings)) => state.settings = settings.clone(),
            Some(_) => damaged = true,
        }
        state.settings = settings_over_defaults(std::mem::take(&mut state.settings));
        (state, damaged)
    }
}

/// Saved settings over the defaults, in the order `runtime/` writes them; everything saved is kept but `RETIRED_SETTINGS`.
fn settings_over_defaults(mut saved: Map<String, Value>) -> Map<String, Value> {
    let mut settings = Map::new();
    for (name, default) in [
        ("name", Value::from("Saturn")),
        ("environment", Value::from("production")),
        ("logging", Value::from("info")),
        ("completionModelId", Value::Null),
    ] {
        let value = saved.shift_remove(name).filter(|value| !value.is_null());
        settings.insert(name.to_owned(), value.unwrap_or(default));
    }
    for name in RETIRED_SETTINGS {
        saved.shift_remove(name);
    }
    settings.append(&mut saved);
    settings
}
