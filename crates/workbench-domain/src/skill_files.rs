//! A skill's file: a name, a description and instructions an agent loads only when a task calls for them.
use std::sync::LazyLock;

use regex::Regex;

use crate::js;

/// Characters of a SKILL.md handed to the model.
pub const SKILL_LIMIT: usize = 40_000;
/// Characters of the skill list in the system prompt.
pub const SKILL_LIST_LIMIT: usize = 4_000;

static NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$").expect("this pattern is valid")
});
static FRONTMATTER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^---\r?\n((?s:.*?))\r?\n---\r?\n?").expect("this pattern is valid")
});
static PAIR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([A-Za-z_-]+):\s*(.*)$").expect("this pattern is valid"));
static PARAGRAPH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\r?\n\r?\n").expect("this pattern is valid"));
static SPACES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s+").expect("this pattern is valid"));

/// Whether a skill or command may have this name.
pub fn valid_name(name: &str) -> bool {
    NAME.is_match(name)
}

/// A parsed skill file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedSkill {
    pub name: String,
    pub description: String,
    pub body: String,
}

/// The frontmatter of a SKILL.md (`name:` and `description:` lines), and the body after it.
pub fn parse_skill(text: &str, fallback_name: &str) -> ParsedSkill {
    let mut body = text;
    let (mut name, mut description) = (None, None);
    if let Some(found) = FRONTMATTER.captures(text) {
        body = &text[found[0].len()..];
        for line in found[1].split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            let Some(pair) = PAIR.captures(line) else {
                continue;
            };
            let value = unquoted(js::trim(&pair[2]));
            match pair[1].to_lowercase().as_str() {
                "name" => name = Some(value.to_owned()),
                "description" => description = Some(value.to_owned()),
                _ => {}
            }
        }
    }
    // Without frontmatter: the first paragraph that is not a heading describes the skill.
    let description = description
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| {
            PARAGRAPH
                .split(body)
                .map(js::trim)
                .find(|part| !part.is_empty() && !part.starts_with('#'))
                .map(|part| js::prefix(&SPACES.replace_all(part, " "), 300).to_owned())
                .unwrap_or_default()
        });
    ParsedSkill {
        name: name
            .filter(|name| valid_name(name))
            .unwrap_or_else(|| fallback_name.to_owned()),
        description,
        body: js::trim(body).to_owned(),
    }
}

/// A value with one quote mark taken off each end that has one.
fn unquoted(value: &str) -> &str {
    let value = value.strip_prefix(['"', '\'']).unwrap_or(value);
    value.strip_suffix(['"', '\'']).unwrap_or(value)
}

/// The skills section of the system prompt: names and descriptions only.
pub fn skills_prompt(skills: &[(String, String)]) -> String {
    if skills.is_empty() {
        return String::new();
    }
    let mut lines: Vec<String> = Vec::new();
    let mut used = 0;
    for (name, description) in skills {
        let shown = if description.is_empty() {
            "(no description)"
        } else {
            description
        };
        let line = format!("- {name}: {shown}");
        let length = js::length(&line);
        if used + length > SKILL_LIST_LIMIT {
            lines.push(format!(
                "- …and {} more (call skill with a name to load one)",
                skills.len() - lines.len()
            ));
            break;
        }
        lines.push(line);
        used += length;
    }
    format!(
        "# Skills\nInstructions for particular tasks, loaded on demand. When a task matches one, call the `skill` tool with its name before starting, and follow it.\n{}",
        lines.join("\n")
    )
}
