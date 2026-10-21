import type { Run } from "../domain/model.js";
import type { RuntimeKernel } from "./kernel.js";

/**
 * Live updates for the apps, instead of polling: after each saved change the hub works out which runs changed and
 * whether anything else did (agents, chats, settings), at most every THROTTLE_MS, and tells its subscribers.
 * `GET /events` relays that as server-sent events; `GET /runs/:id/events` streams one run whole as it changes.
 */

const THROTTLE_MS = 120;

export type StateEvent = {
  /** Runs whose visible state changed: status, steps, answer, reasoning, approvals. */
  runs: { id: string; threadId?: string; agentId: string; status: Run["status"]; parentRunId?: string }[];
  /** Something other than runs changed (agents, chats, projects, connections, settings). */
  other: boolean;
};

type Listener = (event: StateEvent) => void;

/** A cheap fingerprint of what a run shows; any change in it is worth a refresh. */
export function runFingerprint(run: Run): string {
  const last = run.actions.at(-1);
  return [
    run.status,
    run.generation ?? 0,
    run.actions.length,
    last?.status ?? "",
    last?.result === undefined ? 0 : 1,
    run.output.length,
    run.thinking?.length ?? 0,
    run.error ?? "",
    run.wake?.at ?? "",
    run.verification ? `${run.verification.ok}` : "",
    run.compacted?.turns ?? 0,
    run.checkpoint?.files.length ?? 0,
    run.checkpoint?.files.map((file) => file.review ?? "").join(",") ?? "",
  ].join("|");
}

function otherFingerprint(kernel: RuntimeKernel): string {
  const state = kernel.store.state;
  return JSON.stringify([
    state.agents.map((agent) => [agent.id, agent.name, agent.modelConnectionId, agent.autonomy, agent.status]),
    // Not updatedAt: a new turn moves it, and the run change already refreshes that agent's chats.
    (state.threads ?? []).map((thread) => [thread.id, thread.title, thread.worktree?.branch ?? "", thread.summary?.turns ?? 0, thread.pullRequest ? [thread.pullRequest.state, thread.pullRequest.checks, thread.pullRequest.watching, thread.pullRequest.fixRounds, thread.pullRequest.feedback.length, thread.pullRequest.error ?? ""] : 0]),
    (state.projects ?? []).map((project) => [project.id, project.name, project.access ? 1 : 0]),
    state.models.map((model) => [model.id, model.name, model.effort ?? ""]),
    state.mcp.map((server) => [server.id, server.status ?? "", server.tools.length]),
    state.automations.map((automation) => [automation.id, automation.lastRunAt ?? "", automation.enabled ? 1 : 0]),
  ]);
}

export class EventHub {
  private readonly listeners = new Set<Listener>();
  private runPrints = new Map<string, string>();
  private otherPrint = "";
  private timer: NodeJS.Timeout | undefined;
  private started = false;

  constructor(private readonly kernel: RuntimeKernel) {}

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.snapshot();
    this.kernel.store.onChange(() => this.schedule());
  }

  private snapshot(): void {
    this.runPrints = new Map(this.kernel.store.state.runs.map((run) => [run.id, runFingerprint(run)]));
    this.otherPrint = otherFingerprint(this.kernel);
  }

  private schedule(): void {
    if (this.timer || !this.listeners.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, THROTTLE_MS);
    this.timer.unref?.();
  }

  private flush(): void {
    const runs: StateEvent["runs"] = [];
    const next = new Map<string, string>();
    for (const run of this.kernel.store.state.runs) {
      const print = runFingerprint(run);
      next.set(run.id, print);
      if (this.runPrints.get(run.id) !== print) runs.push({ id: run.id, ...(run.threadId ? { threadId: run.threadId } : {}), agentId: run.agentId, status: run.status, ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}) });
    }
    const removed = [...this.runPrints.keys()].some((id) => !next.has(id));
    this.runPrints = next;
    const other = otherFingerprint(this.kernel);
    const changed = other !== this.otherPrint || removed;
    this.otherPrint = other;
    if (!runs.length && !changed) return;
    const event: StateEvent = { runs, other: changed };
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: Listener): () => void {
    this.start();
    // A new subscriber compares against the state as it is now.
    if (!this.listeners.size) this.snapshot();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
