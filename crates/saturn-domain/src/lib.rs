//! Saturn's rules: what an agent may do, with no I/O. `contract/cases` holds the cases they must answer.
pub mod chunks;
pub mod completions;
pub mod context;
pub mod diff;
pub mod hooks;
pub mod js;
pub mod llm;
pub mod permissions;
pub mod policies;
pub mod prompt;
pub mod research;
pub mod schedule;
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

/// Random bytes as lowercase hex.
pub fn random_hex(bytes: usize) -> std::io::Result<String> {
    let mut random = vec![0u8; bytes];
    getrandom::fill(&mut random).map_err(std::io::Error::other)?;
    Ok(research::hex(&random))
}

/// A new id for a record, like `run_0123456789abcdef`.
pub fn new_id(prefix: &str) -> std::io::Result<String> {
    Ok(format!("{prefix}_{}", random_hex(8)?))
}
