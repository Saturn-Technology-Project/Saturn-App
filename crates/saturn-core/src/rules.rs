//! The project's own instructions for agents, read from the files teams already keep.
use std::path::Path;

use saturn_domain::js;

/// Characters of project rules put in an agent's prompt.
pub const RULES_BUDGET: usize = 6000;
/// Rule files, in the order they are read; folders contribute their `.md` files by name.
pub const RULE_FILES: [&str; 5] = [
    "AGENTS.md",
    "CLAUDE.md",
    ".saturn/rules",
    ".agents/rules",
    ".cursorrules",
];

async fn read(file: &Path) -> String {
    match tokio::fs::read(file).await {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(content) if !content.contains('\0') => js::trim(&content).to_owned(),
            _ => String::new(),
        },
        Err(_) => String::new(),
    }
}

/// The rules as prompt text: AGENTS.md, CLAUDE.md, `.saturn/rules/*.md`, `.agents/rules/*.md`, `.cursorrules`, then the rules
/// saved in Saturn's project settings.
pub async fn project_rules(root: &Path, stored: &str) -> String {
    let mut pieces: Vec<(String, String)> = Vec::new();
    for entry in RULE_FILES {
        let full = root.join(entry);
        if entry.ends_with("/rules") {
            let Ok(mut folder) = tokio::fs::read_dir(&full).await else {
                continue;
            };
            let mut names = Vec::new();
            while let Ok(Some(item)) = folder.next_entry().await {
                if let Ok(name) = item.file_name().into_string()
                    && name.ends_with(".md")
                {
                    names.push(name);
                }
            }
            names.sort();
            for name in names {
                let content = read(&full.join(&name)).await;
                if !content.is_empty() {
                    pieces.push((format!("{entry}/{name}"), content));
                }
            }
        } else {
            let content = read(&full).await;
            if !content.is_empty() {
                pieces.push((entry.to_owned(), content));
            }
        }
    }
    let stored = js::trim(stored);
    if !stored.is_empty() {
        pieces.push(("Saturn project settings".to_owned(), stored.to_owned()));
    }
    if pieces.is_empty() {
        return String::new();
    }
    let mut room = RULES_BUDGET;
    let mut parts = Vec::new();
    for (path, content) in &pieces {
        if room <= 200 {
            break;
        }
        let body = if js::length(content) > room {
            format!("{}\n…(truncated)", js::prefix(content, room))
        } else {
            content.clone()
        };
        room = room.saturating_sub(js::length(&body));
        parts.push(format!("## {path}\n{body}"));
    }
    format!(
        "# Project rules (the project's instructions for agents; follow them)\n{}",
        parts.join("\n\n")
    )
}
