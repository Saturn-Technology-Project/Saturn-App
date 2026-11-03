//! Saturn's rules: what an agent may do, with no I/O. Behaviour matches `runtime/src/domain`; `contract/cases` holds the
//! cases both implementations must answer alike.
pub mod llm;
pub mod permissions;
pub mod policies;
pub mod time;

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

/// A new id for a record, like `run_0123456789abcdef`.
pub fn new_id(prefix: &str) -> std::io::Result<String> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).map_err(std::io::Error::other)?;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("{prefix}_{hex}"))
}
