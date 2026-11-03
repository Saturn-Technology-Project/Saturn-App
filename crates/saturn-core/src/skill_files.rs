//! Skills: folders with a SKILL.md an agent loads only when a task calls for them. Read from the project's `.agents/skills`,
//! `.saturn/skills` and `.claude/skills`, then the user's. A name found twice keeps the first.
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use saturn_domain::js;
use saturn_domain::skill_files::{SKILL_LIMIT, parse_skill, valid_name};
use serde_json::{Value, json};

/// Project folders searched for skills, in order.
pub const PROJECT_SKILL_DIRS: [&str; 3] = [".agents/skills", ".saturn/skills", ".claude/skills"];

/// A skill found on disk.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
    pub source: &'static str,
    pub folder: PathBuf,
}

async fn scan(folder: &Path, source: &'static str) -> Vec<SkillInfo> {
    let Ok(mut entries) = tokio::fs::read_dir(folder).await else {
        return Vec::new();
    };
    let mut names = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        if entry.file_type().await.is_ok_and(|kind| kind.is_dir())
            && let Ok(name) = entry.file_name().into_string()
            && valid_name(&name)
        {
            names.push(name);
        }
    }
    names.sort();
    let mut skills = Vec::new();
    for name in names {
        let file = folder.join(&name).join("SKILL.md");
        // Missing or unreadable: skipped.
        let Ok(text) = tokio::fs::read_to_string(&file).await else {
            continue;
        };
        let parsed = parse_skill(&text, &name);
        skills.push(SkillInfo {
            name: parsed.name,
            description: parsed.description,
            path: file,
            source,
            folder: folder.join(name),
        });
    }
    skills
}

/// Every skill available to a chat in `root` (a project folder, or none), the first of each name winning.
pub async fn list_skills(root: Option<&Path>, user_dir: &Path) -> Vec<SkillInfo> {
    let mut found = Vec::new();
    if let Some(root) = root {
        for folder in PROJECT_SKILL_DIRS {
            found.extend(scan(&root.join(folder), "project").await);
        }
    }
    found.extend(scan(user_dir, "user").await);
    let mut seen = HashSet::new();
    found.retain(|skill| seen.insert(skill.name.to_lowercase()));
    found
}

/// Every file under a folder, by path relative to it, at most `limit`.
async fn files_under(folder: &Path, limit: usize) -> Vec<String> {
    let mut files = Vec::new();
    let mut pending = vec![folder.to_path_buf()];
    while let Some(current) = pending.pop() {
        let Ok(mut entries) = tokio::fs::read_dir(&current).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let Ok(kind) = entry.file_type().await else {
                continue;
            };
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() && entry.file_name() != "SKILL.md" {
                let path = entry.path();
                if let Ok(relative) = path.strip_prefix(folder) {
                    files.push(relative.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
    files.sort();
    files.truncate(limit);
    files
}

/// One skill's whole file, with the other files in its folder listed.
pub async fn load_skill(root: Option<&Path>, user_dir: &Path, name: &str) -> Option<Value> {
    let wanted = js::trim(name);
    let wanted = wanted.strip_prefix('/').unwrap_or(wanted).to_lowercase();
    let skill = list_skills(root, user_dir)
        .await
        .into_iter()
        .find(|item| item.name.to_lowercase() == wanted)?;
    let parsed = parse_skill(
        &tokio::fs::read_to_string(&skill.path).await.ok()?,
        &skill.name,
    );
    let body = if js::length(&parsed.body) > SKILL_LIMIT {
        format!("{}\n…(truncated)", js::prefix(&parsed.body, SKILL_LIMIT))
    } else {
        parsed.body
    };
    Some(json!({
        "name": skill.name,
        "description": skill.description,
        "path": skill.path.to_string_lossy(),
        "instructions": body,
        "files": files_under(&skill.folder, 50).await,
    }))
}
