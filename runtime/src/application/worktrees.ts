import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { HttpError } from "../domain/errors.js";
import type { Conversation } from "../domain/model.js";
import { launchEnv } from "../infrastructure/launch-env.js";
import { errorText, logger } from "../infrastructure/logger.js";
import type { RuntimeKernel } from "./kernel.js";
import { runOriginSkill } from "../infrastructure/skills.js";
import type { OriginContext } from "../infrastructure/skills/origin-skill.js";

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
  /**
   * Opens a pull request from a chat's worktree branch: commits what is pending, pushes the branch to origin,
   * and creates the pull request on GitHub with the user's token (the one Saturn's GitHub tools use). `repository`
   * overrides the owner/name read from the origin remote (tests use a local remote).
   */
  async pullRequest(threadId: string, input: { title?: string; body?: string; repository?: string } = {}, context: OriginContext = {}): Promise<{ url: string; number: number; branch: string }> {
    const thread = this.thread(threadId);
    const folder = this.pathOf(thread);
    if (!thread.worktree || !folder || !thread.projectId) throw new HttpError(404, "This chat has no worktree branch to open a pull request from");
    const { branch, base } = thread.worktree;
    const remote = await this.git(folder, ["remote", "get-url", "origin"], true);
    const repository = input.repository?.trim() || githubRepository(remote);
    if (!repository) throw new HttpError(409, remote ? `The origin remote (${remote}) is not a GitHub repository` : "The project has no origin remote to push to");
    await this.push(threadId, `Saturn: ${thread.title}`);
    const [owner, repo] = repository.split("/");
    const title = input.title?.trim() || thread.title;
    const body = input.body ?? this.summaryOf(threadId);
    let result: { pullRequest?: { url?: string; number?: number } };
    try {
      result = (await runOriginSkill(this.kernel.store.root, "create_pull_request", { owner, name: repo, title, body, head: branch, base }, undefined, { ...context, repoDir: folder })) as typeof result;
    } catch (error) {
      const text = errorText(error);
      if (/token/i.test(text)) throw new HttpError(409, "No GitHub token: sign in with `gh auth login`, set GH_TOKEN, or install GitHub under Customizations, then try again.");
      throw new HttpError(502, `GitHub refused the pull request: ${text}`);
    }
    const pr = result.pullRequest ?? {};
    logger.info("worktrees", `Opened pull request #${pr.number ?? "?"} from ${branch}`);
    return { url: String(pr.url ?? ""), number: Number(pr.number ?? 0), branch };
  }

  /**
   * Commits whatever the chat's worktree has pending (as Saturn) and pushes its branch to origin. Returns whether
   * anything was committed. The pull request flow and the CI follow-up both push through here.
   */
  async push(threadId: string, message: string): Promise<{ committed: boolean; branch: string; head: string }> {
    const thread = this.thread(threadId);
    const folder = this.pathOf(thread);
    if (!thread.worktree || !folder) throw new HttpError(404, "This chat has no worktree branch to push");
    const dirty = await this.git(folder, ["status", "--porcelain"], true);
    if (dirty) {
      await this.git(folder, ["add", "-A"]);
      await this.git(folder, ["-c", "user.name=Saturn", "-c", "user.email=saturn@localhost", "commit", "-q", "-m", message]);
    }
    await this.git(folder, ["push", "-u", "origin", thread.worktree.branch]);
    return { committed: Boolean(dirty), branch: thread.worktree.branch, head: await this.git(folder, ["rev-parse", "HEAD"]) };
  }

  /** The repository folder that holds a worktree's git data (its common .git), which sandboxed commits must reach. */
  async gitCommonDir(folder: string): Promise<string | undefined> {
    const dir = await this.git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], true);
    return dir || undefined;
  }

  /** The "## Summary" of the chat's last reply, for a pull request's description. */
  private summaryOf(threadId: string): string {
    const last = this.kernel.store.state.runs.find((run) => run.threadId === threadId && run.status === "completed" && run.output);
    if (!last) return "";
    const match = /\n#{2,3}\s*Summary\s*\n/i.exec(`\n${last.output}`);
    return match ? last.output.slice(match.index - 1 + match[0].length).trim() : last.output.slice(0, 4000);
  }

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
      // The merge commit is the user's when git knows who they are; otherwise it is Saturn's, like the branch's commit.
      const identity = (await this.git(root, ["config", "user.email"], true)).trim() ? [] : ["-c", "user.name=Saturn", "-c", "user.email=saturn@localhost"];
      try {
        await this.git(root, [...identity, "merge", "--no-ff", "-m", `Merge ${branch}: ${thread.title}`, branch]);
        merged = true;
      } catch (error) {
        conflicts = (await this.git(root, ["diff", "--name-only", "--diff-filter=U"], true)).split("\n").filter(Boolean);
        await this.git(root, ["merge", "--abort"], true);
        if (!conflicts.length) throw new HttpError(409, `Could not merge ${branch} into ${base}: ${errorText(error)}`);
        throw new HttpError(409, `Merging ${branch} into ${base} conflicts in ${conflicts.join(", ")}. Keep the branch and merge it by hand, or discard it.`);
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

/** "owner/name" from a GitHub remote URL (https, ssh, or git protocol), or undefined for anything else. */
export function githubRepository(remote: string): string | undefined {
  const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

