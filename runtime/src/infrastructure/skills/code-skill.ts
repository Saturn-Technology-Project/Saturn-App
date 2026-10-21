import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { Workspace } from "../../domain/skills/workspace.js";
import { DEFAULT_SANDBOX, sandboxHint, sandboxMode, wrapCommand, type SandboxSettings } from "../sandbox.js";
import { commandEnv, shellInvocation } from "../shell.js";
import { TEXT_LIMIT, clip, integer, text } from "./text.js";

const runCommand = promisify(execFile);
const CODE_TIMEOUT = 15_000;
const CODE_TIMEOUT_MAX = 30_000;

export type CodeOptions = {
  /** The sandbox the command runs in; the call's own `sandbox: "off"` (approved by then) turns it off. */
  sandbox?: SandboxSettings;
  /** Folders outside the workspace the command may also write to (the agent's private workspace, say). */
  writable?: string[];
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
}
