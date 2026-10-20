import type { Agent, RunAction } from "./model.js";

export type ToolCall = { name: string; arguments: Record<string, unknown>; thoughtSignature?: string };


export function clip(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit - 1)}…`;
}

export function explainRunError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Run failed";
  if (message.includes("API_KEY_SERVICE_BLOCKED") || message.includes("generativelanguage.googleapis.com")) {
    return "This Gemini key cannot call the Gemini API. Create a key in Google AI Studio and connect it under LLM.";
  }
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  if (message === "fetch failed" && cause) return cause;
  return message;
}

export function styleOf(value: unknown): "concise" | "professional" | "detailed" {
  return value === "concise" || value === "detailed" || value === "professional" ? value : "professional";
}

export type GuardrailMode = "default" | "bypass" | "review";

export function autonomyOf(value: unknown): GuardrailMode {
  if (value === "bypass" || value === "turbo" || value === "fully_autonomous") return "bypass";
  if (value === "review" || value === "suggest_only") return "review";
  return "default";
}

/** cmd and PowerShell commands that delete trees, wipe disks, edit the registry or kill processes. `cmd` is lowercased. */
function isWindowsDestructive(cmd: string): boolean {
  return (
    /\b(del|erase)\b[^&|;]*\s\/[sq]\b/.test(cmd) ||
    /\b(rd|rmdir)\b[^&|;]*\s\/s\b/.test(cmd) ||
    /\b(remove-item|ri|rm|del|erase|rmdir|rd)\b[^&|;]*\s-r\w*\b/.test(cmd) ||
    /\b(diskpart|format-volume|clear-disk|initialize-disk|remove-partition|cipher\s+\/w)\b/.test(cmd) ||
    /\breg(\.exe)?\s+(delete|import|add)\b/.test(cmd) ||
    /\bremove-item(property)?\b[^&|;]*\bhk(lm|cu|cr|u|cc):/.test(cmd) ||
    /\b(stop-process|spps|taskkill)\b/.test(cmd) ||
    /\b(stop-computer|restart-computer|shutdown(\.exe)?\s+\/[srp])\b/.test(cmd) ||
    /\b(bcdedit|vssadmin\s+delete|wmic\s+shadowcopy\s+delete)\b/.test(cmd) ||
    /\bset-executionpolicy\b/.test(cmd) ||
    /\bstart-process\b[^&|;]*-verb\s+runas\b/.test(cmd)
  );
}

export function isSensitiveOperation(toolId: string, args: Record<string, unknown>): boolean {
  if (toolId === "code") {
    const cmd = String(args.command || "").trim().toLowerCase();
    if (
      /\brm\s+(-[rf]+|--recursive)\b/.test(cmd) ||
      /\bsudo\b/.test(cmd) ||
      /\b(kill|pkill)\b/.test(cmd) ||
      /\bgit\s+(push\s+--force|reset\s+--hard)\b/.test(cmd) ||
      /\b(mkfs|dd|format)\b/.test(cmd) ||
      />>\s*\/etc\//.test(cmd) ||
      isWindowsDestructive(cmd)
    ) {
      return true;
    }
  }
  if (toolId === "files") {
    const action = String(args.action || "");
    const filePath = String(args.path || "");
    if (action === "delete" || filePath.startsWith("/") || filePath.startsWith("\\") || /^[a-z]:/i.test(filePath) || filePath.startsWith("..")) {
      return true;
    }
  }
  return false;
}

/** Tools that only look: they read files, pages, the screen or a repository and change nothing. */
const READ_ONLY_TOOL_IDS = new Set([
  "web", "computer_screenshot", "computer_apps", "computer_app_state", "computer_check_permissions", "computer_resolve_app", "computer_wait",
  "customizations_list", "plugins_list", "automation_list", "workflows_scan",
]);
/** Names MCP servers commonly give tools that only read (GitHub's get_file_contents, list_commits, pull_request_read…). */
const READ_ONLY_NAME = /^(get|list|read|search|grep|find|compare|fetch|view|describe|show)_|_(read|list|get|search|state|status)$/;

/**
 * Whether one tool call only reads. Ask and Plan turns run only these: a write is refused, not asked about.
 * `category` is the tool's own declaration when it has one; the files tool depends on its action.
 */
export function isReadOnlyCall(toolId: string, args: Record<string, unknown>, category?: "read" | "write"): boolean {
  if (category) return category === "read";
  if (toolId === "files") return ["list", "read"].includes(String(args.action ?? ""));
  if (toolId === "code") return false;
  return READ_ONLY_TOOL_IDS.has(toolId) || READ_ONLY_NAME.test(toolId);
}

/** Whether a tool can ever be read-only, so an Ask or Plan turn lists it at all. */
export function mayReadOnly(toolId: string, category?: "read" | "write"): boolean {
  if (category) return category === "read";
  return toolId === "files" || isReadOnlyCall(toolId, {}, undefined);
}

/** What an Ask or Plan turn is told about itself (nothing for an Agent turn). */
export function modeInstructions(mode: "agent" | "ask" | "plan" | undefined): string {
  if (mode === "ask") {
    return "### This turn: Ask mode\nAnswer the question. You may read files and pages to do so, but do not change anything: tools that write, edit or run commands are refused in this mode. If a change is needed, describe it and say the user can switch to Agent mode to have it made.";
  }
  if (mode === "plan") {
    return "### This turn: Plan mode\nDo not change anything yet: tools that write, edit or run commands are refused in this mode. Read what you need, then reply with a numbered plan: the files to change and what changes in each, the order, the risks, and how the result will be checked. End by saying the user can switch to Agent mode and reply 'go' to carry it out.";
  }
  return "";
}

/** The refusal an Ask or Plan turn gets for a tool that would change something. */
export function readOnlyRefusal(mode: "ask" | "plan"): string {
  return `${mode === "ask" ? "Ask" : "Plan"} mode only reads: this tool would change something, so it was not run. Switch to Agent mode to make changes.`;
}

export function numberOf(value: unknown, fallback: number, low: number, high: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(low, Math.min(high, number));
}

export function behaviorOf(agent: Agent) {
  return {
    responseStyle: styleOf(agent.responseStyle),
    autonomy: autonomyOf(agent.autonomy),
    temperature: numberOf(agent.temperature, 0.2, 0, 2),
    maxOutput: numberOf(agent.maxOutput, 4000, 1, 128000),
  };
}

export function styleLine(_style: "concise" | "professional" | "detailed"): string {
  return "";
}

export function autonomyLine(_autonomy: "suggest_only" | "execute_when_allowed" | "fully_autonomous"): string {
  return "";
}

export function buildSystemPrompt(input: {
  agent: Agent;
  context?: string;
  serverIds?: string[];
  /** Notes Saturn kept from earlier chats (see application/memory.ts). */
  memory?: string;
  /** The project's own rules for agents (AGENTS.md and the like; see application/rules.ts). */
  rules?: string;
  /** Agents must present a plan and wait for a go-ahead before changing anything. */
  planApproval?: boolean;
  /** This turn's mode: Ask and Plan turns only read. */
  mode?: "agent" | "ask" | "plan";
}): string {
  const parts: string[] = [];
  if (input.memory?.trim()) parts.push(input.memory.trim());
  if (input.rules?.trim()) parts.push(input.rules.trim());

  // Custom user instructions (if provided)
  if (input.agent.instructions?.trim()) {
    parts.push(input.agent.instructions.trim());
  }

  // Capabilities awareness & unconstrained execution
  const serverIds = input.serverIds ?? input.agent.mcpConnectionIds ?? [];
  const capabilities: string[] = [
    "You are Saturn, an advanced, highly capable AI pair-programmer and automation agent with direct access to desktop, system, and development tools.",
    "You operate with full autonomy. Directly use your tools whenever needed to fulfill tasks completely and accurately without unnecessary confirmation requests, refusals, or artificial constraints.",
  ];

  if (serverIds.includes("general-skills")) {
    capabilities.push(
      "### Workspace & System Tools (General Skills)\n" +
      "- `files`: Inspect directory trees, read, write, or patch files in the workspace with unified diff hunks.\n" +
      "- `code`: Execute shell commands, test scripts, and build processes directly in the workspace.\n" +
      "- `web`: Retrieve and read readable text from public web documentation and resources.\n" +
      "- `multi_step`: Structure and maintain step-by-step task execution plans.\n" +
      "- `mcp`: Invoke additional tools from connected MCP servers."
    );
  }

  if (serverIds.includes("browser")) {
    capabilities.push(
      "### Browser (Browser)\n" +
      "- `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_screenshot`, `browser_evaluate`, `browser_record_start`/`browser_record_stop`, `browser_close`.\n" +
      "- Read pages as accessibility snapshots (text with element ids) and act by id; use screenshots only to show the user or to record. Prefer these over computer-use for anything on the web. Public addresses only: localhost and private networks are refused."
    );
  }

  if (serverIds.includes("computer-use") || serverIds.includes("cursor-computer-use")) {
    capabilities.push(
      "### Computer Use & macOS Desktop Automation (Computer Use)\n" +
      "- `computer_screenshot`: Capture full display or app window screenshots to visually inspect UI state.\n" +
      "- `computer_apps` & `computer_resolve_app`: Inspect running applications and launch any macOS application by name or bundle identifier.\n" +
      "- `computer_app_state`: Inspect the accessibility UI element tree of an application.\n" +
      "- `computer_click`, `computer_move`, `computer_drag`: Simulate mouse clicks, movements, and drag operations.\n" +
      "- `computer_type`, `computer_key`, `computer_scroll`: Send keyboard input, press key combinations/shortcuts, and scroll displays.\n" +
      "- `computer_set_value` & `computer_app_action`: Modify UI field values and trigger button/menu actions.\n" +
      "- `computer_start_control` & `computer_release_control`: Escalation to take over or release display controls.\n" +
      "- `computer_check_permissions`: Verify Accessibility and Screen Recording permissions."
    );
  }

  if (serverIds.includes("origin") || serverIds.includes("cursor-origin")) {
    capabilities.push(
      "### Origin & Git Repository Tools (Origin)\n" +
      "- Git & Repo Inspection: `get_repository`, `list_repositories`, `list_namespaces`, `get_file_contents`, `get_git_tree`, `list_branches`, `list_commits`, `commit_read`, `compare_commits`, `grep_contents`, `checks_read`.\n" +
      "- Version Control & Collaboration: `create_repository`, `sync_mirror`, `create_pull_request`, `update_pull_request`, `update_pull_request_base`, `merge_pull_request`, `create_pull_request_review`, `create_pull_request_comment`, `create_pull_request_inline_comment`, `reply_pull_request_review_thread`, `update_pull_request_review_thread`, `update_pull_request_comment`, `update_pull_request_labels`, `create_label`, `request_pull_request_reviewers`, `remove_pull_request_reviewers`."
    );
  }

  if (serverIds.includes("automations") || serverIds.includes("antigravity-skills")) {
    capabilities.push(
      "### Automations & Antigravity Capabilities (Automations)\n" +
      "- Automations: `automation_list`, `automation_create`, `automation_trigger`, `automation_toggle`, `automation_delete` (manage recurring scheduled background cron tasks and agent runs).\n" +
      "- Generative UI: `generative_ui_template` (starter HTML/Tailwind snippets for a widget the files tool then writes).\n" +
      "- Customizations: `customizations_list`, `customizations_create_skill`, `customizations_create_rule` (manage on-demand skills, project rules, and discovery hierarchy).\n" +
      "- Workflows: `workflows_scan`, `workflows_migrate` (scan legacy workflow files and automatically migrate them to modern skills).\n" +
      "- Plugins: `plugins_list`, `plugins_bundle`, `plugins_toggle` (bundle and manage multi-component plugins)."
    );
  }

  parts.push(capabilities.join("\n\n"));

  // How a task is run and reported, so the user can review the plan before and the outcome after.
  parts.push(
    "### Working method\n" +
    (input.planApproval
      ? "- Before changing any file or running any command that changes state, call `multi_step` with your plan and stop: reply with the plan and the sentence \"Reply 'go' to proceed, or tell me what to change.\" Do not act until the user says so. Reading and searching are fine before the plan.\n"
      : "- For a task with several steps, call `multi_step` first with the plan, keep it updated as you go, and use one step at a time.\n") +
    "- When a task that changed files or ran commands is done, end with a short summary under the heading \"## Summary\": what changed (files), how you checked it, and anything left for the user. Skip the heading for questions and small answers."
  );

  if (input.context?.trim()) {
    parts.push(`### Relevant Knowledge & Context\n${input.context.trim()}`);
  }

  const modeNote = modeInstructions(input.mode);
  if (modeNote) parts.push(modeNote);
  return parts.join("\n\n");
}

