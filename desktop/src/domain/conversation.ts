import type { Agent, Autonomy, Model, Run, RunAction, RunThought } from "./model.js";

export type PlanStep = {
  step: string;
  status: "pending" | "in_progress" | "completed";
};

export type GuardrailModeId = "review" | "default" | "bypass";

export type GuardrailModeOption = {
  id: GuardrailModeId;
  title: string;
  badge?: string;
  description: string;
  icon: "eye" | "lock" | "star" | "exclamation";
};

export const GUARDRAIL_MODES: GuardrailModeOption[] = [
  {
    id: "review",
    title: "Request Review",
    description: "Every command requires approval.",
    icon: "eye",
  },
  {
    id: "default",
    title: "Default",
    description: "Ask before sensitive operations.",
    icon: "lock",
  },
  {
    id: "bypass",
    title: "Bypass",
    description: "Run all commands without restrictions.",
    icon: "exclamation",
  },
];

export function normalizeGuardrailMode(autonomy?: Autonomy): GuardrailModeId {
  if (autonomy === "bypass" || autonomy === "turbo" || autonomy === "fully_autonomous") return "bypass";
  if (autonomy === "review" || autonomy === "suggest_only") return "review";
  return "default";
}

export const AUTONOMY_OPTIONS: { id: Autonomy; short: string; label: string; hint: string }[] = [
  { id: "review", short: "Review", label: "Request Review", hint: "Every command requires approval" },
  { id: "default", short: "Default", label: "Default", hint: "Ask before sensitive operations" },
  { id: "bypass", short: "Bypass", label: "Bypass", hint: "Run all commands without restrictions" },
  { id: "turbo", short: "Bypass", label: "Bypass", hint: "Run all commands without restrictions" },
  { id: "execute_when_allowed", short: "Default", label: "Default", hint: "Ask before sensitive operations" },
  { id: "fully_autonomous", short: "Bypass", label: "Bypass", hint: "Run all commands without restrictions" },
  { id: "suggest_only", short: "Review", label: "Request Review", hint: "Every command requires approval" },
];

/** A sleeping run is still in progress: it resumes by itself, and the composer offers Stop meanwhile. */
export function isBusy(run: Run | undefined): boolean {
  return run?.status === "running" || run?.status === "queued" || run?.status === "sleeping";
}

