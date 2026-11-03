//! Gemini, through its generateContent API. Tool schemas go out in the form Google's SDK writes them.
use serde_json::{Map, Value, json};

use crate::http::{Http, LlmError};
use crate::shared::{choice, count, mentions_thinking, parse_json, system_text, trimmed};
use crate::{ChatMessage, ChatRequest, Completion, Effort, ImagePart, Role, TokenUsage, ToolCall};

const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com";

/// A tool step: what was called, and how it ended. `result` is absent when the step has none, which differs from null.
struct Action {
    tool_id: String,
    arguments: Value,
    status: Option<Value>,
    result: Option<Value>,
    reason: Option<Value>,
    thought_signature: Option<String>,
}

fn inline_data(image: &ImagePart) -> Value {
    json!({ "inlineData": { "mimeType": image.mime_type, "data": image.base64 } })
}

fn function_call(name: &str, arguments: Value, signature: Option<&str>) -> Value {
    let mut part = json!({ "functionCall": { "name": name, "args": arguments } });
    if let Some(signature) = signature.filter(|text| !text.is_empty()) {
        part["thoughtSignature"] = json!(signature);
    }
    part
}

/// Gemini needs tool calls and their results replayed as functionCall / functionResponse turns.
pub fn gemini_contents(messages: &[ChatMessage]) -> Vec<Value> {
    let mut contents: Vec<Value> = Vec::new();
    let mut index = 0;
    while index < messages.len() {
        let item = &messages[index];
        index += 1;
        if matches!(item.role, Role::System | Role::Tool) {
            continue;
        }
        // Native tool turns: the model's text and functionCall parts (each with its thought signature), then one user turn of
        // functionResponse parts, with any screenshots.
        if item.role == Role::Assistant && !item.tool_calls.is_empty() {
            let mut parts = Vec::new();
            if !item.content.trim().is_empty() {
                parts.push(json!({ "text": item.content }));
            }
            parts.extend(item.tool_calls.iter().map(|call| {
                function_call(
                    &call.name,
                    Value::Object(call.arguments.clone()),
                    call.thought_signature.as_deref(),
                )
            }));
            contents.push(json!({ "role": "model", "parts": parts }));
            let mut answers = Vec::new();
            while let Some(result) = messages.get(index).filter(|next| next.role == Role::Tool) {
                index += 1;
                let outcome = parse_json(&result.content)
                    .unwrap_or_else(|| json!({ "result": result.content }));
                answers.push(json!({ "functionResponse": {
                    "name": result.tool_name.as_deref().unwrap_or_default(),
                    "response": function_response_body(
                        outcome.get("status"),
                        outcome.get("result"),
                        outcome.get("reason"),
                    ),
                }}));
                answers.extend(result.images.iter().map(inline_data));
            }
            contents.push(json!({ "role": "user", "parts": answers }));
            continue;
        }
        if !item.images.is_empty() && item.role == Role::User {
            let text = if item.content.is_empty() {
                "Attached screenshot:"
            } else {
                item.content.as_str()
            };
            let mut parts = vec![json!({ "text": text })];
            parts.extend(item.images.iter().map(inline_data));
            contents.push(json!({ "role": "user", "parts": parts }));
            continue;
        }
        if let Some(actions) = (item.role == Role::Assistant)
            .then(|| tool_result_actions(&item.content))
            .flatten()
        {
            let calls: Vec<Value> = actions
                .iter()
                .map(|action| {
                    function_call(
                        &action.tool_id,
                        action.arguments.clone(),
                        action.thought_signature.as_deref(),
                    )
                })
                .collect();
            contents.push(json!({ "role": "model", "parts": calls }));
            let mut answers = Vec::new();
            for action in &actions {
                answers.push(json!({ "functionResponse": {
                    "name": action.tool_id,
                    "response": function_response_body(action.status.as_ref(), action.result.as_ref(), action.reason.as_ref()),
                }}));
                if let Some(image) = action.result.as_ref().and_then(extract_action_image) {
                    answers.push(inline_data(&image));
                }
            }
            contents.push(json!({ "role": "user", "parts": answers }));
            continue;
        }
        let role = if item.role == Role::Assistant {
            "model"
        } else {
            "user"
        };
        let text = if item.content.trim().is_empty() {
            " "
        } else {
            item.content.as_str()
        };
        if let Some(last) = contents.last_mut().filter(|last| last["role"] == role)
            && let Some(parts) = last["parts"]
                .as_array_mut()
                .filter(|parts| parts.iter().all(|part| part.get("text").is_some()))
        {
            parts.push(json!({ "text": text }));
            continue;
        }
        contents.push(json!({ "role": role, "parts": [{ "text": text }] }));
    }
    if contents.last().is_some_and(|last| last["role"] == "model") {
        contents.push(json!({ "role": "user", "parts": [{ "text": "Continue." }] }));
    }
    contents
}

