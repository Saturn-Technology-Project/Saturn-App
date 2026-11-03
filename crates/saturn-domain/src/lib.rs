//! Saturn's rules: what an agent may do, with no I/O. Behaviour matches `runtime/src/domain`; `contract/cases` holds the
//! cases both implementations must answer alike.
pub mod permissions;
pub mod policies;

/// A tool call's arguments, in the order the model sent them.
pub type Arguments = serde_json::Map<String, serde_json::Value>;

/// An argument as text, the way JavaScript's `String(value ?? "")` reads the values a tool call holds.
pub(crate) fn argument_text(arguments: &Arguments, key: &str) -> String {
    match arguments.get(key) {
        None | Some(serde_json::Value::Null) => String::new(),
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}
