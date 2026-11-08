//! Local agents and the model connections they use.
use std::collections::BTreeMap;
use std::sync::LazyLock;

use saturn_domain::js;
use saturn_domain::llm::{llm_provider, runs_locally, runs_on_plan};
use saturn_domain::new_id;
use saturn_llm::{Effort, ModelConnection};
use saturn_mcp::{LocalCommand, Target};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use url::Url;

use crate::builtins::{
    AUTOMATIONS_ID, COMPUTER_USE_ID, GENERAL_SKILLS_ID, ORIGIN_ID, RESEARCH_ID, builtin_server,
    with_general_skills,
};
use crate::records::{by_id, by_id_mut, remove, strings, text};
use crate::{CoreError, Kernel, log};

/// The providers with the models the settings page offers.
static PROVIDERS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("llm-providers.json")).expect("this file is valid JSON")
});

/// The providers, for the settings page.
pub fn llm_providers() -> &'static Value {
    &PROVIDERS
}

/// The name the provider's list gives a model.
pub(crate) fn known_label(provider: &str, model: &str) -> Option<&'static str> {
    let listed = PROVIDERS
        .as_array()?
        .iter()
        .find(|item| text(item, "id") == provider)?;
    let found = listed
        .get("models")?
        .as_array()?
        .iter()
        .find(|item| text(item, "id") == model)?;
    Some(text(found, "label"))
}

/// Where a local MCP server's environment variables are kept: the encrypted secrets file, never state.json.
pub fn env_secret_key(id: &str) -> String {
    format!("mcp:{id}:env")
}

/// Host only: MCP and knowledge source URLs can carry tokens in their path or query.
fn host_of(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|parsed| {
            let host = parsed.host_str()?.to_owned();
            Some(
                parsed
                    .port()
                    .map_or(host.clone(), |port| format!("{host}:{port}")),
            )
        })
        .unwrap_or_else(|| "(invalid url)".to_owned())
}

/// An MCP server is reached by URL, so adding one by address never makes Saturn start a program. Anything else (a command line,
/// a file: or stdio: address) is refused.
pub fn mcp_endpoint(url: &str) -> Result<String, CoreError> {
    let value = js::trim(url);
    let parsed = Url::parse(value).map_err(|_| {
        CoreError::new(400, "An MCP server is added by its URL (https://…). Saturn does not start local programs as MCP servers.")
    })?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err(CoreError::new(
            400,
            format!(
                "MCP servers are reached over HTTP(S), not {}. Saturn does not start local programs as MCP servers.",
                parsed.scheme()
            ),
        ));
    }
    Ok(value.to_owned())
}

/// Remote tool names, prefixed per server so two servers' `search` tools never collide; safe for every LLM API.
pub fn namespaced_tool(server: &str, name: &str) -> String {
    let joined: String = format!("{server}__{name}")
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
                character
            } else {
                '_'
            }
        })
        .collect();
    js::prefix(&joined, 64).to_owned()
}

/// A tool as saved, from what a request says about it.
fn route(server: &str, tool: &Value) -> Value {
    json!({
        "toolId": text(tool, "toolId"),
        "serverId": server,
        "description": text(tool, "description"),
        "inputSchema": { "type": "object", "properties": {} },
        "environments": ["production"],
    })
}

fn routes(server: &str, input: &Value) -> Vec<Value> {
    input
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|tool| route(server, tool))
        .collect()
}

/// What a program, its arguments and its variables are, checked: a local MCP server's command.
pub fn parse_command(input: &Value) -> Result<(Value, BTreeMap<String, String>), CoreError> {
    let program = js::trim(text(input, "program"));
    if program.is_empty() {
        return Err(CoreError::new(
            400,
            "A local MCP server needs the program to run, for example npx or uvx.",
        ));
    }
    if program.contains(['\r', '\n', '\0']) {
        return Err(CoreError::new(
            400,
            "The program name contains a line break.",
        ));
    }
    let args: Vec<&Value> = input
        .get("args")
        .and_then(Value::as_array)
        .map_or(Vec::new(), |items| items.iter().collect());
    let mut texts = Vec::new();
    for arg in args {
        let arg = arg
            .as_str()
            .ok_or_else(|| CoreError::new(400, "Arguments must be text."))?;
        if arg.contains('\0') {
            return Err(CoreError::new(400, "An argument contains a NUL character."));
        }
        texts.push(arg);
    }
    let mut env = BTreeMap::new();
    for (name, value) in input
        .get("env")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        let valid = name.chars().enumerate().all(|(index, character)| {
            character == '_'
                || character.is_ascii_alphabetic()
                || (index > 0 && character.is_ascii_digit())
        });
        if name.is_empty() || !valid {
            return Err(CoreError::new(
                400,
                format!("\"{name}\" is not a valid environment variable name."),
            ));
        }
        let value = value
            .as_str()
            .ok_or_else(|| CoreError::new(400, format!("The value of {name} must be text.")))?;
        env.insert(name.clone(), value.to_owned());
    }
    let names: Vec<&String> = env.keys().collect();
    Ok((
        json!({ "program": program, "args": texts, "env": names }),
        env,
    ))
}

