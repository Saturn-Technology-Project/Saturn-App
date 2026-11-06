//! OpenAI: Chat Completions for compatible servers, the Responses API for api.openai.com.
use std::sync::LazyLock;

use regex::RegexBuilder;
use serde_json::{Map, Value, json};

use crate::http::{Http, LlmError};
use crate::shared::{
    OptionalField, choice, count, endpoint, join_thinking, parse_arguments, system_text,
    with_optional_fields, without_inline_images,
};
use crate::{
    ChatMessage, ChatRequest, ChatToolCall, Completion, Effort, Role, TokenUsage, ToolCall, ToolDef,
};

/// OpenAI reasoning models (o-series, GPT-5 family): they take a reasoning effort and reject sampling settings.
fn reasons(model: &str) -> bool {
    static REASONING_MODEL: LazyLock<regex::Regex> = LazyLock::new(|| {
        RegexBuilder::new(r"^(o\d|gpt-5)")
            .case_insensitive(true)
            .build()
            .expect("a valid pattern")
    });
    REASONING_MODEL.is_match(model.rsplit('/').next().unwrap_or(model))
}

/// The request's effort as OpenAI's reasoning effort: low thinking is "low"; xhigh and max become "high".
fn openai_effort(request: &ChatRequest) -> Option<&'static str> {
    if request.low_thinking {
        return Some("low");
    }
    Some(match request.effort? {
        Effort::Low => "low",
        Effort::Medium => "medium",
        _ => "high",
    })
}

pub fn is_official_openai(base_url: &str) -> bool {
    reqwest::Url::parse(base_url).is_ok_and(|url| url.host_str() == Some("api.openai.com"))
}

fn cache_key_field(request: &ChatRequest) -> OptionalField {
    OptionalField {
        name: "prompt_cache_key",
        // OpenAI caches long prompt prefixes by itself; the key keeps an agent's requests on the same cache.
        value: request
            .cache_key
            .as_ref()
            .filter(|_| is_official_openai(&request.base_url))
            .map(|key| json!(key)),
        rejected_when: "prompt_cache_key",
    }
}

fn authorization(request: &ChatRequest) -> String {
    let key = request
        .api_key
        .as_deref()
        .filter(|key| !key.is_empty())
        .unwrap_or("local");
    format!("Bearer {key}")
}

fn data_url(image: &crate::ImagePart) -> String {
    format!("data:{};base64,{}", image.mime_type, image.base64)
}

/// A turn's tool calls in Chat Completions' format.
pub(crate) fn tool_calls_param(calls: &[ChatToolCall]) -> Value {
    calls
        .iter()
        .map(|call| {
            let arguments = Value::Object(call.arguments.clone()).to_string();
            json!({ "id": call.id, "type": "function", "function": { "name": call.name, "arguments": arguments } })
        })
        .collect()
}

/// The tools in Chat Completions' format.
pub(crate) fn chat_tools(tools: &[ToolDef]) -> Value {
    tools
        .iter()
        .map(|tool| json!({ "type": "function", "function": tool.function }))
        .collect()
}

