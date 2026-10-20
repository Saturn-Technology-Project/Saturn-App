import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { HttpError } from "../domain/errors.js";
import type { Conversation } from "../domain/model.js";
import { launchEnv } from "../infrastructure/launch-env.js";
import { errorText, logger } from "../infrastructure/logger.js";
import type { RuntimeKernel } from "./kernel.js";

const exec = promisify(execFile);
/** Isolated chats open at once per project, so a busy afternoon does not fill the disk with checkouts. */
const MAX_WORKTREES = 6;

export type WorktreeStatus = {
  threadId: string;
  path: string;
  branch: string;
  /** The branch the worktree was cut from, which merge targets. */
  base: string;
  /** Commits on the branch past the base, and files changed but not committed. */
  ahead: number;
  dirty: number;
  changedFiles: string[];
};

/**
 * One git worktree per isolated chat: the agent works on its own branch in its own checkout, so several agents can
 * change the same project at once without stepping on each other or on the user's working copy. Finishing a chat
 * merges its branch into the base, keeps it for a pull request, or throws it away.
 */
export class WorktreeService {
  constructor(private readonly kernel: RuntimeKernel) {}

  private dir(): string {
    return path.join(this.kernel.store.root, "worktrees");
  }

  private async git(cwd: string, args: string[], allowFail = false): Promise<string> {
    try {
      const { stdout } = await exec("git", args, { cwd, env: launchEnv(), maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
      return stdout.trim();
    } catch (error) {
      if (allowFail) return "";
      const failed = error as { stderr?: string; message?: string };
      throw new HttpError(409, `git ${args[0]} failed: ${(failed.stderr || failed.message || "").trim().split("\n").at(-1) || errorText(error)}`);
    }
  }

  /** The thread's worktree folder, once it has one. */
  pathOf(thread: Pick<Conversation, "id" | "worktree">): string | undefined {
    return thread.worktree ? path.join(this.dir(), thread.id) : undefined;
  }

  /** Gives the thread its own worktree and branch, cut from the project's current branch. */
  async create(threadId: string): Promise<WorktreeStatus> {
    const thread = this.thread(threadId);
    if (thread.worktree) return this.status(threadId);
    if (!thread.projectId) throw new HttpError(409, "Only a chat in a project can work in its own worktree");
    const root = this.kernel.projects.workdir(thread.projectId);
    const inside = await this.git(root, ["rev-parse", "--is-inside-work-tree"], true);
    if (inside !== "true") throw new HttpError(409, `${path.basename(root)} is not a git repository, so a chat cannot work on its own branch there`);
    const open = (this.kernel.store.state.threads ?? []).filter((item) => item.projectId === thread.projectId && item.worktree).length;
    if (open >= MAX_WORKTREES) throw new HttpError(409, `${open} chats already work in their own worktrees of this project; finish one first`);
    const base = (await this.git(root, ["symbolic-ref", "--short", "HEAD"], true)) || (await this.git(root, ["rev-parse", "--short", "HEAD"]));
    const branch = `saturn/${threadId.replace(/^thread_/, "")}`;
    const target = path.join(this.dir(), threadId);
    await mkdir(this.dir(), { recursive: true, mode: 0o700 });
    await this.git(root, ["worktree", "add", "-b", branch, target, "HEAD"]);
    await this.kernel.store.update((state) => {
      const current = (state.threads ?? []).find((item) => item.id === threadId);
      if (current) current.worktree = { branch, base };
    });
    logger.info("worktrees", `Chat ${threadId} works on ${branch} in its own worktree`);
    return this.status(threadId);
  }

  async status(threadId: string): Promise<WorktreeStatus> {
    const thread = this.thread(threadId);
    const folder = this.pathOf(thread);
    if (!thread.worktree || !folder) throw new HttpError(404, "This chat has no worktree");
    const ahead = Number((await this.git(folder, ["rev-list", "--count", `${thread.worktree.base}..HEAD`], true)) || 0);
    const porcelain = await this.git(folder, ["status", "--porcelain"], true);
    const changed = porcelain ? porcelain.split("\n").map((line) => line.slice(3).trim()).filter(Boolean) : [];
    const committed = ahead ? (await this.git(folder, ["diff", "--name-only", `${thread.worktree.base}...HEAD`], true)).split("\n").filter(Boolean) : [];
    return { threadId, path: folder, branch: thread.worktree.branch, base: thread.worktree.base, ahead, dirty: changed.length, changedFiles: [...new Set([...committed, ...changed])] };
  }

  /**
   * Ends the chat's isolation. "merge": commits what is uncommitted, merges the branch into the base in the main
   * checkout (--no-ff), and removes the worktree and branch. "keep": commits and removes the worktree but keeps
   * the branch, for a pull request. "discard": removes everything.
   */
  async finish(threadId: string, how: "merge" | "keep" | "discard", message?: string): Promise<{ how: string; branch: string; merged?: boolean; conflicts?: string[] }> {
    const thread = this.thread(threadId);
    const folder = this.pathOf(thread);
    if (!thread.worktree || !folder || !thread.projectId) throw new HttpError(404, "This chat has no worktree");
    const root = this.kernel.projects.workdir(thread.projectId);
    const { branch, base } = thread.worktree;
    let merged: boolean | undefined;
    let conflicts: string[] | undefined;
    if (how !== "discard") {
      const dirty = await this.git(folder, ["status", "--porcelain"], true);
      if (dirty) {
        await this.git(folder, ["add", "-A"]);
        await this.git(folder, ["-c", "user.name=Saturn", "-c", "user.email=saturn@localhost", "commit", "-q", "-m", message?.trim() || `Saturn: ${thread.title}`]);
      }
    }
    if (how === "merge") {
      const mainDirty = await this.git(root, ["status", "--porcelain", "--untracked-files=no"], true);
      if (mainDirty) throw new HttpError(409, "The project has uncommitted changes; commit or stash them before merging a chat's branch into it");
      try {
        await this.git(root, ["merge", "--no-ff", "-m", `Merge ${branch}: ${thread.title}`, branch]);
        merged = true;
      } catch (error) {
        conflicts = (await this.git(root, ["diff", "--name-only", "--diff-filter=U"], true)).split("\n").filter(Boolean);
        await this.git(root, ["merge", "--abort"], true);
        throw new HttpError(409, `Merging ${branch} into ${base} conflicts in ${conflicts.join(", ") || "some files"}. Keep the branch and merge it by hand, or discard it. (${errorText(error)})`);
      }
    }
    await this.git(root, ["worktree", "remove", "--force", folder], true);
    await rm(folder, { recursive: true, force: true });
    if (how !== "keep") await this.git(root, ["branch", "-D", branch], true);
    await this.kernel.store.update((state) => {
      const current = (state.threads ?? []).find((item) => item.id === threadId);
      if (current) delete current.worktree;
    });
    logger.info("worktrees", `Chat ${threadId}: ${how === "merge" ? `merged ${branch} into ${base}` : how === "keep" ? `kept ${branch} for a pull request` : `discarded ${branch}`}`);
    return { how, branch, ...(merged !== undefined ? { merged } : {}), ...(conflicts ? { conflicts } : {}) };
  }

  /** Worktrees of chats that no longer exist (a crash between steps), removed at startup. */
  async sweep(): Promise<void> {
    let entries: string[] = [];
    try {
      const { readdir } = await import("node:fs/promises");
      entries = await readdir(this.dir());
    } catch {
      return;
    }
    const live = new Set((this.kernel.store.state.threads ?? []).filter((item) => item.worktree).map((item) => item.id));
    for (const entry of entries) {
      if (live.has(entry)) continue;
      const folder = path.join(this.dir(), entry);
      try {
        if (!(await stat(folder)).isDirectory()) continue;
        const root = (await this.git(folder, ["rev-parse", "--git-common-dir"], true)).replace(/\/\.git$/, "");
        if (root) await this.git(root, ["worktree", "remove", "--force", folder], true);
        await rm(folder, { recursive: true, force: true });
        logger.info("worktrees", `Removed the stale worktree of ${entry}`);
      } catch (error) {
        logger.warn("worktrees", `Could not remove the stale worktree ${folder}: ${errorText(error)}`);
      }
    }
  }

  private thread(threadId: string): Conversation {
    const thread = (this.kernel.store.state.threads ?? []).find((item) => item.id === threadId);
    if (!thread) throw new HttpError(404, "Chat not found");
    return thread;
  }
}
