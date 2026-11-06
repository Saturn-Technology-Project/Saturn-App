//! Signing in to a server with OAuth 2.1: finding its authorization server, registering a client (or using one the user
//! registered), PKCE, tokens and their refresh. Everything is kept in the runtime's secrets file.
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use saturn_telemetry::network::SendNoted;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use url::Url;

use crate::{McpClient, McpError, Target, locked, secret_key};

/// A sign-in waiting for the browser to come back.
#[derive(Clone, Debug)]
pub(crate) struct Pending {
    pub target: Target,
    token_endpoint: String,
    resource: String,
    secret_in_header: bool,
}

/// Where a server's sign-in happens.
struct Endpoints {
    authorization: String,
    token: String,
    registration: Option<String>,
    resource: String,
    scope: Option<String>,
    /// The token endpoint takes a client secret only in the Authorization header.
    secret_in_header: bool,
}

fn random_text(bytes: usize) -> Result<String, McpError> {
    let mut raw = vec![0_u8; bytes];
    getrandom::fill(&mut raw).map_err(|error| McpError::failed(error.to_string()))?;
    Ok(URL_SAFE_NO_PAD.encode(raw))
}

/// A value of a `key="value"` pair in a WWW-Authenticate header.
fn challenge_value(header: Option<&str>, key: &str) -> Option<String> {
    let header = header?;
    let start = header.find(&format!("{key}="))? + key.len() + 1;
    let rest = &header[start..];
    Some(match rest.strip_prefix('"') {
        Some(quoted) => quoted.split('"').next()?.to_owned(),
        None => rest.split([',', ' ']).next()?.to_owned(),
    })
}

/// Only web addresses may be opened in the browser or sent a credential; a server's metadata could name anything else.
fn web_address(value: &str, name: &str) -> Result<String, McpError> {
    let parsed = Url::parse(value)
        .map_err(|_| McpError::failed(format!("The server's {name} is not an address")))?;
    let local = matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if parsed.scheme() == "https" || (parsed.scheme() == "http" && local) {
        Ok(value.to_owned())
    } else {
        Err(McpError::failed(format!(
            "The server's {name} must use https"
        )))
    }
}

impl McpClient {
    pub(crate) fn saved_access_token(&self, id: &str) -> Option<String> {
        let saved: Value =
            serde_json::from_str(&self.store.secret(&secret_key(id, "tokens"))?).ok()?;
        saved.get("access_token")?.as_str().map(str::to_owned)
    }

    async fn get_json(&self, url: &str) -> Option<Value> {
        let response = self
            .http
            .get(url)
            .header("accept", "application/json")
            .send_noted()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        serde_json::from_str(&response.text().await.ok()?).ok()
    }

    /// The first of a set of well-known addresses that answers.
    async fn first_json(&self, candidates: Vec<String>) -> Option<Value> {
        for candidate in candidates {
            if let Some(found) = self.get_json(&candidate).await {
                return Some(found);
            }
        }
        None
    }

