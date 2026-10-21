import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Codex, type ThreadItem, type ThreadOptions, type Usage } from "@openai/codex-sdk";
import { HttpError } from "../domain/errors.js";
import { newId } from "../domain/ids.js";
import type { Agent, ModelConnection, Run, RunAction } from "../domain/model.js";
import { tokenMatches } from "../infrastructure/auth.js";
import { openInBrowser } from "../infrastructure/browser.js";
import { errorText, logger } from "../infrastructure/logger.js";
import { SKILLS_SERVER, bridgedTools, runtimeOrigin, type BridgedCall, type BridgedTool } from "./agent-skills.js";
import { saveSession, savedSession, turnContext, withKnowledge } from "./agent-sessions.js";
import { approvalMode } from "./claude-code.js";
import { imagePath } from "./run-images.js";
import { isReadOnlyCall, modeInstructions, readOnlyRefusal } from "../domain/policies.js";
import type { RuntimeKernel } from "./kernel.js";

const exec = promisify(execFile);

/**
 * Credentials that would take over from the user's own Codex login. They are removed from Codex's
 * environment so a stray API key can never bill the wrong account.
 */
const CREDENTIAL_VARIABLES = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"];
/** A sign-in nobody finishes is ended after this long (a device code expires after 15 minutes). */
const SIGN_IN_TIMEOUT_MS = 15 * 60_000;
/**
 * Carries the skills endpoint's token to Codex, which sends it as a bearer token. The name contains TOKEN, so
 * Codex's default shell environment policy keeps it out of the commands it runs.
 */
const SKILLS_TOKEN_VARIABLE = "SATURN_SKILLS_TOKEN";
/** The catalog's "use Codex's own default" model id. */
export const CODEX_DEFAULT_MODEL = "default";

export type CodexSignIn = {
  /** "device": open `url` and type `code`; "browser": the sign-in page opened, and Codex waits for its redirect. */
  mode: "device" | "browser";
  state: "starting" | "waiting" | "failed";
  url?: string;
  code?: string;
  error?: string;
};

export type CodexStatus = {
  loggedIn: boolean;
  /** "chatgpt" (the user's ChatGPT plan), "api-key", or "none". */
  authMethod: string;
  configDir: string;
  signIn?: CodexSignIn;
  error?: string;
  /** False when the program is not installed: Settings offers the download instead of the sign-in. */
  installed?: boolean;
};

/**
 * Codex models: Saturn's local backend drives the official Codex SDK, which runs the official `codex`
 * program; that program alone signs in, keeps the login (in Saturn's own CODEX_HOME) and talks to OpenAI.
 * Saturn never reads or passes a credential. Sign-in runs the program's own `codex login` and only relays
 * what it prints (the device code, or that the browser page opened) to Settings.
 */
export class CodexService {
  private signIn?: { child: ChildProcess; info: CodexSignIn; timer: NodeJS.Timeout };
  private lastSignIn?: CodexSignIn;
  /** Saturn skills endpoints open for running turns, by the token each turn holds. */
  private readonly bridges = new Map<string, { tools: BridgedTool[]; call: BridgedCall }>();
  /** Approvals waiting on the user, by `${runId}:${actionId}`. */
  private readonly pending = new Map<string, (allow: boolean) => void>();

  constructor(private readonly kernel: RuntimeKernel) {}

  /** Codex's home for Saturn, so this login stays apart from the user's own `codex` setup. */
  configDir(): string {
    return path.join(this.kernel.store.root, "codex");
  }

  /** The `codex` program: Saturn's download, a development checkout's SDK copy, or the user's own install. */
  cliPath(): string {
    return this.kernel.programs.path("codex");
  }

