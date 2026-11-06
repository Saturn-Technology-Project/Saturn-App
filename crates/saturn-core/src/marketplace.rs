//! Installs Customizations integrations as real MCP connections: saves any credential, connects (sending the browser to sign in
//! when needed), discovers the tools and attaches them to agents.
use std::sync::LazyLock;

use saturn_domain::js;
use saturn_mcp::{McpError, Target};
use serde_json::{Value, json};

use crate::records::{by_id, by_id_mut, remove, strings, text};
use crate::{CoreError, Kernel, log};

/// How each integration installs.
static RECIPES: LazyLock<Vec<Value>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("install-recipes.json")).expect("this file is valid JSON")
});

/// The MCP connection id an installed integration uses.
fn connection_id(id: &str) -> String {
    format!("mkt-{id}")
}

/// A name from an integration's id.
fn display_name(id: &str) -> String {
    id.split('-')
        .map(|part| {
            let mut characters = part.chars();
            characters.next().map_or(String::new(), |first| {
                first.to_uppercase().chain(characters).collect()
            })
        })
        .collect::<Vec<_>>()
        .join(" ")
}

impl Kernel {
    /// Every integration, with how it stands if installed.
    pub fn marketplace_list(&self) -> Vec<Value> {
        RECIPES
            .iter()
            .map(|recipe| self.marketplace_entry(recipe))
            .collect()
    }

    fn marketplace_entry(&self, recipe: &Value) -> Value {
        let id = text(recipe, "id");
        let wanted = connection_id(id);
        let installed = self.store.read(|state| {
            by_id(&state.mcp, &wanted).map(|connection| {
                let agents = state.agents.iter().filter(|agent| strings(agent, "mcpConnectionIds").contains(&wanted)).count();
                let mut view = json!({
                    "connectionId": wanted,
                    "status": if text(connection, "status").is_empty() { "ready" } else { text(connection, "status") },
                });
                for key in ["statusDetail", "authorizationUrl"] {
                    if let Some(value) = connection.get(key) {
                        view[if key == "statusDetail" { "detail" } else { key }] = value.clone();
                    }
                }
                view["tools"] = connection.get("tools").and_then(Value::as_array).map_or(0, Vec::len).into();
                view["agents"] = agents.into();
                view
            })
        });
        let mut entry = json!({ "id": id, "available": recipe.get("unavailable").is_none() });
        if let Some(reason) = recipe.get("unavailable") {
            entry["reason"] = reason.clone();
        }
        for key in ["auth", "setupUrl", "setupHint", "tokenAlternative"] {
            if let Some(value) = recipe.get(key) {
                entry[key] = value.clone();
            }
        }
        entry["installed"] = installed.unwrap_or(Value::Null);
        entry
    }

