import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { Workspace } from "../../domain/skills/workspace.js";
import { DEFAULT_SANDBOX, sandboxHint, sandboxMode, wrapCommand, type SandboxSettings } from "../sandbox.js";
import { commandEnv, shellInvocation } from "../shell.js";
import type { JobTable } from "../jobs.js";
import { TEXT_LIMIT, clip, integer, text } from "./text.js";

const runCommand = promisify(execFile);
const CODE_TIMEOUT = 15_000;
const CODE_TIMEOUT_MAX = 30_000;

export type CodeOptions = {
  /** The sandbox the command runs in; the call's own `sandbox: "off"` (approved by then) turns it off. */
  sandbox?: SandboxSettings;
  /** Folders outside the workspace the command may also write to (the agent's private workspace, say). */
  writable?: string[];
  /** Background commands for this chat (`background: true`, `code_output`, `code_stop`). */
  jobs?: { table: JobTable; scope: string };
};

export class CodeSkill {
  constructor(private readonly workspace: Workspace) {}

  async run(args: Record<string, unknown>, signal?: AbortSignal, options: CodeOptions = {}): Promise<unknown> {
    const command = text(args.command);
    if (!command.trim()) throw new Error("Command is empty");
    await mkdir(this.workspace.root, { recursive: true });
    const cwd = text(args.cwd) ? this.workspace.resolve(text(args.cwd)) : this.workspace.root;
    const info = await stat(cwd);
    if (!info.isDirectory()) throw new Error("cwd is not a directory");
    const timeout = Math.min(CODE_TIMEOUT_MAX, Math.max(1_000, integer(args.timeout, CODE_TIMEOUT)));
    const settings: SandboxSettings = sandboxMode(args.sandbox) === "off" ? { ...(options.sandbox ?? DEFAULT_SANDBOX), mode: "off" } : options.sandbox ?? DEFAULT_SANDBOX;
    const plan = wrapCommand(shellInvocation(command, "/bin/sh"), settings, this.workspace.root, options.writable);
    const shell = shellInvocation(command, "/bin/sh");
    const note = plan.sandboxed ? {} : plan.reason ? { sandbox: "unavailable", sandboxNote: plan.reason } : {};
    if (args.background === true) {
      if (!options.jobs) throw new Error("Background commands are not available here");
      const job = options.jobs.table.start(options.jobs.scope, command, { file: plan.file, args: plan.args, cwd, env: commandEnv(), windowsVerbatimArguments: shell.windowsVerbatimArguments });
      // A moment for a command that fails at once, so its error comes back with the job id.
      const first = await options.jobs.table.output(job.id, 300);
      return {
        jobId: job.id,
        pid: job.pid,
        running: first.job.running,
        exitCode: first.job.running ? undefined : first.job.exitCode,
        output: clip(first.output),
        sandboxed: plan.sandboxed,
        ...note,
        note: `Started in the background. Read its output with code_output { jobId: "${job.id}" } (wait: milliseconds to wait for more), stop it with code_stop.`,
      };
    }
    try {
      const { stdout, stderr } = await runCommand(plan.file, plan.args, {
        cwd,
        timeout,
        signal,
        maxBuffer: TEXT_LIMIT,
        env: commandEnv(),
        windowsVerbatimArguments: shell.windowsVerbatimArguments,
      });
      return { stdout: clip(stdout), stderr: clip(stderr), exitCode: 0, sandboxed: plan.sandboxed, ...note };
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string; code?: number; message?: string };
      if (signal?.aborted) throw error;
      const stderr = failed.stderr || failed.message || "Command failed";
      const hint = plan.sandboxed ? sandboxHint(stderr, settings) : undefined;
      return {
        stdout: clip(failed.stdout || ""),
        stderr: clip(hint ? `${stderr.trimEnd()}\n${hint}` : stderr),
        exitCode: typeof failed.code === "number" ? failed.code : 1,
        sandboxed: plan.sandboxed,
        ...note,
      };
    }
  }

  /** `code_output`: a background command's recent output and state, after waiting up to `wait` ms for more. */
  async output(args: Record<string, unknown>, options: CodeOptions = {}): Promise<unknown> {
    if (!options.jobs) throw new Error("Background commands are not available here");
    const id = text(args.jobId || args.id);
    if (!id) throw new Error("Name the background command: jobId");
    const wait = Math.max(0, Math.min(30_000, integer(args.wait, 0)));
    const { job, output } = await options.jobs.table.output(id, wait);
    return { jobId: job.id, command: job.command, running: job.running, exitCode: job.running ? undefined : job.exitCode, startedAt: job.startedAt, endedAt: job.endedAt, output: clip(output) };
  }

  /** `code_stop`: ends a background command. */
  async stop(args: Record<string, unknown>, options: CodeOptions = {}): Promise<unknown> {
    if (!options.jobs) throw new Error("Background commands are not available here");
    const id = text(args.jobId || args.id);
    if (!id) throw new Error("Name the background command: jobId");
    const job = options.jobs.table.stop(id);
    return { jobId: job.id, command: job.command, stopped: true };
  }
}