/** "4:05" until `at`, or "now" once it has passed. */
export function countdown(at: string, now = Date.now()): string {
  const left = Math.max(0, Math.ceil((Date.parse(at) - now) / 1000));
  if (!left) return "now";
  const hours = Math.floor(left / 3600);
  const minutes = Math.floor((left % 3600) / 60);
  const seconds = String(left % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

export function visibleThread(thread: Run[], editingId: string | null): { visible: Run[]; editIndex: number } {
  const editIndex = editingId ? thread.findIndex((item) => item.id === editingId) : -1;
  return { visible: editIndex >= 0 ? thread.slice(0, editIndex + 1) : thread, editIndex };
}

export function upsertRun(list: Run[], run: Run): Run[] {
  return list.some((item) => item.id === run.id) ? list.map((item) => (item.id === run.id ? run : item)) : [...list, run];
}

export function replaceRevised(list: Run[], run: Run, removed: string[]): Run[] {
  return upsertRun(list.filter((item) => !removed.includes(item.id)), run);
}

export function modelLabel(models: Model[], agent: Agent | null): string {
  const model = models.find((item) => item.id === agent?.modelConnectionId);
  if (!model) return "None";
  if (model.provider === "lmstudio") return model.name;
  return model.hasSecret ? model.name : `${model.name} · no key`;
}

export function autonomyShortLabel(autonomy?: Autonomy): string {
  const mode = normalizeGuardrailMode(autonomy);
  switch (mode) {
    case "bypass":
      return "Bypass";
    case "review":
      return "Review";
    case "default":
    default:
      return "Default";
  }
}

export function actionTitle(toolId: string): string {
  switch (toolId) {
    case "files":
      return "Workspace Files";
    case "code":
      return "Terminal Command";
    case "web":
      return "Web Fetch";
    case "multi_step":
      return "Task Plan";
    case "mcp":
      return "MCP Bridge";
    case "computer_screenshot":
      return "Screen Capture";
    case "computer_click":
      return "Mouse Click";
    case "computer_move":
      return "Mouse Move";
    case "computer_drag":
      return "Mouse Drag";
    case "computer_type":
      return "Type Text";
    case "computer_key":
      return "Press Key";
    case "computer_scroll":
      return "Scroll Window";
    case "computer_wait":
      return "Wait";
    case "computer_check_permissions":
      return "Check Permissions";
    case "computer_start_control":
      return "Take Control";
    case "computer_release_control":
      return "Release Control";
    case "computer_apps":
      return "List Applications";
    case "computer_resolve_app":
      return "Resolve Application";
    case "computer_app_state":
      return "Application UI State";
    case "computer_set_value":
      return "Set Value";
    case "computer_app_action":
      return "App Action";
    case "get_repository":
      return "Get Repository";
    case "list_repositories":
      return "List Repositories";
    case "list_namespaces":
      return "List Namespaces";
    case "get_file_contents":
      return "Read File";
    case "get_git_tree":
      return "Git Tree";
    case "grep_contents":
      return "Grep Code";
    case "list_branches":
      return "List Branches";
    case "list_commits":
      return "List Commits";
    case "commit_read":
      return "Read Commit";
    case "compare_commits":
      return "Compare Commits";
    case "list_pull_requests":
      return "List Pull Requests";
    case "pull_request_read":
      return "Read Pull Request";
    case "create_pull_request":
      return "Create Pull Request";
    case "update_pull_request":
      return "Update Pull Request";
    case "merge_pull_request":
      return "Merge Pull Request";
    default:
      return toolId.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

export function actionSummary(action: RunAction): string {
  const args = action.arguments ?? {};
  if (action.toolId === "files") {
    const mode = typeof args.action === "string" ? args.action : "inspect";
    const target = typeof args.path === "string" ? args.path : mode === "patch" ? "apply patch" : "workspace";
    return `${mode} · ${target}`;
  }
  if (action.toolId === "code") {
    const cmd = typeof args.command === "string" ? args.command : "";
    return cmd ? `$ ${cmd}` : "shell command";
  }
  if (action.toolId === "web") {
    return typeof args.url === "string" ? args.url : "fetch page";
  }
  if (action.toolId === "multi_step") {
    const steps = Array.isArray(args.steps) ? args.steps : [];
    return `${steps.length} step${steps.length === 1 ? "" : "s"}`;
  }
  if (action.toolId === "mcp") {
    return typeof args.toolId === "string" ? args.toolId : "external tool";
  }
  if (action.toolId === "computer_screenshot") {
    return args.target ? "window screenshot" : "primary display";
  }
  if (action.toolId === "computer_click") {
    return `(${args.x ?? 0}, ${args.y ?? 0})`;
  }
  if (action.toolId === "computer_type") {
    const text = typeof args.text === "string" ? args.text : "";
    return text.length > 30 ? `"${text.slice(0, 30)}…"` : `"${text}"`;
  }
  if (action.toolId === "computer_key") {
    return String(args.key || "key");
  }
  if (action.toolId === "computer_resolve_app") {
    return String(args.name || args.bundle_id || "resolve");
  }
  if (action.toolId === "create_pull_request") {
    return String(args.title || "new PR");
  }
  if (action.toolId === "get_file_contents") {
    return String(args.path || "");
  }
  if (action.toolId === "grep_contents") {
    return `/${args.query || ""}/`;
  }
  if (action.toolId === "automation_create") {
    return String(args.name || "new automation");
  }
  if (action.toolId === "generative_ui_render") {
    return String(args.title || "render widget");
  }
  if (action.toolId === "customizations_create_skill") {
    return String(args.name || "new skill");
  }
  if (action.toolId === "customizations_create_rule") {
    return String(args.name || "new rule");
  }
  if (action.toolId === "ui_navigation_surface_pill") {
    return String(args.label || "navigation pill");
  }
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  const first = args[keys[0]!];
  if (typeof first === "string" && first.length <= 60) return `${keys[0]}: ${first}`;
  return keys.join(", ");
}

export function extractPlanSteps(actions: RunAction[]): PlanStep[] {
  const planActions = actions.filter((item) => item.toolId === "multi_step");
  const last = planActions.at(-1);
  if (!last) return [];
  const source = (last.result as { steps?: unknown } | undefined)?.steps ?? last.arguments?.steps;
  if (!Array.isArray(source)) return [];
  return source
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item): PlanStep => ({
      step: String(item.step ?? ""),
      status:
        item.status === "completed" || item.status === "in_progress"
          ? item.status
          : "pending",
    }))
    .filter((item) => item.step.length > 0);
}

export function formatPayload(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export type RunStep =
  | { kind: "thought"; key: string; thought: RunThought }
  | { kind: "action"; key: string; action: RunAction };

/**
 * The run as one ordered list: each model call's reasoning sits right before the tool calls it made.
 * Runs saved before per-call thoughts existed show their whole reasoning as a single thought up front.
 */
export function runSteps(run: Run): RunStep[] {
  const thoughts: RunThought[] = run.thoughts?.length
    ? [...run.thoughts].sort((a, b) => a.at - b.at)
    : run.thinking?.trim()
      ? [{ text: run.thinking.trim(), seconds: 0, at: 0 }]
      : [];
  const steps: RunStep[] = [];
  let next = 0;
  const flush = (upTo: number) => {
    while (next < thoughts.length && thoughts[next]!.at <= upTo) {
      steps.push({ kind: "thought", key: `t${next}`, thought: thoughts[next]! });
      next += 1;
    }
  };
  run.actions.forEach((action, index) => {
    flush(index);
    steps.push({ kind: "action", key: action.id ?? `a${index}`, action });
  });
  flush(Number.POSITIVE_INFINITY);
  return steps;
}

export type ActionLine = {
  verb: string;
  target: string;
  /** Short file type badge such as "TS", when the target is a file. */
  badge?: string;
  /** Muted text after the target, such as the line range read ("#L1-94"). */
  suffix?: string;
  /** Show the target in monospace, e.g. a shell command. */
  mono?: boolean;
};

export function actionLine(action: RunAction): ActionLine {
  const args = action.arguments ?? {};
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  if (action.toolId === "files") {
    const mode = str(args.action) || "list";
    const target = str(args.path);
    if (mode === "read") return { verb: "Analyzed", target: target || "file", badge: fileBadge(target), suffix: readRange(action) };
    if (mode === "write") return { verb: "Edited", target: target || "file", badge: fileBadge(target) };
    if (mode === "patch") {
      const applied = (action.result as { applied?: { path?: string }[] } | undefined)?.applied ?? [];
      const first = applied[0]?.path ?? "";
      const more = applied.length > 1 ? ` +${applied.length - 1}` : "";
      return { verb: "Edited", target: first ? `${first}${more}` : "files", badge: fileBadge(first) };
    }
    return { verb: "Listed", target: target || "workspace" };
  }
  if (action.toolId === "code") return { verb: args.background === true ? "Started" : "Ran", target: str(args.command) || "command", mono: true };
  if (action.toolId === "code_output") return { verb: "Read output of", target: str(args.jobId) || "background command", mono: true };
  if (action.toolId === "code_stop") return { verb: "Stopped", target: str(args.jobId) || "background command", mono: true };
  if (action.toolId === "delegate") {
    const count = (Array.isArray(args.tasks) ? args.tasks.length : 0) + (str(args.task) ? 1 : 0);
    return { verb: "Delegated", target: count > 1 ? `${count} tasks to sub-agents` : str(args.task) || "a task to a sub-agent" };
  }
  if (action.toolId === "web") return { verb: "Read", target: shortUrl(str(args.url)) || "web page" };
  if (action.toolId === "multi_step") {
    const steps = Array.isArray(args.steps) ? args.steps.length : 0;
    return { verb: "Updated plan", target: steps ? `${steps} step${steps === 1 ? "" : "s"}` : "" };
  }
  if (action.toolId === "mcp") return { verb: "Called", target: str(args.tool) || str(args.toolId) || "MCP tool", mono: true };
  // Claude Code's own tools (claude-code models), named by the SDK.
  const file = str(args.file_path) || str(args.notebook_path);
  if (file && ["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(action.toolId)) {
    const name = projectPath(file);
    return { verb: action.toolId === "Write" ? "Wrote" : "Edited", target: name, badge: fileBadge(name) };
  }
  if (file && action.toolId === "Read") return { verb: "Analyzed", target: projectPath(file), badge: fileBadge(file) };
  if (action.toolId === "Bash") return { verb: "Ran", target: str(args.command) || "command", mono: true };
  if (action.toolId === "Grep" || action.toolId === "Glob") return { verb: "Searched", target: str(args.pattern) || "files", mono: true };
  return { verb: "Called", target: action.toolId, mono: true };
}

export function formatDuration(seconds: number): string {
  const whole = Math.max(1, Math.round(seconds));
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/** "#L1-94" for a file read: the requested window, capped at the file's length. */
function readRange(action: RunAction): string | undefined {
  const result = action.result as { offset?: number; lines?: number } | undefined;
  const total = typeof result?.lines === "number" ? result.lines : undefined;
  if (total === undefined || total === 0) return undefined;
  const args = action.arguments ?? {};
  const start = typeof result?.offset === "number" ? result.offset : 1;
  const limit = typeof args.limit === "number" ? args.limit : Number(args.limit);
  const end = Number.isFinite(limit) && limit > 0 ? Math.min(total, start + limit - 1) : total;
  return end > start ? `#L${start}-${end}` : `#L${start}`;
}

/** The last two segments of an absolute path, which is how Claude Code names files. */
function projectPath(file: string): string {
  return file.startsWith("/") ? file.split("/").slice(-2).join("/") : file;
}

function fileBadge(path: string): string | undefined {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return undefined;
  return name.slice(dot + 1).slice(0, 4).toUpperCase();
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.host}${path}`;
  } catch {
    return url;
  }
}
