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

/// Shell commands that delete, wipe, kill or escalate, on POSIX shells, cmd and PowerShell, and ones that reach for
/// Saturn's own data (its token, its keys) or a system key store. Matched on the lowercased line. A pattern is a
/// heuristic: the sandbox, which hides Saturn's data and the credential folders from commands, is what holds.
static SENSITIVE_COMMANDS: LazyLock<RegexSet> = LazyLock::new(|| {
    RegexSet::new([
        r"\brm\s+(-[rf]+|--recursive)\b",
        r"\brm\b[^&|;]*\s--(recursive|force)\b",
        r"\bfind\b[^&|;]*\s-delete\b",
        r"\bgit\s+clean\s+-\w*f",
        r"\bshred\b",
        r"\.saturn-app\b",
        r"runtime-token",
        r"\bsecrets\.(json|key)\b",
        r"\bsecurity\s+(find|dump|export)-",
        r"\bsecret-tool\s+(lookup|search)\b",
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

/// Research tool calls that change what the project runs on, which the person decides: the interpreter Saturn starts for
/// the project's checks, notebooks, data and language server.
fn changes_the_interpreter(tool: &str, arguments: &Arguments) -> bool {
    tool == "research_environment_action" && argument_text(arguments, "action") == "set"
}

/// Automation calls that leave a prompt to run later, unattended, or run one now: an agent steered by what it read could
/// otherwise schedule itself.
const SCHEDULING_TOOLS: [&str; 3] = [
    "automation_create",
    "automation_toggle",
    "automation_trigger",
];

/// Whether a call is risky enough to ask about in the default approval mode.
pub fn is_sensitive_operation(tool: &str, arguments: &Arguments) -> bool {
    if changes_the_interpreter(tool, arguments) || SCHEDULING_TOOLS.contains(&tool) {
        return true;
    }
    if tool == "code"
        && SENSITIVE_COMMANDS.is_match(&argument_text(arguments, "command").trim().to_lowercase())
    {
        return true;
    }
    if tool == "files" {
        // A patch asks when any file it touches would: one it deletes, or one outside the workspace.
        if let Some(pieces) = crate::permissions::patch_pieces(arguments) {
            return pieces.iter().any(file_call_is_sensitive);
        }
        return file_call_is_sensitive(arguments);
    }
    false
}

/// Whether one file call asks: a delete, or a path outside the workspace.
fn file_call_is_sensitive(arguments: &Arguments) -> bool {
    let path = argument_text(arguments, "path");
    let drive = path.as_bytes();
    let has_drive = drive.len() >= 2 && drive[0].is_ascii_alphabetic() && drive[1] == b':';
    argument_text(arguments, "action") == "delete"
        || path.starts_with('/')
        || path.starts_with('\\')
        || has_drive
        || path.starts_with("..")
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
