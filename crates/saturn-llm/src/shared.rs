//! What the providers' modules have in common.
use std::collections::BTreeSet;
use std::sync::LazyLock;

use regex::{Regex, RegexBuilder};
use saturn_store::json;
use serde_json::{Map, Value, json};

use crate::http::LlmError;
use crate::{Arguments, ChatMessage, Completion, Replay, Role, TokenUsage, ToolCall};

/// Asks the model to go on after tool results sent as text (the format before native tool turns).
pub const CONTINUE_AFTER_TOOLS: &str = "Continue from the tool results above: use more tools if the task needs them, otherwise give your answer.";

/// Text that may be JSON, read the way the run wrote it.
pub(crate) fn parse_json(text: &str) -> Option<Value> {
    json::parse(&json::clip_deep_values(text)).ok()
}

/// Native tool turns (an assistant turn with tool calls, then "tool" results) as text, the way every provider read them
/// before: the calls with their results as a JSON list in an assistant turn, then a user turn asking to go on (with any
/// screenshots). For providers, or rounds, that cannot be sent natively; `keep` leaves a round native.
pub fn flatten_tool_turns(
    messages: &[ChatMessage],
    keep: impl Fn(&ChatMessage) -> bool,
) -> Vec<ChatMessage> {
    let mut output = Vec::with_capacity(messages.len());
    let mut index = 0;
    while index < messages.len() {
        let message = &messages[index];
        index += 1;
        if message.role == Role::Tool {
            continue;
        }
        let results_end = index
            + messages[index..]
                .iter()
                .take_while(|next| next.role == Role::Tool)
                .count();
        let has_calls = message.role == Role::Assistant && !message.tool_calls.is_empty();
        if !has_calls || keep(message) {
            output.push(message.clone());
            if has_calls {
                output.extend_from_slice(&messages[index..results_end]);
                index = results_end;
            }
            continue;
        }
        let results = &messages[index..results_end];
        index = results_end;
        let steps: Vec<Value> = message
            .tool_calls
            .iter()
            .map(|call| {
                let answer = results
                    .iter()
                    .find(|item| item.tool_call_id.as_deref() == Some(call.id.as_str()));
                let mut step = Map::new();
                step.insert("toolId".to_owned(), json!(call.name));
                step.insert(
                    "arguments".to_owned(),
                    Value::Object(call.arguments.clone()),
                );
                if let Some(signature) = &call.thought_signature {
                    step.insert("thoughtSignature".to_owned(), json!(signature));
                }
                if let Some(answer) = answer {
                    match parse_json(&answer.content) {
                        Some(Value::Object(outcome)) => step.extend(outcome),
                        Some(other) => {
                            step.insert("result".to_owned(), other);
                        }
                        None => {
                            step.insert("result".to_owned(), json!(answer.content));
                        }
                    }
                }
                Value::Object(step)
            })
            .collect();
        output.push(ChatMessage {
            reasoning: message.reasoning.clone(),
            ..ChatMessage::new(Role::Assistant, Value::Array(steps).to_string())
        });
        let images: Vec<_> = results
            .iter()
            .flat_map(|item| item.images.iter().cloned())
            .collect();
        output.push(if images.is_empty() {
            ChatMessage::new(Role::User, CONTINUE_AFTER_TOOLS)
        } else {
            ChatMessage {
                images,
                ..ChatMessage::new(
                    Role::User,
                    "Observation from computer_screenshot (attached as multimodal image input):",
                )
            }
        });
    }
    output
}

/// A provider's reply as a `Completion`: any `<think>` tags in the text move to the reasoning.
pub(crate) fn choice(
    content: &str,
    tool_calls: Vec<ToolCall>,
    thinking: &str,
    usage: TokenUsage,
    replay: Option<Replay>,
) -> Completion {
    let (visible, tagged) = split_think_tags(content);
    Completion {
        content: visible,
        thinking: join_thinking(thinking, &tagged),
        tool_calls,
        replay,
        usage: TokenUsage {
            cached: usage.cached.filter(|count| *count != 0),
            cache_write: usage.cache_write.filter(|count| *count != 0),
            ..usage
        },
        usage_record: None,
    }
}

/// Two pieces of reasoning as one, without saying the same thing twice.
pub(crate) fn join_thinking(current: &str, next: &str) -> String {
    let extra = next.trim();
    let current = current.trim();
    if extra.is_empty() {
        current.to_owned()
    } else if current.is_empty() {
        extra.to_owned()
    } else if current.contains(extra) {
        current.to_owned()
    } else {
        format!("{current}\n\n{extra}")
    }
}

