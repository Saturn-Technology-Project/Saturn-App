//! Claude, through Anthropic's Messages API.
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::http::{Http, LlmError};
use crate::shared::{
    OptionalField, choice, count, flat_input_schema, flatten_tool_turns, system_text, trimmed,
    with_optional_fields, without_inline_images,
};
use crate::{ChatMessage, ChatRequest, Completion, ImagePart, Replay, Role, TokenUsage, ToolCall};

const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
const API_VERSION: &str = "2023-06-01";

/// Adaptive thinking runs on Claude 4.6 and later; older models take no adaptive setting.
static OLDER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"claude-3|-4-[0-5](?:$|-)").expect("a valid pattern"));
/// Effort goes in output_config; Haiku 4.5, Sonnet 4.5 and Claude 3 reject it.
static NO_EFFORT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"claude-3|(?:haiku|sonnet)-4-5(?:$|-)").expect("a valid pattern"));
/// Sampling settings are rejected from Opus 4.7 / Sonnet 5 on, so temperature goes only to older models.
static SAMPLING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"claude-3|-4-[0-6](?:$|-)").expect("a valid pattern"));

fn image_block(image: &ImagePart) -> Value {
    let known = ["image/png", "image/jpeg", "image/webp", "image/gif"];
    let media_type = if known.contains(&image.mime_type.as_str()) {
        image.mime_type.as_str()
    } else {
        "image/jpeg"
    };
    json!({ "type": "image", "source": { "type": "base64", "media_type": media_type, "data": image.base64 } })
}

/// The turns of a conversation in Claude's format.
fn messages_of(turns: &[ChatMessage]) -> Vec<Value> {
    let mut messages = Vec::new();
    let mut index = 0;
    while index < turns.len() {
        let item = &turns[index];
        index += 1;
        if item.role == Role::System {
            continue;
        }
        if item.role == Role::Assistant && !item.tool_calls.is_empty() {
            let content = match &item.replay {
                Some(replay) if replay.provider == "claude" => replay.data.clone(),
                _ => {
                    let text = (!item.content.is_empty())
                        .then(|| json!({ "type": "text", "text": item.content }));
                    let calls = item.tool_calls.iter().map(
                        |call| json!({ "type": "tool_use", "id": call.id, "name": call.name, "input": call.arguments }),
                    );
                    Value::Array(text.into_iter().chain(calls).collect())
                }
            };
            messages.push(json!({ "role": "assistant", "content": content }));
            // Every call's result, in one user turn.
            let mut results = Vec::new();
            while let Some(result) = turns.get(index).filter(|next| next.role == Role::Tool) {
                index += 1;
                let text = if result.content.is_empty() {
                    "(no output)"
                } else {
                    result.content.as_str()
                };
                let mut content = vec![json!({ "type": "text", "text": text })];
                content.extend(result.images.iter().map(image_block));
                let mut block = json!({
                    "type": "tool_result",
                    "tool_use_id": result.tool_call_id.as_deref().unwrap_or_default(),
                    "content": content,
                });
                if result.failed {
                    block["is_error"] = json!(true);
                }
                results.push(block);
            }
            messages.push(json!({ "role": "user", "content": results }));
            continue;
        }
        if !item.images.is_empty() && item.role == Role::User {
            let text = if item.content.is_empty() {
                "Attached screenshot:"
            } else {
                item.content.as_str()
            };
            let mut content = vec![json!({ "type": "text", "text": text })];
            content.extend(item.images.iter().map(image_block));
            messages.push(json!({ "role": "user", "content": content }));
            continue;
        }
        let role = if item.role == Role::Assistant {
            "assistant"
        } else {
            "user"
        };
        messages.push(json!({ "role": role, "content": without_inline_images(&item.content) }));
    }
    messages
}

/// A reply block as it is sent back: thinking with its signature, text, tool_use; what only replies carry is dropped.
fn to_param(block: &Value) -> Value {
    let keep = |names: &[&str]| {
        let kept: Map<String, Value> = names
            .iter()
            .filter_map(|name| Some(((*name).to_owned(), block.get(*name)?.clone())))
            .collect();
        Value::Object(kept)
    };
    match block["type"].as_str() {
        Some("text") => keep(&["type", "text"]),
        Some("thinking") => keep(&["type", "thinking", "signature"]),
        Some("redacted_thinking") => keep(&["type", "data"]),
        Some("tool_use") => keep(&["type", "id", "name", "input"]),
        _ => block.clone(),
    }
}

