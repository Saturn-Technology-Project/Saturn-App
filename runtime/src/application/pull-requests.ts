import { HttpError } from "../domain/errors.js";
import type { Conversation, PullRequestFeedback, PullRequestWatch } from "../domain/model.js";
import { errorText } from "../infrastructure/logger.js";
import { runOriginSkill } from "../infrastructure/skills.js";
import type { OriginContext } from "../infrastructure/skills/origin-skill.js";
import type { RuntimeKernel } from "./kernel.js";

/**
 * Following a pull request after Saturn opened it from a chat's worktree, the way Claude Code does:
 *
 * - every CHECK_INTERVAL_MS (and on request) it reads the pull request's state, its head's checks, and its comments
 *   and unresolved review threads, with the user's GitHub token;
 * - when the checks fail on a head it has not handled, it hands the failing checks' log tails to the chat's agent as
 *   an automatic turn in the same worktree, at most MAX_FIX_ROUNDS times, and when that turn ends with changes it
 *   commits and pushes them, so the checks run again;
 * - new comments are kept as feedback the user can send to the agent with one click (they come from other people,
 *   so nothing is sent on its own);
 * - it stops when the pull request is merged or closed, or when the user stops following it.
 */

export const CHECK_INTERVAL_MS = 120_000;
export const MAX_FIX_ROUNDS = 2;
const LOG_LIMIT = 3500;
const MAX_FAILED_LOGS = 3;

type Check = { id: string; name: string; status: string; conclusion: string | null; url?: string };

export class PullRequestService {
  private timer: NodeJS.Timeout | undefined;
  private readonly checking = new Set<string>();

  constructor(private readonly kernel: RuntimeKernel, private readonly origin: () => OriginContext = () => ({ secret: (id) => kernel.store.secret(id) })) {}