static THINK_TAG: LazyLock<Regex> = LazyLock::new(|| {
    RegexBuilder::new(r"<think>([\s\S]*?)</think>")
        .case_insensitive(true)
        .build()
        .expect("a valid pattern")
});
static LEADING_BLANK_LINES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*\n").expect("a valid pattern"));

fn split_think_tags(content: &str) -> (String, String) {
    let thoughts: Vec<&str> = THINK_TAG
        .captures_iter(content)
        .map(|found| found.get(1).map_or("", |body| body.as_str()).trim())
        .filter(|text| !text.is_empty())
        .collect();
    let visible = THINK_TAG.replace_all(content, "");
    // Blank lines and trailing space go, but not the first line's indent: code completions depend on it.
    let visible = LEADING_BLANK_LINES.replace(&visible, "");
    (visible.trim_end().to_owned(), thoughts.join("\n\n"))
}

/// An optional request field: left out when `value` is `None`, and dropped when the provider's refusal matches `rejected_when`.
pub(crate) struct OptionalField {
    pub name: &'static str,
    pub value: Option<Value>,
    pub rejected_when: &'static str,
}

/// Sends a request with optional fields, dropping any one the provider rejects and trying again: a model that does not support
/// an effort or reasoning setting still answers, without it. Only 400/422 answers naming the field count.
pub(crate) async fn with_optional_fields<T>(
    fields: Vec<OptionalField>,
    send: impl AsyncFn(&Map<String, Value>) -> Result<T, LlmError>,
) -> Result<T, LlmError> {
    let attempts = fields.len();
    let mut active: Vec<OptionalField> = fields
        .into_iter()
        .filter(|field| field.value.is_some())
        .collect();
    let mut attempt = 0;
    loop {
        let values: Map<String, Value> = active
            .iter()
            .filter_map(|field| Some((field.name.to_owned(), field.value.clone()?)))
            .collect();
        let error = match send(&values).await {
            Ok(answer) => return Ok(answer),
            Err(error) => error,
        };
        let refused = matches!(error.status, Some(400 | 422));
        let rejected = active
            .iter()
            .position(|field| matches_ignoring_case(field.rejected_when, &error.message));
        match rejected {
            Some(index) if refused && attempt < attempts => {
                active.remove(index);
            }
            _ => return Err(error),
        }
        attempt += 1;
    }
}

fn matches_ignoring_case(pattern: &str, text: &str) -> bool {
    RegexBuilder::new(pattern)
        .case_insensitive(true)
        .build()
        .expect("a valid pattern")
        .is_match(text)
}

/// Whether a refusal is about thinking settings.
pub(crate) fn mentions_thinking(error: &LlmError) -> bool {
    matches_ignoring_case("thinking|thought|reasoning", &error.message)
}

/// A tool call's arguments from the JSON text a model wrote; anything else counts as none.
pub(crate) fn parse_arguments(raw: Option<&str>) -> Arguments {
    match raw.and_then(parse_json) {
        Some(Value::Object(arguments)) => arguments,
        _ => Map::new(),
    }
}

static INLINE_IMAGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"data:image/[^;]+;base64,[A-Za-z0-9+/=]{100,}").expect("a valid pattern")
});

/// A turn's text without inline image data, which only wastes tokens as text.
pub(crate) fn without_inline_images(content: &str) -> String {
    if content.contains("data:image/") {
        INLINE_IMAGE
            .replace_all(content, "[image attached as visual input]")
            .into_owned()
    } else {
        content.to_owned()
    }
}

pub(crate) fn system_text(messages: &[ChatMessage]) -> String {
    let parts: Vec<&str> = messages
        .iter()
        .filter(|item| item.role == Role::System)
        .map(|item| item.content.as_str())
        .collect();
    parts.join("\n")
}

/// A count in a reply.
pub(crate) fn count(value: &Value) -> Option<u64> {
    value.as_u64()
}

/// A base URL without its trailing slash.
pub(crate) fn trimmed(base_url: &str) -> &str {
    base_url.strip_suffix('/').unwrap_or(base_url)
}

const COMBINATORS: [&str; 3] = ["allOf", "anyOf", "oneOf"];

