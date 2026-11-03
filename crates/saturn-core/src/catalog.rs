//! Local agents and the model connections they use.
use saturn_domain::llm::{llm_provider, runs_on_plan};
use saturn_domain::new_id;
use saturn_llm::{Effort, ModelConnection};
use serde_json::{Map, Value, json};

use crate::builtins::{GENERAL_SKILLS_ID, with_general_skills};
use crate::records::{by_id, strings, text};
use crate::{CoreError, Kernel, log};

/// A saved model as the broker reads it. An effort it does not know counts as none.
pub fn connection_of(model: &Value) -> ModelConnection {
    ModelConnection {
        id: text(model, "id").to_owned(),
        name: text(model, "name").to_owned(),
        provider: text(model, "provider").to_owned(),
        model: text(model, "model").to_owned(),
        base_url: text(model, "baseUrl").to_owned(),
        effort: model
            .get("effort")
            .and_then(|effort| serde_json::from_value::<Effort>(effort.clone()).ok()),
    }
}

/// The value of a field if the input has one, else the fallback.
fn or(input: &Value, key: &str, fallback: Value) -> Value {
    input
        .get(key)
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or(fallback)
}

impl Kernel {
    pub async fn list_agents(&self) -> Result<Vec<Value>, CoreError> {
        self.ensure_builtins().await?;
        Ok(self.store.read(|state| state.agents.clone()))
    }

    /// Creates an agent. Without a list of its own it gets every server there is.
    pub async fn create_agent(&self, input: &Value) -> Result<Value, CoreError> {
        self.ensure_builtins().await?;
        let servers = if input.get("mcpConnectionIds").is_some_and(Value::is_array) {
            strings(input, "mcpConnectionIds")
        } else {
            self.store.read(|state| {
                state
                    .mcp
                    .iter()
                    .map(|item| text(item, "id").to_owned())
                    .filter(|id| id != GENERAL_SKILLS_ID)
                    .collect()
            })
        };
        let agent = json!({
            "id": new_id("agent")?,
            "name": text(input, "name"),
            "description": or(input, "description", json!("")),
            "instructions": or(input, "instructions", json!("")),
            "responseStyle": or(input, "responseStyle", json!("professional")),
            "autonomy": or(input, "autonomy", json!("execute_when_allowed")),
            "temperature": or(input, "temperature", json!(0.2)),
            "maxOutput": or(input, "maxOutput", json!(4000)),
            "status": "active",
            "canEdit": true,
            "modelConnectionId": or(input, "modelConnectionId", Value::Null),
            "mcpConnectionIds": with_general_skills(servers),
            "ragConnectionIds": or(input, "ragConnectionIds", json!([])),
        });
        let saved = agent.clone();
        self.store.update(|state| state.agents.push(saved)).await?;
        let model = self.model_of(&agent);
        let on = model.map_or(" with no model".to_owned(), |model| {
            format!(" on {}", text(&model, "name"))
        });
        log(
            "catalog",
            "info",
            &format!("Agent \"{}\" created{on}", text(&agent, "name")),
        );
        Ok(agent)
    }

    /// Whether a model has a key to send.
    fn with_key(&self, model: &Value) -> Value {
        let mut keyed = model.clone();
        keyed["hasSecret"] = self.broker.has_key(&connection_of(model)).into();
        keyed
    }

    /// The saved models, each saying whether it has a key. Never the key.
    pub fn list_models(&self) -> Vec<Value> {
        self.store
            .read(|state| state.models.clone())
            .iter()
            .map(|model| self.with_key(model))
            .collect()
    }

    /// Connects a model, saving its key when one came with it.
    pub async fn create_model(&self, input: &Value) -> Result<Value, CoreError> {
        let wanted = text(input, "provider");
        let provider = llm_provider(if wanted.is_empty() { "openai" } else { wanted }).ok_or_else(
            || {
                CoreError::new(
                    400,
                    "Choose OpenAI, Claude, Claude (via Claude Code), Codex, Gemini, DeepSeek, or LM Studio",
                )
            },
        )?;
        let secret = text(input, "secret");
        if runs_on_plan(provider.id) && !secret.is_empty() {
            return Err(CoreError::new(
                400,
                format!(
                    "{} runs on your own plan through its official program and takes no API key. For API access, add the model under Claude or OpenAI.",
                    provider.label
                ),
            ));
        }
        let named = |key: &str| saturn_domain::js::trim(text(input, key)).to_owned();
        let model_id = if text(input, "model").is_empty() {
            named("name")
        } else {
            named("model")
        };
        if model_id.is_empty() {
            return Err(CoreError::new(400, "Choose a model"));
        }
        let base_url = if text(input, "baseUrl").is_empty() {
            provider.base_url
        } else {
            text(input, "baseUrl")
        };
        let mut fields = Map::new();
        fields.insert("id".to_owned(), new_id("mdl")?.into());
        let name = named("name");
        fields.insert(
            "name".to_owned(),
            if name.is_empty() { &model_id } else { &name }
                .as_str()
                .into(),
        );
        fields.insert("provider".to_owned(), provider.id.into());
        fields.insert("model".to_owned(), model_id.as_str().into());
        fields.insert(
            "baseUrl".to_owned(),
            base_url.strip_suffix('/').unwrap_or(base_url).into(),
        );
        fields.insert("hasSecret".to_owned(), (!secret.is_empty()).into());
        if let Some(effort) = input
            .get("effort")
            .filter(|effort| serde_json::from_value::<Effort>((*effort).clone()).is_ok())
        {
            fields.insert("effort".to_owned(), effort.clone());
        }
        let model = Value::Object(fields);
        let saved = model.clone();
        self.store.update(|state| state.models.push(saved)).await?;
        if !secret.is_empty() {
            self.broker.save_key(&connection_of(&model), secret).await?;
        }
        let keyed = self.with_key(&model);
        log(
            "catalog",
            "info",
            &format!(
                "Model {} connected ({})",
                text(&model, "name"),
                provider.label
            ),
        );
        if provider.needs_key && keyed["hasSecret"] != true {
            log(
                "catalog",
                "warning",
                &format!(
                    "{} has no {} API key; runs on it will be refused until one is added",
                    text(&model, "name"),
                    provider.label
                ),
            );
        }
        Ok(keyed)
    }

    /// The model an agent uses, or why it has none.
    pub(crate) fn require_model(&self, agent: &Value) -> Result<Value, CoreError> {
        self.store
            .read(|state| by_id(&state.models, text(agent, "modelConnectionId")).cloned())
            .ok_or_else(|| CoreError::new(409, "Agent has no model connection"))
    }
}