    fn recipe(id: &str) -> Result<&'static Value, CoreError> {
        RECIPES
            .iter()
            .find(|item| text(item, "id") == id)
            .ok_or_else(|| CoreError::new(404, "Unknown integration"))
    }

    /// One click: create the connection, connect (or start sign-in), discover tools, attach to agents.
    pub async fn marketplace_install(&self, id: &str, input: &Value) -> Result<Value, CoreError> {
        let recipe = Self::recipe(id)?;
        if let Some(reason) = recipe.get("unavailable").and_then(Value::as_str) {
            return Err(CoreError::new(409, reason));
        }
        let url = text(recipe, "url");
        if url.is_empty() {
            return Err(CoreError::new(409, "Not installable"));
        }
        let wanted = connection_id(id);
        let token = js::trim(text(input, "token"));
        let client = js::trim(text(input, "clientId"));
        let kind = text(recipe, "auth");
        let auth = match kind {
            "none" => "none",
            "token" if !token.is_empty() => "token",
            _ => "oauth",
        };
        if kind == "token" && token.is_empty() && client.is_empty() {
            let alternative = recipe.get("tokenAlternative") == Some(&Value::Bool(true));
            return Err(CoreError::new(
                400,
                if alternative {
                    "Paste a token, or an OAuth client ID"
                } else {
                    "Paste a token"
                },
            ));
        }
        if kind == "oauth-client"
            && client.is_empty()
            && self.store.secret(&format!("mcp:{wanted}:client")).is_none()
        {
            return Err(CoreError::new(
                400,
                "Paste the OAuth client ID you created with the provider",
            ));
        }
        let given = js::trim(text(input, "name"));
        let name = if given.is_empty() {
            self.store
                .read(|state| by_id(&state.mcp, &wanted).map(|item| text(item, "name").to_owned()))
                .unwrap_or_else(|| display_name(id))
        } else {
            given.to_owned()
        };
        self.store
            .update(|state| {
                if by_id(&state.mcp, &wanted).is_none() {
                    state.mcp.push(json!({ "id": wanted, "tools": [] }));
                }
                if let Some(next) = by_id_mut(&mut state.mcp, &wanted) {
                    next["name"] = name.as_str().into();
                    next["url"] = url.into();
                    next["auth"] = auth.into();
                    next["marketplaceId"] = id.into();
                    next["status"] = "connecting".into();
                    remove(next, "statusDetail");
                    remove(next, "authorizationUrl");
                }
            })
            .await?;
        if !token.is_empty() {
            self.mcp.save_token(&wanted, token).await?;
        }
        if !client.is_empty() {
            self.mcp
                .save_oauth_client(
                    &wanted,
                    client,
                    input.get("clientSecret").and_then(Value::as_str),
                )
                .await?;
        }
        log(
            "marketplace",
            "info",
            &format!("Installing {name} ({auth})"),
        );
        let target = Target {
            id: wanted.clone(),
            url: url.to_owned(),
            auth: auth.to_owned(),
            command: None,
        };
        match self.mcp.connect(&target).await {
            Ok(()) => {
                self.finish_install(&wanted, text(input, "attach") != "none")
                    .await?
            }
            Err(McpError::SignIn(address)) => {
                self.set_install_status(
                    &wanted,
                    json!({ "status": "signing_in", "authorizationUrl": address }),
                )
                .await?;
                log(
                    "marketplace",
                    "info",
                    &format!("{name}: waiting for sign-in in the browser"),
                );
            }
            Err(McpError::Failed(message)) => {
                log(
                    "marketplace",
                    "warning",
                    &format!("{name} could not connect: {message}"),
                );
                self.set_install_status(
                    &wanted,
                    json!({ "status": "error", "statusDetail": message }),
                )
                .await?;
            }
        }
        Ok(self.marketplace_entry(recipe))
    }

    /// Called by the OAuth redirect: finish sign-in, then discover tools and attach. Gives the integration's name.
    pub async fn marketplace_complete_sign_in(
        &self,
        state: &str,
        code: &str,
    ) -> Result<String, CoreError> {
        let target = self.mcp.finish_sign_in(state, code).await?;
        self.finish_install(&target.id, true).await?;
        Ok(self.store.read(|state| {
            by_id(&state.mcp, &target.id).map_or("the integration".to_owned(), |item| {
                text(item, "name").to_owned()
            })
        }))
    }

    /// Removes an integration from every agent, with its sign-in.
    pub async fn marketplace_uninstall(&self, id: &str) -> Result<(), CoreError> {
        let wanted = connection_id(id);
        if self
            .store
            .read(|state| by_id(&state.mcp, &wanted).is_none())
        {
            return Ok(());
        }
        self.store
            .update(|state| {
                state.mcp.retain(|item| text(item, "id") != wanted);
                for agent in &mut state.agents {
                    let kept: Vec<String> = strings(agent, "mcpConnectionIds")
                        .into_iter()
                        .filter(|item| *item != wanted)
                        .collect();
                    agent["mcpConnectionIds"] = kept.into();
                }
            })
            .await?;
        self.mcp.forget(&wanted).await?;
        log(
            "marketplace",
            "info",
            &format!("{id} uninstalled and its sign-in removed"),
        );
        Ok(())
    }

    async fn finish_install(&self, id: &str, attach: bool) -> Result<(), CoreError> {
        match self.discover_mcp(id).await {
            Ok(_) => {
                self.store
                    .update(|state| {
                        if let Some(current) = by_id_mut(&mut state.mcp, id) {
                            current["status"] = "ready".into();
                            remove(current, "statusDetail");
                            remove(current, "authorizationUrl");
                        }
                        if attach {
                            for agent in &mut state.agents {
                                let mut ids = strings(agent, "mcpConnectionIds");
                                if !ids.iter().any(|item| item == id) {
                                    ids.push(id.to_owned());
                                    agent["mcpConnectionIds"] = ids.into();
                                }
                            }
                        }
                    })
                    .await?;
                Ok(())
            }
            Err(error) => {
                log(
                    "marketplace",
                    "warning",
                    &format!("{id} connected but its tools could not be listed: {error}"),
                );
                self.set_install_status(
                    id,
                    json!({ "status": "error", "statusDetail": error.message }),
                )
                .await
            }
        }
    }

    async fn set_install_status(&self, id: &str, patch: Value) -> Result<(), CoreError> {
        self.store
            .update(|state| {
                if let Some(current) = by_id_mut(&mut state.mcp, id) {
                    remove(current, "statusDetail");
                    remove(current, "authorizationUrl");
                    for (key, value) in patch.as_object().into_iter().flatten() {
                        current[key] = value.clone();
                    }
                }
            })
            .await?;
        Ok(())
    }
}
