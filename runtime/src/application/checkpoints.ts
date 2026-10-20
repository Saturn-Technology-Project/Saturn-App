import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../domain/errors.js";
import { unifiedDiff } from "../domain/diff.js";
import type { FileChange, Run } from "../domain/model.js";
import type { FileCheckpoint } from "../domain/skills/checkpoint.js";
import { Workspace } from "../domain/skills/workspace.js";
import type { RuntimeKernel } from "./kernel.js";

/** Diffs longer than this are cut in API answers; reverting still restores every byte. */
const DIFF_LIMIT = 200_000;

export type FileChangeView = {
  path: string;
  status: "added" | "modified" | "deleted";
  before: string | null;
  after: string | null;
  additions: number;
  deletions: number;
  binary: boolean;
  diff: string;
  truncated: boolean;
  review: "pending" | "kept" | "reverted";
  /** The file on disk no longer matches what this run left (a later run or the user changed it). */
  modifiedSince: boolean;
};

export type RunChanges = { runId: string; root: string | null; files: FileChangeView[] };

/**
 * Checkpoints for agent edits in project folders. Before a run first writes a file, its original bytes are
 * stored under `<data>/checkpoints/<runId>/` by sha256 (a missing file is recorded as null), and the run's
 * state lists each file with its before and after hashes. Reverting writes the original bytes back, or
 * deletes a file the run created. The user's git state is never touched.
 */
