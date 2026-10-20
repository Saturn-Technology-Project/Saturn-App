import { HttpError } from "../domain/errors.js";
import { newId } from "../domain/ids.js";
import { GENERAL_SKILLS_ID, CURSOR_COMPUTER_USE_ID, CURSOR_ORIGIN_ID, ANTIGRAVITY_SKILLS_ID } from "../domain/builtin.js";
import type { Agent, Conversation, ModelConnection, Run, RunAction } from "../domain/model.js";
import { autonomyLine, autonomyOf, behaviorOf, buildSystemPrompt, clip, explainRunError, isSensitiveOperation, joinThinking, styleLine, textOf, thinkingOf, toolCalls } from "../domain/policies.js";
import type { ToolCall } from "./runtime-state.js";
import type { ChatMessage } from "../infrastructure/llm.js";
import { runGeneralSkill, runComputerUseSkill, runOriginSkill, runAntigravitySkill } from "../infrastructure/skills.js";
import { SpanKind, instruments, seconds, traced } from "../infrastructure/telemetry.js";
import { budgetHistory, compactActions } from "../domain/context.js";
import type { RuntimeKernel } from "./kernel.js";

/** computer_wait up to this long blocks inline; longer waits suspend the run and the scheduler resumes it. */
export const INLINE_WAIT_MS = 30_000;
/** One computer_wait call may suspend the run for at most an hour (the same ceiling as Claude Code's scheduled wake-ups). */
export const MAX_WAIT_MS = 3_600_000;
/** Long waits per run, so a polling loop cannot run (and bill) forever. */
export const MAX_SLEEPS = 48;
/** The reason recorded when the user turns down an approval; the run continues and is not counted as failed. */
const DENIED_BY_USER = "Denied by the user";

/** One agent turn: the model call, built-in skills, and MCP. */

/** The user turn that follows a round of tool results, so the model either uses more tools or answers. */
/** Tool rounds one turn may take before it stops and says so; long computer-use tasks need a good number. */
export const MAX_TOOL_ROUNDS = 60;

/** What the user sees when a turn stops at the step limit. */
export function stepLimitNote(): string {
  return `I stopped after ${MAX_TOOL_ROUNDS} tool steps, the limit for one turn, before finishing. Reply "continue" and I will pick up from here.`;
}

const CONTINUE_AFTER_TOOLS = "Continue from the tool results above: use more tools if the task needs them, otherwise give your answer.";
export class RunService {
  constructor(private readonly kernel: RuntimeKernel) {}

  async startRun(agentId: string, input: string, threadId?: string, projectId?: string): Promise<Run> {
    const agent = this.kernel.getAgent(agentId);
    this.kernel.guard(agent.id);
    const model = this.kernel.store.state.models.find((item) => item.id === agent.modelConnectionId);
    if (!model) throw new HttpError(409, "Agent has no model connection");
    this.kernel.llm.requireKey(model);

    // A project chat only runs once the user has allowed access to its folder.
    const threadProject = threadId ? (this.kernel.store.state.threads ?? []).find((t) => t.id === threadId)?.projectId : projectId;
    if (threadProject) this.kernel.projects.workdir(threadProject);

    const now = new Date().toISOString();
    let effectiveThreadId = threadId;

    if (!effectiveThreadId && projectId) {
      effectiveThreadId = (await this.createThread(agentId, input.trim().split("\n")[0].slice(0, 45) || "New Chat", projectId)).id;
    } else if (!effectiveThreadId) {
      const existingThread = (this.kernel.store.state.threads ?? []).find((t) => t.agentId === agentId && !t.projectId);
      if (existingThread) {
        effectiveThreadId = existingThread.id;
      } else {
        const title = input.trim().split("\n")[0].slice(0, 45) || "Conversation";
        const thread: Conversation = {
          id: newId("thread"),
          agentId,
          title,
          createdAt: now,
          updatedAt: now,
        };
        await this.kernel.store.update((state) => {
          if (!state.threads) state.threads = [];
          state.threads.unshift(thread);
        });
        effectiveThreadId = thread.id;
      }
    } else {
      await this.kernel.store.update((state) => {
        if (!state.threads) state.threads = [];
        const thread = state.threads.find((t) => t.id === effectiveThreadId);
        if (thread) {
          thread.updatedAt = now;
          if (thread.title === "New Conversation" || thread.title === "New Chat" || thread.title === "Untitled Chat") {
            thread.title = input.trim().split("\n")[0].slice(0, 45) || thread.title;
          }
        } else {
          state.threads.unshift({
            id: effectiveThreadId!,
            agentId,
            title: input.trim().split("\n")[0].slice(0, 45) || "Conversation",
            createdAt: now,
            updatedAt: now,
          });
        }
      });
    }

    const run: Run = {
      id: newId("run"),
      agentId,
      threadId: effectiveThreadId,
      input,
      status: "running",
      output: "",
      thinking: "",
      thoughts: [],
      actions: [],
      generation: 0,
    };
    await this.kernel.store.update((state) => {
      state.runs.unshift(run);
    });
    void this.advance(run.id);
    return run;
  }

  /**
   * One agent's turn in a group chat. It belongs to no chat thread: the group transcript travels in `input`,
   * so earlier turns are not replayed as history.
   */
  async startGroupRun(agentId: string, input: string, groupId: string, groupMessageId: string): Promise<Run> {
    const agent = this.kernel.getAgent(agentId);
    this.kernel.guard(agent.id);
    const model = this.kernel.store.state.models.find((item) => item.id === agent.modelConnectionId);
    if (!model) throw new HttpError(409, "Agent has no model connection");
    this.kernel.llm.requireKey(model);
    const run: Run = {
      id: newId("run"),
      agentId,
      groupId,
      groupMessageId,
      input,
      status: "running",
      output: "",
      thinking: "",
      thoughts: [],
      actions: [],
      generation: 0,
    };
    await this.kernel.store.update((state) => {
      state.runs.unshift(run);
    });
    void this.advance(run.id);
    return run;
  }

