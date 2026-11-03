//! What an agent is told: its system prompt, and the small texts around a turn.
use crate::js;
use crate::toolkits::load_note;

/// A turn's mode: Ask and Plan turns only read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunMode {
    Agent,
    Ask,
    Plan,
}

impl RunMode {
    /// A saved or requested mode.
    pub fn parse(value: Option<&str>) -> Option<Self> {
        match value {
            Some("agent") => Some(Self::Agent),
            Some("ask") => Some(Self::Ask),
            Some("plan") => Some(Self::Plan),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Ask => "ask",
            Self::Plan => "plan",
        }
    }

    pub fn reads_only(self) -> bool {
        self != Self::Agent
    }
}

/// A text flattened to one line, at most `limit` long.
pub fn clip(text: &str, limit: usize) -> String {
    let flat = text
        .split(js::is_space)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if js::length(&flat) <= limit {
        return flat;
    }
    format!("{}…", js::prefix(&flat, limit.saturating_sub(1)))
}

/// A run's failure in words the user can act on.
pub fn explain_run_error(message: &str) -> String {
    if message.contains("API_KEY_SERVICE_BLOCKED")
        || message.contains("generativelanguage.googleapis.com")
    {
        return "This Gemini key cannot call the Gemini API. Create a key in Google AI Studio and connect it under LLM.".to_owned();
    }
    message.to_owned()
}

/// What an Ask or Plan turn is told about itself (nothing for an Agent turn).
pub fn mode_instructions(mode: Option<RunMode>) -> &'static str {
    match mode {
        Some(RunMode::Ask) => {
            "### This turn: Ask mode\nAnswer the question. You may read files and pages to do so, but do not change anything: tools that write, edit or run commands are refused in this mode. If a change is needed, describe it and say the user can switch to Agent mode to have it made."
        }
        Some(RunMode::Plan) => {
            "### This turn: Plan mode\nDo not change anything yet: tools that write, edit or run commands are refused in this mode. Read what you need, then reply with a numbered plan: the files to change and what changes in each, the order, the risks, and how the result will be checked. End by saying the user can switch to Agent mode and reply 'go' to carry it out."
        }
        _ => "",
    }
}

/// The refusal an Ask or Plan turn gets for a tool that would change something.
pub fn read_only_refusal(mode: RunMode) -> String {
    format!(
        "{} mode only reads: this tool would change something, so it was not run. Switch to Agent mode to make changes.",
        if mode == RunMode::Ask { "Ask" } else { "Plan" }
    )
}

/// A number from a saved setting, inside its range; anything else is the fallback.
pub fn number_of(value: Option<&serde_json::Value>, fallback: f64, low: f64, high: f64) -> f64 {
    let number = js::number(value);
    if number.is_finite() {
        number.clamp(low, high)
    } else {
        fallback
    }
}

/// Adds a model's thinking to what the run has so far, leaving out what is there already.
pub fn join_thinking(current: Option<&str>, next: &str) -> String {
    let extra = js::trim(next);
    let current = current.unwrap_or("");
    if extra.is_empty() {
        return current.to_owned();
    }
    if js::trim(current).is_empty() {
        return extra.to_owned();
    }
    if current.contains(extra) {
        return current.to_owned();
    }
    format!("{}\n\n{extra}", js::trim(current))
}

/// The heading each on-demand toolkit's section of the system prompt starts with.
fn section_head(server: &str) -> Option<&'static str> {
    match server {
        "browser" => Some("### Browser (Browser)"),
        "computer-use" => Some("### Computer Use:"),
        "origin" => Some("### Origin & Git Repository Tools"),
        "automations" => Some("### Automations & Antigravity Capabilities"),
        _ => None,
    }
}

/// What goes into a system prompt.
#[derive(Clone, Copy, Debug, Default)]
pub struct PromptInput<'a> {
    pub instructions: &'a str,
    pub context: &'a str,
    pub server_ids: &'a [String],
    /// Toolkits the agent has but has not loaded: their sections say how to load them.
    pub deferred: &'a [String],
    /// Notes Saturn kept from earlier chats.
    pub memory: &'a str,
    /// The project's own rules for agents (AGENTS.md and the like).
    pub rules: &'a str,
    /// Agents must present a plan and wait for a go-ahead before changing anything.
    pub plan_approval: bool,
    pub mode: Option<RunMode>,
}