/// The function calls in a Chat Completions reply.
pub(crate) fn tool_calls_of(message: &Value) -> Vec<ToolCall> {
    let calls: &[Value] = message["tool_calls"].as_array().map_or(&[], Vec::as_slice);
    calls
        .iter()
        .filter(|call| call["type"] == "function")
        .map(|call| ToolCall {
            id: call["id"].as_str().map(str::to_owned),
            name: call["function"]["name"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            arguments: parse_arguments(call["function"]["arguments"].as_str()),
            thought_signature: None,
        })
        .collect()
}

/// Chat Completions messages: native tool calls and results; a tool's screenshots follow its results as a user turn.
fn chat_messages(messages: &[ChatMessage]) -> Vec<Value> {
    let mut output = Vec::new();
    let mut pending = Vec::new();
    let flush = |output: &mut Vec<Value>, pending: &mut Vec<Value>| {
        if !pending.is_empty() {
            let mut content =
                vec![json!({ "type": "text", "text": "Screenshots from the tool results above:" })];
            content.append(pending);
            output.push(json!({ "role": "user", "content": content }));
        }
    };
    for item in messages {
        if item.role == Role::Tool {
            output.push(json!({
                "role": "tool",
                "tool_call_id": item.tool_call_id.as_deref().unwrap_or_default(),
                "content": item.content,
            }));
            pending.extend(item.images.iter().map(image_url_part));
            continue;
        }
        flush(&mut output, &mut pending);
        if item.role == Role::Assistant && !item.tool_calls.is_empty() {
            let content = if item.content.is_empty() {
                Value::Null
            } else {
                json!(item.content)
            };
            output.push(json!({ "role": "assistant", "content": content, "tool_calls": tool_calls_param(&item.tool_calls) }));
            continue;
        }
        if !item.images.is_empty() && item.role == Role::User {
            let text = if item.content.is_empty() {
                "Attached screenshot:"
            } else {
                item.content.as_str()
            };
            let mut content = vec![json!({ "type": "text", "text": text })];
            content.extend(item.images.iter().map(image_url_part));
            output.push(json!({ "role": "user", "content": content }));
            continue;
        }
        output.push(
            json!({ "role": item.role.as_str(), "content": without_inline_images(&item.content) }),
        );
    }
    flush(&mut output, &mut pending);
    output
}

fn image_url_part(image: &crate::ImagePart) -> Value {
    json!({ "type": "image_url", "image_url": { "url": data_url(image) } })
}

/// Chat Completions, for OpenAI-compatible servers that are not api.openai.com.
pub async fn complete_chat(http: &Http, request: &ChatRequest) -> Result<Completion, LlmError> {
    let url = endpoint(&request.base_url, "/chat/completions");
    let authorization = authorization(request);
    let headers = [("authorization", authorization.as_str())];
    let headers = headers.as_slice();
    let url = url.as_str();
    let completion = with_optional_fields(
        vec![
            // Compatible servers vary: reasoning_effort is sent only when asked for, and dropped if the server rejects it.
            OptionalField {
                name: "reasoning_effort",
                value: openai_effort(request).map(|effort| json!(effort)),
                rejected_when: "reasoning|effort",
            },
            OptionalField {
                name: "temperature",
                value: request.temperature.map(|value| json!(value)),
                rejected_when: "temperature",
            },
            cache_key_field(request),
        ],
        |active: Map<String, Value>| async move {
            let mut body =
                json!({ "model": request.model, "messages": chat_messages(&request.messages) });
            for (name, value) in &active {
                body[name] = value.clone();
            }
            if let Some(max_output) = request.max_output {
                body["max_completion_tokens"] = json!(max_output);
            }
            if !request.tools.is_empty() {
                body["tools"] = chat_tools(&request.tools);
            }
            http.post_json(url, headers, &body).await
        },
    )
    .await?;
    let message = &completion["choices"][0]["message"];
    let usage = &completion["usage"];
    Ok(choice(
        message["content"].as_str().unwrap_or_default(),
        tool_calls_of(message),
        &chat_thinking(message),
        TokenUsage {
            input: count(&usage["prompt_tokens"]),
            output: count(&usage["completion_tokens"]),
            cached: count(&usage["prompt_tokens_details"]["cached_tokens"]),
            cache_write: None,
        },
        None,
    ))
}

/// A Responses input: the assistant's text and function_call items, then each call's function_call_output (a tool's screenshots
/// follow as a user turn).
fn responses_input(messages: &[ChatMessage]) -> Vec<Value> {
    let input_image =
        |image: &crate::ImagePart| json!({ "type": "input_image", "image_url": data_url(image) });
    let mut input = Vec::new();
    for item in messages.iter().filter(|item| item.role != Role::System) {
        if item.role == Role::Assistant && !item.tool_calls.is_empty() {
            if !item.content.is_empty() {
                input.push(json!({ "role": "assistant", "content": item.content }));
            }
            for call in &item.tool_calls {
                input.push(json!({
                    "type": "function_call",
                    "call_id": call.id,
                    "name": call.name,
                    "arguments": Value::Object(call.arguments.clone()).to_string(),
                }));
            }
        } else if item.role == Role::Tool {
            input.push(json!({
                "type": "function_call_output",
                "call_id": item.tool_call_id.as_deref().unwrap_or_default(),
                "output": item.content,
            }));
            if !item.images.is_empty() {
                let mut content = vec![
                    json!({ "type": "input_text", "text": "Screenshot from the tool result above:" }),
                ];
                content.extend(item.images.iter().map(input_image));
                input.push(json!({ "role": "user", "content": content }));
            }
        } else if !item.images.is_empty() && item.role == Role::User {
            let text = if item.content.is_empty() {
                "Attached screenshot:"
            } else {
                item.content.as_str()
            };
            let mut content = vec![json!({ "type": "input_text", "text": text })];
            content.extend(item.images.iter().map(input_image));
            input.push(json!({ "role": "user", "content": content }));
        } else {
            input.push(json!({ "role": item.role.as_str(), "content": without_inline_images(&item.content) }));
        }
    }
    input
}

/// Responses API, for api.openai.com, which returns reasoning summaries.
pub async fn complete_responses(
    http: &Http,
    request: &ChatRequest,
) -> Result<Completion, LlmError> {
    let url = endpoint(&request.base_url, "/responses");
    let authorization = authorization(request);
    let headers = [("authorization", authorization.as_str())];
    let headers = headers.as_slice();
    let url = url.as_str();
    let system = &system_text(&request.messages);
    let input = &responses_input(&request.messages);
    // Reasoning models get a reasoning effort (and a summary of their reasoning) and no temperature; other models the reverse.
    // A model that rejects either is retried without it.
    let reasoning = reasons(&request.model);
    let response = with_optional_fields(
        vec![
            OptionalField {
                name: "reasoning",
                value: reasoning.then(|| match openai_effort(request) {
                    Some(effort) => json!({ "summary": "auto", "effort": effort }),
                    None => json!({ "summary": "auto" }),
                }),
                rejected_when: "reasoning|effort|summary",
            },
            OptionalField {
                name: "temperature",
                value: request
                    .temperature
                    .filter(|_| !reasoning)
                    .map(|value| json!(value)),
                rejected_when: "temperature",
            },
            cache_key_field(request),
        ],
        |active: Map<String, Value>| async move {
            let mut body = json!({
                "model": request.model,
                "input": if input.is_empty() { json!("") } else { json!(input) },
            });
            for (name, value) in &active {
                body[name] = value.clone();
            }
            if !system.is_empty() {
                body["instructions"] = json!(system);
            }
            if let Some(max_output) = request.max_output {
                body["max_output_tokens"] = json!(max_output);
            }
            if !request.tools.is_empty() {
                let tools: Vec<Value> = request
                    .tools
                    .iter()
                    .map(|tool| {
                        let function = &tool.function;
                        let empty = json!({ "type": "object", "properties": {} });
                        let mut definition = json!({
                            "type": "function",
                            "name": function.name,
                            "strict": null,
                            "parameters": function.parameters.as_ref().unwrap_or(&empty),
                        });
                        if let Some(description) = &function.description {
                            definition["description"] = json!(description);
                        }
                        definition
                    })
                    .collect();
                body["tools"] = json!(tools);
            }
            http.post_json(url, headers, &body).await
        },
    )
    .await?;
    let mut thoughts = Vec::new();
    let mut texts = String::new();
    let mut calls = Vec::new();
    let items: &[Value] = response["output"].as_array().map_or(&[], Vec::as_slice);
    for item in items {
        match item["type"].as_str() {
            Some("reasoning") => {
                let text = reasoning_text(item);
                if !text.is_empty() {
                    thoughts.push(text);
                }
            }
            Some("message") => {
                let parts: &[Value] = item["content"].as_array().map_or(&[], Vec::as_slice);
                texts.extend(
                    parts
                        .iter()
                        .filter(|part| part["type"] == "output_text")
                        .filter_map(|part| part["text"].as_str()),
                );
            }
            Some("function_call") => calls.push(ToolCall {
                id: item["call_id"].as_str().map(str::to_owned),
                name: item["name"].as_str().unwrap_or_default().to_owned(),
                arguments: parse_arguments(item["arguments"].as_str()),
                thought_signature: None,
            }),
            _ => {}
        }
    }
    let usage = &response["usage"];
    Ok(choice(
        &texts,
        calls,
        &thoughts.join("\n\n"),
        TokenUsage {
            input: count(&usage["input_tokens"]),
            output: count(&usage["output_tokens"]),
            cached: count(&usage["input_tokens_details"]["cached_tokens"]),
            cache_write: None,
        },
        None,
    ))
}

fn chat_thinking(message: &Value) -> String {
    let reasoning = reasoning_text(&message["reasoning"]);
    let pieces = [
        message["thinking"].as_str(),
        message["reasoning_content"].as_str(),
        Some(reasoning.as_str()),
    ];
    let kept: Vec<&str> = pieces
        .into_iter()
        .flatten()
        .filter(|piece| !piece.trim().is_empty())
        .collect();
    kept.join("\n\n")
}

fn reasoning_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_owned();
    }
    let joined = |name: &str| {
        let items: &[Value] = value[name].as_array().map_or(&[], Vec::as_slice);
        let texts: Vec<&str> = items
            .iter()
            .filter_map(|item| item["text"].as_str())
            .filter(|text| !text.is_empty())
            .collect();
        texts.join("\n\n")
    };
    join_thinking(&joined("content"), &joined("summary"))
}

/// The legacy /completions endpoint (raw prompt in, text out), which OpenAI-compatible local servers still serve.
pub async fn complete_raw(
    http: &Http,
    request: &crate::lmstudio::RawRequest,
) -> Result<crate::lmstudio::RawStream, LlmError> {
    let url = endpoint(&request.base_url, "/completions");
    let stops: Vec<&String> = request.stops.iter().take(4).collect();
    let body = json!({
        "model": request.model,
        "prompt": request.prompt,
        "max_tokens": request.max_output,
        "stop": stops,
        "temperature": request.temperature.unwrap_or(0.0),
        "stream": true,
    });
    let key = request
        .api_key
        .as_deref()
        .filter(|key| !key.is_empty())
        .unwrap_or("local");
    crate::lmstudio::raw_stream(http, &url, Some(key), &body).await
}