  /**
   * Runs still marked running or queued at startup were cut off when the runtime last stopped;
   * nothing resumes them, so they are failed with the reason instead of spinning forever.
   */
  async recoverInterrupted(): Promise<number> {
    // A Claude Code run waiting on an approval lived in an SDK process the restart ended, so it is stuck too.
    const claudeCodeAgents = new Set(
      this.kernel.store.state.agents
        .filter((agent) => this.kernel.store.state.models.find((model) => model.id === agent.modelConnectionId)?.provider === "claude-code")
        .map((agent) => agent.id),
    );
    const stuck = this.kernel.store.state.runs.filter(
      (run) => run.status === "running" || run.status === "queued" || (run.status === "waiting_approval" && claudeCodeAgents.has(run.agentId)),
    );
    if (!stuck.length) return 0;
    const ids = new Set(stuck.map((run) => run.id));
    await this.kernel.store.update((state) => {
      for (const run of state.runs) {
        if (!ids.has(run.id)) continue;
        run.status = "failed";
        run.error = "Interrupted when the runtime restarted. Send the message again to rerun it.";
        run.generation = (run.generation ?? 0) + 1;
      }
    });
    for (const run of stuck) {
      const name = this.kernel.store.state.agents.find((agent) => agent.id === run.agentId)?.name ?? run.agentId;
      this.kernel.log("agent", "warning", `${name}: a run was interrupted by the last restart and marked failed`, { "saturn.run.id": run.id });
    }
    return stuck.length;
  }

  async pendingTasks(): Promise<{ id: string; agentId: string; agentName: string; input: string; toolId: string }[]> {
    return this.kernel.store.state.runs
      .filter((run) => run.status === "waiting_approval")
      .map((run) => ({
        id: run.id,
        agentId: run.agentId,
        agentName: this.kernel.store.state.agents.find((agent) => agent.id === run.agentId)?.name ?? "Agent",
        input: run.input,
        toolId: run.actions.find((action) => action.status === "waiting_approval")?.toolId ?? "",
      }));
  }

  async messagesFor(agentId: string, threadId?: string): Promise<Run[]> {
    this.kernel.getAgent(agentId);
    let list = this.kernel.store.state.runs.filter((item) => item.agentId === agentId && !item.groupId);
    if (threadId) {
      list = list.filter((item) => item.threadId === threadId);
    }
    return list.slice().reverse();
  }

  async listThreads(agentId: string): Promise<Conversation[]> {
    this.kernel.getAgent(agentId);
    let threads = (this.kernel.store.state.threads ?? []).filter((t) => t.agentId === agentId);
    const legacyRuns = this.kernel.store.state.runs.filter((r) => r.agentId === agentId && !r.threadId && !r.groupId);
    if (legacyRuns.length > 0) {
      const now = new Date().toISOString();
      const firstRun = legacyRuns.at(-1);
      const title = firstRun?.input.trim().split("\n")[0].slice(0, 45) || "Previous Conversation";
      const legacyThread: Conversation = {
        id: `legacy_${agentId}`,
        agentId,
        title,
        createdAt: now,
        updatedAt: now,
      };
      await this.kernel.store.update((state) => {
        if (!state.threads) state.threads = [];
        if (!state.threads.some((t) => t.id === legacyThread.id)) {
          state.threads.unshift(legacyThread);
        }
        for (const run of state.runs) {
          if (run.agentId === agentId && !run.threadId && !run.groupId) {
            run.threadId = legacyThread.id;
          }
        }
      });
      threads = (this.kernel.store.state.threads ?? []).filter((t) => t.agentId === agentId);
    }
    return threads.slice().sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  }

  async createThread(agentId: string, title?: string, projectId?: string): Promise<Conversation> {
    this.kernel.getAgent(agentId);
    if (projectId && !(this.kernel.store.state.projects ?? []).some((project) => project.id === projectId)) {
      throw new HttpError(404, "Project not found");
    }
    const now = new Date().toISOString();
    const thread: Conversation = {
      id: newId("thread"),
      agentId,
      ...(projectId ? { projectId } : {}),
      title: title?.trim() || "New Chat",
      createdAt: now,
      updatedAt: now,
    };
    await this.kernel.store.update((state) => {
      if (!state.threads) state.threads = [];
      state.threads.unshift(thread);
    });
    return thread;
  }

  async renameThread(threadId: string, title: string): Promise<Conversation> {
    const trimmed = title.trim();
    if (!trimmed) throw new HttpError(400, "Title is required");
    let updated: Conversation | undefined;
    await this.kernel.store.update((state) => {
      const thread = (state.threads ?? []).find((t) => t.id === threadId);
      if (!thread) throw new HttpError(404, "Conversation not found");
      thread.title = trimmed;
      thread.updatedAt = new Date().toISOString();
      updated = thread;
    });
    return updated!;
  }

  async deleteThread(threadId: string): Promise<void> {
    const thread = (this.kernel.store.state.threads ?? []).find((t) => t.id === threadId);
    if (thread?.worktree) await this.kernel.worktrees.finish(threadId, "discard").catch(() => undefined);
    const removed = this.kernel.store.state.runs.filter((r) => r.threadId === threadId).map((r) => r.id);
    await this.kernel.store.update((state) => {
      state.threads = (state.threads ?? []).filter((t) => t.id !== threadId);
      state.runs = state.runs.filter((r) => r.threadId !== threadId);
    });
    await this.kernel.checkpoints.forget(removed);
  }

