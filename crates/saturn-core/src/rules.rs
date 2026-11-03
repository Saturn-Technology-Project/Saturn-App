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

/// Whether a file is really inside a folder. A cloned repository can bring a link that leads elsewhere on the computer, and what
/// these files hold goes into prompts and so to the model's provider.
pub async fn really_inside(root: &Path, file: &Path) -> bool {
    let (Ok(folder), Ok(target)) = (
        tokio::fs::canonicalize(root).await,
        tokio::fs::canonicalize(file).await,
    ) else {
        return false;
    };
    target != folder && target.starts_with(folder)
}

async fn read(root: &Path, file: &Path) -> String {
    if !really_inside(root, file).await {
        return String::new();
    }
    match tokio::fs::read(file).await {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(content) if !content.contains('\0') => js::trim(&content).to_owned(),
            _ => String::new(),
        },
        Err(_) => String::new(),
    }
}

/// Every file the agents' prompt takes rules from, for the editor.
pub async fn rule_sources(root: &Path, stored: &str) -> Vec<serde_json::Value> {
    pieces_of(root, stored)
        .await
        .iter()
        .map(|(path, content)| serde_json::json!({ "path": path, "chars": js::length(content) }))
        .collect()
}

/// The rules as prompt text: AGENTS.md, CLAUDE.md, `.saturn/rules/*.md`, `.agents/rules/*.md`, `.cursorrules`, then the rules
/// saved in Saturn's project settings.
pub async fn project_rules(root: &Path, stored: &str) -> String {
    let pieces = pieces_of(root, stored).await;
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

/// Each source of rules and what it holds.
async fn pieces_of(root: &Path, stored: &str) -> Vec<(String, String)> {
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
                let content = read(root, &full.join(&name)).await;
                if !content.is_empty() {
                    pieces.push((format!("{entry}/{name}"), content));
                }
            }
        } else {
            let content = read(root, &full).await;
            if !content.is_empty() {
                pieces.push((entry.to_owned(), content));
            }
        }
    }
    let stored = js::trim(stored);
    if !stored.is_empty() {
        pieces.push(("Saturn project settings".to_owned(), stored.to_owned()));
    }
    pieces
}
