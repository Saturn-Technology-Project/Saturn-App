//! Permission rules: what an agent may do without asking, what it must ask about, and what it may never do.
//!
//! A rule names a tool and a pattern. For the shell (`code`) the pattern is a command prefix with `*` wildcards
//! (`npm test *`, `git *`); for files it is `<action> <path glob>` (`write src/**`, `read **`); for every other tool it
//! is matched against the call's first text argument, or `*` for any call. Rules live in layers (the user's settings, a
//! project, an agent, and the project's own settings files); `resolve_permission` combines them.
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::{Arguments, argument_text};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effect {
    Allow,
    Deny,
    Ask,
}

impl Effect {
    /// Deny beats ask beats allow, so one careful rule is never undone by a broader generous one.
    fn priority(self) -> u8 {
        match self {
            Self::Deny => 3,
            Self::Ask => 2,
            Self::Allow => 1,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rule {
    /// A tool id, or a glob over tool ids (`github_*`).
    pub tool: String,
    pub pattern: String,
    pub effect: Effect,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Scope {
    User,
    Project,
    Agent,
    ProjectFile,
    ClaudeFile,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Layer {
    pub scope: Scope,
    pub rules: Vec<Rule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Decision {
    pub effect: Effect,
    pub rule: Rule,
    pub scope: Scope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

const FILE_ACTIONS: [&str; 11] = [
    "list", "read", "write", "append", "delete", "move", "copy", "mkdir", "search", "patch", "edit",
];

/// Whether a glob covers a value. With `path`, `*` stays inside one folder and `**` crosses folders.
fn matches_glob(glob: &str, value: &str, path: bool) -> bool {
    let characters: Vec<char> = glob.trim().chars().collect();
    let mut source = String::from("(?s)^");
    let mut index = 0;
    while index < characters.len() {
        match characters[index] {
            '*' if path && characters.get(index + 1) == Some(&'*') => {
                // `**` crosses folders; `**/` also matches nothing at all (`src/**/x` matches `src/x`).
                if characters.get(index + 2) == Some(&'/') {
                    source.push_str("(?:.*/)?");
                    index += 2;
                } else {
                    source.push_str(".*");
                    index += 1;
                }
            }
            '*' => source.push_str(if path { "[^/]*" } else { ".*" }),
            '?' => source.push_str(if path { "[^/]" } else { "." }),
            other => source.push_str(&regex::escape(&other.to_string())),
        }
        index += 1;
    }
    source.push('$');
    Regex::new(&source).is_ok_and(|pattern| pattern.is_match(value))
}

/// The pieces of a shell line that run one after another: `a && b | c; d` has four. Quotes are respected.
pub fn command_segments(command: &str) -> Vec<String> {
    let characters: Vec<char> = command.chars().collect();
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        let next = characters.get(index + 1).copied();
        if let Some(open) = quote {
            current.push(character);
            if character == open {
                quote = None;
            } else if character == '\\'
                && open == '"'
                && let Some(next) = next
            {
                current.push(next);
                index += 1;
            }
        } else if character == '\'' || character == '"' {
            quote = Some(character);
            current.push(character);
        } else if character == '\\' && next.is_some() {
            current.push(character);
            current.extend(next);
            index += 1;
        } else if character == ';'
            || character == '\n'
            || ((character == '&' || character == '|') && next == Some(character))
        {
            segments.push(std::mem::take(&mut current));
            if character == '&' || character == '|' {
                index += 1;
            }
        } else if character == '|' || character == '&' {
            segments.push(std::mem::take(&mut current));
        } else {
            current.push(character);
        }
        index += 1;
    }
    segments.push(current);
    segments
        .iter()
        .map(|segment| segment.trim().to_owned())
        .filter(|segment| !segment.is_empty())
        .collect()
}

/// Collapses runs of whitespace so `npm   test` and `npm test` read the same.
fn normalize_command(command: &str) -> String {
    command.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Whether a shell pattern covers one command segment. A pattern that ends in ` *` is a prefix: `npm test *` covers
/// `npm test` and `npm test --watch`, but not `npm testing`.
pub fn matches_command(pattern: &str, segment: &str) -> bool {
    let normalized = normalize_command(segment);
    let rule = normalize_command(pattern);
    if rule == "*" {
        return true;
    }
    if let Some(prefix) = rule.strip_suffix(" *") {
        if normalized == prefix || normalized.starts_with(&format!("{prefix} ")) {
            return true;
        }
        // Wildcards inside the prefix too (`git * --dry-run *`).
        return prefix.contains('*')
            && (matches_glob(&format!("{prefix} *"), &normalized, false)
                || matches_glob(prefix, &normalized, false));
    }
    matches_glob(&rule, &normalized, false)
}

/// A file rule's action and path glob.
fn file_parts(pattern: &str) -> (&str, &str) {
    let trimmed = pattern.trim();
    match trimmed.split_once(' ') {
        None if FILE_ACTIONS.contains(&trimmed) => (trimmed, "**"),
        None => ("*", trimmed),
        Some((head, rest)) if FILE_ACTIONS.contains(&head) || head == "*" => (head, rest.trim()),
        Some(_) => ("*", trimmed),
    }
}

/// The text a non-shell, non-file rule is matched against: the call's first string argument.
pub fn primary_argument(arguments: &Arguments) -> String {
    let named = [
        "url", "path", "query", "command", "name", "title", "text", "input",
    ]
    .iter()
    .find_map(|key| arguments.get(*key).and_then(|value| value.as_str()));
    named
        .or_else(|| arguments.values().find_map(|value| value.as_str()))
        .unwrap_or_default()
        .to_owned()
}

fn normalize_path(value: &str) -> String {
    let forward = value.replace('\\', "/");
    forward
        .strip_prefix("./")
        .map(str::to_owned)
        .unwrap_or(forward)
}

/// The first of these arguments that is set, as JavaScript's `a ?? b ?? c` reads them.
fn first_argument(arguments: &Arguments, keys: &[&str]) -> String {
    keys.iter()
        .find(|key| arguments.get(**key).is_some_and(|value| !value.is_null()))
        .map(|key| argument_text(arguments, key))
        .unwrap_or_default()
}

/// Whether one rule covers one tool call (for the shell: one command segment).
pub fn matches_rule(rule: &Rule, tool: &str, arguments: &Arguments, segment: Option<&str>) -> bool {
    if rule.tool != "*"
        && rule.tool != tool
        && !(rule.tool.contains('*') && matches_glob(&rule.tool, tool, false))
    {
        return false;
    }
    if tool == "code" {
        let command = argument_text(arguments, "command");
        return matches_command(&rule.pattern, segment.unwrap_or(&command));
    }
    if tool == "files" {
        let (action, glob) = file_parts(&rule.pattern);
        let called = argument_text(arguments, "action");
        if action != "*" && action != called && !(action == "write" && called == "append") {
            return false;
        }
        let target = normalize_path(&first_argument(arguments, &["path", "from", "source"]));
        return glob == "**" || glob == "*" || matches_glob(glob, &target, true);
    }
    let pattern = rule.pattern.trim();
    pattern == "*"
        || pattern.is_empty()
        || matches_glob(pattern, &primary_argument(arguments), false)
}

/// The strictest decision; the earliest of equals, so the layer order breaks ties.
fn strongest(decisions: impl IntoIterator<Item = Decision>) -> Option<Decision> {
    let mut best: Option<Decision> = None;
    for decision in decisions {
        if best
            .as_ref()
            .is_none_or(|kept| decision.effect.priority() > kept.effect.priority())
        {
            best = Some(decision);
        }
    }
    best
}

/// The decision the layers make about one tool call, or None when no rule applies (the agent's own approval setting
/// decides then). A shell line is judged by its segments: every segment must be allowed for the line to be allowed, and
/// the strictest segment wins otherwise.
pub fn resolve_permission(layers: &[Layer], tool: &str, arguments: &Arguments) -> Option<Decision> {
    let judge = |segment: Option<&str>| {
        let hits = layers.iter().flat_map(|layer| {
            layer
                .rules
                .iter()
                .filter(move |rule| matches_rule(rule, tool, arguments, segment))
                .map(|rule| Decision {
                    effect: rule.effect,
                    rule: rule.clone(),
                    scope: layer.scope,
                    path: layer.path.clone(),
                })
        });
        strongest(hits)
    };
    if tool != "code" {
        return judge(None);
    }
    let segments = command_segments(&argument_text(arguments, "command"));
    if segments.is_empty() {
        return None;
    }
    let decided: Vec<Decision> = segments
        .iter()
        .filter_map(|segment| judge(Some(segment)))
        .collect();
    let covered = decided.len() == segments.len();
    let strict = strongest(decided)?;
    // Allowed only when every segment is covered by an allow rule.
    (strict.effect != Effect::Allow || covered).then_some(strict)
}

/// A readable form for cards and logs: `code: npm test *`.
pub fn describe_rule(rule: &Rule) -> String {
    format!("{}: {}", rule.tool, rule.pattern)
}

/// Converts a rule from Claude Code's `.claude/settings.json` (`Bash(npm test:*)`, `Read(src/**)`, `Edit`,
/// `WebFetch(domain:example.com)`, `mcp__github__create_issue`) to a Saturn rule, or None when there is no equivalent.
pub fn from_claude_rule(text: &str, effect: Effect) -> Option<Rule> {
    let shape = Regex::new(r"^([A-Za-z_][A-Za-z0-9_-]*)(?:\((.*)\))?$").ok()?;
    let found = shape.captures(text.trim())?;
    let name = found.get(1)?.as_str();
    let spec = found.get(2).map_or("", |inner| inner.as_str()).trim();
    let rule = |tool: &str, pattern: String| {
        Some(Rule {
            tool: tool.to_owned(),
            pattern,
            effect,
        })
    };
    let with_spec = |action: &str| {
        if spec.is_empty() {
            action.to_owned()
        } else {
            format!("{action} {spec}")
        }
    };
    match name {
        "Bash" if spec.is_empty() => rule("code", "*".to_owned()),
        "Bash" => rule(
            "code",
            spec.strip_suffix(":*")
                .map_or_else(|| spec.to_owned(), |prefix| format!("{prefix} *")),
        ),
        "Read" | "Glob" | "Grep" => rule("files", with_spec("read")),
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => rule("files", with_spec("write")),
        "WebFetch" | "WebSearch" => rule(
            "web",
            spec.strip_prefix("domain:")
                .filter(|domain| !domain.is_empty())
                .map_or_else(|| "*".to_owned(), |domain| format!("*{domain}*")),
        ),
        _ if name.starts_with("mcp__") => {
            match name.split("__").nth(2).filter(|tool| !tool.is_empty()) {
                Some(tool) => rule(&format!("*{tool}"), "*".to_owned()),
                None => rule("*", "*".to_owned()),
            }
        }
        _ => None,
    }
}

/// A sensible rule to offer when the user picks "Always allow" on a waiting call.
pub fn suggested_pattern(tool: &str, arguments: &Arguments) -> String {
    if tool == "code" {
        let segments = command_segments(&argument_text(arguments, "command"));
        let first = normalize_command(segments.first().map_or("", String::as_str));
        let mut words = first.split(' ');
        let head = words.next().unwrap_or_default();
        if head.is_empty() {
            return "*".to_owned();
        }
        return match words.next().filter(|second| !second.starts_with('-')) {
            Some(second) => format!("{head} {second} *"),
            None => format!("{head} *"),
        };
    }
    if tool == "files" {
        let action = arguments
            .get("action")
            .filter(|value| !value.is_null())
            .map_or_else(|| "*".to_owned(), |_| argument_text(arguments, "action"));
        let target = normalize_path(&argument_text(arguments, "path"));
        let shown = if action == "append" { "write" } else { &action };
        return match target.rsplit_once('/') {
            Some((folder, _)) if !folder.is_empty() => format!("{shown} {folder}/**"),
            _ => format!("{shown} **"),
        };
    }
    "*".to_owned()
}
