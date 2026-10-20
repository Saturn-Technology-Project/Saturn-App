import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Run } from "../domain/model.js";
import { errorText } from "../infrastructure/logger.js";
import type { RuntimeKernel } from "./kernel.js";

/** Automatic fix rounds after one message from the user. */
export const MAX_ROUNDS = 2;
const TIMEOUT_MS = 5 * 60 * 1000;
const OUTPUT_LIMIT = 4000;

export type Verification = { command: string; ok: boolean; code: number | null; output: string };

/**
 * After an agent turn that changed files in a project: runs the project's check command (its own, or the
 * package.json typecheck/lint script when the setting says "auto") and, when it fails, sends the failure back
 * to the agent as a follow-up, at most MAX_ROUNDS times per message from the user. The result is recorded on
 * the run (`run.verification`) for the apps to show.
 */
export class VerifyService {
  constructor(private readonly kernel: RuntimeKernel) {}

  /** The command to run for a project, or undefined when verification is off. */
  async commandFor(projectId: string, root: string): Promise<string | undefined> {
    const project = (this.kernel.store.state.projects ?? []).find((item) => item.id === projectId);
    const setting = (project?.verifyCommand ?? "").trim();
    if (!setting) return undefined;
    if (setting !== "auto") return setting;
    try {
      const scripts = (JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
      return scripts.typecheck ? "npm run typecheck" : scripts.lint ? "npm run lint" : undefined;
    } catch {
      return undefined;
    }
  }

  runCommand(command: string, cwd: string, signal?: AbortSignal): Promise<Verification> {
    return new Promise((resolve) => {
      exec(command, { cwd, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, signal, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } }, (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim().slice(-OUTPUT_LIMIT);
        resolve({ command, ok: !error, code: error ? (typeof error.code === "number" ? error.code : null) : 0, output });
      });
    });
  }

  /** Called when a run ends. Nothing happens unless the run changed files in a project with a check command. */
  async afterRun(run: Run): Promise<void> {
    if (run.status !== "completed" || run.groupId || !run.threadId) return;
    const changed = run.checkpoint?.files.some((file) => file.before !== file.after && file.review !== "reverted");
    if (!changed) return;
    const thread = (this.kernel.store.state.threads ?? []).find((item) => item.id === run.threadId);
    if (!thread?.projectId) return;
    let root: string;
    try {
      root = this.kernel.projects.workdirFor(thread) ?? this.kernel.projects.workdir(thread.projectId);
    } catch {
      return;
    }
    const command = await this.commandFor(thread.projectId, root);
    if (!command) return;
    const result = await this.runCommand(command, root);
    await this.kernel.store.update((state) => {
      const current = state.runs.find((item) => item.id === run.id);
      if (current) current.verification = result;
    });
    if (result.ok) {
      this.kernel.log("agent", "info", `${command} passed after the agent's changes`, { "saturn.run.id": run.id });
      return;
    }
    const rounds = this.roundsSince(run.threadId);
    if (rounds >= MAX_ROUNDS) {
      this.kernel.log("agent", "warning", `${command} still fails after ${MAX_ROUNDS} automatic fix rounds; leaving it to the user`, { "saturn.run.id": run.id });
      return;
    }
    this.kernel.log("agent", "info", `${command} failed (exit ${result.code ?? "?"}); asking the agent to fix it (round ${rounds + 1} of ${MAX_ROUNDS})`, { "saturn.run.id": run.id });
    try {
      await this.kernel.runs.startRun(run.agentId, `\`${command}\` failed (exit ${result.code ?? "?"}) after your changes:\n\n${result.output || "(no output)"}\n\nFix these, then check again.`, run.threadId, undefined, { automatic: true });
    } catch (error) {
      this.kernel.log("agent", "warning", `Could not start the automatic fix round: ${errorText(error)}`, { "saturn.run.id": run.id });
    }
  }

  /** Automatic runs in a chat since the user's own last message (newest runs come first in state). */
  private roundsSince(threadId: string): number {
    let count = 0;
    for (const run of this.kernel.store.state.runs) {
      if (run.threadId !== threadId) continue;
      if (!run.automatic) break;
      count += 1;
    }
    return count;
  }
}