  async reviseRun(id: string, input: string): Promise<{ run: Run; removed: string[] }> {
    const text = input.trim();
    if (!text) throw new HttpError(400, "Message is empty");
    const existing = this.kernel.getRun(id);
    this.kernel.guard(existing.agentId);
    const agent = this.kernel.getAgent(existing.agentId);
    if (!this.kernel.store.state.models.some((item) => item.id === agent.modelConnectionId)) {
      throw new HttpError(409, "Agent has no model connection");
    }
    const removed: string[] = [];
    await this.kernel.store.update((state) => {
      const index = state.runs.findIndex((item) => item.id === id);
      const run = state.runs[index];
      if (!run) return;
      const later = state.runs.slice(0, index).filter((item) => item.agentId === run.agentId && (run.threadId ? item.threadId === run.threadId : true));
      removed.push(...later.map((item) => item.id));
      if (removed.length) state.runs = state.runs.filter((item) => !removed.includes(item.id));
      run.input = text;
      run.output = "";
      run.thinking = "";
      run.thoughts = [];
      run.actions = [];
      delete run.error;
      run.status = "running";
      run.generation = (run.generation ?? 0) + 1;
    });
    const run = this.kernel.getRun(id);
    const dropped = removed.length ? `, dropping ${removed.length} later ${removed.length === 1 ? "turn" : "turns"}` : "";
    this.kernel.log("agent", "info", `${agent.name}: message edited, rerunning that turn${dropped}`, { "saturn.run.id": id });
    void this.advance(run.id);
    return { run, removed };
  }

  private wakeTimer: NodeJS.Timeout | null = null;

  /** Resumes sleeping runs whose wake time has come; also catches up on runs that slept through a restart. */
  startWakeups(intervalMs = 5_000): void {
    if (this.wakeTimer) return;
    void this.wakeDue();
    this.wakeTimer = setInterval(() => void this.wakeDue(), intervalMs);
    this.wakeTimer.unref();
  }

  stopWakeups(): void {
    if (this.wakeTimer) clearInterval(this.wakeTimer);
    this.wakeTimer = null;
  }

  async wakeDue(now = new Date()): Promise<string[]> {
    const due = this.kernel.store.state.runs.filter((run) => run.status === "sleeping" && run.wake && Date.parse(run.wake.at) <= now.getTime());
    for (const run of due) await this.resume(run.id, now, "on_time");
    return due.map((run) => run.id);
  }

  /** Wakes a sleeping run now (the user's "Wake now"), handing the model how long it actually waited. */
  async wakeRun(id: string, now = new Date()): Promise<Run> {
    const run = this.kernel.getRun(id);
    if (run.status !== "sleeping") throw new HttpError(409, "This run is not waiting");
    await this.resume(id, now, "early");
    return this.kernel.getRun(id);
  }

  private async resume(id: string, now: Date, how: "on_time" | "early"): Promise<void> {
    let resumed = false;
    await this.kernel.store.update((state) => {
      const run = state.runs.find((item) => item.id === id);
      if (!run || run.status !== "sleeping" || !run.wake) return;
      const wake = run.wake;
      const action = run.actions.find((item) => item.id === wake.actionId);
      if (action) {
        action.status = "completed";
        action.result = {
          waited_ms: Math.max(0, now.getTime() - Date.parse(wake.since)),
          requested_ms: wake.requestedMs,
          ...(wake.reason ? { reason: wake.reason } : {}),
          woke: how === "early" ? "early, by the user" : "on time",
          now: now.toISOString(),
        };
      }
      run.status = "running";
      run.sleeps = (run.sleeps ?? 0) + 1;
      delete run.wake;
      resumed = true;
    });
    if (!resumed) return;
    const run = this.kernel.getRun(id);
    const name = this.kernel.store.state.agents.find((agent) => agent.id === run.agentId)?.name ?? run.agentId;
    this.kernel.log("agent", "info", `${name} resumed after waiting${how === "early" ? " (woken early)" : ""}`, { "saturn.run.id": id });
    void this.advance(id);
  }

  /** Suspends the run on a long computer_wait. Returns the action recorded in its place. */
  private async sleep(agent: Agent, runId: string, generation: number, call: ToolCall, actions: RunAction[]): Promise<RunAction> {
    const run = this.kernel.getRun(runId);
    const requested = Math.min(MAX_WAIT_MS, Math.max(0, Number(call.arguments.ms ?? call.arguments.duration_ms ?? 0)));
    const reason = typeof call.arguments.reason === "string" ? call.arguments.reason.slice(0, 300) : undefined;
    const action: RunAction = { id: newId("act"), toolId: call.name, arguments: call.arguments, status: "sleeping", ...(reason ? { reason } : {}) };
    if (call.thoughtSignature) action.thoughtSignature = call.thoughtSignature;
    if ((run.sleeps ?? 0) >= MAX_SLEEPS) {
      action.status = "completed";
      action.result = { error: `This run has already waited ${MAX_SLEEPS} times; finish with what you have or ask the user.` };
      return action;
    }
    const since = new Date();
    const at = new Date(since.getTime() + requested);
    actions.push(action);
    await this.kernel.store.update((state) => {
      const current = state.runs.find((item) => item.id === runId);
      if (!current || (current.generation ?? 0) !== generation) return;
      current.actions = [...actions];
      current.status = "sleeping";
      current.wake = { at: at.toISOString(), since: since.toISOString(), actionId: action.id, requestedMs: requested, ...(reason ? { reason } : {}) };
    });
    const minutes = Math.round(requested / 6_000) / 10;
    this.kernel.log("agent", "info", `${agent.name} is waiting ${minutes} min${reason ? `: ${clip(reason, 80)}` : ""}`, { "saturn.run.id": runId });
    return action;
  }