/// The fingerprint the user approves: program, arguments, and every environment variable with its value.
pub fn command_fingerprint(command: &Value, env: &BTreeMap<String, String>) -> String {
    let entries: Vec<Value> = env
        .iter()
        .map(|(name, value)| json!([name, value]))
        .collect();
    let digest = Sha256::digest(
        json!([command.get("program"), command.get("args"), entries])
            .to_string()
            .as_bytes(),
    );
    saturn_domain::research::hex(&digest)
}

/// How the command reads in a terminal, for the approval card. Arguments with spaces or quotes are quoted.
pub fn command_line(command: &Value) -> String {
    let quote = |part: &str| {
        let plain = !part.is_empty()
            && part.chars().all(|character| {
                character.is_ascii_alphanumeric() || "_@%+=:,./-".contains(character)
            });
        if plain {
            part.to_owned()
        } else {
            format!("'{}'", part.replace('\'', "'\\''"))
        }
    };
    let mut parts = vec![quote(text(command, "program"))];
    parts.extend(strings(command, "args").iter().map(|arg| quote(arg)));
    parts.join(" ")
}

/// A readable placeholder for the url every MCP connection has.
fn command_address(command: &Value) -> String {
    let program = text(command, "program");
    let name = program.rsplit(['/', '\\']).next().unwrap_or(program);
    format!("stdio:{name}")
}

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

    /// Creates an agent. Without a list of its own it gets every server there is, except the research tools, which are asked for.
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
                    .filter(|id| id != GENERAL_SKILLS_ID && id != RESEARCH_ID)
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
        let given = named("name");
        let known = known_label(provider.id, &model_id);
        // A subscription model is named apart from the API model of the same name, so the two are never confused.
        let name = match known {
            _ if !given.is_empty() => given,
            Some(label) if provider.id == "claude-code" => format!("{label} (via Claude Code)"),
            Some(label) if !label.is_empty() => label.to_owned(),
            _ => model_id.clone(),
        };
        fields.insert("name".to_owned(), name.into());
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
                "Model {} connected ({}, {})",
                text(&model, "name"),
                provider.label,
                if !secret.is_empty() {
                    "key entered".to_owned()
                } else if keyed["hasSecret"] == true {
                    format!("using the saved {} key", provider.label)
                } else if provider.needs_key {
                    "no key".to_owned()
                } else {
                    "no key needed".to_owned()
                }
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

    /// Changes an agent. Its permission rules are edited through /permissions, never through this.
    pub async fn update_agent(&self, id: &str, patch: &Value) -> Result<Value, CoreError> {
        let before = self.get_agent(id)?;
        let changed = self
            .store
            .update(|state| {
                let agent = by_id_mut(&mut state.agents, id)?;
                let fields = [
                    "name",
                    "description",
                    "instructions",
                    "responseStyle",
                    "autonomy",
                    "temperature",
                    "maxOutput",
                    "status",
                    "ragConnectionIds",
                ];
                for key in fields {
                    if let Some(value) = patch.get(key).filter(|value| !value.is_null()) {
                        agent[key] = value.clone();
                    }
                }
                agent["canEdit"] = true.into();
                // Null clears the model; only a missing field keeps it.
                if let Some(model) = patch.get("modelConnectionId") {
                    agent["modelConnectionId"] = model.clone();
                }
                if patch.get("mcpConnectionIds").is_some_and(Value::is_array) {
                    agent["mcpConnectionIds"] =
                        with_general_skills(strings(patch, "mcpConnectionIds")).into();
                }
                Some(agent.clone())
            })
            .await?;
        let agent = changed.ok_or_else(|| CoreError::new(404, "Agent not found"))?;
        // Field names only: instructions and descriptions can be long or private. Nothing changed, nothing to say.
        let names: Vec<&str> = agent
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(key, value)| before.get(key.as_str()) != Some(*value))
            .map(|(key, _)| key.as_str())
            .collect();
        if !names.is_empty() {
            log(
                "catalog",
                "info",
                &format!(
                    "Agent \"{}\" updated: {}",
                    text(&agent, "name"),
                    names.join(", ")
                ),
            );
        }
        Ok(agent)
    }

    /// Deletes an agent with its runs, chats and automations.
    pub async fn delete_agent(&self, id: &str) -> Result<(), CoreError> {
        let agent = self.get_agent(id)?;
        let count = |records: &[Value]| {
            records
                .iter()
                .filter(|item| text(item, "agentId") == id)
                .count()
        };
        let (runs, automations) = self
            .store
            .read(|state| (count(&state.runs), count(&state.automations)));
        self.store
            .update(|state| {
                state.agents.retain(|item| text(item, "id") != id);
                state.runs.retain(|item| text(item, "agentId") != id);
                state.threads.retain(|item| text(item, "agentId") != id);
                state.automations.retain(|item| text(item, "agentId") != id);
            })
            .await?;
        log(
            "catalog",
            "info",
            &format!(
                "Agent \"{}\" deleted with {runs} runs and {automations} automations",
                text(&agent, "name")
            ),
        );
        Ok(())
    }

    /// Changes a model connection. A new key also becomes the provider's saved key.
    pub async fn update_model(&self, id: &str, patch: &Value) -> Result<Value, CoreError> {
        let secret = text(patch, "secret");
        let before = self
            .store
            .read(|state| by_id(&state.models, id).cloned())
            .ok_or_else(|| CoreError::new(404, "Model connection not found"))?;
        // Refused before anything is saved, or the model would claim a key it does not have.
        if !secret.is_empty() && runs_on_plan(text(&before, "provider")) {
            return Err(CoreError::new(
                400,
                "This model runs on your own plan through its official program and takes no API key.",
            ));
        }
        let updated = self
            .store
            .update(|state| {
                let model = by_id_mut(&mut state.models, id)?;
                for key in ["name", "provider", "baseUrl"] {
                    if let Some(value) = patch.get(key).filter(|value| value.is_string()) {
                        model[key] = value.clone();
                    }
                }
                let chosen = js::trim(text(patch, "model"));
                if !chosen.is_empty() {
                    model["model"] = chosen.into();
                }
                if !secret.is_empty() {
                    model["hasSecret"] = true.into();
                }
                match patch.get("effort") {
                    Some(Value::Null) => remove(model, "effort"),
                    Some(effort) if serde_json::from_value::<Effort>(effort.clone()).is_ok() => {
                        model["effort"] = effort.clone()
                    }
                    _ => {}
                }
                Some(model.clone())
            })
            .await?;
        let updated = updated.ok_or_else(|| CoreError::new(404, "Model connection not found"))?;
        if !secret.is_empty() {
            self.broker
                .save_key(&connection_of(&updated), secret)
                .await?;
        }
        // Never the key itself; for a key, only that one was saved and that it now serves the whole provider.
        let mut fields: Vec<&str> = ["name", "provider", "model", "baseUrl", "effort"]
            .into_iter()
            .filter(|key| before.get(*key) != updated.get(*key))
            .collect();
        if !secret.is_empty() {
            fields.push("API key");
        }
        if !fields.is_empty() {
            let shared = if secret.is_empty() {
                String::new()
            } else {
                format!(" (now the saved {} key)", text(&updated, "provider"))
            };
            log(
                "catalog",
                "info",
                &format!(
                    "Model {} updated: {}{shared}",
                    text(&updated, "name"),
                    fields.join(", ")
                ),
            );
        }
        Ok(self.with_key(&updated))
    }

    /// A local server's environment variables, from the secrets file.
    pub(crate) fn command_env(&self, id: &str) -> BTreeMap<String, String> {
        self.store
            .secret(&env_secret_key(id))
            .and_then(|saved| serde_json::from_str(&saved).ok())
            .unwrap_or_default()
    }

    /// How to reach a server. A local one must have its current command approved.
    pub(crate) fn mcp_target(&self, server: &Value) -> Result<Target, CoreError> {
        let id = text(server, "id");
        let Some(command) = server.get("command").filter(|command| !command.is_null()) else {
            let auth = if text(server, "auth").is_empty() {
                "none"
            } else {
                text(server, "auth")
            };
            return Ok(Target {
                id: id.to_owned(),
                url: text(server, "url").to_owned(),
                auth: auth.to_owned(),
                command: None,
            });
        };
        let env = self.command_env(id);
        if text(server, "approvedCommand") != command_fingerprint(command, &env) {
            return Err(CoreError::new(
                409,
                format!(
                    "The MCP server \"{}\" runs a program on this computer ({}). Allow it in Saturn Settings → MCP Servers before it can start.",
                    text(server, "name"),
                    command_line(command)
                ),
            ));
        }
        let mut variables = env;
        // Saturn adds a PATH that finds npx and uvx when it was started from the Dock; the rest are what the user set.
        if !cfg!(windows) && !variables.contains_key("PATH") {
            let inherited = std::env::var("PATH").unwrap_or_default();
            variables.insert(
                "PATH".to_owned(),
                format!(
                    "{inherited}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
                ),
            );
        }
        Ok(Target {
            id: id.to_owned(),
            url: text(server, "url").to_owned(),
            auth: "none".to_owned(),
            command: Some(LocalCommand {
                program: text(command, "program").to_owned(),
                args: strings(command, "args"),
                env: variables,
                cwd: Some(self.store.root().join("workspace")),
            }),
        })
    }

    /// A server with what Settings shows about a local one: its command line, and whether it may run.
    pub(crate) fn mcp_view(&self, server: &Value) -> Value {
        let mut view = server.clone();
        if let Some(command) = server.get("command").filter(|command| !command.is_null()) {
            let print = command_fingerprint(command, &self.command_env(text(server, "id")));
            view["commandLine"] = command_line(command).into();
            view["approval"] = if text(server, "approvedCommand") == print {
                "approved"
            } else {
                "needed"
            }
            .into();
            view["commandFingerprint"] = print.into();
        }
        view
    }

    /// The connections of one kind. Models say whether they have a key, never which.
    pub async fn list_connections(&self, kind: &str) -> Result<Vec<Value>, CoreError> {
        match kind {
            "models" => Ok(self.list_models()),
            "mcp" => {
                self.ensure_builtins().await?;
                let servers = self.store.read(|state| state.mcp.clone());
                Ok(servers.iter().map(|server| self.mcp_view(server)).collect())
            }
            "rag" => Ok(self.store.read(|state| state.rag.clone())),
            _ => Err(CoreError::new(404, "Unknown connection kind")),
        }
    }

    /// Adds an MCP server by URL, or a local one, which waits until the user has allowed its exact command.
    pub async fn create_mcp(&self, input: &Value) -> Result<Value, CoreError> {
        let id = new_id("mcp")?;
        let tools = routes(&id, input);
        if let Some(command) = input.get("command").filter(|command| !command.is_null()) {
            let (command, env) = parse_command(command)?;
            if !env.is_empty() {
                self.store
                    .put_secret(&env_secret_key(&id), &json!(env).to_string())
                    .await?;
            }
            let given = js::trim(text(input, "name"));
            let program = text(&command, "program");
            let name = if given.is_empty() {
                program.rsplit(['/', '\\']).next().unwrap_or(program)
            } else {
                given
            };
            let connection = json!({ "id": id, "name": name, "url": command_address(&command), "command": command, "tools": tools, "origin": "local" });
            let saved = connection.clone();
            self.store.update(|state| state.mcp.push(saved)).await?;
            log(
                "catalog",
                "info",
                &format!(
                    "Local MCP server {name} added ({}); it waits for approval before it starts",
                    command_line(&command)
                ),
            );
            return Ok(self.mcp_view(&connection));
        }
        let url = mcp_endpoint(text(input, "url"))?;
        let connection = json!({ "id": id, "name": text(input, "name"), "url": url, "tools": tools, "origin": "local" });
        let saved = connection.clone();
        self.store.update(|state| state.mcp.push(saved)).await?;
        log(
            "catalog",
            "info",
            &format!(
                "MCP server {} added at {} with {} tools",
                text(&connection, "name"),
                host_of(&url),
                connection["tools"].as_array().map_or(0, Vec::len)
            ),
        );
        Ok(connection)
    }

    /// Allows a local server's command to run. `fingerprint` is the one Settings showed the user; if the command changed since,
    /// nothing is allowed and the user is asked to look again.
    pub async fn approve_mcp(&self, id: &str, fingerprint: &str) -> Result<Value, CoreError> {
        let server = self
            .store
            .read(|state| by_id(&state.mcp, id).cloned())
            .ok_or_else(|| CoreError::new(404, "MCP connection not found"))?;
        let command = server
            .get("command")
            .filter(|command| !command.is_null())
            .ok_or_else(|| CoreError::new(400, "Only local MCP servers need approval"))?;
        let current = command_fingerprint(command, &self.command_env(id));
        if fingerprint != current {
            return Err(CoreError::new(
                409,
                "The command changed since you looked at it. Review it again before allowing it.",
            ));
        }
        let updated = self
            .store
            .update(|state| {
                let item = by_id_mut(&mut state.mcp, id)?;
                item["approvedCommand"] = current.as_str().into();
                Some(item.clone())
            })
            .await?
            .unwrap_or(server.clone());
        log(
            "catalog",
            "info",
            &format!(
                "Allowed the local MCP server {} to run: {}",
                text(&server, "name"),
                command_line(command)
            ),
        );
        Ok(self.mcp_view(&updated))
    }

    /// Changes an MCP server. A new command (or new variables) starts over: the old approval no longer applies.
    pub async fn update_mcp(&self, id: &str, patch: &Value) -> Result<Value, CoreError> {
        if id == GENERAL_SKILLS_ID
            && ["name", "url", "tools"]
                .iter()
                .any(|key| patch.get(*key).is_some_and(|value| !value.is_null()))
        {
            return Err(CoreError::new(403, "General Skills is built in"));
        }
        let url = patch
            .get("url")
            .filter(|url| !url.is_null())
            .map(|url| mcp_endpoint(url.as_str().unwrap_or("")))
            .transpose()?;
        let changed = patch
            .get("command")
            .filter(|command| !command.is_null())
            .map(parse_command)
            .transpose()?;
        if let Some((_, env)) = &changed {
            let local = self.store.read(|state| {
                by_id(&state.mcp, id).is_some_and(|server| {
                    server
                        .get("command")
                        .is_some_and(|command| !command.is_null())
                })
            });
            if !local {
                return Err(CoreError::new(
                    400,
                    "This MCP server is reached by its URL; add a local server separately.",
                ));
            }
            if env.is_empty() {
                self.store.delete_secret(&env_secret_key(id)).await?;
            } else {
                self.store
                    .put_secret(&env_secret_key(id), &json!(env).to_string())
                    .await?;
            }
            self.mcp.close(id);
        }
        let updated = self
            .store
            .update(|state| {
                let current = by_id_mut(&mut state.mcp, id)?;
                if let Some(name) = patch.get("name").filter(|name| name.is_string()) {
                    current["name"] = name.clone();
                }
                if let Some(url) = url {
                    current["url"] = url.into();
                }
                if let Some((command, _)) = changed {
                    current["url"] = command_address(&command).into();
                    current["command"] = command;
                    remove(current, "approvedCommand");
                }
                if let Some(disabled) = patch
                    .get("disabledTools")
                    .filter(|disabled| disabled.is_array())
                {
                    current["disabledTools"] = disabled.clone();
                }
                if patch.get("tools").is_some_and(Value::is_array) {
                    current["tools"] = routes(id, patch).into();
                }
                Some(current.clone())
            })
            .await?
            .ok_or_else(|| CoreError::new(404, "MCP connection not found"))?;
        log(
            "catalog",
            "info",
            &format!("MCP server {} updated", text(&updated, "name")),
        );
        Ok(self.mcp_view(&updated))
    }

    /// Removes an MCP server from every agent, with its saved environment.
    pub async fn delete_mcp_server(&self, id: &str) -> Result<(), CoreError> {
        if [GENERAL_SKILLS_ID, COMPUTER_USE_ID, ORIGIN_ID].contains(&id) {
            return Err(CoreError::new(403, "Built-in server cannot be removed"));
        }
        let server = self
            .store
            .read(|state| by_id(&state.mcp, id).cloned())
            .ok_or_else(|| CoreError::new(404, "MCP server not found"))?;
        self.store
            .update(|state| {
                state.mcp.retain(|item| text(item, "id") != id);
                for agent in &mut state.agents {
                    let kept: Vec<String> = strings(agent, "mcpConnectionIds")
                        .into_iter()
                        .filter(|item| item != id)
                        .collect();
                    agent["mcpConnectionIds"] = kept.into();
                }
            })
            .await?;
        // Its session (a local server's process) and any saved sign-in or environment go with it.
        self.mcp.forget(id).await?;
        self.store.delete_secret(&env_secret_key(id)).await?;
        log(
            "catalog",
            "info",
            &format!(
                "MCP server {} ({}) removed and detached from all agents",
                text(&server, "name"),
                host_of(text(&server, "url"))
            ),
        );
        Ok(())
    }

    /// Removes a connection the agents using it can do without: a model's move to `move_to` ("none" leaves them with no
    /// model, which they say when asked to run), and a server or index is taken off their lists. Done only when asked,
    /// since `delete_connection` alone refuses; an agent may no longer have a screen of its own to change it on.
    pub async fn release_connection(
        &self,
        kind: &str,
        id: &str,
        move_to: Option<&str>,
    ) -> Result<(), CoreError> {
        if !matches!(kind, "models" | "mcp" | "rag") {
            return Err(CoreError::new(404, "Unknown connection kind"));
        }
        let target = if kind == "models" {
            let asked = move_to.ok_or_else(|| {
                CoreError::new(400, "Say which model its agents move to, or \"none\".")
            })?;
            if asked == id {
                return Err(CoreError::new(
                    400,
                    "Its agents cannot move to the model being removed.",
                ));
            }
            if asked != "none"
                && !self
                    .store
                    .read(|state| state.models.iter().any(|model| text(model, "id") == asked))
            {
                return Err(CoreError::new(404, "No such model to move its agents to."));
            }
            (asked != "none").then(|| asked.to_owned())
        } else {
            None
        };
        let moved = self
            .store
            .update(|state| {
                let mut moved = 0;
                for agent in &mut state.agents {
                    match kind {
                        "models" if text(agent, "modelConnectionId") == id => {
                            agent["modelConnectionId"] = json!(target);
                            moved += 1;
                        }
                        "models" => {}
                        _ => {
                            let key = if kind == "mcp" {
                                "mcpConnectionIds"
                            } else {
                                "ragConnectionIds"
                            };
                            let kept: Vec<String> = strings(agent, key)
                                .into_iter()
                                .filter(|item| item != id)
                                .collect();
                            if kept.len() != strings(agent, key).len() {
                                agent[key] = json!(kept);
                                moved += 1;
                            }
                        }
                    }
                }
                moved
            })
            .await?;
        if moved > 0 {
            log(
                "catalog",
                "info",
                &format!("{moved} agents released a {kind} connection that is being removed"),
            );
        }
        self.delete_connection(kind, id).await
    }

    /// Removes a connection no agent uses.
    pub async fn delete_connection(&self, kind: &str, id: &str) -> Result<(), CoreError> {
        if !matches!(kind, "models" | "mcp" | "rag") {
            return Err(CoreError::new(404, "Unknown connection kind"));
        }
        let used = self.store.read(|state| {
            state.agents.iter().any(|agent| match kind {
                "models" => text(agent, "modelConnectionId") == id,
                "mcp" => strings(agent, "mcpConnectionIds")
                    .iter()
                    .any(|item| item == id),
                _ => strings(agent, "ragConnectionIds")
                    .iter()
                    .any(|item| item == id),
            })
        });
        if used {
            return Err(CoreError::new(409, "Connection is still used by an agent"));
        }
        self.store
            .update(|state| {
                let list = match kind {
                    "models" => &mut state.models,
                    "mcp" => &mut state.mcp,
                    _ => &mut state.rag,
                };
                list.retain(|item| text(item, "id") != id);
                // The editor's completions turn off rather than point at a model that is gone.
                if kind == "models"
                    && state
                        .settings
                        .get("completionModelId")
                        .and_then(Value::as_str)
                        == Some(id)
                {
                    state
                        .settings
                        .insert("completionModelId".to_owned(), Value::Null);
                }
            })
            .await?;
        // The provider's shared key stays, so other models of that provider keep working.
        if kind == "models" {
            self.store.delete_secret(id).await?;
        }
        Ok(())
    }

    /// Asks a server what tools it has now. The built-in ones are their own list.
    pub async fn discover_mcp(&self, id: &str) -> Result<Value, CoreError> {
        if id == GENERAL_SKILLS_ID {
            return Err(CoreError::new(403, "General Skills is built in"));
        }
        let server = self
            .store
            .read(|state| by_id(&state.mcp, id).cloned())
            .ok_or_else(|| CoreError::new(404, "MCP connection not found"))?;
        let tools = if [COMPUTER_USE_ID, ORIGIN_ID, AUTOMATIONS_ID].contains(&id) {
            builtin_server(id)["tools"].clone()
        } else {
            let listed = self.mcp.list_tools(&self.mcp_target(&server)?).await?;
            let market = text(&server, "marketplaceId");
            let routed: Vec<Value> = listed
                .into_iter()
                .map(|mut tool| {
                    tool["serverId"] = id.into();
                    if !market.is_empty() {
                        let remote = text(&tool, "toolId").to_owned();
                        tool["toolId"] = namespaced_tool(market, &remote).into();
                        tool["remoteName"] = remote.into();
                    }
                    tool
                })
                .collect();
            if routed.is_empty() {
                log(
                    "catalog",
                    "warning",
                    &format!(
                        "MCP server {} at {} returned no tools",
                        text(&server, "name"),
                        host_of(text(&server, "url"))
                    ),
                );
            }
            routed.into()
        };
        Ok(self
            .store
            .update(|state| {
                let current = by_id_mut(&mut state.mcp, id)?;
                current["tools"] = tools;
                Some(current.clone())
            })
            .await?
            .unwrap_or(Value::Null))
    }

    pub async fn create_rag(&self, input: &Value) -> Result<Value, CoreError> {
        let connection =
            json!({ "id": new_id("rag")?, "name": text(input, "name"), "url": text(input, "url") });
        let saved = connection.clone();
        self.store.update(|state| state.rag.push(saved)).await?;
        log(
            "catalog",
            "info",
            &format!(
                "Knowledge source {} added at {}",
                text(&connection, "name"),
                host_of(text(&connection, "url"))
            ),
        );
        Ok(connection)
    }

    pub async fn update_rag(&self, id: &str, patch: &Value) -> Result<Value, CoreError> {
        self.store
            .update(|state| {
                let current = by_id_mut(&mut state.rag, id)?;
                for key in ["name", "url"] {
                    if let Some(value) = patch.get(key).filter(|value| value.is_string()) {
                        current[key] = value.clone();
                    }
                }
                Some(current.clone())
            })
            .await?
            .ok_or_else(|| CoreError::new(404, "RAG connection not found"))
    }

    /// The models LM Studio has loaded; an empty list while it is not running, since the settings form polls this.
    pub async fn lm_studio_models(&self, base_url: &str) -> Vec<Value> {
        let url = if base_url.is_empty() {
            "http://127.0.0.1:1234"
        } else {
            base_url
        };
        let Ok(root) = saturn_llm::lmstudio::openai_compatible_url(url) else {
            return Vec::new();
        };
        let root = root.strip_suffix("/v1").unwrap_or(&root);
        let timeout = std::time::Duration::from_secs(4);
        let http = self.broker.http();
        let data = |reply: Option<Value>| {
            reply.and_then(|body| body.get("data").and_then(Value::as_array).cloned())
        };
        let native = data(
            http.get_json(&format!("{root}/api/v0/models"), timeout)
                .await
                .ok()
                .flatten(),
        )
        .map(|items| {
            items
                .into_iter()
                .filter(|item| matches!(text(item, "type"), "llm" | "vlm"))
                .collect::<Vec<_>>()
        });
        let models = match native {
            Some(models) => models,
            None => data(
                http.get_json(&format!("{root}/v1/models"), timeout)
                    .await
                    .ok()
                    .flatten(),
            )
            .unwrap_or_default()
            .into_iter()
            .filter(|item| !text(item, "id").to_lowercase().contains("embed"))
            .collect(),
        };
        models
            .iter()
            .map(|item| json!({ "id": text(item, "id"), "label": text(item, "id") }))
            .collect()
    }

    /// The models to offer for a cloud provider: those the provider lists for its saved key, else Saturn's built-in list,
    /// with `source` and a note saying which. The key goes only to the provider's own address or to one a connected model
    /// of that provider already uses, never to an address given only here.
    pub async fn provider_models(
        &self,
        provider_id: &str,
        base_url: &str,
    ) -> Result<Value, CoreError> {
        let provider = llm_provider(provider_id)
            .filter(|provider| !runs_locally(provider.id))
            .ok_or_else(|| {
                CoreError::new(
                    404,
                    "No such cloud provider. LM Studio and MLX list their models at their own routes.",
                )
            })?;
        let built_in: Vec<Value> = PROVIDERS
            .as_array()
            .and_then(|all| all.iter().find(|item| text(item, "id") == provider.id))
            .and_then(|item| item.get("models"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let fallback =
            |note: String| json!({ "models": built_in, "source": "built-in", "note": note });
        if runs_on_plan(provider.id) {
            return Ok(fallback(format!(
                "{} runs on your own plan and has no list Saturn can read. Any model id it accepts can be typed in.",
                provider.label
            )));
        }
        let bare = |url: &str| url.trim().trim_end_matches('/').to_owned();
        let address = if base_url.trim().is_empty() {
            bare(provider.base_url)
        } else {
            bare(base_url)
        };
        let known = address == bare(provider.base_url)
            || self.store.read(|state| {
                state.models.iter().any(|model| {
                    text(model, "provider") == provider.id
                        && bare(text(model, "baseUrl")) == address
                })
            });
        if !known {
            return Err(CoreError::new(
                400,
                format!(
                    "The {} key is sent only to its own address or to one a connected {} model uses.",
                    provider.label, provider.label
                ),
            ));
        }
        let Some(key) = self.broker.provider_key(provider.id) else {
            return Ok(fallback(format!(
                "No {} API key is saved, so these are Saturn's built-in models. Connect a model with a key to list the ones the key can use.",
                provider.label
            )));
        };
        let listed =
            match saturn_llm::listing::list_models(self.broker.http(), provider.id, &address, &key)
                .await
            {
                Some(Ok(listed)) if !listed.is_empty() => listed,
                Some(Ok(_)) | None => {
                    return Ok(fallback(format!(
                        "{} listed no models for this key, so these are Saturn's built-in models.",
                        provider.label
                    )));
                }
                Some(Err(error)) => {
                    log(
                        "catalog",
                        "warning",
                        &format!(
                            "Could not list {}'s models: {}",
                            provider.label, error.message
                        ),
                    );
                    return Ok(fallback(format!(
                        "{} did not list its models ({}), so these are Saturn's built-in models.",
                        provider.label, error.message
                    )));
                }
            };
        // Saturn's own models first, in its order and with its names, then the rest as the provider listed them. A built-in
        // model the provider did not list is one this key cannot use, and is left out.
        let is_listed = |id: &str| listed.iter().any(|model| model.id == id);
        let mut models: Vec<Value> = built_in
            .iter()
            .filter(|model| is_listed(text(model, "id")))
            .cloned()
            .collect();
        let known_ids: Vec<String> = models
            .iter()
            .map(|model| text(model, "id").to_owned())
            .collect();
        models.extend(
            listed
                .iter()
                .filter(|model| !known_ids.contains(&model.id))
                .map(|model| json!({ "id": model.id, "label": model.label.as_deref().unwrap_or(&model.id) })),
        );
        log(
            "catalog",
            "info",
            &format!(
                "{} listed {} models for its saved key",
                provider.label,
                models.len()
            ),
        );
        Ok(json!({ "models": models, "source": "provider" }))
    }

    /// The models `mlx_lm.server` can load; an empty list while it is not running, since the settings form polls this.
    pub async fn mlx_models(&self, base_url: &str) -> Vec<Value> {
        let url = if base_url.is_empty() {
            "http://127.0.0.1:8080"
        } else {
            base_url
        };
        saturn_llm::mlx::list_models(self.broker.http(), url)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|id| json!({ "id": id, "label": id }))
            .collect()
    }
}
