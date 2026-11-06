//! How much an agent may do on its own, and which calls count as risky or as only reading.
use std::sync::LazyLock;

use regex::{Regex, RegexSet};

use crate::{Arguments, argument_text};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GuardrailMode {
    Default,
    Bypass,
    Review,
}

/// The approval mode an agent's saved setting means, including the names earlier versions saved.
pub fn autonomy_of(value: Option<&str>) -> GuardrailMode {
    match value {
        Some("bypass" | "turbo" | "fully_autonomous") => GuardrailMode::Bypass,
        Some("review" | "suggest_only") => GuardrailMode::Review,
        _ => GuardrailMode::Default,
    }
}

/// Shell commands that delete, wipe, kill or escalate, on POSIX shells, cmd and PowerShell. Matched on the lowercased line.
static SENSITIVE_COMMANDS: LazyLock<RegexSet> = LazyLock::new(|| {
    RegexSet::new([
        r"\brm\s+(-[rf]+|--recursive)\b",
        r"\bsudo\b",
        r"\b(kill|pkill)\b",
        r"\bgit\s+(push\s+--force|reset\s+--hard)\b",
        r"\b(mkfs|dd|format)\b",
        r">>\s*/etc/",
        r"\b(del|erase)\b[^&|;]*\s/[sq]\b",
        r"\b(rd|rmdir)\b[^&|;]*\s/s\b",
        r"\b(remove-item|ri|rm|del|erase|rmdir|rd)\b[^&|;]*\s-r\w*\b",
        r"\b(diskpart|format-volume|clear-disk|initialize-disk|remove-partition|cipher\s+/w)\b",
        r"\breg(\.exe)?\s+(delete|import|add)\b",
        r"\bremove-item(property)?\b[^&|;]*\bhk(lm|cu|cr|u|cc):",
        r"\b(stop-process|spps|taskkill)\b",
        r"\b(stop-computer|restart-computer|shutdown(\.exe)?\s+/[srp])\b",
        r"\b(bcdedit|vssadmin\s+delete|wmic\s+shadowcopy\s+delete)\b",
        r"\bset-executionpolicy\b",
        r"\bstart-process\b[^&|;]*-verb\s+runas\b",
    ])
    .expect("these patterns are valid")
});

/// Whether a call is risky enough to ask about in the default approval mode.
pub fn is_sensitive_operation(tool: &str, arguments: &Arguments) -> bool {
    if tool == "code"
        && SENSITIVE_COMMANDS.is_match(&argument_text(arguments, "command").trim().to_lowercase())
    {
        return true;
    }
    if tool == "files" {
        let path = argument_text(arguments, "path");
        let drive = path.as_bytes();
        let has_drive = drive.len() >= 2 && drive[0].is_ascii_alphabetic() && drive[1] == b':';
        return argument_text(arguments, "action") == "delete"
            || path.starts_with('/')
            || path.starts_with('\\')
            || has_drive
            || path.starts_with("..");
    }
    false
}

/// Tools that only look: they read files, pages, the screen or a repository and change nothing.
const READ_ONLY_TOOLS: [&str; 15] = [
    "web",
    "code_output",
    "delegate",
    "skill",
    "load_tools",
    "computer_screenshot",
    "computer_apps",
    "computer_app_state",
    "computer_check_permissions",
    "computer_resolve_app",
    "computer_wait",
    "customizations_list",
    "plugins_list",
    "automation_list",
    "workflows_scan",
];

/// Names MCP servers commonly give tools that only read (GitHub's get_file_contents, list_commits, pull_request_read…).
static READ_ONLY_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(get|list|read|search|grep|find|compare|fetch|view|describe|show)_|_(read|list|get|search|state|status)$").expect("this pattern is valid")
});

/// Whether one tool call only reads. Ask and Plan turns run only these: a write is refused, not asked about. `category`
/// is the tool's own declaration when it has one (`read` or `write`); the files tool depends on its action.
pub fn is_read_only_call(tool: &str, arguments: &Arguments, category: Option<&str>) -> bool {
    if let Some(category) = category {
        return category == "read";
    }
    match tool {
        "files" => matches!(argument_text(arguments, "action").as_str(), "list" | "read"),
        "code" => false,
        _ => READ_ONLY_TOOLS.contains(&tool) || READ_ONLY_NAME.is_match(tool),
    }
}

/// Whether a tool can ever be read-only, so an Ask or Plan turn lists it at all.
pub fn may_read_only(tool: &str, category: Option<&str>) -> bool {
    if let Some(category) = category {
        return category == "read";
    }
    tool == "files" || is_read_only_call(tool, &Arguments::new(), None)
}