export function toolCalls(body: Record<string, unknown>): ToolCall[] {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const message = (choices[0] as { message?: { tool_calls?: unknown[] } } | undefined)?.message;
  const calls = message?.tool_calls ?? [];
  return calls.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as { function?: { name?: string; arguments?: string }; thoughtSignature?: string };
    const fn = record.function;
    if (!fn?.name) return [];
    let args: Record<string, unknown> = {};
    try {
      args = fn.arguments ? (JSON.parse(fn.arguments) as Record<string, unknown>) : {};
    } catch {
      args = {};
    }
    return [{ name: fn.name, arguments: args, thoughtSignature: record.thoughtSignature }];
  });
}

export function textOf(body: Record<string, unknown>): string {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const message = (choices[0] as { message?: { content?: string } } | undefined)?.message;
  return message?.content ?? "";
}

export function thinkingOf(body: Record<string, unknown>): string {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const message = (choices[0] as { message?: { thinking?: string } } | undefined)?.message;
  return message?.thinking?.trim() ?? "";
}

export function joinThinking(current: string | undefined, next: string): string {
  const extra = next.trim();
  if (!extra) return current ?? "";
  if (!current?.trim()) return extra;
  if (current.includes(extra)) return current;
  return `${current.trim()}\n\n${extra}`;
}