    /// Finds the server's protected-resource metadata and its authorization server's.
    async fn endpoints(
        &self,
        target: &Target,
        challenge: Option<&str>,
    ) -> Result<Endpoints, McpError> {
        let server = Url::parse(&target.url)
            .map_err(|_| McpError::failed("The server's address is not valid"))?;
        let origin = server.origin().ascii_serialization();
        let path = server.path().trim_end_matches('/');
        let mut candidates = Vec::new();
        if let Some(named) = challenge_value(challenge, "resource_metadata") {
            candidates.push(named);
        }
        candidates.push(format!(
            "{origin}/.well-known/oauth-protected-resource{path}"
        ));
        candidates.push(format!("{origin}/.well-known/oauth-protected-resource"));
        let resource_metadata = self.first_json(candidates).await;
        let issuer = resource_metadata
            .as_ref()
            .and_then(|metadata| {
                metadata
                    .get("authorization_servers")?
                    .get(0)?
                    .as_str()
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| origin.clone());
        let issuer_url = Url::parse(&issuer)
            .map_err(|_| McpError::failed("The server's authorization server is not an address"))?;
        let issuer_origin = issuer_url.origin().ascii_serialization();
        let issuer_path = issuer_url.path().trim_end_matches('/');
        let mut places = vec![format!(
            "{issuer_origin}/.well-known/oauth-authorization-server{issuer_path}"
        )];
        if !issuer_path.is_empty() {
            places.push(format!(
                "{issuer_origin}/.well-known/openid-configuration{issuer_path}"
            ));
            places.push(format!("{issuer}/.well-known/openid-configuration"));
        } else {
            places.push(format!("{issuer_origin}/.well-known/openid-configuration"));
        }
        let metadata = self.first_json(places).await;
        let named = |key: &str, fallback: &str| {
            metadata
                .as_ref()
                .and_then(|found| found.get(key)?.as_str().map(str::to_owned))
                .unwrap_or_else(|| format!("{issuer_origin}{fallback}"))
        };
        let scope = challenge_value(challenge, "scope").or_else(|| {
            let scopes = resource_metadata
                .as_ref()?
                .get("scopes_supported")?
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>();
            (!scopes.is_empty()).then(|| scopes.join(" "))
        });
        let methods = metadata.as_ref().and_then(|found| {
            found
                .get("token_endpoint_auth_methods_supported")?
                .as_array()
                .cloned()
        });
        let secret_in_header = methods.is_some_and(|methods| {
            let has = |name: &str| methods.iter().any(|item| item.as_str() == Some(name));
            has("client_secret_basic") && !has("client_secret_post")
        });
        Ok(Endpoints {
            secret_in_header,
            authorization: web_address(
                &named("authorization_endpoint", "/authorize"),
                "sign-in page",
            )?,
            token: web_address(&named("token_endpoint", "/token"), "token endpoint")?,
            registration: match metadata
                .as_ref()
                .and_then(|found| found.get("registration_endpoint")?.as_str())
            {
                Some(address) => Some(web_address(address, "registration endpoint")?),
                None if metadata.is_none() => Some(format!("{issuer_origin}/register")),
                None => None,
            },
            resource: resource_metadata
                .as_ref()
                .and_then(|found| found.get("resource")?.as_str().map(str::to_owned))
                .unwrap_or_else(|| target.url.clone()),
            scope,
        })
    }

    /// The client saved for this server, registering one when the server allows that.
    async fn client_info(&self, target: &Target, endpoints: &Endpoints) -> Result<Value, McpError> {
        if let Some(saved) = self
            .store
            .secret(&secret_key(&target.id, "client"))
            .and_then(|saved| serde_json::from_str(&saved).ok())
        {
            return Ok(saved);
        }
        let register = endpoints.registration.as_ref().ok_or_else(|| McpError::failed("This server does not let apps register themselves. Create an OAuth client with the provider and paste its ID."))?;
        let body = json!({
            "client_name": "Saturn",
            "redirect_uris": [self.redirect_url],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        });
        let response = self
            .http
            .post(register)
            .header("content-type", "application/json")
            .body(body.to_string())
            .send_noted()
            .await
            .map_err(|error| McpError::failed(error.without_url().to_string()))?;
        if !response.status().is_success() {
            return Err(McpError::failed(format!(
                "The server refused to register Saturn ({}). Create an OAuth client with the provider and paste its ID.",
                response.status().as_u16()
            )));
        }
        let text = response
            .text()
            .await
            .map_err(|error| McpError::failed(error.without_url().to_string()))?;
        let info: Value = serde_json::from_str(&text)
            .map_err(|_| McpError::failed("The server's registration answer was not JSON"))?;
        if info.get("client_id").and_then(Value::as_str).is_none() {
            return Err(McpError::failed(
                "The server's registration answer had no client id",
            ));
        }
        self.store
            .put_secret(&secret_key(&target.id, "client"), &info.to_string())
            .await
            .map_err(|error| McpError::failed(error.to_string()))?;
        Ok(info)
    }

    /// Starts a browser sign-in. What comes back is what the caller reports: the address the browser went to, or why it could not.
    pub(crate) async fn begin_sign_in(&self, target: &Target, challenge: Option<&str>) -> McpError {
        match self.start_authorization(target, challenge).await {
            Ok(address) => McpError::SignIn(address),
            Err(error) => error,
        }
    }

    async fn start_authorization(
        &self,
        target: &Target,
        challenge: Option<&str>,
    ) -> Result<String, McpError> {
        let endpoints = self.endpoints(target, challenge).await?;
        let client = self.client_info(target, &endpoints).await?;
        let verifier = random_text(48)?;
        let state = random_text(16)?;
        self.store
            .put_secret(&secret_key(&target.id, "verifier"), &verifier)
            .await
            .map_err(|error| McpError::failed(error.to_string()))?;
        let challenge_text = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut address = Url::parse(&endpoints.authorization)
            .map_err(|_| McpError::failed("The server's sign-in page is not an address"))?;
        {
            let mut query = address.query_pairs_mut();
            query.append_pair("response_type", "code");
            query.append_pair(
                "client_id",
                client
                    .get("client_id")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            );
            query.append_pair("code_challenge", &challenge_text);
            query.append_pair("code_challenge_method", "S256");
            query.append_pair("redirect_uri", &self.redirect_url);
            query.append_pair("state", &state);
            query.append_pair("resource", &endpoints.resource);
            if let Some(scope) = &endpoints.scope {
                query.append_pair("scope", scope);
            }
        }
        locked(&self.pending).insert(
            state,
            Pending {
                target: target.clone(),
                token_endpoint: endpoints.token.clone(),
                resource: endpoints.resource.clone(),
                secret_in_header: endpoints.secret_in_header,
            },
        );
        let address = address.to_string();
        (self.open_browser)(&address);
        Ok(address)
    }

    /// Posts a form to the token endpoint and saves the tokens it answers with.
    async fn token_request(
        &self,
        target: &Target,
        endpoint: &str,
        client: &Value,
        secret_in_header: bool,
        form: &[(&str, &str)],
    ) -> Result<(), McpError> {
        let secret = client.get("client_secret").and_then(Value::as_str);
        let id = client
            .get("client_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        let body = {
            let mut pairs = url::form_urlencoded::Serializer::new(String::new());
            pairs.extend_pairs(form.iter().copied());
            pairs.append_pair("client_id", id);
            if let Some(secret) = secret.filter(|_| !secret_in_header) {
                pairs.append_pair("client_secret", secret);
            }
            pairs.finish()
        };
        let mut request = self
            .http
            .post(endpoint)
            .header("content-type", "application/x-www-form-urlencoded")
            .header("accept", "application/json")
            .body(body);
        if let Some(secret) = secret.filter(|_| secret_in_header) {
            request = request.basic_auth(id, Some(secret));
        }
        let response = request
            .send_noted()
            .await
            .map_err(|error| McpError::failed(error.without_url().to_string()))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| McpError::failed(error.without_url().to_string()))?;
        if !status.is_success() {
            // The provider's error code only: its answer could echo what was sent.
            let reason = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|body| body.get("error")?.as_str().map(str::to_owned))
                .unwrap_or_else(|| status.as_u16().to_string());
            return Err(McpError::failed(format!(
                "The server refused the sign-in ({reason})"
            )));
        }
        let mut tokens: Value = serde_json::from_str(&text)
            .map_err(|_| McpError::failed("The server's token answer was not JSON"))?;
        if tokens.get("access_token").and_then(Value::as_str).is_none() {
            return Err(McpError::failed("The server's token answer had no token"));
        }
        // A refresh that gives no new refresh token leaves the old one in force.
        if tokens.get("refresh_token").is_none()
            && let Some(saved) = self
                .store
                .secret(&secret_key(&target.id, "tokens"))
                .and_then(|saved| serde_json::from_str::<Value>(&saved).ok())
            && let Some(old) = saved.get("refresh_token")
        {
            tokens["refresh_token"] = old.clone();
        }
        self.store
            .put_secret(&secret_key(&target.id, "tokens"), &tokens.to_string())
            .await
            .map_err(|error| McpError::failed(error.to_string()))
    }

    /// Completes a browser sign-in from the provider's redirect. Returns the server that was signed in to.
    pub async fn finish_sign_in(&self, state: &str, code: &str) -> Result<Target, McpError> {
        let waiting = locked(&self.pending).remove(state).ok_or_else(|| McpError::failed("This sign-in is unknown or has already finished. Start it again from Customizations."))?;
        let target = waiting.target.clone();
        let verifier = self
            .store
            .secret(&secret_key(&target.id, "verifier"))
            .ok_or_else(|| McpError::failed("Sign-in expired; start it again"))?;
        let client: Value = self
            .store
            .secret(&secret_key(&target.id, "client"))
            .and_then(|saved| serde_json::from_str(&saved).ok())
            .ok_or_else(|| McpError::failed("Sign-in expired; start it again"))?;
        self.token_request(
            &target,
            &waiting.token_endpoint,
            &client,
            waiting.secret_in_header,
            &[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("code_verifier", &verifier),
                ("redirect_uri", &self.redirect_url),
                ("resource", &waiting.resource),
            ],
        )
        .await?;
        self.store
            .delete_secret(&secret_key(&target.id, "verifier"))
            .await
            .map_err(|error| McpError::failed(error.to_string()))?;
        self.close(&target.id);
        self.connect(&target).await?;
        eprintln!("[mcp] Signed in to {}", crate::host_of(&target.url));
        Ok(target)
    }

    /// Tries the saved refresh token. False when there is none or the server refused it.
    pub(crate) async fn refresh_tokens(&self, target: &Target) -> bool {
        let saved = self
            .store
            .secret(&secret_key(&target.id, "tokens"))
            .and_then(|saved| serde_json::from_str::<Value>(&saved).ok());
        let Some(refresh) = saved
            .as_ref()
            .and_then(|tokens| tokens.get("refresh_token")?.as_str())
        else {
            return false;
        };
        let client = self
            .store
            .secret(&secret_key(&target.id, "client"))
            .and_then(|saved| serde_json::from_str::<Value>(&saved).ok());
        let (Some(client), Ok(endpoints)) = (client, self.endpoints(target, None).await) else {
            return false;
        };
        let form = [
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh),
            ("resource", endpoints.resource.as_str()),
        ];
        self.token_request(
            target,
            &endpoints.token,
            &client,
            endpoints.secret_in_header,
            &form,
        )
        .await
        .is_ok()
    }
}