export class CheckpointService {
  /** One capture at a time per run, so parallel tool calls on one file keep the first original. */
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly kernel: RuntimeKernel) {}

  private dir(runId: string): string {
    return path.join(this.kernel.store.root, "checkpoints", runId);
  }

  /** Hooks for one run's writes in `root`; writes outside it are not tracked. */
  forRun(runId: string, root: string): FileCheckpoint {
    const workspace = new Workspace(root);
    const relative = (target: string): string | undefined => {
      try {
        const resolved = workspace.resolve(target);
        return resolved === workspace.root ? undefined : workspace.relative(resolved).split(path.sep).join("/");
      } catch {
        return undefined;
      }
    };
    return {
      before: async (target, actionId) => {
        const file = relative(target);
        if (file) await this.locked(runId, () => this.captureBefore(runId, workspace.root, file, actionId));
      },
      after: async (target) => {
        const file = relative(target);
        if (file) await this.locked(runId, () => this.captureAfter(runId, workspace.root, file));
      },
    };
  }

  private async locked(runId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.locks.get(runId) ?? Promise.resolve();
    const current = previous.then(work, work);
    const settled = current.catch(() => undefined);
    this.locks.set(runId, settled);
    try {
      await current;
    } finally {
      if (this.locks.get(runId) === settled) this.locks.delete(runId);
    }
  }

  private async captureBefore(runId: string, root: string, file: string, actionId?: string): Promise<void> {
    const run = this.kernel.store.state.runs.find((item) => item.id === runId);
    if (!run) return;
    if (actionId) await this.captureStep(runId, root, file, actionId);
    const existing = run.checkpoint?.root === root ? run.checkpoint.files.find((item) => item.path === file) : undefined;
    if (existing && existing.review !== "reverted") return;
    // A reverted file is back to its original, so the run's next write starts from the same `before`.
    const hash = existing ? existing.before : await this.save(runId, await readBytes(path.join(root, file)));
    await this.kernel.store.update((state) => {
      const current = state.runs.find((item) => item.id === runId);
      if (!current) return;
      if (!current.checkpoint || current.checkpoint.root !== root) current.checkpoint = { root, files: [] };
      const entry = current.checkpoint.files.find((item) => item.path === file);
      if (entry) delete entry.review;
      else current.checkpoint.files.push({ path: file, before: hash, after: hash });
    });
  }

  /** The file as it is just before one tool step writes it, the first time that step does. */
  private async captureStep(runId: string, root: string, file: string, actionId: string): Promise<void> {
    const run = this.kernel.store.state.runs.find((item) => item.id === runId);
    if (run?.checkpoint?.root === root && run.checkpoint.steps?.some((item) => item.actionId === actionId && item.path === file)) return;
    const hash = await this.save(runId, await readBytes(path.join(root, file)));
    await this.kernel.store.update((state) => {
      const current = state.runs.find((item) => item.id === runId);
      if (!current) return;
      if (!current.checkpoint || current.checkpoint.root !== root) current.checkpoint = { root, files: [] };
      (current.checkpoint.steps ??= []).push({ actionId, path: file, hash });
    });
  }

  private async captureAfter(runId: string, root: string, file: string): Promise<void> {
    const run = this.kernel.store.state.runs.find((item) => item.id === runId);
    if (!run?.checkpoint || run.checkpoint.root !== root || !run.checkpoint.files.some((item) => item.path === file)) return;
    const hash = await this.save(runId, await readBytes(path.join(root, file)));
    await this.kernel.store.update((state) => {
      const entry = state.runs.find((item) => item.id === runId)?.checkpoint?.files.find((item) => item.path === file);
      if (entry) entry.after = hash;
    });
  }

  /** Stores bytes by hash (once) and returns the hash; null for a missing file. */
  private async save(runId: string, bytes: Buffer | null): Promise<string | null> {
    if (!bytes) return null;
    const hash = sha256(bytes);
    const target = path.join(this.dir(runId), hash);
    if (!(await readBytes(target))) {
      await mkdir(this.dir(runId), { recursive: true });
      await writeFile(target, bytes);
    }
    return hash;
  }

  private async blob(runId: string, hash: string | null): Promise<Buffer | null> {
    if (!hash) return null;
    const bytes = await readBytes(path.join(this.dir(runId), hash));
    if (!bytes) throw new HttpError(410, "This checkpoint's saved copy is missing");
    return bytes;
  }

  /** The run's changed files with a unified diff each; files it wrote back unchanged are left out. */
  async changes(runId: string): Promise<RunChanges> {
    const run = this.kernel.getRun(runId);
    const checkpoint = run.checkpoint;
    if (!checkpoint) return { runId, root: null, files: [] };
    const files: FileChangeView[] = [];
    for (const entry of checkpoint.files) {
      if (entry.before === entry.after) continue;
      files.push(await this.view(runId, checkpoint.root, entry));
    }
    return { runId, root: checkpoint.root, files };
  }

  private async view(runId: string, root: string, entry: FileChange): Promise<FileChangeView> {
    const before = await this.blob(runId, entry.before);
    const after = await this.blob(runId, entry.after);
    const result = unifiedDiff(entry.path, before, after);
    const onDisk = await readBytes(path.join(root, entry.path));
    const current = onDisk ? sha256(onDisk) : null;
    const review = entry.review ?? "pending";
    return {
      path: entry.path,
      status: entry.before === null ? "added" : entry.after === null ? "deleted" : "modified",
      before: entry.before,
      after: entry.after,
      additions: result.additions,
      deletions: result.deletions,
      binary: result.binary,
      diff: result.diff.length > DIFF_LIMIT ? result.diff.slice(0, DIFF_LIMIT) : result.diff,
      truncated: result.diff.length > DIFF_LIMIT,
      review,
      modifiedSince: review === "reverted" ? current !== entry.before : current !== entry.after,
    };
  }

  /** One changed file's text before or after the run, for the editor's diff view. */
  async fileContent(runId: string, file: string, side: "before" | "after"): Promise<{ path: string; content: string; exists: boolean; binary: boolean }> {
    const entry = this.kernel.getRun(runId).checkpoint?.files.find((item) => item.path === file);
    if (!entry) throw new HttpError(404, "That file is not among this run's changes");
    const bytes = await this.blob(runId, side === "before" ? entry.before : entry.after);
    if (!bytes) return { path: file, content: "", exists: false, binary: false };
    const binary = bytes.includes(0);
    return { path: file, content: binary ? "" : bytes.toString("utf8"), exists: true, binary };
  }

  /** Puts back the original bytes of one file, or of every file the run changed; files the run created are deleted. */
  async revert(runId: string, file?: string): Promise<RunChanges> {
    const run = this.kernel.getRun(runId);
    this.assertIdle(run);
    const checkpoint = run.checkpoint;
    if (file !== undefined && !checkpoint?.files.some((item) => item.path === file)) {
      throw new HttpError(404, "This run did not change that file");
    }
    if (checkpoint) {
      await this.locked(runId, async () => {
        const workspace = new Workspace(checkpoint.root);
        const reverted: string[] = [];
        for (const entry of checkpoint.files) {
          if (file !== undefined && entry.path !== file) continue;
          if (entry.review === "reverted") continue;
          const target = workspace.resolve(entry.path);
          const original = await this.blob(runId, entry.before);
          if (original) {
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, original);
          } else {
            await rm(target, { force: true });
          }
          reverted.push(entry.path);
        }
        await this.kernel.store.update((state) => {
          for (const entry of state.runs.find((item) => item.id === runId)?.checkpoint?.files ?? []) {
            if (reverted.includes(entry.path)) entry.review = "reverted";
          }
        });
        if (reverted.length) {
          this.kernel.log("agent", "info", `Reverted ${reverted.length} ${reverted.length === 1 ? "file" : "files"} changed by a run`, { "saturn.run.id": runId });
        }
      });
    }
    return this.changes(runId);
  }

  /** The user accepted the run's edits: the card stops offering to revert them (the checkpoint stays). */
  async keep(runId: string, file?: string): Promise<RunChanges> {
    const run = this.kernel.getRun(runId);
    if (file !== undefined && !run.checkpoint?.files.some((item) => item.path === file)) {
      throw new HttpError(404, "This run did not change that file");
    }
    await this.kernel.store.update((state) => {
      for (const entry of state.runs.find((item) => item.id === runId)?.checkpoint?.files ?? []) {
        if (file !== undefined && entry.path !== file) continue;
        if (entry.review !== "reverted") entry.review = "kept";
      }
    });
    return this.changes(runId);
  }

  /**
   * Restores the chat's files to how they were before this turn: reverts this run and every later run in
   * the same chat, newest first, so each file ends at the oldest original. Messages are left as they are.
   */
  async restoreTo(runId: string): Promise<{ reverted: string[]; files: string[] }> {
    const run = this.kernel.getRun(runId);
    const runs = this.kernel.store.state.runs;
    // Newest runs come first in state.runs.
    const index = runs.findIndex((item) => item.id === runId);
    const turns = runs
      .slice(0, index + 1)
      .filter((item) => item.agentId === run.agentId && (run.threadId ? item.threadId === run.threadId : !item.threadId && !item.groupId));
    for (const turn of turns) this.assertIdle(turn);
    const reverted: string[] = [];
    const files = new Set<string>();
    for (const turn of turns) {
      const pending = turn.checkpoint?.files.filter((item) => item.review !== "reverted" && item.before !== item.after) ?? [];
      await this.revert(turn.id);
      if (pending.length) {
        reverted.push(turn.id);
        for (const item of pending) files.add(item.path);
      }
    }
    return { reverted, files: [...files] };
  }

  /**
   * Puts the chat's files back to how they were just before one tool step of a run: later turns are reverted
   * whole, then each file this run's step or a later step of it wrote gets the bytes it had before the first
   * of those writes. Files changed by shell commands are not tracked step by step.
   */
  async restoreToStep(runId: string, actionId: string): Promise<{ reverted: string[]; files: string[] }> {
    const run = this.kernel.getRun(runId);
    const position = run.actions.findIndex((item) => item.id === actionId);
    if (position < 0) throw new HttpError(404, "That step is not part of this run");
    const runs = this.kernel.store.state.runs;
    const index = runs.findIndex((item) => item.id === runId);
    const later = runs
      .slice(0, index)
      .filter((item) => item.agentId === run.agentId && (run.threadId ? item.threadId === run.threadId : !item.threadId && !item.groupId));
    this.assertIdle(run);
    for (const turn of later) this.assertIdle(turn);
    const reverted: string[] = [];
    const files = new Set<string>();
    for (const turn of later) {
      const pending = turn.checkpoint?.files.filter((item) => item.review !== "reverted" && item.before !== item.after) ?? [];
      await this.revert(turn.id);
      if (pending.length) {
        reverted.push(turn.id);
        for (const item of pending) files.add(item.path);
      }
    }
    const checkpoint = run.checkpoint;
    if (checkpoint?.steps?.length) {
      const order = new Map(run.actions.map((item, at) => [item.id, at]));
      const restore = new Map<string, string | null>();
      for (const step of checkpoint.steps) {
        const at = order.get(step.actionId);
        if (at !== undefined && at >= position && !restore.has(step.path)) restore.set(step.path, step.hash);
      }
      await this.locked(runId, async () => {
        const workspace = new Workspace(checkpoint.root);
        for (const [file, hash] of restore) {
          const target = workspace.resolve(file);
          const bytes = await this.blob(runId, hash);
          if (bytes) {
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, bytes);
          } else {
            await rm(target, { force: true });
          }
          files.add(file);
        }
        await this.kernel.store.update((state) => {
          const current = state.runs.find((item) => item.id === runId)?.checkpoint;
          if (!current) return;
          for (const entry of current.files) {
            if (!restore.has(entry.path)) continue;
            entry.after = restore.get(entry.path)!;
            if (entry.after === entry.before) entry.review = "reverted";
            else delete entry.review;
          }
          current.steps = (current.steps ?? []).filter((step) => {
            const at = order.get(step.actionId);
            return at === undefined || at < position;
          });
        });
      });
      if (restore.size && !reverted.includes(runId)) reverted.push(runId);
    }
    if (files.size) this.kernel.log("agent", "info", `Restored ${files.size} ${files.size === 1 ? "file" : "files"} to before a step`, { "saturn.run.id": runId });
    return { reverted, files: [...files] };
  }

  /** Drops the saved originals of runs that no longer exist. */
  async forget(runIds: string[]): Promise<void> {
    await Promise.all(runIds.map((id) => rm(this.dir(id), { recursive: true, force: true })));
  }

  private assertIdle(run: Run): void {
    if (run.status === "running" || run.status === "queued" || run.status === "waiting_approval") {
      throw new HttpError(409, "Wait for the run to finish (or stop it) before reverting its changes");
    }
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBytes(target: string): Promise<Buffer | null> {
  try {
    if (!(await stat(target)).isFile()) return null;
    return await readFile(target);
  } catch {
    return null;
  }
}