  start(intervalMs = CHECK_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.checkAll(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private thread(threadId: string): Conversation {
    const thread = (this.kernel.store.state.threads ?? []).find((item) => item.id === threadId);
    if (!thread) throw new HttpError(404, "Chat not found");
    return thread;
  }

  private async save(threadId: string, change: (watch: PullRequestWatch) => void): Promise<PullRequestWatch | undefined> {
    let result: PullRequestWatch | undefined;
    await this.kernel.store.update((state) => {
      const thread = (state.threads ?? []).find((item) => item.id === threadId);
      if (!thread?.pullRequest) return;
      change(thread.pullRequest);
      result = { ...thread.pullRequest };
    });
    return result;
  }

  /** Starts following a pull request just opened from the chat. */
  async follow(threadId: string, pr: { number: number; url: string; repository: string; branch: string }): Promise<void> {
    await this.kernel.store.update((state) => {
      const thread = (state.threads ?? []).find((item) => item.id === threadId);
      if (!thread) return;
      thread.pullRequest = { ...pr, watching: true, state: "open", checks: "pending", fixRounds: 0, feedback: [], seenFeedback: [], openedAt: new Date().toISOString() };
    });
    this.kernel.log("worktrees", "info", `Following pull request #${pr.number} (${pr.repository}): checks and comments`);
  }

  async setWatching(threadId: string, watching: boolean): Promise<PullRequestWatch> {
    const watch = await this.save(threadId, (item) => {
      item.watching = watching;
    });
    if (!watch) throw new HttpError(404, "This chat has no pull request");
    if (watching) void this.check(threadId);
    return watch;
  }

  private async checkAll(): Promise<void> {
    for (const thread of this.kernel.store.state.threads ?? []) {
      if (thread.pullRequest?.watching) await this.check(thread.id).catch(() => undefined);
    }
  }

  private gh(toolId: string, args: Record<string, unknown>, watch: PullRequestWatch): Promise<unknown> {
    const [owner, name] = watch.repository.split("/");
    return runOriginSkill(this.kernel.store.root, toolId, { owner, name, ...args }, undefined, this.origin());
  }

  /** One look at the pull request: state, checks, comments; a CI fix round when the checks newly fail. */
  async check(threadId: string): Promise<PullRequestWatch> {
    const thread = this.thread(threadId);
    const watch = thread.pullRequest;
    if (!watch) throw new HttpError(404, "This chat has no pull request");
    if (this.checking.has(threadId)) return watch;
    this.checking.add(threadId);
    try {
      const summary = (await this.gh("pull_request_read", { number: watch.number, view: "summary" }, watch)) as { pullRequest?: Record<string, unknown> } & Record<string, unknown>;
      const pr = (summary.pullRequest ?? summary) as { state?: string; merged?: boolean; mergedAt?: string | null; headSha?: string; head?: { sha?: string } };
      const state: PullRequestWatch["state"] = pr.merged || pr.mergedAt ? "merged" : pr.state === "closed" ? "closed" : "open";
      const checks = (await this.gh("checks_read", { number: watch.number }, watch)) as { sha?: string | null; rollup?: string; checkRuns?: Check[] };
      const head = checks.sha ?? pr.headSha ?? pr.head?.sha ?? "";
      const failed = (checks.checkRuns ?? []).filter((run) => ["failure", "timed_out", "cancelled", "action_required"].includes(String(run.conclusion)));
      const feedback = await this.newFeedback(watch);
      let next = await this.save(threadId, (item) => {
        item.state = state;
        item.head = head;
        item.checks = (checks.rollup as PullRequestWatch["checks"]) ?? "pending";
        item.failed = failed.map((run) => ({ name: run.name, url: run.url ?? "" }));
        item.lastCheckedAt = new Date().toISOString();
        item.error = undefined;
        if (feedback.length) {
          item.feedback = [...item.feedback, ...feedback];
          item.seenFeedback = [...item.seenFeedback, ...feedback.map((entry) => entry.id)];
        }
        if (state !== "open") item.watching = false;
      });
      if (feedback.length) this.kernel.log("worktrees", "info", `Pull request #${watch.number}: ${feedback.length} new comment${feedback.length === 1 ? "" : "s"}`);
      if (state !== "open") this.kernel.log("worktrees", "info", `Pull request #${watch.number} was ${state}; no longer following it`);
      if (next && state === "open" && next.checks === "failure" && head && next.handledHead !== head) next = (await this.fixRound(threadId, failed, head)) ?? next;
      return next ?? watch;
    } catch (error) {
      const message = errorText(error);
      return (await this.save(threadId, (item) => {
        item.error = /token|GitHub access/i.test(message) ? "No GitHub token: sign in with `gh auth login`, set GH_TOKEN, or install GitHub under Customizations." : message.slice(0, 300);
        item.lastCheckedAt = new Date().toISOString();
      })) ?? watch;
    } finally {
      this.checking.delete(threadId);
    }
  }

  /** Comments and unresolved review threads not seen before. */
  private async newFeedback(watch: PullRequestWatch): Promise<PullRequestFeedback[]> {
    const seen = new Set(watch.seenFeedback);
    const items: PullRequestFeedback[] = [];
    const comments = (await this.gh("pull_request_read", { number: watch.number, view: "comments", pageSize: 50 }, watch).catch(() => ({ comments: [] }))) as { comments?: { id: string; author?: string; body?: string; createdAt?: string }[] };
    for (const comment of comments.comments ?? []) {
      const id = `comment:${comment.id}`;
      if (!seen.has(id) && comment.body?.trim()) items.push({ id, author: comment.author ?? "someone", body: comment.body.trim(), at: comment.createdAt ?? "" });
    }
    const threads = (await this.gh("pull_request_read", { number: watch.number, view: "threads" }, watch).catch(() => ({ threads: [] }))) as { threads?: { id: string; resolved?: boolean; path?: string; line?: number | null; comments?: { author?: string; body?: string; createdAt?: string }[] }[] };
    for (const thread of threads.threads ?? []) {
      const id = `thread:${thread.id}:${thread.comments?.length ?? 0}`;
      const last = thread.comments?.at(-1);
      if (thread.resolved || seen.has(id) || !last?.body?.trim()) continue;
      items.push({ id, author: last.author ?? "someone", body: last.body.trim(), at: last.createdAt ?? "", ...(thread.path ? { path: thread.path } : {}), ...(thread.line ? { line: thread.line } : {}) });
    }
    return items;
  }

  /** Hands the failing checks to the agent as an automatic turn in the worktree; pushes its changes when it ends. */
  private async fixRound(threadId: string, failed: Check[], head: string): Promise<PullRequestWatch | undefined> {
    const thread = this.thread(threadId);
    const watch = thread.pullRequest!;
    const busy = this.kernel.store.state.runs.some((run) => run.threadId === threadId && ["running", "queued", "waiting_approval", "sleeping"].includes(run.status));
    if (busy) return undefined;
    if (watch.fixRounds >= MAX_FIX_ROUNDS) {
      this.kernel.log("worktrees", "warning", `Pull request #${watch.number}: checks still fail after ${MAX_FIX_ROUNDS} automatic rounds; leaving it to the user`);
      return this.save(threadId, (item) => {
        item.handledHead = head;
      });
    }
    const logs: string[] = [];
    for (const run of failed.slice(0, MAX_FAILED_LOGS)) {
      try {
        const detail = (await this.gh("check_run_log", { checkRunId: run.id, limit: LOG_LIMIT }, watch)) as { annotations?: string[]; log?: string };
        logs.push(`### ${run.name}${run.url ? ` (${run.url})` : ""}\n${detail.annotations?.length ? `${detail.annotations.join("\n")}\n` : ""}\`\`\`\n${(detail.log ?? "").trim() || "(no log)"}\n\`\`\``);
      } catch (error) {
        logs.push(`### ${run.name}\n(could not read its log: ${errorText(error)})`);
      }
    }
    const round = watch.fixRounds + 1;
    const input = `The checks failed on pull request #${watch.number} (${failed.map((run) => run.name).join(", ")}). Their output:\n\n${logs.join("\n\n")}\n\nFind the cause and fix it here. When you finish, Saturn commits your changes and pushes them to the pull request, and the checks run again. If the failure is not caused by this branch (a flaky test, an outage, missing secrets), say so instead of changing code.`;
    try {
      const run = await this.kernel.runs.startRun(thread.agentId, input, threadId, undefined, { automatic: true });
      this.kernel.log("worktrees", "info", `Pull request #${watch.number}: checks failed; the agent is fixing them (round ${round} of ${MAX_FIX_ROUNDS})`, { "saturn.run.id": run.id });
      return this.save(threadId, (item) => {
        item.handledHead = head;
        item.fixRounds = round;
        item.fixRunId = run.id;
      });
    } catch (error) {
      return this.save(threadId, (item) => {
        item.handledHead = head;
        item.error = `Could not start the fix round: ${errorText(error)}`;
      });
    }
  }

  /** Called when a run ends: a finished CI fix round's, or review answer's, changes are committed and pushed. */
  async afterRun(runId: string): Promise<void> {
    const run = this.kernel.store.state.runs.find((item) => item.id === runId);
    const thread = run?.threadId ? (this.kernel.store.state.threads ?? []).find((item) => item.id === run.threadId) : undefined;
    const watch = thread?.pullRequest;
    if (!run || !thread || !watch || (watch.fixRunId !== runId && watch.pushRunId !== runId)) return;
    if (run.status !== "completed") {
      await this.save(thread.id, (item) => {
        if (item.fixRunId === runId) item.fixRunId = undefined;
        if (item.pushRunId === runId) item.pushRunId = undefined;
      });
      return;
    }
    const message = watch.fixRunId === runId ? `Saturn: fix the checks on #${watch.number} (round ${watch.fixRounds})` : `Saturn: address review comments on #${watch.number}`;
    try {
      const pushed = await this.kernel.worktrees.push(thread.id, message);
      await this.save(thread.id, (item) => {
        item.fixRunId = undefined;
        item.pushRunId = undefined;
        item.checks = pushed.committed ? "pending" : item.checks;
        if (pushed.committed) item.head = pushed.head;
      });
      this.kernel.log("worktrees", "info", pushed.committed ? `Pull request #${watch.number}: pushed the fix; the checks run again` : `Pull request #${watch.number}: the agent changed nothing to push`, { "saturn.run.id": runId });
    } catch (error) {
      await this.save(thread.id, (item) => {
        item.fixRunId = undefined;
        item.pushRunId = undefined;
        item.error = `Could not push: ${errorText(error)}`;
      });
    }
  }

  /** The user sends review feedback (all of it, or the chosen items) to the agent as the next message. */
  async sendFeedback(threadId: string, ids?: string[]): Promise<{ runId: string; sent: number }> {
    const thread = this.thread(threadId);
    const watch = thread.pullRequest;
    if (!watch) throw new HttpError(404, "This chat has no pull request");
    const chosen = watch.feedback.filter((item) => !ids || ids.includes(item.id));
    if (!chosen.length) throw new HttpError(409, "No review comments to send");
    const lines = chosen.map((item) => `- ${item.author}${item.path ? ` on \`${item.path}${item.line ? `:${item.line}` : ""}\`` : ""}: ${item.body.replace(/\n/g, "\n  ")}`);
    const run = await this.kernel.runs.startRun(thread.agentId, `Review comments on pull request #${watch.number}:\n\n${lines.join("\n")}\n\nAddress them in this branch, or say why not. When you finish, Saturn commits your changes and pushes them to the pull request.`, threadId);
    await this.save(threadId, (item) => {
      item.feedback = item.feedback.filter((entry) => !chosen.some((sent) => sent.id === entry.id));
      item.pushRunId = run.id;
    });
    return { runId: run.id, sent: chosen.length };
  }

  /** Clears feedback the user decided not to send. */
  async dismissFeedback(threadId: string, ids?: string[]): Promise<PullRequestWatch> {
    const watch = await this.save(threadId, (item) => {
      item.feedback = ids ? item.feedback.filter((entry) => !ids.includes(entry.id)) : [];
    });
    if (!watch) throw new HttpError(404, "This chat has no pull request");
    return watch;
  }
}
