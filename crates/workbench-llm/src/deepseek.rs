//! DeepSeek, whose API has the OpenAI shape. Thinking mode is on by default and returns reasoning_content. When tools are sent,
//! every earlier assistant turn must carry its reasoning_content back or the API answers 400. Legacy reasoner models reject
//! temperature; current models just ignore it while thinking. DeepSeek has no effort levels. Low thinking (editor completions)
//! turns thinking mode off; a model or server that rejects that setting is asked again without it.
use serde_json::{Map, Value, json};

use crate::http::{Http, LlmError};
use crate::openai::{chat_tools, tool_calls_of, tool_calls_param};
use crate::shared::{OptionalField, choice, count, endpoint, trimmed, with_optional_fields};
use crate::{ChatMessage, ChatRequest, Completion, Role, TokenUsage};

const DEFAULT_BASE_URL: &str = "https://api.deepseek.com";

/// OpenAI-style messages; assistant turns carry their reasoning_content back when tools are in play. No images.
fn messages_for(messages: &[ChatMessage], with_tools: bool) -> Vec<Value> {
    messages
        .iter()
        .map(|item| match item.role {
            Role::Tool => json!({
                "role": "tool",
                "tool_call_id": item.tool_call_id.as_deref().unwrap_or_default(),
                "content": item.content,
            }),
            Role::Assistant => {
                let mut message = json!({ "role": "assistant", "content": item.content });
                if with_tools || !item.tool_calls.is_empty() {
                    message["reasoning_content"] =
                        json!(item.reasoning.as_deref().unwrap_or_default());
                }
                if !item.tool_calls.is_empty() {
                    message["tool_calls"] = tool_calls_param(&item.tool_calls);
                }
                message
            }
            role => json!({ "role": role.as_str(), "content": item.content }),
        })
        .collect()
}

/// One call to DeepSeek.
pub async fn complete(http: &Http, request: &ChatRequest) -> Result<Completion, LlmError> {
    let Some(api_key) = request.api_key.as_deref().filter(|key| !key.is_empty()) else {
        return Err(LlmError::new(None, "DeepSeek API key is required"));
    };
    let base_url = if request.base_url.is_empty() {
        DEFAULT_BASE_URL
    } else {
        trimmed(&request.base_url)
    };
    let url = endpoint(base_url, "/chat/completions");
    let authorization = format!("Bearer {api_key}");
    let headers = [("authorization", authorization.as_str())];
    let headers = headers.as_slice();
    let url = url.as_str();
    let reasoner = request.model.to_lowercase().contains("reasoner");
    let completion = with_optional_fields(
        vec![OptionalField {
            name: "thinking",
            value: request.low_thinking.then(|| json!({ "type": "disabled" })),
            rejected_when: "thinking",
        }],
        |active: Map<String, Value>| async move {
            let mut body = json!({
                "model": request.model,
                "messages": messages_for(&request.messages, !request.tools.is_empty()),
            });
            if let Some(temperature) = request.temperature.filter(|_| !reasoner) {
                body["temperature"] = json!(temperature);
            }
            if let Some(max_output) = request.max_output {
                body["max_tokens"] = json!(max_output);
            }
            if let Some(thinking) = active.get("thinking") {
                body["thinking"] = thinking.clone();
            }
            if !request.tools.is_empty() {
                body["tools"] = chat_tools(&request.tools);
            }
            http.post_json(url, headers, &body).await
        },
    )
    .await?;
    let message = &completion["choices"][0]["message"];
    let non_empty = |name: &str| message[name].as_str().filter(|text| !text.is_empty());
    let thinking = non_empty("reasoning_content")
        .or_else(|| non_empty("thinking"))
        .unwrap_or_default()
        .trim();
    let usage = &completion["usage"];
    Ok(choice(
        message["content"].as_str().unwrap_or_default(),
        tool_calls_of(message),
        thinking,
        TokenUsage {
            input: count(&usage["prompt_tokens"]),
            output: count(&usage["completion_tokens"]),
            // DeepSeek caches on disk by itself and reports the hits.
            cached: count(&usage["prompt_cache_hit_tokens"]),
            cache_write: None,
        },
        None,
    ))
}