  async stopRun(id: string): Promise<Run> {
    const run = this.kernel.getRun(id);
    if (run.status !== "running" && run.status !== "queued" && run.status !== "waiting_approval" && run.status !== "sleeping") return run;
    const name = this.kernel.store.state.agents.find((item) => item.id === run.agentId)?.name ?? run.agentId;
    for (const [key, controller] of this.kernel.stops) {
      if (!key.startsWith(`${id}:`)) continue;
      controller.abort();
      this.kernel.stops.delete(key);
    }
    await this.kernel.store.update((state) => {
      const current = state.runs.find((item) => item.id === id);
      if (!current) return;
      if (current.status !== "running" && current.status !== "queued" && current.status !== "waiting_approval" && current.status !== "sleeping") return;
      current.status = "cancelled";
      delete current.wake;
      current.generation = (current.generation ?? 0) + 1;
      current.error = undefined;
    });
    const stopped = this.kernel.getRun(id);
    this.kernel.log("agent", "info", `${name} stopped`);
    return stopped;
  }

  /**
   * The user's answer to an approval card on a local (non-Claude Code) run. The waiting tool call runs, or is
   * denied, and the turn continues from there as a new generation, so nothing from the paused pass can resume.
   */
  async decide(runId: string, actionId: string, allow: boolean): Promise<Run> {
    const run = this.kernel.getRun(runId);
    const index = run.actions.findIndex((item) => item.id === actionId && item.status === "waiting_approval");
    if (run.status !== "waiting_approval" || index < 0) throw new HttpError(409, "This approval is no longer waiting");
    this.kernel.guard(run.agentId);
    const pending = run.actions[index]!;
    const generation = (run.generation ?? 0) + 1;
    const actions = run.actions.slice(0, index);
    await this.kernel.store.update((state) => {
      const current = state.runs.find((item) => item.id === runId);
      if (!current) return;
      current.status = "running";
      current.generation = generation;
      current.actions = [...actions];
    });
    void this.continueAfterDecision(runId, generation, pending, allow, actions);
    return this.kernel.getRun(runId);
  }

  private async continueAfterDecision(runId: string, generation: number, pending: RunAction, allow: boolean, actions: RunAction[]): Promise<void> {
    const signal = this.kernel.track(runId, generation);
    try {
      const run = this.kernel.getRun(runId);
      const agent = this.kernel.getAgent(run.agentId);
      const model = this.kernel.store.state.models.find((item) => item.id === agent.modelConnectionId);
      if (!model) throw new Error("Agent has no model connection");
      const done: RunAction = allow
        ? await this.executeTool({ agentId: agent.id, toolId: pending.toolId, arguments: pending.arguments, runId, actionId: pending.id, signal })
        : { ...pending, status: "denied", reason: DENIED_BY_USER };
      if (pending.thoughtSignature) done.thoughtSignature = pending.thoughtSignature;
      actions.push(done);
      this.kernel.log("agent", "info", `${agent.name} ${pending.toolId} ${allow ? "approved" : "denied"} by the user`, { "saturn.run.id": runId });
      if (!this.kernel.alive(runId, generation)) return;
      await this.kernel.store.update((state) => {
        const current = state.runs.find((item) => item.id === runId);
        if (current && (current.generation ?? 0) === generation) current.actions = [...actions];
      });
      const context = await this.ragContext(agent, run.input, signal);
      await this.finishFromModel(runId, generation, agent, model, context, this.toolList(agent), actions, signal);
    } catch (error) {
      if (!this.kernel.alive(runId, generation) || signal.aborted) return;
      await this.finish(runId, generation, "failed", "", explainRunError(error));
    } finally {
      this.kernel.stops.delete(`${runId}:${generation}`);
    }
  }

