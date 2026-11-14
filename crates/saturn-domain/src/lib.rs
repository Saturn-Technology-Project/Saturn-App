//! Saturn's rules: what an agent may do, with no I/O. `contract/cases` holds the cases they must answer.
pub mod chunks;
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

/// A path as people and other programs write it. Asked for a path's real form, Windows answers with its long-path
/// spelling, `\\?\C:\folder` or `\\?\UNC\server\share`: fine to open, but not what a person typed, and other programs
/// (cmd, Codex's `--cd`) read it badly or not at all. This takes the prefix off; any other path comes back as it is.
pub fn plain_path(path: std::path::PathBuf) -> std::path::PathBuf {
    let Some(text) = path.to_str() else {
        return path;
    };
    if let Some(share) = text.strip_prefix(r"\\?\UNC\") {
        return std::path::PathBuf::from(format!(r"\\{share}"));
    }
    match text.strip_prefix(r"\\?\") {
        // Only a drive's path has a plain spelling; a device or volume name keeps its own.
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => std::path::PathBuf::from(rest),
        _ => path,
    }
}

#[cfg(test)]
mod path_tests {
    use std::path::PathBuf;

    use super::plain_path;

    #[test]
    fn a_long_path_spelling_becomes_the_plain_one_and_nothing_else_changes() {
        let plain = |text: &str| {
            plain_path(PathBuf::from(text))
                .to_string_lossy()
                .into_owned()
        };
        assert_eq!(
            plain(r"\\?\C:\Users\someone\study"),
            r"C:\Users\someone\study"
        );
        assert_eq!(
            plain(r"\\?\UNC\server\share\study"),
            r"\\server\share\study"
        );
        assert_eq!(plain(r"\\?\Volume{1234}\study"), r"\\?\Volume{1234}\study");
        assert_eq!(plain(r"C:\Users\someone"), r"C:\Users\someone");
        assert_eq!(plain("/home/someone/study"), "/home/someone/study");
    }
}
