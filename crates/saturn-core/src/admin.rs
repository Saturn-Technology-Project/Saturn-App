//! Local settings, the runtime's identity, and the in-app log.
use saturn_domain::js;
use serde_json::{Map, Value, json};

use crate::logger;
use crate::records::{by_id, text};
use crate::{CoreError, Kernel, log};

/// A sandbox setting from a request: a known mode, and whether commands may use the network.
pub fn check_sandbox(value: &Value) -> Result<Value, CoreError> {
    let mode =
        saturn_tools::sandbox::SandboxMode::from_value(value.get("mode")).ok_or_else(|| {
            CoreError::new(
                400,
                "sandbox.mode must be workspace-write, read-only or off",
            )
        })?;
    Ok(json!({ "mode": mode, "network": value.get("network") != Some(&Value::Bool(false)) }))
}

/// Puts a value in the settings, or removes the field when there is none.
fn set(settings: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(value) => {
            settings.insert(key.to_owned(), value);
        }
        None => {
            settings.shift_remove(key);
        }
    }
}

impl Kernel {
    pub fn settings(&self) -> Value {
        self.store
            .read(|state| Value::Object(state.settings.clone()))
    }

    /// Changes settings. Permission rules, hooks and plugins are edited through their own routes, never through this.
    pub async fn update_settings(&self, patch: &Value) -> Result<Value, CoreError> {
        let logging = patch
            .get("logging")
            .and_then(Value::as_str)
            .filter(|level| !level.is_empty());
        if logging.is_some_and(|level| !matches!(level, "debug" | "info" | "warning" | "error")) {
            return Err(CoreError::new(400, "Unknown logging level"));
        }
        let completion = patch
            .get("completionModelId")
            .map(|id| id.as_str().filter(|id| !id.is_empty()));
        let known_model = |id: &str| self.store.read(|state| by_id(&state.models, id).is_some());
        if completion.flatten().is_some_and(|id| !known_model(id)) {
            return Err(CoreError::new(400, "Unknown background model"));
        }
        if let Some(source) = patch.get("embeddingSource")
            && !matches!(source.as_str(), Some("builtin" | "lmstudio" | "openai"))
        {
            return Err(CoreError::new(
                400,
                "embeddingSource must be builtin, lmstudio or openai",
            ));
        }
        let embedding = text(patch, "embeddingConnectionId");
        if !embedding.is_empty() && !known_model(embedding) {
            return Err(CoreError::new(
                400,
                "Unknown model connection for embeddings",
            ));
        }
        let sandbox = match patch.get("sandbox") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(value) => Some(Some(check_sandbox(value)?)),
        };
        let before = self.settings();
        let next = self
            .store
            .update(|state| {
                let settings = &mut state.settings;
                for key in ["name", "environment"] {
                    let value = js::trim(text(patch, key));
                    if !value.is_empty() {
                        settings.insert(key.to_owned(), value.into());
                    }
                }
                if let Some(level) = logging {
                    settings.insert("logging".to_owned(), level.into());
                }
                if let Some(model) = completion {
                    settings.insert(
                        "completionModelId".to_owned(),
                        model.map_or(Value::Null, Value::from),
                    );
                }
                for key in ["memory", "planApproval", "claudeProjectSettings"] {
                    if let Some(flag) = patch.get(key).filter(|flag| flag.is_boolean()) {
                        settings.insert(key.to_owned(), flag.clone());
                    }
                }
                if let Some(sandbox) = sandbox {
                    set(settings, "sandbox", sandbox);
                }
                if matches!(
                    patch.get("browser").and_then(Value::as_str),
                    Some("saturn" | "system" | "safari")
                ) {
                    settings.insert("browser".to_owned(), patch["browser"].clone());
                }
                if let Some(source) = patch.get("embeddingSource") {
                    settings.insert("embeddingSource".to_owned(), source.clone());
                }
                for (key, value) in [
                    (
                        "embeddingModel",
                        patch
                            .get("embeddingModel")
                            .and_then(Value::as_str)
                            .map(js::trim),
                    ),
                    (
                        "embeddingConnectionId",
                        patch.get("embeddingConnectionId").and_then(Value::as_str),
                    ),
                ] {
                    if let Some(value) = value {
                        set(
                            settings,
                            key,
                            Some(value)
                                .filter(|value| !value.is_empty())
                                .map(Value::from),
                        );
                    }
                }
                // Null starts the onboarding over.
                match patch.get("onboardedAt") {
                    Some(Value::Null) => set(settings, "onboardedAt", None),
                    Some(Value::String(at)) => {
                        set(settings, "onboardedAt", Some(at.as_str().into()))
                    }
                    _ => {}
                }
                Value::Object(settings.clone())
            })
            .await?;
        if let Some(level) = logging {
            // Recorded whichever way it goes: at the louder of the two levels, so lowering it is on record as well.
            let was = before
                .get("logging")
                .and_then(Value::as_str)
                .unwrap_or("info");
            if was != level {
                logger::set_level(if logger::rank(level) < logger::rank(was) {
                    level
                } else {
                    "info"
                });
                log(
                    "runtime",
                    "info",
                    &format!("Logging level changed from {was} to {level}"),
                );
            }
            logger::set_level(level);
        }
        let setting = |values: &Value, key: &str| text(values, key).to_owned();
        let mut said = String::new();
        if setting(&next, "name") != setting(&before, "name") {
            said.push_str(&format!(" (name: {})", text(&next, "name")));
        }
        if setting(&next, "environment") != setting(&before, "environment") {
            said.push_str(&format!(" (environment: {})", text(&next, "environment")));
        }
        log("runtime", "info", &format!("Settings saved{said}"));
        Ok(next)
    }

    /// The runtime's identity and how its secrets are kept.
    pub async fn information(&self) -> Value {
        let (name, environment, servers) = self.store.read(|state| {
            let setting = |key: &str| state.settings.get(key).cloned().unwrap_or(Value::Null);
            let servers: Vec<Value> = state
                .mcp
                .iter()
                .filter_map(|item| item.get("id").cloned())
                .collect();
            (setting("name"), setting("environment"), servers)
        });
        let protection = self.store.secrets_protection().await;
        let host = std::env::var("SATURN_RUNTIME_HOST").unwrap_or_else(|_| "127.0.0.1".to_owned());
        let port = std::env::var("SATURN_RUNTIME_PORT").unwrap_or_else(|_| "4700".to_owned());
        json!({
            "version": "0.1.0",
            "listen": format!("http://{host}:{port}"),
            "name": name,
            "environment": environment,
            "runtimeId": "saturn-app",
            "mcpServers": servers,
            "secrets": { "encrypted": protection.encrypted, "keyStore": protection.key_store, "label": protection.label },
        })
    }

    /// The recent log, by service, lowest level and text.
    pub fn list_logs(service: &str, level: &str, query: &str) -> Vec<Value> {
        let floor = match level {
            "error" => 2,
            "warn" | "warning" => 1,
            _ => 0,
        };
        let rank = |line: &Value| match text(line, "level") {
            "error" => 2,
            "warning" => 1,
            _ => 0,
        };
        let wanted = query.to_lowercase();
        logger::recent()
            .into_iter()
            .filter(|line| {
                (service.is_empty() || text(line, "service") == service)
                    && rank(line) >= floor
                    && (wanted.is_empty() || text(line, "message").to_lowercase().contains(&wanted))
            })
            .collect()
    }
}
