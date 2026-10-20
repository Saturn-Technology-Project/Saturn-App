import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { query, type CanUseTool, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { HttpError } from "../domain/errors.js";
import { newId } from "../domain/ids.js";
import type { Agent, GroupAutonomy, ModelConnection, Run, RunAction } from "../domain/model.js";
import { errorText, logger } from "../infrastructure/logger.js";
import { isSensitiveOperation } from "../domain/policies.js";
import { saveSession, savedSession } from "./agent-sessions.js";
import type { RuntimeKernel } from "./kernel.js";

const exec = promisify(execFile);

/**
 * Credentials that outrank the user's own `claude` login (Claude Code's documented order). They are removed
 * from the SDK's environment so a stray API key or cloud setting can never take over a subscription session.
 */
const CREDENTIAL_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

/** Tools that only read; they run without asking. Everything else (edits, Bash, MCP) waits for the user. */
const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "TodoWrite", "Task", "ExitPlanMode"]);
/** Tools that edit one file, with the input field naming it; their edits get a checkpoint for review. */
const FILE_TOOLS: Record<string, string> = { Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };
/** No general network tools (see the Claude Code architecture doc). */
const DISALLOWED_TOOLS = ["WebSearch", "WebFetch"];

export type ClaudeCodeStatus = {
  loggedIn: boolean;
  authMethod: string;
  email?: string;
  subscriptionType?: string;
  /** Paste into a terminal once: the official program signs in through the browser and keeps the credential. */
  loginCommand: string;
  configDir: string;
  error?: string;
};

/**
 * Claude Code models: Saturn's local backend drives the official Claude Agent SDK, which runs the official
 * `claude` program; that program alone reads the user's login and talks to Anthropic. Saturn never reads,
 * copies or passes a credential. Its part is the guard rails: a clean environment, a working directory limited
 * to the chat's project folder, and an approval for every tool that is not read-only.
 */
export class ClaudeCodeService {
  /** Approvals waiting on the user, by `${runId}:${actionId}`. */
  private readonly pending = new Map<string, (allow: boolean) => void>();

  constructor(private readonly kernel: RuntimeKernel) {}

  /** Claude Code's own config directory for Saturn, so this login stays apart from the user's other Claude apps. */
  configDir(): string {
    return path.join(this.kernel.store.root, "claude");
  }

  /** The `claude` program bundled with the SDK. */
  cliPath(): string {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    return path.join(path.dirname(manifest), process.platform === "win32" ? "claude.exe" : "claude");
  }