/// One call to Claude.
pub async fn complete(http: &Http, request: &ChatRequest) -> Result<Completion, LlmError> {
    let Some(api_key) = request.api_key.as_deref().filter(|key| !key.is_empty()) else {
        return Err(LlmError::new(None, "Claude API key is required"));
    };
    let id = request.model.to_lowercase();
    let thinking_on = !(request.low_thinking || OLDER.is_match(&id));
    // With thinking on, a turn that called tools goes back with its signed thinking blocks, as Claude wrote it. A round Claude
    // did not write (another model earlier in the chat, a run from before) goes as text instead.
    let turns = flatten_tool_turns(&request.messages, |assistant| {
        assistant
            .replay
            .as_ref()
            .is_some_and(|replay| replay.provider == "claude")
            || !thinking_on
    });
    let mut messages = messages_of(&turns);
    // Claude's newest models reject a conversation that ends on the assistant ("does not support assistant message prefill"),
    // so a request that still ends there gets a user turn asking it to go on.
    if messages
        .last()
        .is_some_and(|last| last["role"] == "assistant")
    {
        messages.push(json!({ "role": "user", "content": "Continue." }));
    }
    if messages.is_empty() {
        messages.push(json!({ "role": "user", "content": "" }));
    }

    let effort = if request.low_thinking {
        Some("low")
    } else {
        request.effort.map(|effort| effort.as_str())
    };
    let tools: Vec<Value> = request
        .tools
        .iter()
        .map(|tool| {
            let (schema, note) = flat_input_schema(tool.function.parameters.as_ref());
            let parts: Vec<&str> = [tool.function.description.as_deref(), note.as_deref()]
                .into_iter()
                .flatten()
                .filter(|part| !part.is_empty())
                .collect();
            let mut definition = json!({ "name": tool.function.name, "input_schema": schema });
            if !parts.is_empty() {
                definition["description"] = json!(parts.join(" "));
            }
            definition
        })
        .collect();
    let system = system_text(&request.messages);
    let base_url = if request.base_url.is_empty() {
        DEFAULT_BASE_URL
    } else {
        trimmed(&request.base_url)
    };
    let url = format!("{base_url}/v1/messages");
    let headers = [("x-api-key", api_key), ("anthropic-version", API_VERSION)];
    let headers = headers.as_slice();
    let url = url.as_str();
    let (messages, system, tools) = (&messages, &system, &tools);

    let response = with_optional_fields(
        vec![
            OptionalField {
                name: "thinking",
                value: thinking_on.then(|| json!({ "type": "adaptive", "display": "summarized" })),
                rejected_when: "thinking",
            },
            OptionalField {
                name: "output_config",
                value: effort
                    .filter(|_| !NO_EFFORT.is_match(&id))
                    .map(|effort| json!({ "effort": effort })),
                rejected_when: "effort|output_config",
            },
            OptionalField {
                name: "temperature",
                value: request
                    .temperature
                    .filter(|_| SAMPLING.is_match(&id))
                    .map(|value| json!(value)),
                rejected_when: "temperature|sampling",
            },
        ],
        |active: Map<String, Value>| async move {
            let mut body = json!({
                "model": request.model,
                "max_tokens": request.max_output.unwrap_or(4096),
                // Automatic prompt caching: the system prompt, tools and earlier turns are read from cache on every later round
                // of a run (and after a computer_wait resumes within the cache lifetime).
                "cache_control": { "type": "ephemeral" },
                "messages": messages,
            });
            for name in ["thinking", "output_config"] {
                if let Some(value) = active.get(name) {
                    body[name] = value.clone();
                }
            }
            // Temperature cannot go with thinking on the models that still accept it.
            if let (Some(value), None) = (active.get("temperature"), active.get("thinking")) {
                body["temperature"] = value.clone();
            }
            if !system.is_empty() {
                body["system"] = json!(system);
            }
            if !tools.is_empty() {
                body["tools"] = json!(tools);
            }
            http.post_json(url, headers, &body).await
        },
    )
    .await?;

    let blocks: &[Value] = response["content"].as_array().map_or(&[], Vec::as_slice);
    let of_type = |kind: &'static str, field: &'static str| {
        blocks
            .iter()
            .filter(move |block| block["type"] == kind)
            .filter_map(move |block| block[field].as_str())
    };
    let text: String = of_type("text", "text").collect();
    let thinking = of_type("thinking", "thinking")
        .collect::<Vec<_>>()
        .join("\n\n");
    let calls: Vec<ToolCall> = blocks
        .iter()
        .filter(|block| block["type"] == "tool_use")
        .map(|block| ToolCall {
            id: block["id"].as_str().map(str::to_owned),
            name: block["name"].as_str().unwrap_or_default().to_owned(),
            arguments: block["input"].as_object().cloned().unwrap_or_default(),
            thought_signature: None,
        })
        .collect();
    let usage = &response["usage"];
    let written = count(&usage["cache_creation_input_tokens"]);
    let cached = count(&usage["cache_read_input_tokens"]);
    let replay = (!calls.is_empty()).then(|| Replay {
        provider: "claude".to_owned(),
        data: Value::Array(blocks.iter().map(to_param).collect()),
    });
    Ok(choice(
        &text,
        calls,
        &thinking,
        TokenUsage {
            // input_tokens excludes cached tokens; count every prompt token so usage stays comparable across providers.
            input: Some(
                count(&usage["input_tokens"]).unwrap_or(0)
                    + written.unwrap_or(0)
                    + cached.unwrap_or(0),
            ),
            output: count(&usage["output_tokens"]),
            cached,
            cache_write: written,
        },
        replay,
    ))
}
