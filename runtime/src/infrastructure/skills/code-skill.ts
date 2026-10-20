import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { Workspace } from "../../domain/skills/workspace.js";
import { commandEnv, shellInvocation } from "../shell.js";
import { TEXT_LIMIT, clip, integer, text } from "./text.js";

const runCommand = promisify(execFile);
const CODE_TIMEOUT = 15_000;
const CODE_TIMEOUT_MAX = 30_000;

export class CodeSkill {
  constructor(private readonly workspace: Workspace) {}

  async run(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const command = text(args.command);
    if (!command.trim()) throw new Error("Command is empty");
    await mkdir(this.workspace.root, { recursive: true });
    const cwd = text(args.cwd) ? this.workspace.resolve(text(args.cwd)) : this.workspace.root;
    const info = await stat(cwd);
    if (!info.isDirectory()) throw new Error("cwd is not a directory");
    const timeout = Math.min(CODE_TIMEOUT_MAX, Math.max(1_000, integer(args.timeout, CODE_TIMEOUT)));
    const shell = shellInvocation(command, "/bin/sh");
    try {
      const { stdout, stderr } = await runCommand(shell.file, shell.args, {
        cwd,
        timeout,
        signal,
        maxBuffer: TEXT_LIMIT,
        env: commandEnv(),
        windowsVerbatimArguments: shell.windowsVerbatimArguments,
      });
      return { stdout: clip(stdout), stderr: clip(stderr), exitCode: 0 };
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string; code?: number; message?: string };
      if (signal?.aborted) throw error;
      return {
        stdout: clip(failed.stdout || ""),
        stderr: clip(failed.stderr || failed.message || "Command failed"),
        exitCode: typeof failed.code === "number" ? failed.code : 1,
      };
    }
  }
}