/// An assistant turn saved as a JSON list of tool steps (runs from before native tool turns), or `None` when it is plain text.
fn tool_result_actions(content: &str) -> Option<Vec<Action>> {
    let text = content.trim();
    if !text.starts_with('[') {
        return None;
    }
    let Value::Array(items) = parse_json(text)? else {
        return None;
    };
    if items.is_empty() {
        return None;
    }
    items
        .iter()
        .map(|item| {
            let tool_id = item
                .get("toolId")?
                .as_str()
                .filter(|id| !id.is_empty())?
                .to_owned();
            let string = |name: &str| item.get(name).filter(|value| value.is_string()).cloned();
            Some(Action {
                tool_id,
                arguments: item
                    .get("arguments")
                    .filter(|value| value.is_object())
                    .cloned()
                    .unwrap_or_else(|| json!({})),
                status: string("status"),
                result: item.get("result").cloned(),
                reason: string("reason"),
                thought_signature: item
                    .get("thoughtSignature")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            })
        })
        .collect()
}

/// A screenshot in a tool step's result.
fn extract_action_image(result: &Value) -> Option<ImagePart> {
    let truthy = |name: &str| result.get(name).filter(|value| is_truthy(value));
    let image = truthy("image")
        .or_else(|| truthy("screenshot"))
        .or_else(|| truthy("base64"))?
        .as_str()?;
    if let Some(rest) = image.strip_prefix("data:") {
        let (mime_type, base64) = rest.split_once(";base64,")?;
        let valid = !mime_type.is_empty()
            && !mime_type.contains(';')
            && !base64.is_empty()
            && !base64.contains('\n');
        return valid.then(|| ImagePart {
            mime_type: mime_type.to_owned(),
            base64: base64.to_owned(),
        });
    }
    (image.chars().count() > 200 && !image.contains(' ') && !image.contains('\n')).then(|| {
        ImagePart {
            mime_type: "image/jpeg".to_owned(),
            base64: image.to_owned(),
        }
    })
}

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64() != Some(0.0),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// A tool result without what Gemini should see as an image or in full.
fn sanitize_value(value: &Value) -> Value {
    match value {
        Value::String(text) => {
            let length = text.chars().count();
            if text.starts_with("data:image/")
                || (length > 1000 && !text.contains(' ') && !text.contains('\n'))
            {
                json!("[image data attached as visual input]")
            } else if length > 40_000 {
                let kept: String = text.chars().take(40_000).collect();
                json!(format!("{kept}... [truncated {} chars]", length - 40_000))
            } else {
                value.clone()
            }
        }
        Value::Array(items) => Value::Array(items.iter().map(sanitize_value).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(name, item)| (name.clone(), sanitize_value(item)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn function_response_body(
    status: Option<&Value>,
    result: Option<&Value>,
    reason: Option<&Value>,
) -> Value {
    let Some(result) = result else {
        let or = |value: Option<&Value>, default: &str| {
            value
                .filter(|item| !item.is_null())
                .cloned()
                .unwrap_or_else(|| json!(default))
        };
        return sanitize_value(
            &json!({ "status": or(status, "completed"), "reason": or(reason, "") }),
        );
    };
    if result.is_object() {
        sanitize_value(result)
    } else {
        json!({ "result": sanitize_value(result) })
    }
}

fn sanitize_schema(schema: &Value) -> Value {
    match schema {
        Value::Array(items) => Value::Array(items.iter().map(sanitize_schema).collect()),
        Value::Object(fields) => {
            let mut object = fields.clone();
            if let Some(constant) = object.shift_remove("const")
                && !object.contains_key("enum")
            {
                object.insert("enum".to_owned(), json!([constant]));
            }
            for name in ["$schema", "$id", "$comment", "definitions", "$defs"] {
                object.shift_remove(name);
            }
            Value::Object(
                object
                    .iter()
                    .map(|(name, value)| (name.clone(), sanitize_schema(value)))
                    .collect(),
            )
        }
        other => other.clone(),
    }
}

fn type_name(name: &str) -> Value {
    let upper = name.to_uppercase();
    let known = [
        "STRING", "NUMBER", "INTEGER", "BOOLEAN", "ARRAY", "OBJECT", "NULL",
    ];
    json!(if known.contains(&upper.as_str()) {
        upper.as_str()
    } else {
        "TYPE_UNSPECIFIED"
    })
}

/// A JSON schema as Gemini's own schema type, the way Google's SDK converts it: upper-case types, nullable instead of a null
/// type, no additionalProperties. Only `items`, `anyOf` and `properties` are walked; other fields go as they are.
fn gemini_schema(source: &Value) -> Value {
    let mut output = Map::new();
    let mut schema = source;
    if let Some(options) = schema["anyOf"]
        .as_array()
        .filter(|options| options.len() == 2)
    {
        let other = if options[0]["type"] == "null" {
            Some(&options[1])
        } else if options[1]["type"] == "null" {
            Some(&options[0])
        } else {
            None
        };
        if let Some(other) = other {
            output.insert("nullable".to_owned(), json!(true));
            schema = other;
        }
    }
    if let Some(types) = schema["type"].as_array() {
        let names: Vec<&str> = types.iter().filter_map(Value::as_str).collect();
        if names.contains(&"null") {
            output.insert("nullable".to_owned(), json!(true));
        }
        let rest: Vec<&str> = names.into_iter().filter(|name| *name != "null").collect();
        if let [only] = rest.as_slice() {
            output.insert("type".to_owned(), type_name(only));
        } else {
            let options: Vec<Value> = rest
                .iter()
                .map(|name| json!({ "type": type_name(name) }))
                .collect();
            output.insert("anyOf".to_owned(), json!(options));
        }
    }
    let Some(fields) = schema.as_object() else {
        return Value::Object(output);
    };
    for (name, value) in fields {
        if value.is_null() {
            continue;
        }
        match name.as_str() {
            "type" => {
                if let Some(text) = value.as_str() {
                    output.insert(name.clone(), type_name(text));
                }
            }
            "items" => {
                output.insert(name.clone(), gemini_schema(value));
            }
            "anyOf" => {
                let mut options = Vec::new();
                for option in value.as_array().into_iter().flatten() {
                    if option["type"] == "null" {
                        output.insert("nullable".to_owned(), json!(true));
                    } else {
                        options.push(gemini_schema(option));
                    }
                }
                output.insert(name.clone(), Value::Array(options));
            }
            "properties" => {
                let converted: Map<String, Value> = value
                    .as_object()
                    .into_iter()
                    .flatten()
                    .map(|(property, inner)| (property.clone(), gemini_schema(inner)))
                    .collect();
                output.insert(name.clone(), Value::Object(converted));
            }
            "additionalProperties" => {}
            _ => {
                output.insert(name.clone(), value.clone());
            }
        }
    }
    Value::Object(output)
}

/// Gemini 4 requires an explicit thinkingLevel; without it no thought summary comes back. MEDIUM is the documented default, so
/// only the summary changes, not the effort. Gemini 3.x and 2.5 keep their defaults (2.5 rejects a level).
fn default_thinking(model: &str, config: &mut Value) {
    if model.starts_with("gemini-4") {
        config["thinkingLevel"] = json!("MEDIUM");
    }
}

/// The connection's effort as Gemini thinking settings: a level on Gemini 3.x and 4 (xhigh and max are HIGH, the top level), a
/// token budget on 2.5. A model that refuses them is retried without thinking settings.
fn effort_thinking(model: &str, effort: Effort, config: &mut Value) {
    if model.starts_with("gemini-2.5") {
        let top = if model.contains("pro") {
            32_768
        } else {
            24_576
        };
        config["thinkingBudget"] = json!(match effort {
            Effort::Low => 1024,
            Effort::Medium => 8192,
            Effort::High => top.min(16_384),
            _ => top,
        });
    } else {
        config["thinkingLevel"] = json!(match effort {
            Effort::Low => "LOW",
            Effort::Medium => "MEDIUM",
            _ => "HIGH",
        });
    }
}

/// Little or no thinking, for editor completions where a few output tokens must be the answer. Gemini 2.5 takes a thinking budget
/// (0 turns it off on Flash); 3.x and 4 take a level. A model that refuses is retried without it.
fn low_thinking(model: &str) -> Value {
    if model.starts_with("gemini-2.5") {
        json!({ "includeThoughts": false, "thinkingBudget": if model.contains("pro") { 128 } else { 0 } })
    } else {
        json!({ "includeThoughts": false, "thinkingLevel": if model.starts_with("gemini-3") { "LOW" } else { "MINIMAL" } })
    }
}

/// A model's name as one path segment.
fn path_segment(model: &str) -> String {
    let name = model.strip_prefix("models/").unwrap_or(model);
    name.bytes().fold(String::new(), |mut text, byte| {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.') {
            text.push(byte as char);
        } else {
            text.push_str(&format!("%{byte:02X}"));
        }
        text
    })
}

/// One call to Gemini.
pub async fn complete(http: &Http, request: &ChatRequest) -> Result<Completion, LlmError> {
    let Some(api_key) = request.api_key.as_deref().filter(|key| !key.is_empty()) else {
        return Err(LlmError::new(None, "Gemini API key is required"));
    };
    let system = system_text(&request.messages);
    let mut contents = gemini_contents(&request.messages);
    if contents.is_empty() {
        contents.push(json!({ "role": "user", "parts": [{ "text": "" }] }));
    }
    let base_url = if request.base_url.is_empty() {
        DEFAULT_BASE_URL
    } else {
        trimmed(&request.base_url)
    };
    let url = format!(
        "{base_url}/v1beta/models/{}:generateContent",
        path_segment(&request.model)
    );
    let headers = [("x-goog-api-key", api_key)];

    let send = async |with_thoughts: bool| {
        let mut config = json!({});
        if let Some(temperature) = request.temperature {
            config["temperature"] = json!(temperature);
        }
        if let Some(max_output) = request.max_output {
            config["maxOutputTokens"] = json!(max_output);
        }
        if with_thoughts {
            config["thinkingConfig"] = if request.low_thinking {
                low_thinking(&request.model)
            } else {
                let mut thinking = json!({ "includeThoughts": true });
                match request.effort {
                    Some(effort) => effort_thinking(&request.model, effort, &mut thinking),
                    None => default_thinking(&request.model, &mut thinking),
                }
                thinking
            };
        }
        let mut body = json!({ "contents": contents, "generationConfig": config });
        if !system.is_empty() {
            body["systemInstruction"] = json!({ "role": "user", "parts": [{ "text": system }] });
        }
        if !request.tools.is_empty() {
            let declarations: Vec<Value> = request
                .tools
                .iter()
                .map(|tool| {
                    let mut declaration = json!({ "name": tool.function.name });
                    if let Some(description) = &tool.function.description {
                        declaration["description"] = json!(description);
                    }
                    if let Some(parameters) = &tool.function.parameters {
                        declaration["parameters"] = gemini_schema(&sanitize_schema(parameters));
                    }
                    declaration
                })
                .collect();
            body["tools"] = json!([{ "functionDeclarations": declarations }]);
        }
        http.post_json(&url, &headers, &body).await
    };
    let response = match send(true).await {
        Ok(response) => response,
        Err(error) if mentions_thinking(&error) => {
            eprintln!(
                "[llm] {} refused the thinking settings; retried without thought summaries",
                request.model
            );
            send(false).await?
        }
        Err(error) => return Err(error),
    };

    let parts: &[Value] = response["candidates"][0]["content"]["parts"]
        .as_array()
        .map_or(&[], Vec::as_slice);
    let is_thought = |part: &&Value| part["thought"] == true;
    let thoughts: Vec<&str> = parts
        .iter()
        .filter(is_thought)
        .filter_map(|part| part["text"].as_str())
        .filter(|text| !text.is_empty())
        .collect();
    let text: String = parts
        .iter()
        .filter(|part| !is_thought(part))
        .filter_map(|part| part["text"].as_str())
        .collect();
    let calls: Vec<ToolCall> = parts
        .iter()
        .filter_map(|part| {
            let call = part.get("functionCall")?;
            Some(ToolCall {
                id: None,
                name: call["name"]
                    .as_str()
                    .filter(|name| !name.is_empty())?
                    .to_owned(),
                arguments: call["args"].as_object().cloned().unwrap_or_default(),
                thought_signature: part["thoughtSignature"].as_str().map(str::to_owned),
            })
        })
        .collect();
    let usage = response.get("usageMetadata");
    let of = |name: &str| usage.and_then(|fields| count(&fields[name]));
    Ok(choice(
        &text,
        calls,
        &thoughts.join("\n\n"),
        TokenUsage {
            input: of("promptTokenCount"),
            output: usage.map(|_| {
                of("candidatesTokenCount").unwrap_or(0) + of("thoughtsTokenCount").unwrap_or(0)
            }),
            // Implicit caching: the part of the prompt Gemini served from its cache.
            cached: of("cachedContentTokenCount"),
            cache_write: None,
        },
        None,
    ))
}
