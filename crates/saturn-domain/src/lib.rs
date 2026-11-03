//! Saturn's rules: what an agent may do, with no I/O. Behaviour matches `runtime/src/domain`; `contract/cases` holds the
//! cases both implementations must answer alike.
pub mod context;
pub mod diff;
pub mod hooks;
pub mod js;
pub mod llm;
pub mod permissions;
pub mod policies;
pub mod prompt;
pub mod skill_files;
pub mod skills;
pub mod time;
pub mod toolkits;

/// A tool call's arguments, in the order the model sent them.
pub type Arguments = serde_json::Map<String, serde_json::Value>;

/// An argument as text, the way JavaScript's `String(value ?? "")` reads the values a tool call holds.
pub(crate) fn argument_text(arguments: &Arguments, key: &str) -> String {
    js::text(arguments.get(key))
}

/// A new id for a record, like `run_0123456789abcdef`.
pub fn new_id(prefix: &str) -> std::io::Result<String> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).map_err(std::io::Error::other)?;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("{prefix}_{hex}"))
}
