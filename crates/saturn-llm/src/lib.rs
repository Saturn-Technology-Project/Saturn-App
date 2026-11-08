//! Saturn's one door to every model provider, over plain HTTP. Each provider's module turns the same request into what that
//! provider expects, and its reply into a `Completion`. `contract/cases/llm.json` holds what the providers' official SDKs send, which
//! these modules must send too. To stop a call, drop its future.
pub mod broker;
pub mod claude;
pub mod deepseek;
pub mod gemini;
pub mod http;
pub mod listing;
pub mod lmstudio;
pub mod openai;
pub mod shared;

pub use broker::{Broker, CallContext, CompletionInput, KeyVault, ModelConnection};
pub use http::{Http, LlmError};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// A tool call's arguments.
pub type Arguments = Map<String, Value>;

/// Who wrote a turn. `Tool` is one tool call's result, right after the assistant turn that made the call.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    #[default]
    User,
    Assistant,
    Tool,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Tool => "tool",
        }
    }
}

/// An image attached to a turn.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePart {
    pub mime_type: String,
    pub base64: String,
}

/// A tool call as the model made it, sent back in the provider's own format on the next request.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Arguments,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thought_signature: Option<String>,
}

/// A provider's own reply, kept to send back verbatim to that provider (Claude's signed thinking blocks).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Replay {
    pub provider: String,
    pub data: Value,
}

/// One turn of a conversation.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
    /// The model's chain of thought for an assistant turn. Only providers that need it sent back read it.
    pub reasoning: Option<String>,
    pub images: Vec<ImagePart>,
    /// An assistant turn's tool calls.
    pub tool_calls: Vec<ChatToolCall>,
    /// An assistant turn's raw reply, for the provider that wrote it.
    pub replay: Option<Replay>,
    /// A tool result: the call it answers, the tool's name, and whether it failed or was refused.
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub failed: bool,
}

impl ChatMessage {
    pub fn new(role: Role, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
            ..Self::default()
        }
    }
}

/// A tool offered to the model.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolDef {
    pub function: ToolFunction,
}

/// A tool's name and schema.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolFunction {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<Value>,
}

/// A model connection's reasoning effort; every provider maps it to its own control.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl Effort {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}

/// One model call after the broker has picked the provider and the key. It holds the key, so it has no `Debug`.
#[derive(Clone, Default)]
pub struct ChatRequest {
    pub model: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolDef>,
    pub temperature: Option<f64>,
    pub max_output: Option<u64>,
    /// For latency-sensitive editor calls: providers that think by default are asked to think little, so the output budget
    /// goes to the answer. Takes precedence over `effort`.
    pub low_thinking: bool,
    pub effort: Option<Effort>,
    /// Groups requests that share a prompt prefix (an agent's), for providers whose caching takes a key (OpenAI).
    pub cache_key: Option<String>,
}

/// Tokens a provider reports for one call; any may be missing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TokenUsage {
    pub input: Option<u64>,
    pub output: Option<u64>,
    /// Prompt tokens read from the provider's cache (cheaper, faster).
    pub cached: Option<u64>,
    /// Prompt tokens written to it, where the provider bills writes.
    pub cache_write: Option<u64>,
}

/// A tool call in a reply. Gemini gives no id.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolCall {
    pub id: Option<String>,
    pub name: String,
    pub arguments: Arguments,
    pub thought_signature: Option<String>,
}

/// A model's reply, the same from every provider.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Completion {
    pub content: String,
    pub thinking: String,
    pub tool_calls: Vec<ToolCall>,
    /// The raw reply, to send back with the turn's tool results.
    pub replay: Option<Replay>,
    pub usage: TokenUsage,
    /// The call's line in the usage history, when it reported tokens. Whoever made the call files it.
    pub usage_record: Option<Value>,
}