  /** Codex's environment: the runtime's own, minus every credential that outranks the user's login. */
  environment(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !CREDENTIAL_VARIABLES.includes(key) && !key.startsWith("ELECTRON_")) env[key] = value;
    }
    env.CODEX_HOME = this.configDir();
    return env;
  }

  private cli(): string {
    try {
      return this.cliPath();
    } catch {
      throw new HttpError(409, "Codex is not installed. Download it in Saturn Settings → General → Codex.");
    }
  }

  /** Asks the official program whether it is signed in; Saturn only reads its answer. */
  async status(): Promise<CodexStatus> {
    await mkdir(this.configDir(), { recursive: true, mode: 0o700 });
    const signIn = this.signIn?.info ?? this.lastSignIn;
    const base = { configDir: this.configDir(), ...(signIn ? { signIn } : {}) };
    let cli: string;
    try {
      cli = this.cliPath();
    } catch {
      return { loggedIn: false, authMethod: "none", ...base, installed: false };
    }
    // `codex login status` prints e.g. "Logged in using ChatGPT", and exits non-zero when signed out.
    const answer = await exec(cli, ["login", "status"], { env: this.environment(), timeout: 20_000 }).then(
      (result) => ({ ok: true, text: `${result.stdout}\n${result.stderr}` }),
      (error: { stdout?: string; stderr?: string; code?: unknown }) => ({ ok: false, text: `${error.stdout ?? ""}\n${error.stderr ?? ""}`, code: error.code }),
    );
    const loggedIn = answer.ok && /logged in/i.test(answer.text) && !/not logged in/i.test(answer.text);
    if (loggedIn) return { loggedIn, authMethod: /chatgpt/i.test(answer.text) ? "chatgpt" : /api key/i.test(answer.text) ? "api-key" : "unknown", ...base };
    if (!/not logged in/i.test(answer.text) && "code" in answer && typeof answer.code !== "number") {
      return { loggedIn: false, authMethod: "none", ...base, error: `Could not ask Codex for its login: ${clipText(answer.text.trim(), 200)}` };
    }
    return { loggedIn: false, authMethod: "none", ...base };
  }

  /**
   * Starts the official `codex login`. Device mode prints a link and a one-time code, with no local
   * redirect at all; browser mode opens the sign-in page, and the program itself waits for the redirect
   * on its own loopback port. Either way the program runs under the runtime, so it is still listening
   * when the browser comes back, and it ends once signed in, cancelled, or after 15 minutes.
   */
  async startSignIn(mode: "device" | "browser"): Promise<CodexStatus> {
    if (this.signIn) {
      if (this.signIn.info.mode === mode) return await this.status();
      this.cancelSignIn();
    }
    const cli = this.cli();
    await mkdir(this.configDir(), { recursive: true, mode: 0o700 });
    const info: CodexSignIn = { mode, state: "starting" };
    const child = spawn(cli, mode === "device" ? ["login", "--device-auth"] : ["login"], {
      env: { ...this.environment(), NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      info.error = "The sign-in expired. Start it again.";
      child.kill();
    }, SIGN_IN_TIMEOUT_MS);
    this.signIn = { child, info, timer };
    // A sign-in still waiting when the runtime stops ends with it.
    const stop = () => child.kill();
    process.once("exit", stop);
    child.once("exit", () => process.off("exit", stop));
    this.lastSignIn = undefined;
    let printed = "";
    let opened = false;
    const read = (chunk: Buffer) => {
      printed = `${printed}${stripAnsi(chunk.toString("utf8"))}`.slice(-8000);
      const parsed = parseSignIn(printed, mode);
      if (parsed.url) info.url = parsed.url;
      if (parsed.code) info.code = parsed.code;
      if (info.url && (mode === "browser" || info.code)) info.state = "waiting";
      // The program opens the page itself where it can; the runtime has no terminal, so open it here too.
      if (mode === "browser" && info.url && !opened) {
        opened = true;
        openInBrowser(info.url);
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("error", (error) => {
      info.state = "failed";
      info.error = `Could not start Codex sign-in: ${errorText(error)}`;
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (this.signIn?.child === child) this.signIn = undefined;
      if (code === 0) {
        this.kernel.log("admin", "info", "Codex signed in");
        return;
      }
      if (info.error === "cancelled") return;
      info.state = "failed";
      info.error ??= lastLine(printed) || `Codex sign-in ended (exit ${code ?? "signal"})`;
      this.lastSignIn = info;
      this.kernel.log("admin", "warning", `Codex sign-in failed: ${clipText(info.error, 200)}`);
    });
    this.kernel.log("admin", "info", `Codex sign-in started (${mode === "device" ? "device code" : "browser"})`);
    // Give the program a moment to print its link and code, so the first answer usually carries them.
    for (let waited = 0; waited < 5000 && info.state === "starting"; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return await this.status();
  }

  /** Opens the sign-in page again: the link Codex printed for the sign-in in progress. */
  openSignInPage(): { opened: boolean } {
    const url = this.signIn?.info.url;
    if (!url || !/^https:\/\//.test(url)) throw new HttpError(409, "No Codex sign-in is waiting");
    openInBrowser(url);
    return { opened: true };
  }

  cancelSignIn(): void {
    const current = this.signIn;
    this.lastSignIn = undefined;
    if (!current) return;
    current.info.error = "cancelled";
    clearTimeout(current.timer);
    current.child.kill();
    this.signIn = undefined;
  }

  /** Signs Saturn's Codex out with the official `codex logout`; the user's own Codex setup is untouched. */
  async logout(): Promise<CodexStatus> {
    this.cancelSignIn();
    try {
      await exec(this.cli(), ["logout"], { env: this.environment(), timeout: 20_000 });
    } catch (error) {
      // Signing out when already signed out is not an error worth showing.
      if (!/not logged in/i.test(errorText(error))) throw new HttpError(502, `Codex could not sign out: ${errorText(error)}`);
    }
    this.kernel.log("admin", "info", "Signed Codex out");
    return await this.status();
  }

  /** The skills endpoint a bearer token opens, while the turn that holds it is running. */
  bridge(token: string | undefined): { tools: BridgedTool[]; call: BridgedCall } | undefined {
    for (const [key, bridge] of this.bridges) if (tokenMatches(key, token)) return bridge;
    return undefined;
  }

  /** True while a skill call holds Codex waiting for the user's answer. */
  waiting(runId: string, actionId: string): boolean {
    return this.pending.has(`${runId}:${actionId}`);
  }

  /** The user's answer to an approval card. */
  decide(runId: string, actionId: string, allow: boolean): void {
    const resolve = this.pending.get(`${runId}:${actionId}`);
    if (!resolve) throw new HttpError(409, "This approval is no longer waiting");
    resolve(allow);
  }

  /**
   * One turn of a Codex chat; the Codex thread is resumed from the chat's last turn. Codex's exec mode has no
   * per-command approval, so its guard rails are its own sandbox: writes only inside the chat's project
   * folder, and no network for the commands it runs. The agent's Saturn skills are the exception: they run
   * in Saturn, which asks for them by the agent's approval setting.
   */
  async run(runId: string, generation: number, agent: Agent, model: ModelConnection, signal: AbortSignal): Promise<void> {
    const run = this.kernel.getRun(runId);
    const thread = run.threadId ? (this.kernel.store.state.threads ?? []).find((item) => item.id === run.threadId) : undefined;
    const workdir = this.kernel.projects.workdirFor(thread) ?? path.join(this.kernel.store.root, "workspace");
    await mkdir(workdir, { recursive: true });
    await mkdir(this.configDir(), { recursive: true, mode: 0o700 });

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

    const options: ThreadOptions = {
      workingDirectory: workdir,
      skipGitRepoCheck: true,
      // Ask and Plan turns only read: Codex's own read-only sandbox refuses edits and writing commands.
      sandboxMode: run.mode === "ask" || run.mode === "plan" ? "read-only" : "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      ...(model.model && model.model !== CODEX_DEFAULT_MODEL ? { model: model.model } : {}),
      ...(model.effort ? { modelReasoningEffort: model.effort } : {}),
    };

    // The agent's Saturn skills and MCP servers, over the runtime's /agent-mcp endpoint with a token only this
    // turn holds. Codex approves every call itself ("approve"); Saturn asks the user here when the agent's
    // setting is Review, as it does for the same tools on every other provider.
    const group = run.groupId ? (this.kernel.store.state.groups ?? []).find((item) => item.id === run.groupId) : undefined;
    const mode = approvalMode(agent, group?.autonomy);
    const skills = bridgedTools(this.kernel, agent, thread?.projectId ? workdir : undefined);
    const bridged = { aliases: new Map<string, string>(), orphans: new Set<string>() };
    const skillsCall: BridgedCall = async (toolId, args) => {
      if ((run.mode === "ask" || run.mode === "plan") && !isReadOnlyCall(toolId, args, this.kernel.runs.toolCategory(agent, toolId))) {
        return { id: newId("act"), toolId, arguments: args, status: "denied", reason: readOnlyRefusal(run.mode) };
      }
      if (mode === "review") {
        // The card goes on the action Codex already reported for this call, or on one its report adopts later.
        let action = [...actions].reverse().find((item) => item.result === undefined && item.status === "completed" && sameCall(item, toolId, args));
        if (!action) {
          action = { id: newId("act"), toolId, arguments: args, status: "completed" };
          actions.push(action);
          bridged.orphans.add(action.id);
        }
        const waiting = action;
        waiting.status = "waiting_approval";
        waiting.reason = `${toolId} needs your approval`;
        await save((current) => {
          current.status = "waiting_approval";
        });
        this.kernel.log("agent", "info", `${agent.name} ${toolId} waiting_approval`, { "saturn.run.id": runId });
        const key = `${runId}:${waiting.id}`;
        const allow = await new Promise<boolean>((resolve) => {
          this.pending.set(key, resolve);
          signal.addEventListener("abort", () => resolve(false), { once: true });
        }).finally(() => this.pending.delete(key));
        waiting.status = allow ? "completed" : "denied";
        waiting.reason = allow ? undefined : "Denied by the user";
        await save((current) => {
          current.status = "running";
        });
        if (!allow) return { ...waiting };
      }
      return await this.kernel.runs.executeTool({ agentId: agent.id, toolId, arguments: args, runId, actionId: newId("act"), signal });
    };
    const token = skills.length ? randomBytes(32).toString("hex") : undefined;
    const codex = new Codex({
      codexPathOverride: this.cli(),
      env: token ? { ...this.environment(), [SKILLS_TOKEN_VARIABLE]: token } : this.environment(),
      ...(token
        ? {
            config: {
              mcp_servers: {
                [SKILLS_SERVER]: {
                  url: `${runtimeOrigin()}/agent-mcp`,
                  bearer_token_env_var: SKILLS_TOKEN_VARIABLE,
                  default_tools_approval_mode: "approve",
                  // A Review card can wait on the user for a while.
                  tool_timeout_sec: 3600,
                },
              },
            },
          }
        : {}),
    });
    if (token) this.bridges.set(token, { tools: skills, call: skillsCall });
    const resumeId = savedSession(this.kernel, run, "codexThreadId");
    const session = resumeId ? codex.resumeThread(resumeId, options) : codex.startThread(options);
    // Memory and the agent's instructions open a new Codex thread; a resumed thread already has them. What the
    // knowledge sources return goes with every message.
    // Codex reads AGENTS.md from its working folder itself; the other rule files come from Saturn.
    const { memory, knowledge, rules } = await turnContext(this.kernel, agent, run, signal, ["AGENTS.md"]);
    const instructions = agent.instructions.trim();
    const opening = resumeId
      ? ""
      : [memory ? `<memory>\n${memory}\n</memory>` : "", rules ? `<project_rules>\n${rules}\n</project_rules>` : "", instructions ? `<instructions>\n${instructions}\n</instructions>` : ""].filter(Boolean).join("\n\n");
    const note = modeInstructions(run.mode);
    const message = withKnowledge(note ? `${note}\n\n${run.input}` : run.input, knowledge);
    const text = opening ? `${opening}\n\n${message}` : message;
    // Attached images go to Codex as files it reads itself.
    const images = (run.inputImages ?? []).map((relative) => ({ type: "local_image" as const, path: imagePath(this.kernel.store.root, relative) }));
    const prompt = images.length ? [{ type: "text" as const, text }, ...images] : text;

    this.kernel.log("agent", "info", `${agent.name} asked Codex (${options.model ?? "default model"}${model.effort ? `, ${model.effort} effort` : ""}) in ${workdir}`, { "saturn.run.id": runId });
    const startedAt = Date.now();
    let threadId = resumeId;
    let failure: string | undefined;
    try {
      const { events } = await session.runStreamed(prompt, { signal });
      for await (const event of events) {
        if (!this.kernel.alive(runId, generation)) break;
        if (event.type === "thread.started") threadId = event.thread_id;
        else if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
          const done = event.type === "item.completed";
          const item = event.item;
          if (item.type === "agent_message" && done && item.text.trim()) output = output ? `${output}\n\n${item.text}` : item.text;
          else if (item.type === "reasoning" && done && item.text.trim()) thoughts.push({ text: item.text, seconds: 0, at: actions.length });
          else if (item.type === "error") logger.warn("agent", `Codex: ${item.message}`);
          else track(actions, item, bridged);
          await save(() => undefined);
        } else if (event.type === "turn.completed") {
          await this.recordUsage(runId, agent, model, event.usage);
        } else if (event.type === "turn.failed") {
          failure = event.error.message;
        } else if (event.type === "error") {
          failure = event.message;
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      failure = errorText(error);
    } finally {
      if (token) this.bridges.delete(token);
    }

    if (threadId && threadId !== resumeId) await saveSession(this.kernel, run, "codexThreadId", threadId);
    if (!this.kernel.alive(runId, generation)) return;
    const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
    if (failure) {
      const explained = /login|logged in|authenticat|unauthori[sz]ed|401|token/i.test(failure)
        ? "Codex isn't signed in for Saturn yet. Sign in under Settings → General → Codex."
        : failure;
      await save((current) => {
        current.status = "failed";
        current.error = explained;
      });
      this.kernel.log("agent", "error", `${agent.name} failed in Codex after ${seconds}s: ${clipText(explained, 200)}`, { "saturn.run.id": runId });
      return;
    }
    await save((current) => {
      current.status = "completed";
      delete current.error;
    });
    this.kernel.log("agent", "info", `${agent.name} finished in Codex after ${seconds}s with ${actions.length} tool ${actions.length === 1 ? "call" : "calls"}`, { "saturn.run.id": runId });
  }

  /** Token counts from the turn. Billing is the user's ChatGPT plan, so no cost is recorded. */
  private async recordUsage(runId: string, agent: Agent, model: ModelConnection, usage: Usage): Promise<void> {
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
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          inputRate: null,
          outputRate: null,
          pricing: "ChatGPT plan",
          costUsd: null,
          createdAt: new Date().toISOString(),
        });
      })
      .catch((error: unknown) => logger.warn("usage", `Could not record Codex usage: ${errorText(error)}`));
  }
}

/**
 * Shows Codex's commands, file changes and MCP calls as the run's actions, in the chat's tool-call shape.
 * A Saturn skill call keeps the action its approval card went on (`bridged`), under the skill's own name.
 */
function track(actions: RunAction[], item: ThreadItem, bridged?: { aliases: Map<string, string>; orphans: Set<string> }): void {
  let toolId: string;
  let input: Record<string, unknown>;
  let result: unknown;
  let failed = false;
  if (item.type === "command_execution") {
    toolId = "Bash";
    input = { command: item.command };
    result = { output: clipText(item.aggregated_output ?? "", 4000), ...(item.exit_code !== undefined ? { exitCode: item.exit_code } : {}) };
    failed = item.status === "failed" || (item.exit_code !== undefined && item.exit_code !== 0);
  } else if (item.type === "file_change") {
    toolId = "Edit";
    input = { changes: item.changes };
    result = { output: item.changes.map((change) => `${change.kind} ${change.path}`).join("\n") };
    failed = item.status === "failed";
  } else if (item.type === "mcp_tool_call") {
    toolId = item.server === SKILLS_SERVER ? item.tool : `${item.server}.${item.tool}`;
    input = (item.arguments && typeof item.arguments === "object" ? item.arguments : { value: item.arguments }) as Record<string, unknown>;
    // No result while the call is in flight, so a Review card for it can find this action.
    result = item.status === "in_progress" ? undefined : item.error ? { output: item.error.message } : { output: clipText(JSON.stringify(item.result?.content ?? ""), 4000) };
    failed = item.status === "failed";
  } else {
    return;
  }
  const id = bridged?.aliases.get(item.id) ?? item.id;
  let action = actions.find((entry) => entry.id === id);
  if (!action && bridged && item.type === "mcp_tool_call" && item.server === SKILLS_SERVER) {
    action = actions.find((entry) => bridged.orphans.has(entry.id) && sameCall(entry, toolId, input));
    if (action) {
      bridged.orphans.delete(action.id);
      bridged.aliases.set(item.id, action.id);
    }
  }
  if (!action) {
    action = { id: item.id, toolId, arguments: input, status: "completed" };
    actions.push(action);
  }
  action.arguments = input;
  // An approval card stays until the user answers it, and a denied call stays denied.
  if (action.status === "denied" || (action.status === "waiting_approval" && item.status === "in_progress")) return;
  action.result = result;
  action.status = failed ? "failed" : "completed";
  if (failed) action.reason = clipText(typeof (result as { output?: unknown }).output === "string" ? (result as { output: string }).output : "failed", 300);
  else delete action.reason;
}

function sameCall(action: RunAction, toolId: string, args: Record<string, unknown>): boolean {
  return action.toolId === toolId && JSON.stringify(action.arguments) === JSON.stringify(args);
}

/** The link and one-time code `codex login` prints. */
export function parseSignIn(printed: string, mode: "device" | "browser"): { url?: string; code?: string } {
  const urls = printed.match(/https:\/\/[^\s"'<>]+/g) ?? [];
  const url = mode === "device" ? urls.find((item) => /device/i.test(item)) ?? urls[0] : urls.find((item) => /authorize|oauth|auth\./i.test(item)) ?? urls[0];
  const code = mode === "device" ? printed.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/)?.[0] : undefined;
  return { ...(url ? { url } : {}), ...(code ? { code } : {}) };
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

function lastLine(value: string): string {
  return value.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
}

function clipText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
