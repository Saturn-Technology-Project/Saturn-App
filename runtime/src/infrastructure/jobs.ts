import { execFile, spawn, type ChildProcess } from "node:child_process";
import { newId } from "../domain/ids.js";

/**
 * Background commands: a dev server, a watcher, a long build an agent starts with `code` and `background: true`,
 * then reads with `code_output` and ends with `code_stop`. Jobs belong to a scope (the chat, or the agent outside
 * one) and outlive the turn that started them; they end with the chat, the runtime, or on request.
 */

/** Bytes of a job's most recent output kept for reading. */
export const OUTPUT_LIMIT = 64 * 1024;
/** Jobs one scope may have at once. */
export const MAX_JOBS = 8;
/** A finished job stays readable this long. */
const KEEP_FINISHED_MS = 60 * 60 * 1000;

export type JobView = {
  id: string;
  scope: string;
  command: string;
  pid: number | undefined;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  running: boolean;
  /** Bytes of output seen so far (the last OUTPUT_LIMIT are kept). */
  bytes: number;
};

type Job = JobView & { child: ChildProcess; chunks: Buffer[]; kept: number; waiters: (() => void)[]; ended: Promise<void>; finish: () => void };

export class JobTable {
  private readonly jobs = new Map<string, Job>();

  start(scope: string, command: string, invocation: { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; windowsVerbatimArguments?: boolean }): JobView {
    this.reap();
    const running = this.list(scope).filter((job) => job.running);
    if (running.length >= MAX_JOBS) throw new Error(`This chat already runs ${MAX_JOBS} background commands; stop one with code_stop first.`);
    const child = spawn(invocation.file, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      detached: process.platform !== "win32",
    });
    let finish = () => {};
    const ended = new Promise<void>((resolve) => (finish = resolve));
    const job: Job = {
      ended,
      finish,
      id: newId("job"),
      scope,
      command,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      running: true,
      bytes: 0,
      child,
      chunks: [],
      kept: 0,
      waiters: [],
    };
    const take = (chunk: Buffer) => {
      job.bytes += chunk.length;
      job.chunks.push(chunk);
      job.kept += chunk.length;
      while (job.kept > OUTPUT_LIMIT && job.chunks.length > 1) {
        const dropped = job.chunks.shift()!;
        job.kept -= dropped.length;
      }
      this.wake(job);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const end = (code: number | null, signal: NodeJS.Signals | null) => {
      if (!job.running) return;
      job.running = false;
      job.exitCode = code;
      job.signal = signal;
      job.endedAt = new Date().toISOString();
      this.wake(job);
      job.finish();
    };
    child.on("exit", end);
    child.on("error", (error) => {
      take(Buffer.from(`${error.message}\n`));
      end(null, null);
    });
    child.unref();
    this.jobs.set(job.id, job);
    return view(job);
  }

  /** Resolves when the job ends (at once for an ended or unknown job). */
  whenEnded(id: string): Promise<void> {
    return this.jobs.get(id)?.ended ?? Promise.resolve();
  }

  get(id: string): JobView | undefined {
    const job = this.jobs.get(id);
    return job ? view(job) : undefined;
  }

  list(scope?: string): JobView[] {
    this.reap();
    return [...this.jobs.values()].filter((job) => !scope || job.scope === scope).map(view);
  }

  /** The job's recent output, after waiting up to `waitMs` for more output or its end. */
  async output(id: string, waitMs = 0): Promise<{ job: JobView; output: string }> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`No background command ${id}. It may have been stopped, or belong to another chat.`);
    if (waitMs > 0 && job.running) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(waitMs, 30_000));
        function done() {
          clearTimeout(timer);
          resolve();
        }
        job.waiters.push(done);
      });
    }
    return { job: view(job), output: Buffer.concat(job.chunks).toString("utf8") };
  }

  stop(id: string): JobView {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`No background command ${id}`);
    kill(job);
    return view(job);
  }

  /** Ends every job of a scope (the chat was deleted), or every job at all (the runtime stops). */
  stopAll(scope?: string): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (scope && job.scope !== scope) continue;
      if (job.running) count += 1;
      kill(job);
      if (scope) this.jobs.delete(job.id);
    }
    return count;
  }

  private wake(job: Job): void {
    const waiters = job.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  private reap(): void {
    const cutoff = Date.now() - KEEP_FINISHED_MS;
    for (const [id, job] of this.jobs) {
      if (!job.running && job.endedAt && Date.parse(job.endedAt) < cutoff) this.jobs.delete(id);
    }
  }
}

/** Windows has no process groups to signal: taskkill /T ends the shell and everything it started. */
function killTree(pid: number): void {
  execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
}

function kill(job: Job): void {
  if (!job.running || !job.child.pid) return;
  if (process.platform === "win32") {
    killTree(job.child.pid);
    return;
  }
  try {
    // The process group, so a shell's children (the server it started) go too.
    process.kill(-job.child.pid, "SIGTERM");
  } catch {
    try {
      job.child.kill();
    } catch {
      // Already gone.
    }
  }
  const pid = job.child.pid;
  setTimeout(() => {
    if (!job.running) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }, 2_000).unref();
}

function view(job: Job): JobView {
  const { child: _child, chunks: _chunks, kept: _kept, waiters: _waiters, ended: _ended, finish: _finish, ...rest } = job;
  return { ...rest };
}
