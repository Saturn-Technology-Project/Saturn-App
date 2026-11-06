//! Hooks: commands that run around an agent's tool calls and at the end of its turn, the way Claude Code's do. This is what
//! they are and how their answers read; `saturn-core` runs them.
use std::collections::BTreeMap;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// When a hook runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HookEvent {
    PreTool,
    PostTool,
    Stop,
}

impl HookEvent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PreTool => "pre_tool",
            Self::PostTool => "post_tool",
            Self::Stop => "stop",
        }
    }
}

/// One hook.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hook {
    pub event: HookEvent,
    /// A tool id or glob (`code`, `files`, `github_*`); empty matches every tool. Ignored for `stop`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matcher: Option<String>,
    pub command: String,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "whole_when_possible"
    )]
    pub timeout_ms: Option<f64>,
}

/// A number the way JSON.stringify writes it: 5000, not 5000.0.
fn whole_when_possible<S: serde::Serializer>(
    value: &Option<f64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match value {
        Some(number) if number.fract() == 0.0 => serializer.serialize_i64(*number as i64),
        Some(number) => serializer.serialize_f64(*number),
        None => serializer.serialize_none(),
    }
}

/// What a hook's output says about a tool call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HookDecision {
    Allow,
    Ask,
    Deny,
}

/// A saved value as a hook; anything that is not one is left out.
pub fn hook_from(value: &Value) -> Option<Hook> {
    let hook: Hook = serde_json::from_value(value.clone()).ok()?;
    (!crate::js::trim(&hook.command).is_empty()).then_some(hook)
}

/// Names one exact set of hooks: approving them names this, and any change to them asks again.
pub fn hooks_fingerprint(hooks: &[Hook]) -> String {
    let rows: Vec<Value> = hooks
        .iter()
        .map(|hook| {
            let timeout = hook.timeout_ms.unwrap_or(0.0);
            json!([
                hook.event.as_str(),
                hook.matcher.as_deref().unwrap_or(""),
                hook.command,
                if timeout.fract() == 0.0 {
                    json!(timeout as i64)
                } else {
                    json!(timeout)
                },
            ])
        })
        .collect();
    let digest = Sha256::digest(Value::Array(rows).to_string().as_bytes());
    crate::research::hex(&digest)
}

/// Whether a hook's matcher covers a tool: exact, a `*` glob, or a `|` list (Claude Code's `Edit|Write`).
pub fn matches_tool(matcher: Option<&str>, tool: &str) -> bool {
    let text = crate::js::trim(matcher.unwrap_or(""));
    if text.is_empty() || text == "*" {
        return true;
    }
    text.split('|').any(|part| {
        let glob = crate::js::trim(part);
        if !glob.contains('*') {
            return glob == tool;
        }
        let pattern = glob
            .split('*')
            .map(regex::escape)
            .collect::<Vec<_>>()
            .join(".*");
        Regex::new(&format!("^(?s:{pattern})$")).is_ok_and(|regex| regex.is_match(tool))
    })
}

/// Claude Code's event names.
fn claude_event(name: &str) -> Option<HookEvent> {
    match name {
        "PreToolUse" => Some(HookEvent::PreTool),
        "PostToolUse" => Some(HookEvent::PostTool),
        "Stop" => Some(HookEvent::Stop),
        _ => None,
    }
}

/// Saturn's tool for one of Claude Code's.
fn claude_tool(name: &str) -> &str {
    match name {
        "Bash" => "code",
        "Read" | "Edit" | "Write" | "MultiEdit" | "Glob" | "Grep" => "files",
        "WebFetch" | "WebSearch" => "web",
        other => other,
    }
}

/// Translates the `hooks` of a Claude Code settings file; matchers name Claude Code's tools, mapped to Saturn's.
pub fn from_claude_hooks(value: Option<&Value>) -> Vec<Hook> {
    let mut hooks = Vec::new();
    let Some(events) = value.and_then(Value::as_object) else {
        return hooks;
    };
    for (name, groups) in events {
        let (Some(event), Some(groups)) = (claude_event(name), groups.as_array()) else {
            continue;
        };
        for group in groups {
            let matcher = group.get("matcher").and_then(Value::as_str).map(|text| {
                let mut tools: Vec<&str> = Vec::new();
                for tool in text.split('|') {
                    let mapped = claude_tool(crate::js::trim(tool));
                    if !tools.contains(&mapped) {
                        tools.push(mapped);
                    }
                }
                tools.join("|")
            });
            let entries = group.get("hooks").and_then(Value::as_array);
            for entry in entries.into_iter().flatten() {
                let command = entry.get("command").and_then(Value::as_str).unwrap_or("");
                if entry.get("type").and_then(Value::as_str) != Some("command")
                    || crate::js::trim(command).is_empty()
                {
                    continue;
                }
                hooks.push(Hook {
                    event,
                    matcher: matcher.clone().filter(|text| !text.is_empty()),
                    command: command.to_owned(),
                    timeout_ms: entry
                        .get("timeout")
                        .and_then(Value::as_f64)
                        .map(|seconds| seconds * 1000.0),
                });
            }
        }
    }
    hooks
}

/// What a hook wrote to stdout: `{ decision, reason }`, or Claude Code's `{ hookSpecificOutput: { permissionDecision, … } }`.
pub fn parse_answer(stdout: &str) -> (Option<HookDecision>, Option<String>) {
    let text = crate::js::trim(stdout);
    if !text.starts_with('{') {
        return (None, None);
    }
    let Ok(json) = serde_json::from_str::<BTreeMap<String, Value>>(text) else {
        return (None, None);
    };
    let specific = json.get("hookSpecificOutput");
    let field = |own: &str, inner: &str| {
        json.get(own)
            .filter(|value| !value.is_null())
            .or_else(|| specific.and_then(|value| value.get(inner)))
    };
    let decision = match field("decision", "permissionDecision").and_then(Value::as_str) {
        Some("allow") => Some(HookDecision::Allow),
        Some("ask") => Some(HookDecision::Ask),
        Some("deny" | "block") => Some(HookDecision::Deny),
        _ => None,
    };
    let reason = field("reason", "permissionDecisionReason")
        .and_then(Value::as_str)
        .map(str::to_owned);
    (decision, reason)
}
