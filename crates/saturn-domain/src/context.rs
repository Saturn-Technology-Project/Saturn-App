//! Keeps what each model call carries bounded on long runs: the latest tool results stay whole, older ones are cleared to a
//! stub (the run keeps the originals), one oversized result is clipped to its head and tail, and earlier turns of a chat fit
//! a budget sized to the model's context window.
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

use crate::js;

/// Tool results from the most recent actions that are sent in full (still capped per result).
pub const RECENT_ACTIONS: usize = 6;
/// Characters of one tool result the model sees, head and tail together.
pub const RESULT_CHARS: usize = 8_000;
/// Characters of earlier turns sent before the current request, when the model's window is unknown.
pub const HISTORY_CHARS: usize = 60_000;
/// A rough 4 characters per token, the usual estimate for English and code.
pub const CHARS_PER_TOKEN: usize = 4;

/// The instruction the summarizing call gets; the turns follow as the conversation itself.
pub const COMPACTION_PROMPT: &str = "You are compacting the earlier part of a conversation between a user and an AI agent so the agent can continue it with less context. Write a summary for the agent, in the user's language, under 600 words. Keep what later turns depend on: the user's goal and the decisions made, files, paths, commands and identifiers that mattered, what was done and what is still open, errors seen and how they were resolved, and the user's preferences and constraints. Leave out pleasantries and anything superseded. If an earlier summary is given, fold it in rather than repeating it. Answer with the summary only.";

static GPT_SIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("^gpt-6").expect("this pattern is valid"));

/// Tokens a text takes, roughly.
pub fn estimate_tokens(text: &str) -> usize {
    js::length(text).div_ceil(CHARS_PER_TOKEN)
}

/// A model's context window in tokens. A connection's own `contextTokens` wins.
pub fn context_tokens_for(provider: &str, model: &str, own: Option<f64>) -> u64 {
    if let Some(tokens) = own.filter(|tokens| *tokens > 0.0) {
        return tokens as u64;
    }
    match provider {
        "claude" => 200_000,
        "openai" if GPT_SIX.is_match(model) => 400_000,
        "gemini" => 1_000_000,
        "lmstudio" | "mlx" => 32_000,
        _ => 128_000,
    }
}

/// Characters of earlier turns a request may carry: half the window, leaving the rest for the system prompt, the tools, this
/// turn's tool results and the answer.
pub fn history_budget_chars(provider: &str, model: &str, own: Option<f64>) -> usize {
    context_tokens_for(provider, model, own) as usize * CHARS_PER_TOKEN / 2
}

/// A value as the text the model would see.
fn serialized(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// Head and tail of a long text, with what was cut in between.
pub fn clip_middle(text: &str, limit: usize) -> String {
    let length = js::length(text);
    if length <= limit {
        return text.to_owned();
    }
    let head = limit * 7 / 10;
    let tail = limit - head;
    format!(
        "{}\n…[{} characters omitted]…\n{}",
        js::prefix(text, head),
        length - head - tail,
        js::suffix(text, tail)
    )
}

/// The actions as the model should see them this round; the run keeps the originals.
pub fn compact_actions(actions: &[Value]) -> Vec<Value> {
    let first_recent = actions.len().saturating_sub(RECENT_ACTIONS);
    actions
        .iter()
        .enumerate()
        .map(|(index, action)| {
            let Some(result) = action.get("result").filter(|result| !result.is_null()) else {
                return action.clone();
            };
            let text = serialized(result);
            let length = js::length(&text);
            let replacement = if index < first_recent {
                let tool = action.get("toolId").and_then(Value::as_str).unwrap_or("");
                format!(
                    "[result cleared to save context: {length} characters. Call {tool} again if you need it.]"
                )
            } else if length <= RESULT_CHARS {
                return action.clone();
            } else {
                clip_middle(&text, RESULT_CHARS)
            };
            let mut compacted = action.clone();
            compacted["result"] = Value::String(replacement);
            compacted
        })
        .collect()
}

/// Which of the turns (oldest first, by role and size) fit the budget, trimmed from the oldest end: the index of the first
/// turn kept. Never opens on an answer whose question was cut.
pub fn budget_start(turns: &[(bool, usize)], budget: usize) -> usize {
    let mut used = 0;
    let mut start = turns.len();
    while start > 0 {
        let size = turns[start - 1].1;
        if used + size > budget && start < turns.len() {
            break;
        }
        used += size;
        start -= 1;
    }
    while start < turns.len() && !turns[start].0 {
        start += 1;
    }
    start
}

/// Which earlier turns to fold into the summary: the index of the first that stays, so that what stays fits `keep_chars`. The
/// newest turn always stays, so the model sees the exchange it is continuing.
pub fn compaction_start(sizes: &[usize], keep_chars: usize) -> usize {
    let mut used = 0;
    let mut start = sizes.len();
    while start > 0 {
        let size = sizes[start - 1];
        if used + size > keep_chars && start < sizes.len() {
            break;
        }
        used += size;
        start -= 1;
    }
    start
}