/// An agent's system prompt.
pub fn build_system_prompt(input: &PromptInput<'_>) -> String {
    let mut parts: Vec<String> = Vec::new();
    for text in [input.memory, input.rules, input.instructions] {
        let text = js::trim(text);
        if !text.is_empty() {
            parts.push(text.to_owned());
        }
    }
    let has = |id: &str| input.server_ids.iter().any(|item| item == id);
    let mut capabilities: Vec<&str> = vec![
        "You are Saturn, an advanced, highly capable AI pair-programmer and automation agent with direct access to desktop, system, and development tools.",
        "You operate with full autonomy. Directly use your tools whenever needed to fulfill tasks completely and accurately without unnecessary confirmation requests, refusals, or artificial constraints.",
    ];
    if has("general-skills") {
        capabilities.push(concat!(
            "### Workspace & System Tools (General Skills)\n",
            "- `files`: Inspect directory trees, read, write, or patch files in the workspace with unified diff hunks.\n",
            "- `code`: Execute shell commands, test scripts, and build processes in the workspace, inside a sandbox that writes only there. If a command needs to write elsewhere, call it again with sandbox: \"off\" (the user is asked). A server or watcher goes in the background with background: true; read it with `code_output`, end it with `code_stop`.\n",
            "- `web`: Retrieve and read readable text from public web documentation and resources.\n",
            "- `multi_step`: Structure and maintain step-by-step task execution plans.\n",
            "- `delegate`: Hand a self-contained task (a wide search, an investigation, an independent subtask) to a sub-agent with a fresh context and get back its answer only; several tasks run in parallel. Use it to keep large exploration out of this conversation.\n",
            "- `mcp`: Invoke additional tools from connected MCP servers."
        ));
    }
    if has("browser") {
        capabilities.push(concat!(
            "### Browser (Browser)\n",
            "- `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_screenshot`, `browser_evaluate`, `browser_record_start`/`browser_record_stop`, `browser_close`.\n",
            "- Read pages as accessibility snapshots (text with element ids) and act by id; use screenshots only to show the user or to record. Prefer these over computer-use for anything on the web. Public addresses only: localhost and private networks are refused."
        ));
    }
    if has("computer-use") || has("cursor-computer-use") {
        capabilities.push(concat!(
            "### Computer Use: Desktop Automation on macOS and Windows\n",
            "- `computer_screenshot`: Capture full display or app window screenshots to visually inspect UI state.\n",
            "- `computer_apps` & `computer_resolve_app`: Inspect running applications and launch one by name, bundle identifier (macOS) or executable path (Windows).\n",
            "- `computer_app_state`: Inspect an application's UI element tree (macOS accessibility, Windows UI Automation).\n",
            "- `computer_click`, `computer_move`, `computer_drag`: Simulate mouse clicks, movements, and drag operations.\n",
            "- `computer_type`, `computer_key`, `computer_scroll`: Send keyboard input, press key combinations/shortcuts, and scroll displays.\n",
            "- `computer_set_value` & `computer_app_action`: Modify UI field values and trigger button/menu actions.\n",
            "- `computer_start_control` & `computer_release_control`: Escalation to take over or release display controls.\n",
            "- `computer_check_permissions`: Verify Accessibility and Screen Recording permissions (macOS; Windows needs none)."
        ));
    }
    if has("origin") || has("cursor-origin") {
        capabilities.push(concat!(
            "### Origin & Git Repository Tools (Origin)\n",
            "- Git & Repo Inspection: `get_repository`, `list_repositories`, `list_namespaces`, `get_file_contents`, `get_git_tree`, `list_branches`, `list_commits`, `commit_read`, `compare_commits`, `grep_contents`, `checks_read`.\n",
            "- Version Control & Collaboration: `create_repository`, `sync_mirror`, `create_pull_request`, `update_pull_request`, `update_pull_request_base`, `merge_pull_request`, `create_pull_request_review`, `create_pull_request_comment`, `create_pull_request_inline_comment`, `reply_pull_request_review_thread`, `update_pull_request_review_thread`, `update_pull_request_comment`, `update_pull_request_labels`, `create_label`, `request_pull_request_reviewers`, `remove_pull_request_reviewers`."
        ));
    }
    if has("automations") || has("antigravity-skills") {
        capabilities.push(concat!(
            "### Automations & Antigravity Capabilities (Automations)\n",
            "- Automations: `automation_list`, `automation_create`, `automation_trigger`, `automation_toggle`, `automation_delete` (manage recurring scheduled background cron tasks and agent runs).\n",
            "- Generative UI: `generative_ui_template` (starter HTML/Tailwind snippets for a widget the files tool then writes).\n",
            "- Customizations: `customizations_list`, `customizations_create_skill`, `customizations_create_rule` (manage on-demand skills, project rules, and discovery hierarchy).\n",
            "- Workflows: `workflows_scan`, `workflows_migrate` (scan legacy workflow files and automatically migrate them to modern skills).\n",
            "- Plugins: `plugins_list`, `plugins_bundle`, `plugins_toggle` (bundle and manage multi-component plugins)."
        ));
    }
    // A section whose toolkit is not loaded yet says how to load it; the section stands as its catalog.
    let sections: Vec<String> = capabilities
        .into_iter()
        .map(|section| {
            input
                .deferred
                .iter()
                .find(|id| section_head(id).is_some_and(|head| section.starts_with(head)))
                .map_or_else(
                    || section.to_owned(),
                    |id| format!("{section}\n{}", load_note(id)),
                )
        })
        .collect();
    parts.push(sections.join("\n\n"));
    // How a task is run and reported, so the user can review the plan before and the outcome after.
    parts.push(format!(
        "### Working method\n{}- When a task that changed files or ran commands is done, end with a short summary under the heading \"## Summary\": what changed (files), how you checked it, and anything left for the user. Skip the heading for questions and small answers.",
        if input.plan_approval {
            "- Before changing any file or running any command that changes state, call `multi_step` with your plan and stop: reply with the plan and the sentence \"Reply 'go' to proceed, or tell me what to change.\" Do not act until the user says so. Reading and searching are fine before the plan.\n"
        } else {
            "- For a task with several steps, call `multi_step` first with the plan, keep it updated as you go, and use one step at a time.\n"
        }
    ));
    let context = js::trim(input.context);
    if !context.is_empty() {
        parts.push(format!("### Relevant Knowledge & Context\n{context}"));
    }
    let mode_note = mode_instructions(input.mode);
    if !mode_note.is_empty() {
        parts.push(mode_note.to_owned());
    }
    parts.join("\n\n")
}
