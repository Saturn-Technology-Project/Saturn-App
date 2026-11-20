//! A model server on this computer (LM Studio, Ollama, vLLM, llama.cpp, mlx_lm.server), through its OpenAI-compatible
//! endpoints: Chat Completions takes tool definitions and images and returns the reasoning of thinking models. The provider
//! keeps its first name, `lmstudio`, in saved connections and records.
use std::time::Duration;

use serde_json::Value;

use crate::http::{Http, LlmError};
use crate::openai::complete_chat;
use crate::shared::flatten_tool_turns;
use crate::{ChatMessage, ChatRequest, Completion, Role};

/// The conversation with consecutive turns of the same role merged, and a user turn first after the system prompt: some models'
/// chat templates (Mistral's, for one) reject anything but strict user/assistant alternation.
pub fn alternating(messages: &[ChatMessage]) -> Vec<ChatMessage> {
    let mut output: Vec<ChatMessage> = Vec::new();
    for message in messages {
        if message.role != Role::System
            && message.content.trim().is_empty()
            && message.images.is_empty()
        {
            continue;
        }
        if let Some(last) = output
            .last_mut()
            .filter(|last| last.role == message.role && message.role != Role::System)
        {
            let parts: Vec<&str> = [last.content.as_str(), message.content.as_str()]
                .into_iter()
                .filter(|part| !part.trim().is_empty())
                .collect();
            last.content = parts.join("\n\n");
            last.images.extend_from_slice(&message.images);
            continue;
        }
        if message.role == Role::Assistant
            && output.last().is_none_or(|last| last.role == Role::System)
        {
            output.push(ChatMessage::new(
                Role::User,
                "(continuing the conversation)",
            ));
        }
        output.push(message.clone());
    }
    output
}

/// The name errors give the server.
const SERVER: &str = "the local model server";

/// The server's OpenAI-compatible endpoint (http://host:port/v1) for a connection saved as http://host:port. LM Studio
/// once showed its address as ws://, which is taken too.
pub fn openai_compatible_url(base_url: &str) -> Result<String, LlmError> {
    let http_url = match base_url.strip_prefix("ws") {
        Some(rest) if rest.starts_with(':') || rest.starts_with("s:") => format!("http{rest}"),
        _ => base_url.to_owned(),
    };
    let mut url = reqwest::Url::parse(&http_url).map_err(|error| {
        LlmError::new(None, format!("{SERVER}'s address is not valid: {error}"))
    })?;
    let path = url.path().trim_end_matches('/').to_owned();
    if !path.ends_with("/v1") {
        url.set_path(&format!("{path}/v1"));
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

/// One chat call to the server, which takes any key: a placeholder is sent when the connection has none. Local models' chat
/// templates vary in how (and whether) they take tool turns: they get them as text.
pub async fn complete(http: &Http, request: &ChatRequest) -> Result<Completion, LlmError> {
    let local = ChatRequest {
        messages: alternating(&flatten_tool_turns(&request.messages, |_| false)),
        base_url: openai_compatible_url(&request.base_url)?,
        api_key: Some(
            request
                .api_key
                .clone()
                .filter(|key| !key.is_empty())
                .unwrap_or_else(|| "lm-studio".to_owned()),
        ),
        temperature: request.temperature.map(|value| value.min(1.0)),
        effort: None,
        ..request.clone()
    };
    complete_chat(http, &local).await
}

/// Whether a model's name marks it as an embedding or reranking model, which cannot chat: one with "embed" or "rerank" in
/// it, or one of the families that are only that (bge, e5, gte), as in `mlx-community/bge-m3-mlx-fp16`.
fn is_embedding_model(id: &str) -> bool {
    let name = id.rsplit('/').next().unwrap_or(id).to_lowercase();
    name.contains("embed")
        || name.contains("rerank")
        || ["bge-", "e5-", "multilingual-e5-", "gte-"]
            .iter()
            .any(|family| name.starts_with(family))
}

/// The language models the server has: LM Studio's REST API (/api/v0/models) tells them apart from embedding models;
/// every other server, and older LM Studio versions, serve /v1/models, where embedding models are known by their names.
pub async fn list_models(http: &Http, base_url: &str) -> Result<Vec<String>, LlmError> {
    let not_running = |_| LlmError::new(None, format!("{SERVER} is not running"));
    let root = openai_compatible_url(base_url)?;
    let root = root.strip_suffix("/v1").unwrap_or(&root);
    let timeout = Duration::from_secs(4);
    let ids = |answer: &Value, keep: &dyn Fn(&Value) -> bool| -> Option<Vec<String>> {
        let items = answer["data"].as_array()?;
        Some(
            items
                .iter()
                .filter(|item| keep(item))
                .filter_map(|item| item["id"].as_str().map(str::to_owned))
                .collect(),
        )
    };
    let current = http
        .get_json(&format!("{root}/api/v0/models"), timeout)
        .await
        .map_err(not_running)?;
    if let Some(models) = current.and_then(|answer| {
        ids(&answer, &|item| {
            item["type"] == "llm" || item["type"] == "vlm"
        })
    }) {
        return Ok(models);
    }
    let older = http
        .get_json(&format!("{root}/v1/models"), timeout)
        .await
        .map_err(not_running)?;
    Ok(older
        .and_then(|answer| {
            ids(&answer, &|item| {
                !is_embedding_model(item["id"].as_str().unwrap_or_default())
            })
        })
        .unwrap_or_default())
}
