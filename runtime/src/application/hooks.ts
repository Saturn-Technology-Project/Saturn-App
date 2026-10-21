import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../domain/errors.js";
import type { Agent, Run, RunAction } from "../domain/model.js";
import { commandEnv, shellInvocation } from "../infrastructure/shell.js";
import type { RuntimeKernel } from "./kernel.js";

/**
 * Hooks: commands that run around an agent's tool calls and at the end of its turn, the way Claude Code's do.
 *
 * - `pre_tool` runs before a call. Exit 2 blocks it (stderr goes to the model); stdout JSON
 *   `{ "decision": "allow" | "ask" | "deny", "reason": "…" }` can skip the approval card, ask for one, or refuse.
 * - `post_tool` runs after a call. Exit 2 adds its stderr to the result as feedback for the model.
 * - `stop` runs when a turn finishes. Exit 2 sends its stderr back to the agent as a follow-up (at most twice per
 *   message from the user, like the check command), so a hook can insist on tests passing or a format being met.
 *
 * Each hook gets JSON on stdin (the event, the run, the agent, the tool, its arguments and result, the turn's
 * answer) and runs in the chat's working folder. The user's hooks (Settings → Hooks) run as set. A project's hooks
 * (`.saturn/hooks.json`, and the hooks of its `.claude/settings.json`) come with the folder, so they run only once
 * the user has allowed that exact set; any change asks again.
 */

export type HookEvent = "pre_tool" | "post_tool" | "stop";
export const HOOK_EVENTS: HookEvent[] = ["pre_tool", "post_tool", "stop"];

export type Hook = {
  event: HookEvent;
  /** A tool id or glob (`code`, `files`, `github_*`); empty matches every tool. Ignored for `stop`. */
  matcher?: string;
  command: string;
  timeoutMs?: number;
};

export type HookSource = "user" | "project-file" | "claude-file" | "plugin";

export type HookSet = { source: HookSource; path?: string; hooks: Hook[]; fingerprint?: string; approved: boolean };

export type HookOutcome = { blocked?: string; decision?: "allow" | "ask" | "deny"; reason?: string; feedback?: string[] };

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_LIMIT = 4000;
export const HOOKS_FILE = ".saturn/hooks.json";
const CLAUDE_SETTINGS_FILE = ".claude/settings.json";

/** Claude Code's event and tool names, for the hooks of a `.claude/settings.json`. */
const CLAUDE_EVENTS: Record<string, HookEvent> = { PreToolUse: "pre_tool", PostToolUse: "post_tool", Stop: "stop" };
const CLAUDE_TOOLS: Record<string, string> = { Bash: "code", Read: "files", Edit: "files", Write: "files", MultiEdit: "files", Glob: "files", Grep: "files", WebFetch: "web", WebSearch: "web" };

export function isHook(value: unknown): value is Hook {
  const hook = value as Hook;
  return Boolean(hook) && HOOK_EVENTS.includes(hook.event) && typeof hook.command === "string" && hook.command.trim() !== "" && (hook.matcher === undefined || typeof hook.matcher === "string");
}

export function hooksFingerprint(hooks: Hook[]): string {
  return createHash("sha256").update(JSON.stringify(hooks.map((hook) => [hook.event, hook.matcher ?? "", hook.command, hook.timeoutMs ?? 0]))).digest("hex");
}

