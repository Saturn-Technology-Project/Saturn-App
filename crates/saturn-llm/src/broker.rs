//! The one door to every provider: for each request it picks which key to send (the model's own, else its provider's) and which
//! module talks to the provider, and prices what the call used.
use std::future::Future;
use std::io;
use std::sync::Arc;
use std::time::Instant;

use saturn_domain::llm::{CallToPrice, llm_provider, price_call, runs_on_plan};
use saturn_domain::new_id;
use saturn_domain::time::{iso_time, now_millis};
use saturn_store::FileStore;
use saturn_telemetry::{Kind, Span};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::http::{Http, LlmError};
use crate::lmstudio;
use crate::shared::{flatten_tool_turns, trimmed};
use crate::{
    ChatMessage, ChatRequest, Completion, Effort, Role, TokenUsage, ToolDef, claude, deepseek,
    gemini, openai,
};

/// Where keys live. The broker only needs to read and write them by id.
pub trait KeyVault: Send + Sync {
    fn secret(&self, id: &str) -> Option<String>;
    fn put_secret(&self, id: &str, value: &str) -> impl Future<Output = io::Result<()>> + Send;
}

impl KeyVault for FileStore {
    fn secret(&self, id: &str) -> Option<String> {
        FileStore::secret(self, id)
    }

    fn put_secret(&self, id: &str, value: &str) -> impl Future<Output = io::Result<()>> + Send {
        FileStore::put_secret(self, id, value)
    }
}

/// A saved model connection, as far as calling it goes.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelConnection {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub effort: Option<Effort>,
}

/// Who made a call, so its tokens and cost are filed under the right agent.
#[derive(Clone, Debug, Default)]
pub struct CallContext {
    pub agent_id: String,
    pub agent_name: String,
    pub run_id: Option<String>,
    /// "run", "automation_draft", "memory" or "compaction".
    pub purpose: &'static str,
}

/// One call as the rest of the runtime asks for it.
#[derive(Clone, Debug, Default)]
pub struct CompletionInput {
    pub context: CallContext,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolDef>,
    pub temperature: Option<f64>,
    pub max_output: Option<u64>,
    pub low_thinking: bool,
}

/// Which module serves a model.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Adapter {
    Claude,
    Gemini,
    DeepSeek,
    LmStudio,
    OpenAiChat,
    OpenAiResponses,
}

impl Adapter {
    pub fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Gemini => "gemini",
            Self::DeepSeek => "deepseek",
            Self::LmStudio => "lmstudio",
            Self::OpenAiChat => "openai-chat",
            Self::OpenAiResponses => "openai-responses",
        }
    }

    /// One call through this module.
    pub async fn complete(
        self,
        http: &Http,
        request: &ChatRequest,
    ) -> Result<Completion, LlmError> {
        match self {
            Self::Claude => claude::complete(http, request).await,
            Self::Gemini => gemini::complete(http, request).await,
            Self::DeepSeek => deepseek::complete(http, request).await,
            Self::LmStudio => lmstudio::complete(http, request).await,
            Self::OpenAiChat => openai::complete_chat(http, request).await,
            Self::OpenAiResponses => openai::complete_responses(http, request).await,
        }
    }
}

/// The id a provider's shared key is saved under.
pub fn provider_key_id(provider: &str) -> String {
    format!(
        "provider:{}",
        if provider.is_empty() {
            "openai"
        } else {
            provider
        }
    )
}

fn provider_or_openai(provider: &str) -> &str {
    if provider.is_empty() {
        "openai"
    } else {
        provider
    }
}

/// Sends calls to providers.
pub struct Broker<V> {
    vault: Arc<V>,
    http: Http,
}

impl<V: KeyVault> Broker<V> {
    pub fn new(vault: Arc<V>, http: Http) -> Self {
        Self { vault, http }
    }

    pub fn http(&self) -> &Http {
        &self.http
    }

    /// True when the model talks to its provider's own endpoint, so the provider's list price applies.
    pub fn hosted(&self, model: &ModelConnection) -> bool {
        llm_provider(provider_or_openai(&model.provider))
            .is_some_and(|provider| trimmed(provider.base_url) == trimmed(&model.base_url))
    }

    /// The model's own key, else the key saved for its provider, so every model of a provider shares one key.
    pub fn key_for(&self, model: &ModelConnection) -> Option<String> {
        self.vault
            .secret(&model.id)
            .or_else(|| self.vault.secret(&provider_key_id(&model.provider)))
    }

    /// The key saved for a provider, which its models share.
    pub fn provider_key(&self, provider: &str) -> Option<String> {
        self.vault
            .secret(&provider_key_id(provider))
            .filter(|key| !key.is_empty())
    }