  /** One tool call, as an "execute_tool <tool>" span plus saturn.tool.calls / saturn.tool.duration. */
  async executeTool(input: {
    agentId: string;
    toolId: string;
    arguments: Record<string, unknown>;
    runId: string;
    actionId: string;
    signal?: AbortSignal;
  }): Promise<RunAction> {
    const agent = this.kernel.store.state.agents.find((item) => item.id === input.agentId);
    const server = agent ? this.toolServer(agent, input.toolId) : null;
    const kind = server === GENERAL_SKILLS_ID ? "general_skill" : server ? "mcp" : "unknown";
    return traced(`execute_tool ${input.toolId}`, {
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": input.toolId,
        "gen_ai.tool.call.id": input.actionId,
        "gen_ai.agent.id": input.agentId,
        "saturn.run.id": input.runId,
        "saturn.tool.kind": kind,
        ...(server ? { "saturn.tool.server": server } : {}),
      },
    }, async (span) => {
      const startedAt = performance.now();
      let status = "failed";
      try {
        const action = await this.runTool(input);
        status = action.status;
        span.setAttribute("saturn.tool.status", status);
        if (action.reason) span.setAttribute("saturn.tool.reason", clip(action.reason, 200));
        return action;
      } finally {
        const attributes = { "gen_ai.tool.name": input.toolId, "saturn.tool.kind": kind, "saturn.tool.status": status };
        instruments().tools.add(1, attributes);
        instruments().toolDuration.record(seconds(startedAt), attributes);
      }
    });
  }

  /** The project folder a run works in, or undefined for chats outside a project (the private sandbox). */
  private workdirOf(runId: string): string | undefined {
    const run = this.kernel.store.state.runs.find((item) => item.id === runId);
    const thread = run?.threadId ? (this.kernel.store.state.threads ?? []).find((t) => t.id === run.threadId) : undefined;
    return this.kernel.projects.workdirFor(thread);
  }

  private async runTool(input: {
    agentId: string;
    toolId: string;
    arguments: Record<string, unknown>;
    runId: string;
    actionId: string;
    signal?: AbortSignal;
  }): Promise<RunAction> {
    this.kernel.guard(input.agentId);
    const agent = this.kernel.getAgent(input.agentId);
    const serverId = this.toolServer(agent, input.toolId);
    if (!serverId) {
      return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "failed", reason: `Unknown tool: ${input.toolId}` };
    }
    if (serverId === GENERAL_SKILLS_ID) {
      try {
        const workdir = this.workdirOf(input.runId);
        const result = await runGeneralSkill(this.kernel.store.root, input.toolId, input.arguments, async (toolId, args) => {
          const action = await this.executeTool({ ...input, toolId, arguments: args, actionId: newId("act") });
          if (action.status !== "completed") throw new Error(action.reason || "MCP call failed");
          return action.result;
        }, input.signal, workdir, workdir ? this.kernel.checkpoints.forRun(input.runId, workdir) : undefined);
        return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "completed", result };
      } catch (error) {
        return {
          id: input.actionId,
          toolId: input.toolId,
          arguments: input.arguments,
          status: "failed",
          reason: error instanceof Error ? error.message : "Skill failed",
        };
      }
    }
    if (serverId === CURSOR_COMPUTER_USE_ID || serverId === "cursor-computer-use") {
      try {
        const result = await runComputerUseSkill(this.kernel.store.root, input.toolId, input.arguments, input.signal);
        return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "completed", result };
      } catch (error) {
        return {
          id: input.actionId,
          toolId: input.toolId,
          arguments: input.arguments,
          status: "failed",
          reason: error instanceof Error ? error.message : "Computer Use skill failed",
        };
      }
    }
    if (serverId === CURSOR_ORIGIN_ID || serverId === "cursor-origin") {
      try {
        const workdir = this.workdirOf(input.runId);
        const result = await runOriginSkill(this.kernel.store.root, input.toolId, input.arguments, input.signal, {
          secret: (id) => this.kernel.store.secret(id),
          ...(workdir ? { repoDir: workdir } : {}),
        });
        return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "completed", result };
      } catch (error) {
        return {
          id: input.actionId,
          toolId: input.toolId,
          arguments: input.arguments,
          status: "failed",
          reason: error instanceof Error ? error.message : "Origin skill failed",
        };
      }
    }
    if (serverId === ANTIGRAVITY_SKILLS_ID || serverId === "antigravity-skills") {
      try {
        const result = await runAntigravitySkill(this.kernel.store.root, input.toolId, input.arguments, input.signal, {
          automations: this.kernel.automations,
          agentId: input.agentId,
        });
        return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "completed", result };
      } catch (error) {
        return {
          id: input.actionId,
          toolId: input.toolId,
          arguments: input.arguments,
          status: "failed",
          reason: error instanceof Error ? error.message : "Automations skill failed",
        };
      }
    }
    return this.callMcp(serverId, input, input.signal);
  }

  /**
   * One pass of a run, as an "invoke_agent <agent>" span. When the pass ends the run's state is counted
   * in saturn.agent.runs (completed, failed, cancelled, waiting_approval, or superseded by an edit).
   */
  async advance(runId: string): Promise<void> {
    const current = this.kernel.getRun(runId);
    if (current.status === "cancelled") return;
    const generation = current.generation ?? 0;
    const agent = this.kernel.store.state.agents.find((item) => item.id === current.agentId);
    const model = this.kernel.store.state.models.find((item) => item.id === agent?.modelConnectionId);
    await traced(`invoke_agent ${agent?.name ?? current.agentId}`, {
      kind: SpanKind.INTERNAL,
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.id": current.agentId,
        "gen_ai.agent.name": agent?.name ?? "",
        "saturn.run.id": runId,
        "saturn.run.generation": generation,
        ...(model ? { "gen_ai.request.model": model.model || model.name, "gen_ai.provider.name": model.provider } : {}),
        ...(agent?.autonomy ? { "saturn.agent.autonomy": agent.autonomy } : {}),
      },
    }, async (span) => {
      const startedAt = performance.now();
      try {
        await this.pass(runId, generation);
      } finally {
        const run = this.kernel.store.state.runs.find((item) => item.id === runId);
        const status = !run ? "deleted" : (run.generation ?? 0) !== generation ? "superseded" : run.status;
        span.setAttribute("saturn.run.status", status);
        span.setAttribute("saturn.run.actions", run?.actions.length ?? 0);
        if (status === "failed") span.setAttribute("error.type", "run_failed");
        if (run?.error) span.setAttribute("saturn.run.error", clip(run.error, 200));
        const attributes = { "saturn.run.status": status, ...(model ? { "gen_ai.provider.name": model.provider } : {}) };
        instruments().runs.add(1, attributes);
        instruments().runDuration.record(seconds(startedAt), attributes);
      }
    });
  }

  private async pass(runId: string, generation: number): Promise<void> {
    const signal = this.kernel.track(runId, generation);
    try {
      if (!this.kernel.alive(runId, generation)) return;
      const run = this.kernel.getRun(runId);
      const agent = this.kernel.getAgent(run.agentId);
      const model = this.kernel.store.state.models.find((item) => item.id === agent.modelConnectionId);
      if (!model) throw new Error("Agent has no model connection");
      this.kernel.guard(agent.id);
      if (model.provider === "claude-code") {
        // The official Agent SDK runs the whole agent loop (tools, approvals, session) itself.
        await this.kernel.claudeCode.run(runId, generation, agent, model, signal);
        return;
      }
      if (model.provider === "codex") {
        // The official Codex SDK runs the whole agent loop (commands, edits, thread) itself.
        await this.kernel.codex.run(runId, generation, agent, model, signal);
        return;
      }
      const context = await this.ragContext(agent, run.input, signal);
      if (!this.kernel.alive(runId, generation)) return;
      const tools = this.toolList(agent);
      if (run.actions.length) {
        // Resuming (after a wait): continue from the actions already taken instead of starting over.
        await this.finishFromModel(runId, generation, agent, model, context, tools, [...run.actions], signal);
        return;
      }
      this.kernel.log("agent", "info", `${agent.name} asked ${model.model || model.name}: ${clip(run.input)}`);
      const startedAt = performance.now();
      const first = await this.complete(model, agent, runId, run.input, context, tools, [], signal);
      if (!this.kernel.alive(runId, generation)) return;
      await this.noteThinking(runId, generation, first, seconds(startedAt));
      const actions: RunAction[] = [];
      const calls = toolCalls(first);
      const waiting = await this.runTools(agent, runId, generation, calls, actions, signal);
      if (waiting || !this.kernel.alive(runId, generation)) return;
      // A reply with no tool calls is already the answer; asking again would only double the cost.
      await this.finishFromModel(runId, generation, agent, model, context, tools, actions, signal, calls.length ? undefined : first);
    } catch (error) {
      if (!this.kernel.alive(runId, generation) || signal.aborted) return;
      await this.finish(runId, generation, "failed", "", explainRunError(error));
    } finally {
      this.kernel.stops.delete(`${runId}:${generation}`);
    }
  }

  async runTools(agent: Agent, runId: string, generation: number, calls: ToolCall[], actions: RunAction[], signal: AbortSignal): Promise<boolean> {
    // In a group, the group's approval setting (when it has one) replaces the agent's own.
    const groupId = this.kernel.store.state.runs.find((item) => item.id === runId)?.groupId;
    const groupAutonomy = groupId ? (this.kernel.store.state.groups ?? []).find((item) => item.id === groupId)?.autonomy : undefined;
    const mode = groupAutonomy ?? autonomyOf(agent.autonomy);
    for (let index = 0; index < calls.length; index += 1) {
      if (!this.kernel.alive(runId, generation) || signal.aborted) return true;
      this.kernel.guard(agent.id);
      const call = calls[index];

      // Antigravity guardrail enforcement
      let requiresApproval = false;
      let approvalReason = "";

      if (mode === "review") {
        requiresApproval = true;
        approvalReason = "Request Review mode: every command requires approval";
      } else if (mode === "default") {
        if (isSensitiveOperation(call.name, call.arguments)) {
          requiresApproval = true;
          approvalReason = `Sensitive operation requires approval: ${call.name}`;
        }
      }

      if (requiresApproval) {
        const action: RunAction = {
          id: newId("act"),
          toolId: call.name,
          arguments: call.arguments,
          status: "waiting_approval",
          reason: approvalReason,
        };
        if (call.thoughtSignature) action.thoughtSignature = call.thoughtSignature;
        actions.push(action);
        this.kernel.log("agent", "info", `${agent.name} ${action.toolId} waiting_approval: ${approvalReason}`);
        if (this.kernel.alive(runId, generation)) {
          await this.kernel.store.update((state) => {
            const current = state.runs.find((item) => item.id === runId);
            if (!current || (current.generation ?? 0) !== generation) return;
            current.actions = [...actions];
            current.status = "waiting_approval";
          });
        }
        return true;
      }

      if (call.name === "computer_wait" && Number(call.arguments.ms ?? call.arguments.duration_ms ?? 0) > INLINE_WAIT_MS) {
        const slept = await this.sleep(agent, runId, generation, call, actions);
        // Suspended: the round ends here, with no model call while the run waits.
        if (slept.status === "sleeping") return true;
        actions.push(slept);
        continue;
      }

      const action = await this.executeTool({
        agentId: agent.id,
        toolId: call.name,
        arguments: call.arguments,
        runId,
        actionId: newId("act"),
        signal,
      });
      if (call.thoughtSignature) action.thoughtSignature = call.thoughtSignature;
      actions.push(action);
      const detail = action.reason ? `: ${clip(action.reason, 80)}` : "";
      this.kernel.log("agent", action.status === "failed" || action.status === "denied" ? "warning" : "info", `${agent.name} ${action.toolId} ${action.status}${detail}`);
      if (this.kernel.alive(runId, generation)) {
        await this.kernel.store.update((state) => {
          const current = state.runs.find((item) => item.id === runId);
          if (!current || (current.generation ?? 0) !== generation) return;
          current.actions = [...actions];
          if (action.status === "waiting_approval") {
            current.status = "waiting_approval";
          }
        });
      }
      if (action.status === "waiting_approval") {
        return true;
      }
    }
    return false;
  }

  async callMcp(
    serverId: string,
    input: { agentId: string; toolId: string; arguments: Record<string, unknown>; runId: string; actionId: string },
    signal?: AbortSignal,
  ): Promise<RunAction> {
    const server = this.kernel.store.state.mcp.find((item) => item.id === serverId);
    if (!server) {
      return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "failed", reason: "MCP server missing" };
    }
    const headers: Record<string, string> = {
      "X-Saturn-Agent-Id": input.agentId,
      "X-Saturn-Run-Id": input.runId,
      "X-Saturn-Action-Id": input.actionId,
    };
    try {
      const remote = server.tools.find((tool) => tool.toolId === input.toolId)?.remoteName ?? input.toolId;
      const target = { id: server.id, url: server.url, auth: server.auth ?? "none" };
      const result = await this.kernel.mcp.call(target, remote, input.arguments, signal, headers);
      return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "completed", result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "MCP call failed";
      if (message === "approval_required") {
        return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "waiting_approval" };
      }
      if (message === "policy_denied") {
        return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "denied", reason: "Policy denied" };
      }
      if (message === "approval_rejected") {
        return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "denied", reason: "Approval rejected" };
      }
      if (message === "Agent is not allowed to call this tool") {
        return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "denied", reason: message };
      }
      throw error;
    }
  }

  toolServer(agent: Agent, toolId: string): string | null {
    const attached = this.kernel.store.state.mcp.filter((item) => agent.mcpConnectionIds.includes(item.id));
    return attached.find((server) => server.tools.some((tool) => tool.toolId === toolId && !server.disabledTools?.includes(toolId)))?.id ?? null;
  }

  async finishFromModel(
    runId: string,
    generation: number,
    agent: Agent,
    model: ModelConnection,
    context: string,
    tools: unknown[],
    actions: RunAction[],
    signal?: AbortSignal,
    answered?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.kernel.alive(runId, generation)) return;
    const run = this.kernel.getRun(runId);
    let response = answered;
    if (!response) {
      const startedAt = performance.now();
      response = await this.complete(model, agent, runId, run.input, context, tools, actions, signal);
      await this.noteThinking(runId, generation, response, seconds(startedAt));
    }
    let rounds = 0;
    while (agent.mcpConnectionIds.length > 0 && rounds < MAX_TOOL_ROUNDS) {
      const calls = toolCalls(response);
      if (!calls.length || !this.kernel.alive(runId, generation)) break;
      rounds += 1;
      const waiting = await this.runTools(agent, runId, generation, calls, actions, signal ?? new AbortController().signal);
      if (waiting || !this.kernel.alive(runId, generation)) return;
      const startedAt = performance.now();
      response = await this.complete(model, agent, runId, run.input, context, tools, actions, signal);
      await this.noteThinking(runId, generation, response, seconds(startedAt));
    }
    // Still asking for tools after the last round: the step limit ended this turn, not the model.
    const cutOff = rounds >= MAX_TOOL_ROUNDS && toolCalls(response).length > 0;
    if (cutOff) this.kernel.log("agent", "warning", `${agent.name} reached the limit of ${MAX_TOOL_ROUNDS} tool rounds in one turn`, { "saturn.run.id": runId });
    let saved = false;
    await this.kernel.store.update((state) => {
      const current = state.runs.find((item) => item.id === runId);
      if (!current || (current.generation ?? 0) !== generation) return;
      current.actions = actions;
      current.output = cutOff ? [textOf(response).trim(), stepLimitNote()].filter(Boolean).join("\n\n") : textOf(response);
      current.status = actions.some((item) => item.status === "failed" || (item.status === "denied" && item.reason !== DENIED_BY_USER))
        ? "failed"
        : "completed";
      saved = true;
    });
    if (!saved) return;
    const current = this.kernel.getRun(runId);
    this.kernel.log("agent", current.status === "failed" ? "error" : "info", `${agent.name} ${current.status}`);
  }

  toolList(agent: Agent) {
    return this.kernel.store.state.mcp
      .filter((item) => agent.mcpConnectionIds.includes(item.id))
      .flatMap((server) =>
        server.tools
          .filter((tool) => !server.disabledTools?.includes(tool.toolId))
          .map((tool) => ({
            type: "function",
            function: { name: tool.toolId, description: tool.description, parameters: tool.inputSchema },
          })),
      );
  }

  async ragContext(agent: Agent, query: string, signal?: AbortSignal): Promise<string> {
    this.kernel.guard(agent.id);
    const servers = this.kernel.store.state.rag.filter((item) => agent.ragConnectionIds.includes(item.id));
    if (!servers.length) return "";
    return traced("retrieve", {
      kind: SpanKind.CLIENT,
      attributes: { "gen_ai.operation.name": "retrieve", "gen_ai.agent.id": agent.id, "saturn.rag.sources": servers.length },
    }, async (span) => {
      const context = await this.fetchRag(servers, query, signal);
      span.setAttribute("saturn.rag.context_chars", context.length);
      return context;
    });
  }

  private async fetchRag(servers: { name: string; url: string }[], query: string, signal?: AbortSignal): Promise<string> {
    const chunks: string[] = [];
    for (const server of servers) {
      const response = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
        signal,
      });
      if (!response.ok) {
        // An error page is not knowledge; leave it out of the model's context.
        this.kernel.log("agent", "warning", `Knowledge source ${server.name} answered ${response.status}; its context was skipped`);
        continue;
      }
      const text = await response.text();
      if (!text.trim()) this.kernel.log("agent", "debug", `Knowledge source ${server.name} returned nothing for this query`);
      chunks.push(text);
    }
    return chunks.join("\n");
  }

  priorMessages(agentId: string, runId: string): ChatMessage[] {
    const currentRun = this.kernel.store.state.runs.find((item) => item.id === runId);
    const threadId = currentRun?.threadId;
    // A group turn carries the group transcript in its input.
    if (currentRun?.groupId) return [];
    const turns = this.kernel.store.state.runs.filter((item) =>
      item.agentId === agentId && (threadId ? item.threadId === threadId : true)
    );
    const index = turns.findIndex((item) => item.id === runId);
    const older = (index < 0 ? [] : turns.slice(index + 1))
      .filter((item) => item.status === "completed" || item.status === "failed" || item.status === "cancelled")
      .reverse();
    const messages: ChatMessage[] = [];
    for (const turn of older) {
      messages.push({ role: "user", content: turn.input });
      if (turn.output) messages.push({ role: "assistant", content: turn.output, reasoning: turn.thinking });
    }
    return messages;
  }

  async complete(
    model: ModelConnection,
    agent: Agent,
    runId: string,
    input: string,
    context: string,
    tools: unknown[],
    actions: RunAction[],
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    this.kernel.guard(agent.id);
    const behavior = behaviorOf(agent);
    const workdir = this.workdirOf(runId);
    const systemPrompt = buildSystemPrompt({
      agent,
      context: workdir
        ? `Working directory: ${workdir}\nThis chat belongs to the project in that folder. The files and code tools read, write and run commands there; paths are relative to it.${context ? `\n\n${context}` : ""}`
        : context,
      serverIds: agent.mcpConnectionIds,
    });
    // Earlier turns newest-first within a budget, so a long thread does not grow every request.
    const history = budgetHistory(this.priorMessages(agent.id, runId));
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...(history.omitted
        ? [{ role: "user" as const, content: `[${history.omitted} earlier messages in this conversation are omitted to save context.]` }]
        : []),
      ...history.kept,
      { role: "user", content: input },
    ];
    if (actions.length) {
      const thinking = this.kernel.store.state.runs.find((item) => item.id === runId)?.thinking;
      // Latest tool results whole (capped); older ones cleared to a stub. The run keeps the originals.
      // Screenshots become placeholders first (their pixels go as images), so trimming never clips base64.
      const sanitized = compactActions(sanitizeActionsForText(actions) as RunAction[]);
      messages.push({ role: "assistant", content: JSON.stringify(sanitized), reasoning: thinking });

      const screenshots = extractScreenshots(actions);
      if (screenshots.length > 0) {
        messages.push({
          role: "user",
          content: "Observation from computer_screenshot (attached as multimodal image input):",
          images: screenshots,
        });
      } else {
        // The results above are the model's own turn; asking it to go on ends the request on a user turn, which
        // every provider accepts (Claude's newest models reject a conversation that ends on the assistant).
        messages.push({ role: "user", content: CONTINUE_AFTER_TOOLS });
      }
    }
    return this.kernel.llm.complete(model, {
      context: { agentId: agent.id, agentName: agent.name, runId, purpose: "run" },
      messages,
      tools,
      temperature: behavior.temperature,
      maxOutput: behavior.maxOutput,
      signal,
    });
  }

  async noteThinking(runId: string, generation: number, body: Record<string, unknown>, elapsed = 0): Promise<void> {
    const next = thinkingOf(body);
    if (!next) return;
    await this.kernel.store.update((state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (!run || (run.generation ?? 0) !== generation) return;
      run.thinking = joinThinking(run.thinking, next);
      run.thoughts = [...(run.thoughts ?? []), { text: next, seconds: Math.round(elapsed * 10) / 10, at: run.actions.length }];
    });
  }

  async finish(runId: string, generation: number, status: Run["status"], output: string, error?: string) {
    let saved = false;
    await this.kernel.store.update((state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (!run || (run.generation ?? 0) !== generation) return;
      run.status = status;
      run.output = output;
      run.error = error;
      saved = true;
    });
    if (!saved) return;
    const run = this.kernel.store.state.runs.find((item) => item.id === runId);
    if (!run) return;
    if (status === "failed") {
      const name = this.kernel.store.state.agents.find((item) => item.id === run.agentId)?.name ?? run.agentId;
      this.kernel.log("agent", "error", `${name} failed: ${clip(error || "Run failed")}`);
    }
  }
}

