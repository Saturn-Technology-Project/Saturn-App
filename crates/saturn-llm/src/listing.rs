//! The models a provider says a key can use, read from its own list: Anthropic's and DeepSeek's `/models`, OpenAI's
//! `/models` without what cannot chat, and Gemini's models that generate content. Each answers with ids and, where the
//! provider gives them, a display name and the model's sizes. Saturn keeps no list of its own.
use std::time::Duration;

use serde_json::Value;

use crate::http::{Http, LlmError};
use crate::shared::endpoint;

/// How long a provider may take to list its models.
const TIMEOUT: Duration = Duration::from_secs(10);

/// One model a provider listed: its id, and what else the provider says of it. Anthropic and Gemini give a display name,
/// the context window and the longest answer, in tokens; OpenAI and DeepSeek give the id alone.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ListedModel {
    pub id: String,
    pub label: Option<String>,
    pub context_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

/// Words in an OpenAI model id that mark a model as not for chat: embeddings, speech, images, moderation and the like.
const NOT_CHAT: [&str; 14] = [
    "embedding",
    "tts",
    "whisper",
    "dall-e",
    "davinci",
    "babbage",
    "moderation",
    "audio",
    "realtime",
    "transcribe",
    "image",
    "search",
    "sora",
    "computer-use",
];

/// Whether an id OpenAI lists is a model to chat with.
pub fn chats(id: &str) -> bool {
    let lowered = id.to_lowercase();
    !NOT_CHAT.iter().any(|word| lowered.contains(word))
}

/// The models `provider` lists at `base_url` for `key`, in the provider's order. `None` for a provider without a list.
pub async fn list_models(
    http: &Http,
    provider: &str,
    base_url: &str,
    key: &str,
) -> Option<Result<Vec<ListedModel>, LlmError>> {
    let bearer = format!("Bearer {key}");
    let (url, headers): (String, Vec<(&str, &str)>) = match provider {
        "openai" | "deepseek" => (
            endpoint(base_url, "/models"),
            vec![("authorization", bearer.as_str())],
        ),
        "claude" => (
            endpoint(base_url, "/v1/models?limit=1000"),
            vec![("x-api-key", key), ("anthropic-version", "2023-06-01")],
        ),
        "gemini" => (
            endpoint(base_url, "/v1beta/models?pageSize=1000"),
            vec![("x-goog-api-key", key)],
        ),
        _ => return None,
    };
    Some(
        http.get_json_with(&url, &headers, TIMEOUT)
            .await
            .map(|answer| read_list(provider, &answer)),
    )
}

/// The models in a provider's answer.
fn read_list(provider: &str, answer: &Value) -> Vec<ListedModel> {
    let text = |item: &Value, key: &str| {
        item.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let items = |key: &str| {
        answer
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let count = |item: &Value, key: &str| {
        item.get(key)
            .and_then(Value::as_u64)
            .filter(|tokens| *tokens > 0)
    };
    match provider {
        "gemini" => items("models")
            .iter()
            .filter(|item| {
                item.get("supportedGenerationMethods")
                    .and_then(Value::as_array)
                    .is_some_and(|methods| methods.iter().any(|method| method == "generateContent"))
            })
            .filter_map(|item| {
                let name = text(item, "name")?;
                let id = name.strip_prefix("models/").unwrap_or(&name).to_owned();
                (!id.contains("embedding")).then(|| ListedModel {
                    id,
                    label: text(item, "displayName"),
                    context_tokens: count(item, "inputTokenLimit"),
                    output_tokens: count(item, "outputTokenLimit"),
                })
            })
            .collect(),
        _ => {
            let mut listed = items("data");
            // OpenAI and DeepSeek list in no useful order; each model says when it was made, so the newest come first.
            // Anthropic already lists newest first and gives no such number, and is left as it is.
            listed
                .sort_by_key(|item| std::cmp::Reverse(item.get("created").and_then(Value::as_i64)));
            listed
                .iter()
                .filter_map(|item| {
                    let id = text(item, "id")?;
                    (provider != "openai" || chats(&id)).then(|| ListedModel {
                        id,
                        label: text(item, "display_name"),
                        context_tokens: count(item, "max_input_tokens"),
                        output_tokens: count(item, "max_tokens"),
                    })
                })
                .collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn each_providers_answer_is_read_and_what_cannot_chat_is_left_out() {
        let ids = |provider: &str, answer: &Value| -> Vec<String> {
            read_list(provider, answer)
                .into_iter()
                .map(|model| model.id)
                .collect()
        };
        let openai = json!({ "data": [{ "id": "chat-older", "created": 100 }, { "id": "text-embedding-3-small", "created": 300 }, { "id": "whisper-1" }, { "id": "chat-newer", "created": 200 }, { "id": "gpt-image-2" }] });
        // What cannot chat is left out, and the newest model comes first.
        assert_eq!(ids("openai", &openai), ["chat-newer", "chat-older"]);
        assert_eq!(read_list("openai", &openai)[0].label, None);
        let gemini = json!({ "models": [
            { "name": "models/gemini-next", "displayName": "Gemini Next", "inputTokenLimit": 1_048_576, "outputTokenLimit": 65_536, "supportedGenerationMethods": ["generateContent"] },
            { "name": "models/gemini-embedding-2", "supportedGenerationMethods": ["embedContent", "generateContent"] },
            { "name": "models/imagen-5", "supportedGenerationMethods": ["predict"] }
        ] });
        assert_eq!(
            read_list("gemini", &gemini),
            vec![ListedModel {
                id: "gemini-next".into(),
                label: Some("Gemini Next".into()),
                context_tokens: Some(1_048_576),
                output_tokens: Some(65_536),
            }]
        );
        assert!(read_list("deepseek", &json!({ "unexpected": true })).is_empty());
    }

    /// Anthropic says how large each model is, so Saturn keeps no table of its own; its order, newest first, is kept.
    #[test]
    fn claudes_list_gives_each_models_name_and_sizes_in_its_own_order() {
        let claude = json!({ "data": [
            { "id": "claude-next-6", "display_name": "Claude Next 6", "max_input_tokens": 1_000_000, "max_tokens": 128_000 },
            { "id": "claude-small-4", "display_name": "Claude Small 4", "max_input_tokens": 200_000, "max_tokens": 64_000 },
            { "id": "claude-unsized" }
        ] });
        assert_eq!(
            read_list("claude", &claude),
            vec![
                ListedModel {
                    id: "claude-next-6".into(),
                    label: Some("Claude Next 6".into()),
                    context_tokens: Some(1_000_000),
                    output_tokens: Some(128_000),
                },
                ListedModel {
                    id: "claude-small-4".into(),
                    label: Some("Claude Small 4".into()),
                    context_tokens: Some(200_000),
                    output_tokens: Some(64_000),
                },
                ListedModel {
                    id: "claude-unsized".into(),
                    ..ListedModel::default()
                },
            ]
        );
    }
}