    pub fn has_key(&self, model: &ModelConnection) -> bool {
        self.key_for(model).is_some_and(|key| !key.is_empty())
    }

    /// Binds the key to the model and to its provider, so later models of that provider reuse it.
    pub async fn save_key(&self, model: &ModelConnection, secret: &str) -> io::Result<()> {
        let key = secret.trim();
        if key.is_empty() {
            return Ok(());
        }
        self.vault.put_secret(&model.id, key).await?;
        self.vault
            .put_secret(&provider_key_id(&model.provider), key)
            .await
    }

    /// Refuses up front when a model on the provider's own endpoint has no key to send.
    pub fn require_key(&self, model: &ModelConnection) -> Result<(), LlmError> {
        match llm_provider(provider_or_openai(&model.provider)) {
            Some(provider) if provider.needs_key && self.hosted(model) && !self.has_key(model) => {
                Err(LlmError::new(
                    Some(409),
                    format!(
                        "{} has no {} API key. Add it in Settings → Models.",
                        model.name, provider.label
                    ),
                ))
            }
            _ => Ok(()),
        }
    }

    /// Which module serves this model. Subscription models have none: they never make API requests.
    pub fn adapter_for(&self, model: &ModelConnection) -> Result<Adapter, LlmError> {
        if runs_on_plan(&model.provider) {
            let program = if model.provider == "codex" {
                "Codex"
            } else {
                "Claude Code"
            };
            return Err(LlmError::new(
                None,
                format!(
                    "{} runs through {program} on your own plan; Saturn never sends API requests for it. Use a model with an API key for this.",
                    model.name
                ),
            ));
        }
        Ok(match model.provider.as_str() {
            "claude" => Adapter::Claude,
            "gemini" => Adapter::Gemini,
            "deepseek" => Adapter::DeepSeek,
            "lmstudio" => Adapter::LmStudio,
            _ if openai::is_official_openai(&model.base_url) => Adapter::OpenAiResponses,
            _ => Adapter::OpenAiChat,
        })
    }

    /// One model call. A provider or server that rejects native tool turns (a 400 or 422) is asked again with them as text, the
    /// format every provider took before; the run goes on, and the log says so.
    pub async fn complete(
        &self,
        model: &ModelConnection,
        input: &CompletionInput,
    ) -> Result<Completion, LlmError> {
        let adapter = self.adapter_for(model)?;
        let request_model = if model.model.is_empty() {
            &model.name
        } else {
            &model.model
        };
        let provider = if model.provider.is_empty() {
            "openai"
        } else {
            model.provider.as_str()
        };
        let base = json!({
            "gen_ai.operation.name": "chat",
            "gen_ai.provider.name": provider,
            "gen_ai.request.model": request_model,
        });
        let mut attributes = base.clone();
        attributes["saturn.llm.adapter"] = json!(adapter.id());
        attributes["server.address"] = json!(
            url::Url::parse(&model.base_url)
                .ok()
                .and_then(|url| url.host_str().map(str::to_owned))
                .unwrap_or_default()
        );
        if let Some(temperature) = input.temperature {
            attributes["gen_ai.request.temperature"] = json!(temperature);
        }
        if let Some(most) = input.max_output {
            attributes["gen_ai.request.max_tokens"] = json!(most);
        }
        attributes["saturn.llm.tools.offered"] = json!(
            input
                .tools
                .iter()
                .filter(|tool| !tool.function.name.is_empty())
                .count()
        );
        attributes["saturn.llm.messages"] = json!(input.messages.len());
        let span = Span::start(format!("chat {request_model}"), Kind::Client, attributes);
        let started = Instant::now();
        let answer = span
            .scope(self.complete_inner(model, input, adapter, request_model))
            .await;
        let seconds = started.elapsed().as_secs_f64();
        match &answer {
            Ok(completion) => {
                let usage = completion.usage;
                if let Some(cached) = usage.cached {
                    span.set("gen_ai.usage.cache_read.input_tokens", cached);
                }
                span.set("saturn.llm.tool_calls", completion.tool_calls.len());
                let tokens = |kind: &str| {
                    let mut labels = base.clone();
                    labels["gen_ai.token.type"] = json!(kind);
                    labels
                };
                if let Some(count) = usage.input {
                    span.set("gen_ai.usage.input_tokens", count);
                    saturn_telemetry::record(
                        "gen_ai.client.token.usage",
                        count as f64,
                        tokens("input"),
                    );
                }
                if let Some(count) = usage.output {
                    span.set("gen_ai.usage.output_tokens", count);
                    saturn_telemetry::record(
                        "gen_ai.client.token.usage",
                        count as f64,
                        tokens("output"),
                    );
                }
                saturn_telemetry::record("gen_ai.client.operation.duration", seconds, base);
            }
            Err(error) => {
                let kind = error
                    .status
                    .map_or_else(|| "error".to_owned(), |status| format!("http_{status}"));
                span.fail(&error.to_string(), &kind);
                let mut labels = base;
                labels["error.type"] = json!(kind);
                saturn_telemetry::record("gen_ai.client.operation.duration", seconds, labels);
            }
        }
        answer
    }

