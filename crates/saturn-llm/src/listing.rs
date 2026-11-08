//! The models a provider says a key can use, read from its own list: Anthropic's and DeepSeek's `/models`, OpenAI's
//! `/models` without what cannot chat, and Gemini's models that generate content. Each answers with ids and, where the
//! provider gives one, a display name.
use std::time::Duration;

use serde_json::Value;

use crate::http::{Http, LlmError};
use crate::shared::endpoint;

/// How long a provider may take to list its models.
const TIMEOUT: Duration = Duration::from_secs(10);

/// One model a provider listed: its id, and its display name when the provider gives one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListedModel {
    pub id: String,
    pub label: Option<String>,
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
                })
            })
            .collect(),
        _ => items("data")
            .iter()
            .filter_map(|item| {
                let id = text(item, "id")?;
                (provider != "openai" || chats(&id)).then(|| ListedModel {
                    id,
                    label: text(item, "display_name"),
                })
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn each_providers_answer_is_read_and_what_cannot_chat_is_left_out() {
        let openai = json!({ "data": [{ "id": "gpt-6-astra" }, { "id": "text-embedding-3-small" }, { "id": "whisper-1" }, { "id": "gpt-image-2" }] });
        assert_eq!(
            read_list("openai", &openai),
            vec![ListedModel {
                id: "gpt-6-astra".into(),
                label: None
            }]
        );
        let claude =
            json!({ "data": [{ "id": "claude-mythos-5-1", "display_name": "Claude Mythos 5.1" }] });
        assert_eq!(
            read_list("claude", &claude)[0].label.as_deref(),
            Some("Claude Mythos 5.1")
        );
        let gemini = json!({ "models": [
            { "name": "models/gemini-4-argon", "displayName": "Gemini 4 Argon", "supportedGenerationMethods": ["generateContent"] },
            { "name": "models/gemini-embedding-2", "supportedGenerationMethods": ["embedContent", "generateContent"] },
            { "name": "models/imagen-5", "supportedGenerationMethods": ["predict"] }
        ] });
        assert_eq!(
            read_list("gemini", &gemini),
            vec![ListedModel {
                id: "gemini-4-argon".into(),
                label: Some("Gemini 4 Argon".into())
            }]
        );
        assert!(read_list("deepseek", &json!({ "unexpected": true })).is_empty());
    }
}
