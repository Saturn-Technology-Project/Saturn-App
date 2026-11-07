//! LM Studio, through its OpenAI-compatible endpoints: Chat Completions takes tool definitions and images and returns the
//! reasoning of thinking models; /completions serves raw completions.
use std::collections::VecDeque;
use std::time::Duration;

use reqwest::Response;
use serde_json::{Value, json};

use crate::http::{Http, LlmError, parse_reply};
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

/// LM Studio's OpenAI-compatible endpoint (http://host:port/v1) for a connection saved as http://host:port.
pub fn openai_compatible_url(base_url: &str) -> Result<String, LlmError> {
    local_server_url(base_url, "LM Studio")
}

/// The OpenAI-compatible endpoint (http://host:port/v1) of a model server on this computer, named `server` in errors.
pub(crate) fn local_server_url(base_url: &str, server: &str) -> Result<String, LlmError> {
    let http_url = match base_url.strip_prefix("ws") {
        Some(rest) if rest.starts_with(':') || rest.starts_with("s:") => format!("http{rest}"),
        _ => base_url.to_owned(),
    };
    let mut url = reqwest::Url::parse(&http_url).map_err(|error| {
        LlmError::new(None, format!("{server}'s address is not valid: {error}"))
    })?;
    let path = url.path().trim_end_matches('/').to_owned();
    if !path.ends_with("/v1") {
        url.set_path(&format!("{path}/v1"));
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

/// One chat call to LM Studio. Local models' chat templates vary in how (and whether) they take tool turns: they get them as text.
pub async fn complete(http: &Http, request: &ChatRequest) -> Result<Completion, LlmError> {
    complete_local(http, request, "LM Studio", "lm-studio").await
}

/// One chat call to a model server on this computer, which takes any key: `placeholder` is sent when the connection has none.
pub(crate) async fn complete_local(
    http: &Http,
    request: &ChatRequest,
    server: &str,
    placeholder: &str,
) -> Result<Completion, LlmError> {
    let local = ChatRequest {
        messages: alternating(&flatten_tool_turns(&request.messages, |_| false)),
        base_url: local_server_url(&request.base_url, server)?,
        api_key: Some(
            request
                .api_key
                .clone()
                .filter(|key| !key.is_empty())
                .unwrap_or_else(|| placeholder.to_owned()),
        ),
        temperature: request.temperature.map(|value| value.min(1.0)),
        effort: None,
        ..request.clone()
    };
    complete_chat(http, &local).await
}

/// A raw text completion to ask for (no chat turns), for fill-in-the-middle code models.
#[derive(Clone, Default)]
pub struct RawRequest {
    pub model: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub prompt: String,
    pub stops: Vec<String>,
    pub max_output: u64,
    pub temperature: Option<f64>,
}

/// The fragments of a raw completion as they are generated.
pub struct RawStream {
    response: Response,
    buffer: Vec<u8>,
    ready: VecDeque<String>,
    finished: bool,
}

impl RawStream {
    /// The next fragment, or `None` at the end.
    pub async fn next(&mut self) -> Result<Option<String>, LlmError> {
        loop {
            if let Some(fragment) = self.ready.pop_front() {
                return Ok(Some(fragment));
            }
            if self.finished {
                return Ok(None);
            }
            let chunk = self.response.chunk().await.map_err(|error| {
                LlmError::new(
                    None,
                    format!("the model's answer stopped: {}", error.without_url()),
                )
            })?;
            match chunk {
                Some(bytes) => self.buffer.extend_from_slice(&bytes),
                None => self.finished = true,
            }
            // Only whole lines: a chunk can end in the middle of a character.
            while let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
                let line: Vec<u8> = self.buffer.drain(..=end).collect();
                self.read_line(&String::from_utf8_lossy(&line))?;
            }
        }
    }

    /// One line of server-sent events.
    fn read_line(&mut self, line: &str) -> Result<(), LlmError> {
        let Some(data) = line
            .strip_prefix("data:")
            .map(str::trim)
            .filter(|data| !data.is_empty())
        else {
            return Ok(());
        };
        if data == "[DONE]" {
            self.finished = true;
            return Ok(());
        }
        if !self.finished
            && let Some(text) = parse_reply(data)?["choices"][0]["text"]
                .as_str()
                .filter(|text| !text.is_empty())
        {
            self.ready.push_back(text.to_owned());
        }
        Ok(())
    }
}

/// Asks a /completions endpoint for a raw completion, streamed.
pub(crate) async fn raw_stream(
    http: &Http,
    url: &str,
    api_key: Option<&str>,
    body: &Value,
) -> Result<RawStream, LlmError> {
    let authorization = api_key.map(|key| format!("Bearer {key}"));
    let headers: Vec<(&str, &str)> = authorization
        .iter()
        .map(|value| ("authorization", value.as_str()))
        .collect();
    let response = http.post_stream(url, &headers, body).await?;
    Ok(RawStream {
        response,
        buffer: Vec::new(),
        ready: VecDeque::new(),
        finished: false,
    })
}

/// The model's raw completion of a prompt, from LM Studio's /v1/completions.
pub async fn complete_raw(http: &Http, request: &RawRequest) -> Result<RawStream, LlmError> {
    complete_raw_local(http, request, "LM Studio").await
}

/// The model's raw completion of a prompt, from the /v1/completions of a model server on this computer.
pub(crate) async fn complete_raw_local(
    http: &Http,
    request: &RawRequest,
    server: &str,
) -> Result<RawStream, LlmError> {
    let url = format!(
        "{}/completions",
        local_server_url(&request.base_url, server)?
    );
    let mut body = json!({
        "model": request.model,
        "prompt": request.prompt,
        "max_tokens": request.max_output,
        "stop": request.stops,
        "stream": true,
    });
    if let Some(temperature) = request.temperature {
        body["temperature"] = json!(temperature.min(1.0));
    }
    raw_stream(
        http,
        &url,
        request.api_key.as_deref().filter(|key| !key.is_empty()),
        &body,
    )
    .await
}

/// The language models downloaded in LM Studio: its REST API (/api/v0/models) tells them apart from embedding models; older
/// versions only serve /v1/models.
pub async fn list_models(http: &Http, base_url: &str) -> Result<Vec<String>, LlmError> {
    let not_running = |_| LlmError::new(None, "LM Studio is not running");
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
                !item["id"]
                    .as_str()
                    .unwrap_or_default()
                    .to_lowercase()
                    .contains("embed")
            })
        })
        .unwrap_or_default())
}