/** Whether a hook's matcher covers a tool: exact, a `*` glob, or a `|` list (Claude Code's `Edit|Write`). */
export function matchesTool(matcher: string | undefined, toolId: string): boolean {
  const text = (matcher ?? "").trim();
  if (!text || text === "*") return true;
  return text.split("|").some((part) => {
    const glob = part.trim();
    if (!glob.includes("*")) return glob === toolId;
    return new RegExp(`^${glob.replace(/[.+^${}()[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(toolId);
  });
}

/** Translates the `hooks` of a Claude Code settings file; matchers name Claude Code's tools, mapped to Saturn's. */
export function fromClaudeHooks(value: unknown): Hook[] {
  const hooks: Hook[] = [];
  if (!value || typeof value !== "object") return hooks;
  for (const [name, groups] of Object.entries(value as Record<string, unknown>)) {
    const event = CLAUDE_EVENTS[name];
    if (!event || !Array.isArray(groups)) continue;
    for (const group of groups as { matcher?: unknown; hooks?: unknown }[]) {
      const matcher = typeof group?.matcher === "string" ? group.matcher.split("|").map((tool) => CLAUDE_TOOLS[tool.trim()] ?? tool.trim()).filter((tool, index, all) => all.indexOf(tool) === index).join("|") : undefined;
      for (const entry of Array.isArray(group?.hooks) ? (group.hooks as { type?: unknown; command?: unknown; timeout?: unknown }[]) : []) {
        if (entry?.type !== "command" || typeof entry.command !== "string" || !entry.command.trim()) continue;
        hooks.push({ event, ...(matcher ? { matcher } : {}), command: entry.command, ...(typeof entry.timeout === "number" ? { timeoutMs: entry.timeout * 1000 } : {}) });
      }
    }
  }
  return hooks;
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

type RunHookResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

function runHook(hook: Hook, input: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<RunHookResult> {
  return new Promise((resolve) => {
    const shell = shellInvocation(hook.command, "/bin/sh");
    const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, hook.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    const child = spawn(shell.file, shell.args, {
      cwd,
      env: { ...commandEnv(), SATURN_HOOK_EVENT: hook.event, SATURN_PROJECT_DIR: cwd, CLAUDE_PROJECT_DIR: cwd },
      windowsVerbatimArguments: shell.windowsVerbatimArguments,
      stdio: ["pipe", "pipe", "pipe"],
      signal,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString("utf8")).slice(-OUTPUT_LIMIT * 2); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-OUTPUT_LIMIT * 2); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim().slice(-OUTPUT_LIMIT), stderr: stderr.trim().slice(-OUTPUT_LIMIT), timedOut });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(input));
  });
}

export class HookService {
  constructor(private readonly kernel: RuntimeKernel) {}

  /** Every hook set that applies in a project (or only the user's, outside one), approved or not. */
  async sets(projectId?: string): Promise<HookSet[]> {
    const sets: HookSet[] = [{ source: "user", hooks: this.kernel.store.state.settings.hooks ?? [], approved: true }];
    // The plugins that are on: their hooks run once the user allowed that exact set (Settings → Plugins).
    for (const plugin of await this.kernel.plugins.hookSets()) sets.push({ source: "plugin", path: plugin.name, hooks: plugin.hooks, fingerprint: plugin.fingerprint, approved: plugin.approved });
    const project = projectId ? (this.kernel.store.state.projects ?? []).find((item) => item.id === projectId) : undefined;
    if (!project) return sets;
    const saturn = await readJson(path.join(project.path, HOOKS_FILE));
    const own = Array.isArray(saturn?.hooks) ? saturn.hooks.filter(isHook).map((hook) => ({ event: hook.event, ...(hook.matcher ? { matcher: hook.matcher } : {}), command: hook.command, ...(hook.timeoutMs ? { timeoutMs: hook.timeoutMs } : {}) })) : [];
    const claude = fromClaudeHooks((await readJson(path.join(project.path, CLAUDE_SETTINGS_FILE)))?.hooks);
    for (const [source, file, hooks] of [["project-file", HOOKS_FILE, own], ["claude-file", CLAUDE_SETTINGS_FILE, claude]] as const) {
      if (!hooks.length) continue;
      const fingerprint = hooksFingerprint(hooks);
      sets.push({ source, path: file, hooks, fingerprint, approved: project.approvedHooks?.[file] === fingerprint });
    }
    return sets;
  }

  /** The user allows a project file's hooks: only the exact set they saw, named by its fingerprint. */
  async approve(projectId: string, file: string, fingerprint: string): Promise<HookSet[]> {
    const current = (await this.sets(projectId)).find((set) => set.path === file);
    if (!current) throw new HttpError(404, `${file} has no hooks`);
    if (current.fingerprint !== fingerprint) throw new HttpError(409, `The hooks in ${file} changed since you looked; review them again.`);
    await this.kernel.store.update((state) => {
      const project = (state.projects ?? []).find((item) => item.id === projectId);
      if (!project) throw new HttpError(404, "Project not found");
      project.approvedHooks = { ...(project.approvedHooks ?? {}), [file]: fingerprint };
    });
    this.kernel.log("runtime", "info", `Hooks in ${file} allowed for this project (${current.hooks.length})`);
    return this.sets(projectId);
  }

  async revoke(projectId: string, file: string): Promise<HookSet[]> {
    await this.kernel.store.update((state) => {
      const project = (state.projects ?? []).find((item) => item.id === projectId);
      if (project?.approvedHooks) delete project.approvedHooks[file];
    });
    return this.sets(projectId);
  }

  async setUserHooks(hooks: unknown): Promise<HookSet[]> {
    if (!Array.isArray(hooks) || !hooks.every(isHook)) throw new HttpError(400, "Each hook needs an event (pre_tool, post_tool or stop) and a command");
    await this.kernel.store.update((state) => {
      state.settings.hooks = hooks.map((hook) => ({ event: hook.event, ...(hook.matcher?.trim() ? { matcher: hook.matcher.trim() } : {}), command: hook.command.trim(), ...(hook.timeoutMs ? { timeoutMs: hook.timeoutMs } : {}) }));
    });
    return this.sets();
  }

  /** The hooks that run for an event in a run's chat: the user's, and the project's allowed sets. */
  private async active(run: Pick<Run, "threadId">, event: HookEvent, toolId?: string): Promise<{ hooks: Hook[]; cwd: string } | undefined> {
    const thread = run.threadId ? (this.kernel.store.state.threads ?? []).find((item) => item.id === run.threadId) : undefined;
    const sets = (await this.sets(thread?.projectId)).filter((set) => set.approved);
    const hooks = sets.flatMap((set) => set.hooks).filter((hook) => hook.event === event && (event === "stop" || matchesTool(hook.matcher, toolId ?? "")));
    if (!hooks.length) return undefined;
    let cwd = path.join(this.kernel.store.root, "workspace");
    try {
      cwd = this.kernel.projects.workdirFor(thread) ?? cwd;
    } catch {
      // The project lost its access: hooks run in the agent's own workspace.
    }
    return { hooks, cwd };
  }

  private payload(event: HookEvent, agent: Agent, run: Run, extra: Record<string, unknown>): Record<string, unknown> {
    return { event, hook_event_name: event, run_id: run.id, thread_id: run.threadId ?? null, agent: { id: agent.id, name: agent.name }, ...extra };
  }

  /** `pre_tool`: the strictest answer of the matching hooks (deny/block beats ask beats allow). */
  async beforeTool(agent: Agent, run: Run, toolId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<HookOutcome> {
    const active = await this.active(run, "pre_tool", toolId);
    if (!active) return {};
    const outcome: HookOutcome = {};
    for (const hook of active.hooks) {
      const result = await runHook(hook, this.payload("pre_tool", agent, run, { tool: toolId, tool_name: toolId, arguments: args, tool_input: args }), active.cwd, signal);
      if (result.code === 2) return { blocked: result.stderr || `Blocked by the hook: ${hook.command}` };
      if (result.code !== 0) {
        this.kernel.log("agent", "warning", `pre_tool hook failed (${result.timedOut ? "timed out" : `exit ${result.code ?? "?"}`}): ${hook.command}`, { "saturn.run.id": run.id });
        continue;
      }
      const answer = parseAnswer(result.stdout);
      if (answer.decision === "deny") return { blocked: answer.reason || `Denied by the hook: ${hook.command}` };
      if (answer.decision === "ask" || (answer.decision === "allow" && outcome.decision !== "ask")) {
        outcome.decision = answer.decision;
        outcome.reason = answer.reason || `${answer.decision === "ask" ? "Asked" : "Allowed"} by the hook: ${hook.command}`;
      }
    }
    return outcome;
  }

  /** `post_tool`: the feedback of every hook that exited 2, added to the result the model sees. */
  async afterTool(agent: Agent, run: Run, action: RunAction, signal?: AbortSignal): Promise<RunAction> {
    const active = await this.active(run, "post_tool", action.toolId);
    if (!active) return action;
    const feedback: string[] = [];
    for (const hook of active.hooks) {
      const result = await runHook(hook, this.payload("post_tool", agent, run, { tool: action.toolId, tool_name: action.toolId, arguments: action.arguments, tool_input: action.arguments, status: action.status, result: action.result ?? null, tool_response: action.result ?? null }), active.cwd, signal);
      if (result.code === 2 && result.stderr) feedback.push(result.stderr);
      else if (result.code !== 0) this.kernel.log("agent", "warning", `post_tool hook failed (${result.timedOut ? "timed out" : `exit ${result.code ?? "?"}`}): ${hook.command}`, { "saturn.run.id": run.id });
    }
    if (!feedback.length) return action;
    const note = feedback.join("\n\n");
    const result = action.result && typeof action.result === "object" && !Array.isArray(action.result)
      ? { ...(action.result as Record<string, unknown>), hookFeedback: note }
      : { result: action.result ?? null, hookFeedback: note };
    return { ...action, result };
  }

  /** `stop`: a hook that exits 2 sends its stderr back to the agent as an automatic follow-up. */
  async afterRun(run: Run): Promise<void> {
    if (run.status !== "completed" || run.groupId || run.parentRunId || !run.threadId) return;
    const agent = this.kernel.store.state.agents.find((item) => item.id === run.agentId);
    if (!agent) return;
    const active = await this.active(run, "stop");
    if (!active) return;
    const messages: string[] = [];
    for (const hook of active.hooks) {
      const result = await runHook(hook, this.payload("stop", agent, run, { input: run.input, output: run.output, changed_files: run.checkpoint?.files.filter((file) => file.before !== file.after).map((file) => file.path) ?? [] }), active.cwd);
      if (result.code === 2) messages.push(result.stderr || `The stop hook \`${hook.command}\` asked you to continue.`);
      else if (result.code !== 0) this.kernel.log("agent", "warning", `stop hook failed (${result.timedOut ? "timed out" : `exit ${result.code ?? "?"}`}): ${hook.command}`, { "saturn.run.id": run.id });
    }
    if (!messages.length) return;
    if (this.automaticRoundsSince(run.threadId) >= 2) {
      this.kernel.log("agent", "warning", "A stop hook still objects after 2 automatic rounds; leaving it to the user", { "saturn.run.id": run.id });
      return;
    }
    await this.kernel.runs.startRun(run.agentId, `A stop hook did not accept this turn:\n\n${messages.join("\n\n")}\n\nAddress it, then finish again.`, run.threadId, undefined, { automatic: true });
  }

  private automaticRoundsSince(threadId: string): number {
    let count = 0;
    for (const run of this.kernel.store.state.runs) {
      if (run.threadId !== threadId || run.parentRunId) continue;
      if (!run.automatic) break;
      count += 1;
    }
    return count;
  }
}

function parseAnswer(stdout: string): { decision?: "allow" | "ask" | "deny"; reason?: string } {
  const text = stdout.trim();
  if (!text.startsWith("{")) return {};
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    // Claude Code's shape too: { hookSpecificOutput: { permissionDecision, permissionDecisionReason } }.
    const specific = (json.hookSpecificOutput ?? {}) as Record<string, unknown>;
    const decision = json.decision ?? specific.permissionDecision;
    const reason = json.reason ?? specific.permissionDecisionReason;
    return {
      ...(decision === "allow" || decision === "ask" || decision === "deny" ? { decision } : decision === "block" ? { decision: "deny" as const } : {}),
      ...(typeof reason === "string" ? { reason } : {}),
    };
  } catch {
    return {};
  }
}