    /// The call itself.
    async fn complete_inner(
        &self,
        model: &ModelConnection,
        input: &CompletionInput,
        adapter: Adapter,
        request_model: &String,
    ) -> Result<Completion, LlmError> {
        self.require_key(model)?;
        let mut request = ChatRequest {
            model: request_model.clone(),
            base_url: model.base_url.clone(),
            api_key: self.key_for(model),
            messages: input.messages.clone(),
            tools: input
                .tools
                .iter()
                .filter(|tool| !tool.function.name.is_empty())
                .cloned()
                .collect(),
            temperature: input.temperature,
            max_output: input.max_output,
            low_thinking: input.low_thinking,
            effort: model.effort,
            cache_key: Some(format!("saturn:{}", input.context.agent_id)),
        };
        let native = input
            .messages
            .iter()
            .any(|item| item.role == Role::Tool || !item.tool_calls.is_empty());
        let mut completion = match adapter.complete(&self.http, &request).await {
            Err(error) if native && matches!(error.status, Some(400 | 422)) => {
                eprintln!(
                    "[llm] chat {request_model} via {} refused native tool turns ({error}); sent them as text",
                    adapter.id()
                );
                request.messages = flatten_tool_turns(&input.messages, |_| false);
                adapter.complete(&self.http, &request).await?
            }
            other => other?,
        };
        completion.usage_record = usage_record(
            model,
            request_model,
            self.hosted(model),
            &input.context,
            completion.usage,
            now_millis(),
        );
        Ok(completion)
    }
}

/// One call's line in the usage history, fixed when the call is made: the agent and model that actually ran it and the official
/// rate in force at that moment. `None` when the provider reported no tokens.
fn usage_record(
    model: &ModelConnection,
    request_model: &str,
    hosted: bool,
    context: &CallContext,
    usage: TokenUsage,
    at: i64,
) -> Option<Value> {
    let input_tokens = usage.input.unwrap_or(0);
    let output_tokens = usage.output.unwrap_or(0);
    if input_tokens == 0 && output_tokens == 0 {
        return None;
    }
    let cached = usage.cached.unwrap_or(0);
    let written = usage.cache_write.unwrap_or(0);
    let priced = price_call(&CallToPrice {
        provider: &model.provider,
        model: request_model,
        hosted,
        at,
        input_tokens,
        output_tokens,
        cached_tokens: cached,
        cache_write_tokens: written,
    });
    let mut record = Map::new();
    let mut set = |name: &str, value: Value| {
        record.insert(name.to_owned(), value);
    };
    set("id", json!(new_id("usage").ok()?));
    set(
        "runId",
        json!(context.run_id.as_deref().unwrap_or_default()),
    );
    set("agentId", json!(context.agent_id));
    set("agentName", json!(context.agent_name));
    set("modelId", json!(model.id));
    set("modelName", json!(model.name));
    set("provider", json!(model.provider));
    set("model", json!(request_model));
    set("purpose", json!(context.purpose));
    set("inputTokens", json!(input_tokens));
    set("outputTokens", json!(output_tokens));
    if cached != 0 {
        set("cachedInputTokens", json!(cached));
    }
    if written != 0 {
        set("cacheWriteTokens", json!(written));
    }
    set(
        "inputRate",
        json!(priced.as_ref().map(|price| price.input_rate)),
    );
    set(
        "outputRate",
        json!(priced.as_ref().map(|price| price.output_rate)),
    );
    if cached != 0 || written != 0 {
        set(
            "cachedRate",
            json!(priced.as_ref().map(|price| price.cached_rate)),
        );
        set(
            "cacheWriteRate",
            json!(priced.as_ref().map(|price| price.cache_write_rate)),
        );
    }
    set(
        "pricing",
        json!(
            priced
                .as_ref()
                .map_or("unpriced", |price| price.tier.as_str())
        ),
    );
    set(
        "costUsd",
        json!(priced.as_ref().map(|price| price.cost_usd)),
    );
    set("createdAt", json!(iso_time(at)));
    Some(Value::Object(record))
}
