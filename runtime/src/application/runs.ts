import { writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../domain/errors.js";
import { newId } from "../domain/ids.js";
import { errorText } from "../infrastructure/logger.js";
import { GENERAL_SKILLS_ID, CURSOR_COMPUTER_USE_ID, CURSOR_ORIGIN_ID, ANTIGRAVITY_SKILLS_ID } from "../domain/builtin.js";
import { BROWSER_ID } from "../domain/browser-tools.js";
import { ON_DEMAND_TOOLKITS, toolkitServer } from "../domain/toolkits.js";
import type { CommandSnapshot } from "./checkpoints.js";
import { IDE_ID } from "../domain/ide-tools.js";
import type { Agent, Conversation, ModelConnection, Run, RunAction, RunMode } from "../domain/model.js";
import { autonomyLine, autonomyOf, behaviorOf, buildSystemPrompt, clip, explainRunError, isReadOnlyCall, isSensitiveOperation, mayReadOnly, readOnlyRefusal, joinThinking, styleLine, textOf, thinkingOf, toolCalls } from "../domain/policies.js";
import type { ToolCall } from "./runtime-state.js";
import type { ChatMessage } from "../infrastructure/llm.js";
import type { ImagePart } from "../infrastructure/llm/types.js";
import type { FileCheckpoint } from "../domain/skills/checkpoint.js";
import { forgetImages, loadImages, saveImages } from "./run-images.js";
import { rulesFor } from "./agent-sessions.js";
import { runGeneralSkill, runComputerUseSkill, runOriginSkill, runAntigravitySkill, runBrowserSkill } from "../infrastructure/skills.js";
import { SpanKind, instruments, seconds, traced } from "../infrastructure/telemetry.js";
import { COMPACTION_PROMPT, budgetHistory, compactActions, contextTokensFor, estimateTokens, historyBudgetChars, splitForCompaction } from "../domain/context.js";
import { DEFAULT_SANDBOX, type SandboxSettings } from "../infrastructure/sandbox.js";
import { runsOnPlan } from "../domain/llm/catalog.js";
import { listSkills, loadSkill, skillsPrompt } from "./skill-files.js";
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
/** How many levels a sub-agent may delegate below the chat's own run. */
export const MAX_DELEGATION_DEPTH = 2;
/** Tasks one `delegate` call may run at once. */
export const MAX_PARALLEL_DELEGATIONS = 6;

/** What the user sees when a turn stops at the step limit. */
export function stepLimitNote(): string {
  return `I stopped after ${MAX_TOOL_ROUNDS} tool steps, the limit for one turn, before finishing. Reply "continue" and I will pick up from here.`;
}

const CONTINUE_AFTER_TOOLS = "Continue from the tool results above: use more tools if the task needs them, otherwise give your answer.";


/** One row of the IDE's Agents view (see recentRuns). */
export type RunSummary = {
  id: string;
  agentId: string;
  agentName: string;
  threadId: string;
  threadTitle: string;
  projectId?: string;
  branch?: string;
  status: Run["status"];
  input: string;
  changedFiles: number;
  updatedAt?: string;
};

/** Providers whose Saturn adapter sends a user's images to the model. DeepSeek's API takes text only. */
const SEES_IMAGES = new Set(["claude", "openai", "gemini", "lmstudio", "claude-code", "codex"]);

export class RunService {
  /** Background commands whose file changes are recorded, against the snapshot taken when they started. */
  private readonly trackedJobs = new Map<string, { runId: string; snapshot: CommandSnapshot; actionId: string }>();

  constructor(private readonly kernel: RuntimeKernel) {}

  /** Records what a background command has changed so far (again when it is read, stopped, and when it ends). */
  private async recordJob(jobId: string): Promise<void> {
    const tracked = this.trackedJobs.get(jobId);
    if (tracked) await this.kernel.checkpoints.afterCommand(tracked.runId, tracked.snapshot, tracked.actionId).catch(() => undefined);
  }

  async startRun(agentId: string, input: string, threadId?: string, projectId?: string, options: { images?: ImagePart[]; mode?: RunMode; automatic?: boolean; parent?: { runId: string; task: string; tools: "read-only" | "all" } } = {}): Promise<Run> {
    const agent = this.kernel.getAgent(agentId);
    this.kernel.guard(agent.id);
    const model = this.kernel.store.state.models.find((item) => item.id === agent.modelConnectionId);
    if (!model) throw new HttpError(409, "Agent has no model connection");
    this.kernel.llm.requireKey(model);
    const images = options.images ?? [];
    if (images.length && !SEES_IMAGES.has(model.provider)) {
      throw new HttpError(409, `${model.name} cannot take images. Remove them, or switch the agent to a model that can see (Claude, OpenAI, Gemini, Claude Code, Codex, or a vision model in LM Studio).`);
    }

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
    if (images.length) run.inputImages = await saveImages(this.kernel.store.root, run.id, images);
    if (options.mode && options.mode !== "agent") run.mode = options.mode;
    if (options.automatic) run.automatic = true;
    if (options.parent) {
      run.parentRunId = options.parent.runId;
      run.delegated = { task: options.parent.task, tools: options.parent.tools };
    }
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
    // A Claude Code or Codex run waiting on an approval lived in a process the restart ended, so it is stuck too.
    const programAgents = new Set(
      this.kernel.store.state.agents
        .filter((agent) => {
          const provider = this.kernel.store.state.models.find((model) => model.id === agent.modelConnectionId)?.provider;
          return provider === "claude-code" || provider === "codex";
        })
        .map((agent) => agent.id),
    );
    const stuck = this.kernel.store.state.runs.filter(
      (run) => run.status === "running" || run.status === "queued" || (run.status === "waiting_approval" && programAgents.has(run.agentId)),
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
    // Sub-agent runs ride on the run that delegated them (nested in its steps), not as turns of the chat.
    return list.filter((item) => !item.parentRunId).map((item) => this.withChildren(item)).reverse();
  }

  /** The run with its sub-agent runs attached, each with its own, newest first within the thread order. */
  withChildren(run: Run): Run {
    const children = this.kernel.store.state.runs.filter((item) => item.parentRunId === run.id).reverse().map((item) => this.withChildren(item));
    return children.length ? { ...run, children } : run;
  }

  /** The run that started a chain of delegations, so checkpoints and reviews gather on it. */
  rootRunId(runId: string): string {
    let current = this.kernel.store.state.runs.find((item) => item.id === runId);
    for (let depth = 0; current?.parentRunId && depth < 10; depth += 1) {
      current = this.kernel.store.state.runs.find((item) => item.id === current!.parentRunId);
    }
    return current?.id ?? runId;
  }

  private depthOf(runId: string): number {
    let depth = 0;
    let current = this.kernel.store.state.runs.find((item) => item.id === runId);
    while (current?.parentRunId && depth < 10) {
      depth += 1;
      current = this.kernel.store.state.runs.find((item) => item.id === current!.parentRunId);
    }
    return depth;
  }

  /** Waits for a run to settle; a stopped parent stops it instead. */
  private async waitForRun(runId: string, signal?: AbortSignal): Promise<Run> {
    for (;;) {
      const run = this.kernel.getRun(runId);
      if (run.status !== "running" && run.status !== "queued" && run.status !== "waiting_approval" && run.status !== "sleeping") return run;
      if (signal?.aborted) {
        await this.stopRun(runId);
        throw new Error("The delegating run was stopped");
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  /**
   * The `delegate` tool: one or more sub-agent runs in the same chat, each with a fresh context (only its task),
   * run in parallel and waited for; only their final answers come back. A read-only sub-agent runs in Ask mode;
   * one with all tools inherits this run's mode, approvals (its cards show nested under this step) and sandbox.
   */
  private async delegate(input: { agentId: string; arguments: Record<string, unknown>; runId: string; signal?: AbortSignal }): Promise<unknown> {
    const parent = this.kernel.getRun(input.runId);
    if (this.depthOf(input.runId) >= MAX_DELEGATION_DEPTH) throw new Error(`Sub-agents may not delegate further than ${MAX_DELEGATION_DEPTH} levels deep; do this task yourself.`);
    const tasks = [
      ...(typeof input.arguments.task === "string" && input.arguments.task.trim() ? [input.arguments.task.trim()] : []),
      ...(Array.isArray(input.arguments.tasks) ? input.arguments.tasks.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()) : []),
    ];
    if (!tasks.length) throw new Error("Give the sub-agent a task (task, or tasks for several)");
    if (tasks.length > MAX_PARALLEL_DELEGATIONS) throw new Error(`At most ${MAX_PARALLEL_DELEGATIONS} tasks at once`);
    const tools = input.arguments.tools === "all" ? "all" : "read-only";
    const wanted = typeof input.arguments.agent === "string" ? input.arguments.agent.trim() : "";
    const agent = wanted
      ? this.kernel.store.state.agents.find((item) => item.id === wanted || item.name.toLowerCase() === wanted.toLowerCase())
      : this.kernel.getAgent(input.agentId);
    if (!agent) throw new Error(`No agent named "${wanted}"`);
    // Read-only sub-agents run in Ask mode; others inherit the mode of this turn (an Ask turn cannot escape it).
    const mode: RunMode = tools === "read-only" || parent.mode === "ask" || parent.mode === "plan" ? "ask" : parent.mode ?? "agent";
    const started = await Promise.all(tasks.map((task) => this.startRun(agent.id, task, parent.threadId, undefined, { mode, parent: { runId: input.runId, task, tools } })));
    this.kernel.log("agent", "info", `${agent.name}: ${started.length} sub-agent ${started.length === 1 ? "run" : "runs"} started by ${input.runId}`, { "saturn.run.id": input.runId });
    const finished = await Promise.all(started.map((run) => this.waitForRun(run.id, input.signal)));
    return {
      results: finished.map((run) => ({
        task: run.delegated?.task ?? run.input,
        runId: run.id,
        status: run.status,
        answer: run.output || (run.error ? `(failed: ${run.error})` : "(no answer)"),
        steps: run.actions.length,
      })),
    };
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
    this.kernel.jobs.stopAll(threadId);
    await this.kernel.store.update((state) => {
      state.threads = (state.threads ?? []).filter((t) => t.id !== threadId);
      state.runs = state.runs.filter((r) => r.threadId !== threadId);
    });
    await this.kernel.checkpoints.forget(removed);
    await forgetImages(this.kernel.store.root, removed);
  }

  /**
   * The runs worth showing in a list of agents at work: every run still going (running, queued, waiting for an
   * approval, sleeping), then the latest finished ones, newest first. Group turns are left out.
   */
  recentRuns(projectId?: string, limit = 20): RunSummary[] {
    const threads = new Map((this.kernel.store.state.threads ?? []).map((thread) => [thread.id, thread]));
    const agents = new Map(this.kernel.store.state.agents.map((agent) => [agent.id, agent]));
    const active = new Set(["running", "queued", "waiting_approval", "sleeping"]);
    const runs = this.kernel.store.state.runs.filter((run) => {
      if (run.groupId || !run.threadId || run.parentRunId) return false;
      return !projectId || threads.get(run.threadId)?.projectId === projectId;
    });
    const picked = [...runs.filter((run) => active.has(run.status)), ...runs.filter((run) => !active.has(run.status)).slice(0, Math.max(0, limit))];
    return picked.map((run) => {
      const thread = threads.get(run.threadId!);
      return {
        id: run.id,
        agentId: run.agentId,
        agentName: agents.get(run.agentId)?.name ?? "Agent",
        threadId: run.threadId!,
        threadTitle: thread?.title ?? "Chat",
        ...(thread?.projectId ? { projectId: thread.projectId } : {}),
        ...(thread?.worktree ? { branch: thread.worktree.branch } : {}),
        status: run.status,
        input: clip(run.input.split("\n<saturn_context")[0] ?? run.input, 120),
        changedFiles: run.checkpoint?.files.filter((file) => file.before !== file.after).length ?? 0,
        ...(thread?.updatedAt ? { updatedAt: thread.updatedAt } : {}),
      };
    });
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
    if (removed.length) await forgetImages(this.kernel.store.root, removed);
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
    for (const child of this.kernel.store.state.runs.filter((item) => item.parentRunId === id)) await this.stopRun(child.id);
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
        ? await this.kernel.hooks.afterTool(agent, run, await this.executeTool({ agentId: agent.id, toolId: pending.toolId, arguments: pending.arguments, runId, actionId: pending.id, signal }), signal)
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
      await this.finishFromModel(runId, generation, agent, model, context, this.toolList(agent, this.kernel.getRun(runId).mode, runId), actions, signal);
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

  /** The project's .git folder when the run works in a chat's worktree (empty otherwise). */
  private async worktreeGitDir(runId: string): Promise<string[]> {
    const run = this.kernel.store.state.runs.find((item) => item.id === runId);
    const thread = run?.threadId ? (this.kernel.store.state.threads ?? []).find((item) => item.id === run.threadId) : undefined;
    const folder = thread?.worktree ? this.kernel.worktrees.pathOf(thread) : undefined;
    if (!folder) return [];
    const dir = await this.kernel.worktrees.gitCommonDir(folder);
    return dir ? [dir] : [];
  }

  /** The user's own prompt commands (the composer's "/" menu). */
  userCommandsDir(): string {
    return path.join(this.kernel.store.root, "commands");
  }

  /** The user's own skills, available in every chat. */
  userSkillsDir(): string {
    return path.join(this.kernel.store.root, "skills");
  }

  /** Background commands belong to the chat, or to the agent outside one, so they outlive the turn. */
  jobScopeOf(runId: string): string {
    const run = this.kernel.store.state.runs.find((item) => item.id === runId);
    return run?.threadId ?? `agent:${run?.agentId ?? "unknown"}`;
  }

  /** The sandbox the run's commands get: the project's setting, else the setting for everywhere, else the default. */
  sandboxOf(runId: string): SandboxSettings {
    const run = this.kernel.store.state.runs.find((item) => item.id === runId);
    const thread = run?.threadId ? (this.kernel.store.state.threads ?? []).find((t) => t.id === run.threadId) : undefined;
    const project = thread?.projectId ? (this.kernel.store.state.projects ?? []).find((item) => item.id === thread.projectId) : undefined;
    return project?.sandbox ?? this.kernel.store.state.settings.sandbox ?? DEFAULT_SANDBOX;
  }

  /** The project folder a run works in, or undefined for chats outside a project (the private sandbox). */
  private workdirOf(runId: string): string | undefined {
    const run = this.kernel.store.state.runs.find((item) => item.id === runId);
    const thread = run?.threadId ? (this.kernel.store.state.threads ?? []).find((t) => t.id === run.threadId) : undefined;
    return this.kernel.projects.workdirFor(thread);
  }

  /**
   * One editor tool, answered by the Saturn IDE window that has the chat's project open. Paths stay inside the
   * project; a rename comes back as each file's new content and is written here, through the run's checkpoint,
   * so it shows in the review and can be reverted like any other edit.
   */
  private async runIdeTool(input: { toolId: string; arguments: Record<string, unknown>; runId: string; actionId: string; signal?: AbortSignal }): Promise<unknown> {
    const workdir = this.workdirOf(input.runId);
    if (!workdir) throw new Error("Editor tools work in a project chat: this chat has no project folder.");
    const inside = (file: string) => {
      const full = path.resolve(workdir, file);
      if (full !== workdir && !full.startsWith(workdir + path.sep)) throw new Error(`${file} is outside the project folder`);
      return full;
    };
    const args = { ...input.arguments };
    if (typeof args.path === "string") args.path = inside(args.path);
    const result = await this.kernel.ide.call(workdir, input.toolId, args, input.signal);
    if (input.toolId !== "ide_rename") return relativize(result, workdir);
    const edits = (result as { files?: { path: string; content: string }[] } | undefined)?.files ?? [];
    const checkpoint = withStep(this.kernel.checkpoints.forRun(this.rootRunId(input.runId), workdir), input.actionId);
    const changed: string[] = [];
    for (const edit of edits) {
      const target = inside(edit.path);
      await checkpoint.before(target);
      await writeFile(target, edit.content, "utf8");
      await checkpoint.after(target);
      changed.push(path.relative(workdir, target).split(path.sep).join("/"));
    }
    return { renamed: input.arguments.symbol, to: input.arguments.newName, files: changed };
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
    // A toolkit's tool called before loading it (its name is in the instructions): it counts as loaded.
    if (ON_DEMAND_TOOLKITS[serverId] && !this.loadedToolkits(input.runId).has(serverId)) {
      await this.loadToolkits(input.runId, [serverId]);
    }
    if (serverId === GENERAL_SKILLS_ID && input.toolId === "skill") {
      const name = typeof input.arguments.name === "string" ? input.arguments.name : "";
      const loaded = name ? await loadSkill(this.workdirOf(input.runId), this.userSkillsDir(), name, this.kernel.plugins.enabledFolders()) : undefined;
      if (!loaded) {
        const known = (await listSkills(this.workdirOf(input.runId), this.userSkillsDir(), this.kernel.plugins.enabledFolders())).map((item) => item.name).join(", ") || "none";
        return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "failed", reason: `No skill named "${name}". Available: ${known}` };
      }
      return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "completed", result: loaded };
    }
    if (serverId === GENERAL_SKILLS_ID && input.toolId === "load_tools") {
      const names = Array.isArray(input.arguments.toolkits) ? input.arguments.toolkits.map(String) : [String(input.arguments.toolkits ?? "")];
      const ids = names.map(toolkitServer).filter((id): id is string => Boolean(id) && agent.mcpConnectionIds.includes(id!));
      if (!ids.length) {
        const offered = agent.mcpConnectionIds.filter((id) => ON_DEMAND_TOOLKITS[id]).map((id) => ON_DEMAND_TOOLKITS[id]!.name).join(", ") || "none";
        return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "failed", reason: `No such toolkit for this agent. Available: ${offered}` };
      }
      await this.loadToolkits(input.runId, ids);
      const loaded = this.kernel.store.state.mcp.filter((server) => ids.includes(server.id)).map((server) => ({ toolkit: ON_DEMAND_TOOLKITS[server.id]!.name, tools: server.tools.filter((tool) => !server.disabledTools?.includes(tool.toolId)).map((tool) => tool.toolId) }));
      return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "completed", result: { loaded, note: "These tools can be called from the next step on." } };
    }
    if (serverId === GENERAL_SKILLS_ID && input.toolId === "delegate") {
      try {
        const result = await this.delegate(input);
        return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "completed", result };
      } catch (error) {
        return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "failed", reason: error instanceof Error ? error.message : "Delegation failed" };
      }
    }
    if (serverId === GENERAL_SKILLS_ID) {
      try {
        const workdir = this.workdirOf(input.runId);
        // A shell command's file changes join the run's checkpoint too (git folders), so they can be reviewed and reverted.
        const background = input.arguments.background === true;
        const tracked = input.toolId === "code" && workdir
          ? await this.kernel.checkpoints.beforeCommand(this.rootRunId(input.runId), workdir)
          : null;
        const result = await runGeneralSkill(this.kernel.store.root, input.toolId, input.arguments, async (toolId, args) => {
          const action = await this.executeTool({ ...input, toolId, arguments: args, actionId: newId("act") });
          if (action.status !== "completed") throw new Error(action.reason || "MCP call failed");
          return action.result;
        }, input.signal, workdir, workdir ? withStep(this.kernel.checkpoints.forRun(this.rootRunId(input.runId), workdir), input.actionId) : undefined, {
          sandbox: this.sandboxOf(input.runId),
          // A worktree keeps its git data in the project's .git: sandboxed commits must be able to write there.
          writable: [path.join(this.kernel.store.root, "workspace"), ...(input.toolId === "code" ? await this.worktreeGitDir(input.runId) : [])],
          jobs: { table: this.kernel.jobs, scope: this.jobScopeOf(input.runId) },
        }).finally(async () => {
          // A failing command can still have changed files.
          if (tracked && !background) await this.kernel.checkpoints.afterCommand(this.rootRunId(input.runId), tracked, input.actionId).catch(() => undefined);
        });
        const jobId = (result as { jobId?: unknown } | undefined)?.jobId;
        if (tracked && background && typeof jobId === "string") {
          // A background command changes files as it runs: recorded when it is read or stopped, and when it ends.
          this.trackedJobs.set(jobId, { runId: this.rootRunId(input.runId), snapshot: tracked, actionId: input.actionId });
          void this.kernel.jobs.whenEnded(jobId).then(async () => {
            await this.recordJob(jobId);
            this.trackedJobs.delete(jobId);
          });
        }
        if ((input.toolId === "code_output" || input.toolId === "code_stop") && typeof input.arguments.jobId === "string") await this.recordJob(input.arguments.jobId);
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
    if (serverId === IDE_ID) {
      try {
        const result = await this.runIdeTool(input);
        return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "completed", result };
      } catch (error) {
        return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "failed", reason: error instanceof Error ? error.message : "Editor tool failed" };
      }
    }
    if (serverId === BROWSER_ID) {
      try {
        const result = await runBrowserSkill(this.kernel.store.root, input.toolId, input.arguments, input.signal, this.kernel.store.state.settings.browser ?? "saturn");
        return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "completed", result };
      } catch (error) {
        return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "failed", reason: error instanceof Error ? error.message : "Browser tool failed" };
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
        // Rules and skills are written in the chat's project (or the agent's workspace), not the runtime's own folder.
        const workspaceDir = this.workdirOf(input.runId) ?? path.join(this.kernel.store.root, "workspace");
        const result = await runAntigravitySkill(this.kernel.store.root, input.toolId, input.arguments, input.signal, {
          automations: this.kernel.automations,
          agentId: input.agentId,
          workspaceDir,
          plugins: this.kernel.plugins,
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
        this.noteFinished(runId, generation);
        return;
      }
      if (model.provider === "codex") {
        // The official Codex SDK runs the whole agent loop (commands, edits, thread) itself.
        await this.kernel.codex.run(runId, generation, agent, model, signal);
        this.noteFinished(runId, generation);
        return;
      }
      const context = await this.ragContext(agent, run.input, signal);
      if (!this.kernel.alive(runId, generation)) return;
      const tools = this.toolList(agent, run.mode, runId);
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
    const turnMode = this.kernel.store.state.runs.find((item) => item.id === runId)?.mode;
    for (let index = 0; index < calls.length; index += 1) {
      if (!this.kernel.alive(runId, generation) || signal.aborted) return true;
      this.kernel.guard(agent.id);
      const call = calls[index];

      // An Ask or Plan turn only reads: a tool that would change something is refused, and the model is told why.
      if ((turnMode === "ask" || turnMode === "plan") && !isReadOnlyCall(call.name, call.arguments, this.toolCategory(agent, call.name))) {
        const refused: RunAction = { id: newId("act"), toolId: call.name, arguments: call.arguments, status: "denied", reason: readOnlyRefusal(turnMode) };
        if (call.thoughtSignature) refused.thoughtSignature = call.thoughtSignature;
        actions.push(refused);
        continue;
      }

      // pre_tool hooks first: exit 2 or a "deny" answer refuses the call; "allow" and "ask" act like rules.
      const hooked = await this.kernel.hooks.beforeTool(agent, this.kernel.getRun(runId), call.name, call.arguments, signal);
      if (hooked.blocked) {
        const refused: RunAction = { id: newId("act"), toolId: call.name, arguments: call.arguments, status: "denied", reason: `Blocked by a hook: ${hooked.blocked}` };
        if (call.thoughtSignature) refused.thoughtSignature = call.thoughtSignature;
        actions.push(refused);
        this.kernel.log("agent", "warning", `${agent.name} ${call.name} blocked by a pre_tool hook`);
        continue;
      }

      // The permission rules first (the user's, the project's, the agent's, the project's settings files): a
      // deny rule refuses the call, an allow rule runs it without asking in any mode, an ask rule asks.
      const ruled = await this.kernel.permissions.decide(agent, { threadId: this.kernel.store.state.runs.find((item) => item.id === runId)?.threadId }, call.name, call.arguments);
      // A hook's answer counts like a rule from the hook; the stricter of the two wins.
      const ruling = hooked.decision === "ask" && ruled?.effect !== "deny"
        ? { effect: "ask" as const, rule: { tool: call.name, pattern: "*", effect: "ask" as const }, scope: "user" as const, path: "hook" }
        : hooked.decision === "allow" && !ruled
          ? { effect: "allow" as const, rule: { tool: call.name, pattern: "*", effect: "allow" as const }, scope: "user" as const, path: "hook" }
          : ruled;
      if (ruling?.effect === "deny") {
        const refused: RunAction = { id: newId("act"), toolId: call.name, arguments: call.arguments, status: "denied", reason: this.kernel.permissions.explain(ruling) };
        if (call.thoughtSignature) refused.thoughtSignature = call.thoughtSignature;
        actions.push(refused);
        this.kernel.log("agent", "warning", `${agent.name} ${call.name} denied by a permission rule (${ruling.scope})`);
        continue;
      }

      // Antigravity guardrail enforcement
      let requiresApproval = false;
      let approvalReason = "";

      // Leaving the sandbox (`code` with sandbox: "off") asks in every mode but bypass, whatever the rules say.
      const escapes = call.name === "code" && call.arguments.sandbox === "off" && this.sandboxOf(runId).mode !== "off";
      if (escapes && mode !== "bypass") {
        requiresApproval = true;
        approvalReason = "Runs outside the sandbox: this command may write anywhere on this computer";
      } else if (ruling?.effect === "ask") {
        requiresApproval = true;
        approvalReason = ruling.path === "hook" ? hooked.reason ?? "Asked by a hook" : this.kernel.permissions.explain(ruling);
      } else if (ruling?.effect === "allow") {
        requiresApproval = false;
      } else if (mode === "review") {
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

      const action = await this.kernel.hooks.afterTool(agent, this.kernel.getRun(runId), await this.executeTool({
        agentId: agent.id,
        toolId: call.name,
        arguments: call.arguments,
        runId,
        actionId: newId("act"),
        signal,
      }), signal);
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
      const target = this.kernel.catalog.targetFor(server);
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

  /** A tool's declared read/write category, when its server declares one. */
  toolCategory(agent: Agent, toolId: string): "read" | "write" | undefined {
    for (const server of this.kernel.store.state.mcp) {
      if (!agent.mcpConnectionIds.includes(server.id)) continue;
      const tool = server.tools.find((item) => item.toolId === toolId);
      if (tool) return tool.category;
    }
    return undefined;
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
    // Tools the run has taken so far may have loaded a toolkit (load_tools).
    tools = this.toolList(agent, run.mode, runId);
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
      // A toolkit loaded in this round brings its tools to the next request.
      tools = this.toolList(agent, run.mode, runId);
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
      // A failed tool call the agent recovered from (a rejected patch it redid as a write, say) is part of the work:
      // the turn failed only when something went wrong and the agent ended without an answer.
      const troubled = actions.some((item) => item.status === "failed" || (item.status === "denied" && item.reason !== DENIED_BY_USER && !item.reason?.includes("mode only reads")));
      const answered = !cutOff && textOf(response).trim().length > 0;
      current.status = troubled && !answered ? "failed" : "completed";
      saved = true;
    });
    if (!saved) return;
    const current = this.kernel.getRun(runId);
    this.kernel.log("agent", current.status === "failed" ? "error" : "info", `${agent.name} ${current.status}`);
    // A sub-agent's turn feeds neither memory nor verification: the run that delegated it does, once it finishes.
    if (current.parentRunId) return;
    void this.kernel.memory.noteRun(current);
    void this.kernel.verify.afterRun(current).catch((error) => this.kernel.log("agent", "warning", `Verification failed to run: ${errorText(error)}`, { "saturn.run.id": runId }));
    void this.kernel.hooks.afterRun(current).catch((error) => this.kernel.log("agent", "warning", `Stop hooks failed to run: ${errorText(error)}`, { "saturn.run.id": runId }));
    void this.kernel.pullRequests.afterRun(runId);
  }

  /** A Claude Code or Codex turn that completed feeds memory, as a local run's does when it finishes. */
  private noteFinished(runId: string, generation: number): void {
    const run = this.kernel.store.state.runs.find((item) => item.id === runId);
    if (!run || (run.generation ?? 0) !== generation || run.status !== "completed") return;
    void this.kernel.pullRequests.afterRun(runId);
    void this.kernel.memory.noteRun(run);
    void this.kernel.verify.afterRun(run).catch((error) => this.kernel.log("agent", "warning", `Verification failed to run: ${errorText(error)}`, { "saturn.run.id": runId }));
  }

  /** The tools the model is offered; an Ask or Plan turn gets only those that can read without changing anything. */
  /** On-demand toolkits loaded in this chat so far (any of its turns), or by this run and its parent. */
  loadedToolkits(runId?: string): Set<string> {
    const runs = this.kernel.store.state.runs;
    const run = runId ? runs.find((item) => item.id === runId) : undefined;
    if (!run) return new Set();
    const related = runs.filter((item) => item.id === run.id || item.id === run.parentRunId || (run.threadId && !run.parentRunId && item.threadId === run.threadId && !item.parentRunId));
    return new Set(related.flatMap((item) => item.toolkits ?? []));
  }

  /** The agent's on-demand toolkits not loaded yet; none without General Skills, which has load_tools. */
  deferredToolkits(agent: Agent, runId?: string): string[] {
    if (!agent.mcpConnectionIds.includes(GENERAL_SKILLS_ID)) return [];
    const loaded = this.loadedToolkits(runId);
    return agent.mcpConnectionIds.filter((id) => ON_DEMAND_TOOLKITS[id] && !loaded.has(id));
  }

  private async loadToolkits(runId: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.kernel.store.update((state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (run) run.toolkits = [...new Set([...(run.toolkits ?? []), ...ids])];
    });
  }

  toolList(agent: Agent, mode?: RunMode, runId?: string) {
    const readOnly = mode === "ask" || mode === "plan";
    // The editor tools only when Saturn IDE has this chat's project open.
    const ide = this.kernel.ide.available(runId ? this.workdirOf(runId) : undefined);
    const deferred = this.deferredToolkits(agent, runId);
    return this.kernel.store.state.mcp
      .filter((item) => agent.mcpConnectionIds.includes(item.id))
      .filter((item) => item.id !== IDE_ID || ide)
      .filter((item) => !deferred.includes(item.id))
      .flatMap((server) =>
        server.tools
          .filter((tool) => !server.disabledTools?.includes(tool.toolId))
          .filter((tool) => tool.toolId !== "load_tools" || deferred.length > 0)
          .filter((tool) => !readOnly || mayReadOnly(tool.toolId, tool.category))
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

  /** The finished turns before `runId` in its chat (or, outside a chat, the agent's), oldest first. */
  priorTurns(agentId: string, runId: string): Run[] {
    const currentRun = this.kernel.store.state.runs.find((item) => item.id === runId);
    const threadId = currentRun?.threadId;
    // A group turn carries the group transcript in its input.
    if (currentRun?.groupId) return [];
    // A sub-agent run has a fresh context: no earlier turns at all. The chat's turns leave sub-agent runs out.
    if (currentRun?.parentRunId) return [];
    const turns = this.kernel.store.state.runs.filter((item) =>
      item.agentId === agentId && !item.parentRunId && (threadId ? item.threadId === threadId : true)
    );
    const index = turns.findIndex((item) => item.id === runId);
    return (index < 0 ? [] : turns.slice(index + 1))
      .filter((item) => item.status === "completed" || item.status === "failed" || item.status === "cancelled")
      .reverse();
  }

  private turnMessages(turns: Run[]): ChatMessage[] {
    const messages: ChatMessage[] = [];
    for (const turn of turns) {
      const attached = turn.inputImages?.length ? `\n[${turn.inputImages.length} ${turn.inputImages.length === 1 ? "image was" : "images were"} attached to this message]` : "";
      messages.push({ role: "user", content: turn.input + attached });
      if (turn.output) messages.push({ role: "assistant", content: turn.output, reasoning: turn.thinking });
    }
    return messages;
  }

  priorMessages(agentId: string, runId: string): ChatMessage[] {
    return this.turnMessages(this.priorTurns(agentId, runId));
  }

  /** The turns a chat's summary does not cover yet, oldest first. */
  private turnsAfterSummary(turns: Run[], summary: Conversation["summary"]): Run[] {
    if (!summary) return turns;
    const index = turns.findIndex((item) => item.id === summary.throughRunId);
    // The summarized turn was removed (an edit, a restore): the summary still stands, and every turn left is newer.
    return index < 0 ? turns : turns.slice(index + 1);
  }

  private summaryMessage(summary: NonNullable<Conversation["summary"]>): ChatMessage {
    return { role: "user", content: `[Summary of the earlier conversation, ${summary.turns} ${summary.turns === 1 ? "turn" : "turns"}, written by the assistant to continue it]\n${summary.text}` };
  }

  /**
   * The earlier turns a request carries: the chat's summary (when it has one) and the turns after it. When they
   * exceed the model's budget, the oldest turns are folded into the summary first, by the same model; if that
   * fails the oldest turns are left out, as before.
   */
  async historyFor(agent: Agent, model: ModelConnection, runId: string, signal?: AbortSignal): Promise<ChatMessage[]> {
    const run = this.kernel.store.state.runs.find((item) => item.id === runId);
    const thread = run?.threadId ? (this.kernel.store.state.threads ?? []).find((item) => item.id === run.threadId) : undefined;
    const all = this.priorTurns(agent.id, runId);
    let summary = thread?.summary;
    let turns = this.turnsAfterSummary(all, summary);
    const budget = historyBudgetChars(model);
    const sized = () => turns.map((turn) => ({ turn, chars: this.turnMessages([turn]).reduce((sum, item) => sum + item.content.length, 0) }));
    const total = () => sized().reduce((sum, item) => sum + item.chars, 0) + (summary?.text.length ?? 0);

    if (thread && total() > budget && turns.length > 1) {
      const { old, recent } = splitForCompaction(sized(), Math.floor(budget / 2));
      if (old.length) {
        try {
          const text = await this.summarize(agent, model, runId, summary?.text, old.map((item) => item.turn), signal);
          const next = { text, throughRunId: old[old.length - 1]!.turn.id, turns: (summary?.turns ?? 0) + old.length, createdAt: new Date().toISOString() };
          await this.kernel.store.update((state) => {
            const current = (state.threads ?? []).find((item) => item.id === thread.id);
            if (current) current.summary = next;
            const active = state.runs.find((item) => item.id === runId);
            if (active) active.compacted = { turns: old.length, at: next.createdAt };
          });
          this.kernel.log("agent", "info", `${agent.name}: ${old.length} earlier ${old.length === 1 ? "turn" : "turns"} of the chat folded into its summary (${estimateTokens(text)} tokens)`, { "saturn.run.id": runId });
          summary = next;
          turns = recent.map((item) => item.turn);
        } catch (error) {
          this.kernel.log("agent", "warning", `Could not summarize the chat's earlier turns: ${explainRunError(error)}; the oldest are left out instead`, { "saturn.run.id": runId });
        }
      }
    }
    const history = budgetHistory(this.turnMessages(turns), Math.max(1, budget - (summary?.text.length ?? 0)));
    return [
      ...(summary ? [this.summaryMessage(summary)] : []),
      ...(history.omitted ? [{ role: "user" as const, content: `[${history.omitted} earlier messages in this conversation are omitted to save context.]` }] : []),
      ...history.kept,
    ];
  }

  /** One model call that writes the summary of `turns` (folding in `previous` when there is one). */
  private async summarize(agent: Agent, model: ModelConnection, runId: string, previous: string | undefined, turns: Run[], signal?: AbortSignal): Promise<string> {
    const body = await this.kernel.llm.complete(model, {
      context: { agentId: agent.id, agentName: agent.name, runId, purpose: "compaction" },
      temperature: 0,
      maxOutput: 1500,
      thinking: "low",
      messages: [
        { role: "system", content: COMPACTION_PROMPT },
        ...(previous ? [{ role: "user" as const, content: `Earlier summary:\n${previous}` }] : []),
        ...this.turnMessages(turns),
        { role: "user", content: "Write the summary now." },
      ],
      signal,
    });
    const text = textOf(body).trim();
    if (!text) throw new Error("the model returned no summary");
    return text;
  }

  /** How full the chat's context is for its agent's model, and what its summary covers. */
  contextUsage(threadId: string): { usedTokens: number; budgetTokens: number; windowTokens: number; percent: number; turns: number; summary: { turns: number; createdAt: string } | null } {
    const thread = (this.kernel.store.state.threads ?? []).find((item) => item.id === threadId);
    if (!thread) throw new HttpError(404, "Chat not found");
    const agent = this.kernel.getAgent(thread.agentId);
    const model = this.kernel.store.state.models.find((item) => item.id === agent.modelConnectionId);
    const finished = this.kernel.store.state.runs
      .filter((item) => item.threadId === threadId && !item.parentRunId && (item.status === "completed" || item.status === "failed" || item.status === "cancelled"))
      .reverse();
    const turns = this.turnsAfterSummary(finished, thread.summary);
    const chars = this.turnMessages(turns).reduce((sum, item) => sum + item.content.length, 0) + (thread.summary?.text.length ?? 0);
    const budgetChars = model ? historyBudgetChars(model) : 60_000;
    return {
      usedTokens: estimateTokens(" ".repeat(chars)),
      budgetTokens: estimateTokens(" ".repeat(budgetChars)),
      windowTokens: model ? contextTokensFor(model) : 0,
      percent: Math.min(100, Math.round((chars / budgetChars) * 100)),
      turns: turns.length,
      summary: thread.summary ? { turns: thread.summary.turns, createdAt: thread.summary.createdAt } : null,
    };
  }

  /** Folds every finished turn of the chat into its summary now (the "/compact" command). */
  async compactThread(threadId: string): Promise<{ summary: NonNullable<Conversation["summary"]>; folded: number }> {
    const thread = (this.kernel.store.state.threads ?? []).find((item) => item.id === threadId);
    if (!thread) throw new HttpError(404, "Chat not found");
    const agent = this.kernel.getAgent(thread.agentId);
    const model = this.kernel.store.state.models.find((item) => item.id === agent.modelConnectionId);
    if (!model) throw new HttpError(409, "This agent has no model connection");
    if (runsOnPlan(model.provider)) throw new HttpError(409, `${model.name} runs in its own program, which manages its own context; there is nothing for Saturn to compact.`);
    const finished = this.kernel.store.state.runs
      .filter((item) => item.threadId === threadId && !item.parentRunId && (item.status === "completed" || item.status === "failed" || item.status === "cancelled"))
      .reverse();
    const turns = this.turnsAfterSummary(finished, thread.summary);
    if (!turns.length) throw new HttpError(409, thread.summary ? "Every turn is in the summary already" : "Nothing to compact yet");
    const text = await this.summarize(agent, model, finished[finished.length - 1]!.id, thread.summary?.text, turns);
    const summary = { text, throughRunId: turns[turns.length - 1]!.id, turns: (thread.summary?.turns ?? 0) + turns.length, createdAt: new Date().toISOString() };
    await this.kernel.store.update((state) => {
      const current = (state.threads ?? []).find((item) => item.id === threadId);
      if (current) current.summary = summary;
    });
    this.kernel.log("agent", "info", `${agent.name}: the chat was compacted on request (${turns.length} ${turns.length === 1 ? "turn" : "turns"} folded)`);
    return { summary, folded: turns.length };
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
    const threadForPrompt = this.kernel.store.state.runs.find((item) => item.id === runId)?.threadId;
    const projectForPrompt = threadForPrompt ? (this.kernel.store.state.threads ?? []).find((t) => t.id === threadForPrompt)?.projectId : undefined;
    const memory = await this.kernel.memory.forPrompt(projectForPrompt);
    const planApproval = this.kernel.store.state.settings.planApproval === true;
    const current = this.kernel.store.state.runs.find((item) => item.id === runId);
    const images = await loadImages(this.kernel.store.root, current?.inputImages);
    const rules = current ? await rulesFor(this.kernel, current) : "";
    const systemPrompt = buildSystemPrompt({
      agent,
      memory,
      rules,
      planApproval,
      mode: current?.mode,
      context: [
        workdir ? `Working directory: ${workdir}\nThis chat belongs to the project in that folder. The files and code tools read, write and run commands there; paths are relative to it.` : "",
        context,
        // Only when the agent has the skill tool (General Skills): names and descriptions, loaded on demand.
        agent.mcpConnectionIds.includes(GENERAL_SKILLS_ID) ? skillsPrompt(await listSkills(workdir, this.userSkillsDir(), this.kernel.plugins.enabledFolders())) : "",
      ].filter(Boolean).join("\n\n"),
      serverIds: agent.mcpConnectionIds,
      deferred: this.deferredToolkits(agent, runId),
    });
    // Earlier turns within the model's budget: the chat's summary, then the turns after it (see historyFor).
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...(await this.historyFor(agent, model, runId, signal)),
      images.length ? { role: "user", content: input, images } : { role: "user", content: input },
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

/** A run's checkpoint hooks, tagging each write with the tool step that makes it. */
function withStep(checkpoint: FileCheckpoint, actionId: string): FileCheckpoint {
  return { before: (target) => checkpoint.before(target, actionId), after: (target) => checkpoint.after(target) };
}

/** An editor answer with the project folder taken off its paths, as the agent's other tools report them. */
function relativize(value: unknown, root: string): unknown {
  if (typeof value === "string") return value.startsWith(root + path.sep) ? value.slice(root.length + 1).split(path.sep).join("/") : value;
  if (Array.isArray(value)) return value.map((item) => relativize(item, root));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relativize(item, root)]));
  return value;
}