/** Screenshots, and computer-use actions that return the screen after acting (click, key, scroll…). */
function carriesImage(action: RunAction): boolean {
  return action.toolId.includes("screenshot") || action.toolId.startsWith("computer_");
}

function extractScreenshots(actions: RunAction[]): { mimeType: string; base64: string }[] {
  const images: { mimeType: string; base64: string }[] = [];
  for (const action of actions) {
    if (!carriesImage(action)) continue;
    const res = action.result as Record<string, unknown> | undefined;
    if (!res) continue;
    const raw = res.image || res.screenshot || res.base64;
    if (typeof raw === "string" && raw) {
      if (raw.startsWith("data:")) {
        const match = raw.match(/^data:([^;]+);base64,(.+)$/);
        if (match && match[1] && match[2]) {
          images.push({ mimeType: match[1], base64: match[2] });
        }
      } else if (raw.length > 200 && !raw.includes(" ") && !raw.includes("\n")) {
        images.push({ mimeType: "image/jpeg", base64: raw });
      }
    }
  }
  return images.slice(-2);
}

function sanitizeActionsForText(actions: RunAction[]): unknown[] {
  return actions.map((action) => {
    if (carriesImage(action)) {
      const res = action.result as Record<string, unknown> | undefined;
      if (res && (res.image || res.screenshot || res.base64)) {
        return {
          ...action,
          result: {
            ...res,
            image: "[screenshot attached as multimodal image input]",
            screenshot: undefined,
            base64: undefined,
          },
        };
      }
    }
    return action;
  });
}