  /** The SDK's environment: the runtime's own, minus every credential that outranks the user's login. */
  environment(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      // ELECTRON_* belong to the packaged runtime itself; commands the agent runs must not inherit them.
      if (value !== undefined && !CREDENTIAL_VARIABLES.includes(key) && !key.startsWith("ELECTRON_")) env[key] = value;
    }
    env.CLAUDE_CONFIG_DIR = this.configDir();
    return env;
  }

  /** Asks the official program whether it is signed in; it reads the credential, Saturn only reads its answer. */
  async status(): Promise<ClaudeCodeStatus> {
    await mkdir(this.configDir(), { recursive: true, mode: 0o700 });
    let cli: string;
    try {
      cli = this.cliPath();
    } catch {
      return { loggedIn: false, authMethod: "none", loginCommand: "", configDir: this.configDir(), error: "The Claude Code program is missing from this Saturn install." };
    }
    // The SDK's bundled `claude` is headless (a bare start waits for a --print prompt), so sign-in is its
    // `auth login` subcommand: the Claude-subscription flow in the browser.
    const loginCommand = `CLAUDE_CONFIG_DIR=${shellQuote(this.configDir())} ${shellQuote(cli)} auth login --claudeai`;
    try {
      // A signed-out `claude auth status` still prints its JSON, but exits non-zero.
      const stdout = await exec(cli, ["auth", "status", "--json"], { env: this.environment(), timeout: 20_000 }).then(
        (result) => result.stdout,
        (error: { stdout?: string }) => {
          if (error.stdout?.trim().startsWith("{")) return error.stdout;
          throw error;
        },
      );
      const answer = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; email?: string; subscriptionType?: string };
      return {
        loggedIn: answer.loggedIn === true,
        authMethod: answer.authMethod ?? "none",
        ...(answer.email ? { email: answer.email } : {}),
        ...(answer.subscriptionType ? { subscriptionType: answer.subscriptionType } : {}),
        loginCommand,
        configDir: this.configDir(),
      };
    } catch (error) {
      return { loggedIn: false, authMethod: "none", loginCommand, configDir: this.configDir(), error: `Could not ask Claude Code for its login: ${errorText(error)}` };
    }
  }

  /**
   * Signs Saturn's Claude Code out with the official program's `auth logout`, which removes the credential it
   * stored for this config directory. The user's other Claude apps keep their own logins.
   */
  async logout(): Promise<ClaudeCodeStatus> {
    let cli: string;
    try {
      cli = this.cliPath();
    } catch {
      throw new HttpError(500, "The Claude Code program is missing from this Saturn install.");
    }
    try {
      await exec(cli, ["auth", "logout"], { env: this.environment(), timeout: 20_000 });
    } catch (error) {
      throw new HttpError(502, `Claude Code could not sign out: ${errorText(error)}`);
    }
    this.kernel.log("admin", "info", "Signed Claude Code out");
    return await this.status();
  }

  /** True while the SDK holds this tool call open waiting for the user's answer. */
  waiting(runId: string, actionId: string): boolean {
    return this.pending.has(`${runId}:${actionId}`);
  }

  /** The user's answer to an approval card. */
  decide(runId: string, actionId: string, allow: boolean): void {
    const resolve = this.pending.get(`${runId}:${actionId}`);
    if (!resolve) throw new HttpError(409, "This approval is no longer waiting");
    resolve(allow);
  }

  /** One turn of a Claude Code chat; the SDK session is resumed from the chat's last turn. */
  async run(runId: string, generation: number, agent: Agent, model: ModelConnection, signal: AbortSignal): Promise<void> {
    const run = this.kernel.getRun(runId);
    const thread = run.threadId ? (this.kernel.store.state.threads ?? []).find((item) => item.id === run.threadId) : undefined;
    const workdir = thread?.projectId ? this.kernel.projects.workdir(thread.projectId) : path.join(this.kernel.store.root, "workspace");
    await mkdir(workdir, { recursive: true });
    await mkdir(this.configDir(), { recursive: true, mode: 0o700 });

    const resumeId = savedSession(this.kernel, run, "claudeSessionId");
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    signal.addEventListener("abort", abort, { once: true });

    // Edits in a project folder keep their originals, so the chat can show a diff and revert them.
    const checkpoint = thread?.projectId ? this.kernel.checkpoints.forRun(runId, workdir) : undefined;
    const edited = new Map<string, string>();
    const actions: RunAction[] = [];
    let output = "";
    const thoughts: { text: string; seconds: number; at: number }[] = [];
    const save = (patch: (current: Run) => void) =>
      this.kernel.store.update((state) => {
        const current = state.runs.find((item) => item.id === runId);
        if (!current || (current.generation ?? 0) !== generation) return;
        current.actions = actions.map((action) => ({ ...action }));
        current.output = output;
        current.thoughts = [...thoughts];
        patch(current);
      });
    const actionFor = (id: string, toolId: string, input: Record<string, unknown>): RunAction => {
      let action = actions.find((item) => item.id === id);
      if (!action) {
        action = { id, toolId, arguments: input, status: "completed" };
        actions.push(action);
      }
      return action;
    };

    // Outside a group every tool that is not read-only asks; a group can let its agents work on their own.
    const group = run.groupId ? (this.kernel.store.state.groups ?? []).find((item) => item.id === run.groupId) : undefined;
    const mode: GroupAutonomy = group?.autonomy ?? "review";
    // Before an edit runs, keep the file's original for the diff and revert.
    const keepOriginal = async (actionId: string, toolName: string, input: Record<string, unknown>) => {
      const requested = FILE_TOOLS[toolName] ? input[FILE_TOOLS[toolName]] : undefined;
      if (checkpoint && typeof requested === "string") {
        const target = path.resolve(workdir, requested);
        await checkpoint.before(target);
        edited.set(actionId, target);
      }
    };

    const canUseTool: CanUseTool = async (toolName, input, options) => {
      if (READ_ONLY_TOOLS.has(toolName)) return { behavior: "allow", updatedInput: input };
      if (mode === "bypass" || (mode === "default" && !risky(toolName, input, workdir))) {
        const action = actionFor(options.toolUseID || newId("act"), toolName, input);
        await keepOriginal(action.id, toolName, input);
        return { behavior: "allow", updatedInput: input };
      }
      const action = actionFor(options.toolUseID || newId("act"), toolName, input);
      action.status = "waiting_approval";
      action.reason = `${toolName} needs your approval`;
      await save((current) => {
        current.status = "waiting_approval";
      });
      this.kernel.log("agent", "info", `${agent.name} ${toolName} waiting_approval`, { "saturn.run.id": runId });
      const allow = await new Promise<boolean>((resolve) => {
        const key = `${runId}:${action.id}`;
        this.pending.set(key, resolve);
        options.signal.addEventListener("abort", () => resolve(false), { once: true });
      }).finally(() => this.pending.delete(`${runId}:${action.id}`));
      action.status = allow ? "completed" : "denied";
      action.reason = allow ? undefined : "Denied by the user";
      if (allow) await keepOriginal(action.id, toolName, input);
      await save((current) => {
        current.status = "running";
      });
      return allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "The user denied this action." };
    };

    const options: Options = {
      cwd: workdir,
      env: this.environment(),
      pathToClaudeCodeExecutable: this.cliPath(),
      settingSources: [],
      model: model.model,
      ...(model.effort ? { effort: model.effort } : {}),
      ...(resumeId ? { resume: resumeId } : {}),
      permissionMode: "default",
      canUseTool,
      disallowedTools: DISALLOWED_TOOLS,
      abortController,
      systemPrompt: agent.instructions.trim()
        ? { type: "preset", preset: "claude_code", append: agent.instructions.trim() }
        : { type: "preset", preset: "claude_code" },
    };

    this.kernel.log("agent", "info", `${agent.name} asked Claude Code (${model.model}${model.effort ? `, ${model.effort} effort` : ""}) in ${workdir}`, { "saturn.run.id": runId });
    const startedAt = Date.now();
    let sessionId = resumeId;
    let failure: string | undefined;
    try {
      for await (const message of query({ prompt: run.input, options })) {
        if (!this.kernel.alive(runId, generation)) break;
        sessionId = sessionOf(message) ?? sessionId;
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text" && block.text.trim()) output = output ? `${output}\n\n${block.text}` : block.text;
            if (block.type === "thinking" && block.thinking.trim()) thoughts.push({ text: block.thinking, seconds: 0, at: actions.length });
            if (block.type === "tool_use") actionFor(block.id, block.name, (block.input ?? {}) as Record<string, unknown>);
          }
          await save(() => undefined);
        } else if (message.type === "user" && Array.isArray(message.message.content)) {
          for (const block of message.message.content) {
            if (typeof block !== "object" || block.type !== "tool_result") continue;
            const target = edited.get(block.tool_use_id);
            if (target && checkpoint) {
              edited.delete(block.tool_use_id);
              await checkpoint.after(target);
            }
            const action = actions.find((item) => item.id === block.tool_use_id);
            if (!action || action.status === "denied") continue;
            action.status = block.is_error ? "failed" : "completed";
            action.result = clipResult(block.content);
            if (block.is_error) action.reason = clipText(textOf(block.content), 300);
          }
          await save(() => undefined);
        } else if (message.type === "result") {
          await this.recordUsage(runId, agent, model, message);
          if (message.subtype === "success" && !message.is_error) {
            if (message.result.trim()) output = message.result;
          } else {
            const errors = "errors" in message && Array.isArray(message.errors) ? message.errors.join("; ") : "";
            failure = ("result" in message && typeof message.result === "string" && message.result) || errors || message.subtype;
          }
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      failure = errorText(error);
    } finally {
      signal.removeEventListener("abort", abort);
      // An edit whose result never arrived (stopped mid-tool) may still have written; record what is on disk.
      if (checkpoint) for (const target of edited.values()) await checkpoint.after(target).catch(() => undefined);
    }

    if (sessionId && sessionId !== resumeId) await saveSession(this.kernel, run, "claudeSessionId", sessionId);
    if (!this.kernel.alive(runId, generation)) return;
    const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
    if (failure) {
      const explained = /login|authenticat|oauth|api key|401/i.test(failure)
        ? "Claude Code isn't signed in for Saturn yet. In Settings → General → Claude Code, copy the login command and run it once in a terminal."
        : failure;
      await save((current) => {
        current.status = "failed";
        current.error = explained;
      });
      this.kernel.log("agent", "error", `${agent.name} failed in Claude Code after ${seconds}s: ${clipText(explained, 200)}`, { "saturn.run.id": runId });
      return;
    }
    await save((current) => {
      current.status = "completed";
      delete current.error;
    });
    this.kernel.log("agent", "info", `${agent.name} finished in Claude Code after ${seconds}s with ${actions.length} tool ${actions.length === 1 ? "call" : "calls"}`, { "saturn.run.id": runId });
  }

  /** Token counts from the SDK's result. Billing is the user's Claude plan, so no cost is recorded. */
  private async recordUsage(runId: string, agent: Agent, model: ModelConnection, message: Extract<SDKMessage, { type: "result" }>): Promise<void> {
    const usage = message.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
    if (!usage) return;
    await this.kernel.store
      .update((state) => {
        state.usage.unshift({
          id: newId("use"),
          runId,
          agentId: agent.id,
          agentName: agent.name,
          modelId: model.id,
          modelName: model.name,
          provider: model.provider,
          model: model.model,
          purpose: "run",
          inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
          outputTokens: usage.output_tokens ?? 0,
          inputRate: null,
          outputRate: null,
          pricing: "Claude plan",
          costUsd: null,
          createdAt: new Date().toISOString(),
        });
      })
      .catch((error: unknown) => logger.warn("usage", `Could not record Claude Code usage: ${errorText(error)}`));
  }
}

/** "Ask for risky actions": a destructive shell command, or an edit outside the working folder. */
function risky(toolName: string, input: Record<string, unknown>, workdir: string): boolean {
  if (toolName === "Bash") return isSensitiveOperation("code", { command: input.command });
  const requested = FILE_TOOLS[toolName] ? input[FILE_TOOLS[toolName]] : undefined;
  if (typeof requested === "string") {
    const relative = path.relative(workdir, path.resolve(workdir, requested));
    return relative.startsWith("..") || path.isAbsolute(relative);
  }
  return false;
}

function sessionOf(message: SDKMessage): string | undefined {
  return "session_id" in message && typeof message.session_id === "string" ? message.session_id : undefined;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "")).join("\n");
  }
  return "";
}

function clipText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Tool output kept on the run: the text, clipped so long file reads don't bloat state.json. */
function clipResult(content: unknown): unknown {
  return { output: clipText(textOf(content), 4000) };
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