/// A tool's parameters as an input schema Anthropic accepts: an object schema with no oneOf, anyOf or allOf at the top level
/// (Anthropic rejects the whole request otherwise; built-in and MCP tools use them to say "give one of these"). allOf branches
/// are merged in; oneOf/anyOf branches add their properties, and the choice they expressed comes back as a note for the tool
/// description. Nested combinators are left alone.
pub fn flat_input_schema(parameters: Option<&Value>) -> (Value, Option<String>) {
    let mut schema = parameters
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let is_array = |name: &str| schema.get(name).is_some_and(Value::is_array);
    if !COMBINATORS.iter().any(|name| is_array(name)) {
        schema.insert("type".to_owned(), json!("object"));
        return (Value::Object(schema), None);
    }
    let branches = |name: &str| -> Vec<Value> {
        schema
            .get(name)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let names_of = |branch: &Value| -> Vec<String> {
        branch["required"]
            .as_array()
            .map_or_else(Vec::new, |names| {
                names
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
    };
    let mut properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut add_properties = |branch: &Value| {
        for (name, value) in branch["properties"].as_object().into_iter().flatten() {
            if properties.get(name).is_none_or(Value::is_null) {
                properties.insert(name.clone(), value.clone());
            }
        }
    };
    let mut required = names_of(&Value::Object(schema.clone()));
    let mut seen: BTreeSet<String> = required.iter().cloned().collect();
    for branch in branches("allOf") {
        add_properties(&branch);
        for name in names_of(&branch) {
            if seen.insert(name.clone()) {
                required.push(name);
            }
        }
    }
    let mut notes = Vec::new();
    for (name, lead) in [
        ("oneOf", "Give exactly one of"),
        ("anyOf", "Give at least one of"),
    ] {
        let options = branches(name);
        if options.is_empty() {
            continue;
        }
        options.iter().for_each(&mut add_properties);
        let choices: Vec<String> = options
            .iter()
            .map(|branch| names_of(branch).join(" + "))
            .collect();
        if choices.iter().all(|text| !text.is_empty()) {
            notes.push(format!("{lead}: {}.", choices.join(", ")));
        }
    }
    schema.insert("type".to_owned(), json!("object"));
    schema.insert("properties".to_owned(), Value::Object(properties));
    for name in COMBINATORS {
        schema.shift_remove(name);
    }
    if required.is_empty() {
        schema.shift_remove("required");
    } else {
        schema.insert("required".to_owned(), json!(required));
    }
    (
        Value::Object(schema),
        (!notes.is_empty()).then(|| notes.join(" ")),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn think_tags_move_to_the_reasoning_and_the_first_lines_indent_stays() {
        assert_eq!(
            split_think_tags("<think> a </think>\n\n  code  \n"),
            ("  code".to_owned(), "a".to_owned())
        );
        assert_eq!(
            split_think_tags("<THINK>a</think>b<think></think><think>c</think>"),
            ("b".to_owned(), "a\n\nc".to_owned())
        );
        assert_eq!(
            split_think_tags("plain"),
            ("plain".to_owned(), String::new())
        );
    }

    #[test]
    fn reasoning_does_not_repeat() {
        assert_eq!(join_thinking(" a ", ""), "a");
        assert_eq!(join_thinking("", " b "), "b");
        assert_eq!(join_thinking("abc", "b"), "abc");
        assert_eq!(join_thinking("a", "b"), "a\n\nb");
    }

    #[test]
    fn a_schema_with_a_top_level_choice_is_flattened() {
        let (schema, note) = flat_input_schema(Some(&json!({
            "type": "object",
            "properties": { "keep": { "type": "string" } },
            "required": ["keep"],
            "allOf": [{ "properties": { "merged": { "type": "number" } }, "required": ["merged", "keep"] }],
            "anyOf": [{ "properties": { "a": {} }, "required": ["a", "b"] }, { "properties": { "keep": { "type": "number" } }, "required": ["c"] }],
        })));
        assert_eq!(schema["required"], json!(["keep", "merged"]));
        assert_eq!(
            schema["properties"]["keep"]["type"], "string",
            "what the schema says itself wins"
        );
        assert!(schema["properties"]["a"].is_object() && schema.get("anyOf").is_none());
        assert_eq!(note.as_deref(), Some("Give at least one of: a + b, c."));

        let (schema, note) =
            flat_input_schema(Some(&json!({ "oneOf": [{ "properties": { "a": {} } }] })));
        assert_eq!(
            note, None,
            "a branch that requires nothing is no choice to state"
        );
        assert!(schema.get("required").is_none());
        assert_eq!(flat_input_schema(None).0, json!({ "type": "object" }));
    }
}
