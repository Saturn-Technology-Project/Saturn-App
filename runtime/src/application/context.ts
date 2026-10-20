import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { HttpError } from "../domain/errors.js";
import { WebSkill } from "../infrastructure/skills/web-skill.js";
import type { RuntimeKernel } from "./kernel.js";

const run = promisify(execFile);

/** Characters of attached context in one message. */
export const ATTACH_BUDGET = 60_000;
const FILE_LIMIT = 30_000;
const DIFF_LIMIT = 40_000;
const LISTING_LIMIT = 400;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", "build", ".next", ".cache", "coverage", "vendor", ".venv", "__pycache__"]);

/** One thing attached to a message with "@". */
export type ContextItem =
  | { kind: "file"; path: string; label?: string }
  | { kind: "folder"; path: string; label?: string }
  | { kind: "git"; label?: string }
  | { kind: "web"; url: string; label?: string }
  | { kind: "terminal"; label?: string }
  | { kind: "problems"; label?: string };

/**
 * Turns the "@" attachments of an Agent App message into the text the agent reads: files and folder listings
 * from the project, its uncommitted git changes, a public web page, the last commands agents ran in it, and the
 * output of its check command. Paths never leave the project folder.
 */
export class ContextService {
  private readonly web = new WebSkill();

  constructor(private readonly kernel: RuntimeKernel) {}

  async expand(projectId: string, items: ContextItem[], signal?: AbortSignal): Promise<{ text: string; sources: string[] }> {
    const root = this.kernel.projects.workdir(projectId);
    const parts: string[] = [];
    const sources: string[] = [];
    let used = 0;
    const push = (text: string) => {
      const room = ATTACH_BUDGET - used;
      if (room <= 200) return;
      const clipped = text.length > room ? `${text.slice(0, room)}\n…(truncated)` : text;
      parts.push(clipped);
      used += clipped.length;
    };
    for (const item of items.slice(0, 20)) {
      try {
        if (item.kind === "file") {
          const file = this.inside(root, item.path);
          const content = await readFile(file, "utf8");
          if (content.includes("\u0000")) throw new HttpError(415, `${item.path} is not a text file`);
          push(`<file path="${relative(root, file)}">\n${content.slice(0, FILE_LIMIT)}\n</file>`);
          sources.push(relative(root, file));
        } else if (item.kind === "folder") {
          const folder = this.inside(root, item.path);
          const listing = await this.listing(folder);
          push(`<folder path="${relative(root, folder) || "."}">\n${listing.join("\n")}\n</folder>`);
          sources.push(`${relative(root, folder) || "."}/`);
        } else if (item.kind === "git") {
          const status = await git(root, ["status", "--short"]);
          const diff = await git(root, ["diff", "HEAD", "--stat", "--patch", "--no-color"]);
          push(`<git_changes>\n${status}\n${diff.slice(0, DIFF_LIMIT)}\n</git_changes>`);
          sources.push("git changes");
        } else if (item.kind === "web") {
          const page = (await this.web.run({ url: item.url }, signal)) as { text?: string; title?: string };
          push(`<web_page url="${item.url}">\n${page.title ? `${page.title}\n\n` : ""}${page.text ?? ""}\n</web_page>`);
          sources.push(item.url.replace(/^https?:\/\//, "").slice(0, 40));
        } else if (item.kind === "terminal") {
          push(`<terminal>\n${this.terminal(projectId)}\n</terminal>`);
          sources.push("terminal");
        } else if (item.kind === "problems") {
          push(`<problems>\n${await this.problems(projectId, root, signal)}\n</problems>`);
          sources.push("problems");
        }
      } catch (error) {
        push(`<error item="${item.label ?? item.kind}">${error instanceof Error ? error.message : String(error)}</error>`);
      }
    }
    return { text: parts.join("\n"), sources };
  }

  /** Files in the project matching `query` (a case-insensitive part of the path), for the "@" picker. */
  async files(projectId: string, query: string, limit = 200): Promise<string[]> {
    const root = this.kernel.projects.workdir(projectId);
    const all = await this.listing(root, 5000);
    const needle = query.trim().toLowerCase();
    const matches = needle ? all.filter((item) => item.toLowerCase().includes(needle)) : all;
    // Shorter paths first: a file named like the query beats a deep one that only contains it.
    return matches.sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, limit);
  }

  /** `relative` resolved inside the project folder, or a 400. */
  private inside(root: string, relativePath: string): string {
    const full = path.resolve(root, String(relativePath ?? ""));
    if (full !== root && !full.startsWith(root + path.sep)) throw new HttpError(400, `${relativePath} is outside the project folder`);
    return full;
  }

  /** The folder's files, from git when it is a repository (so ignored files are left out), else a walk. */
  private async listing(folder: string, limit = LISTING_LIMIT): Promise<string[]> {
    try {
      const out = await git(folder, ["ls-files", "--cached", "--others", "--exclude-standard"]);
      const files = out.split("\n").filter(Boolean);
      if (files.length) return files.slice(0, limit);
    } catch {
      // Not a repository.
    }
    const found: string[] = [];
    const walk = async (dir: string, depth: number) => {
      if (depth > 8 || found.length >= limit) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (found.length >= limit) return;
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
        } else if (entry.isFile()) {
          found.push(path.relative(folder, full).split(path.sep).join("/"));
        }
      }
    };
    await walk(folder, 0);
    return found;
  }

  /** The last commands agents ran in this project, newest last. */
  private terminal(projectId: string): string {
    const threads = new Set((this.kernel.store.state.threads ?? []).filter((thread) => thread.projectId === projectId).map((thread) => thread.id));
    const commands: string[] = [];
    for (const run of this.kernel.store.state.runs) {
      if (!run.threadId || !threads.has(run.threadId)) continue;
      for (const action of [...run.actions].reverse()) {
        if (action.toolId !== "code" || commands.length >= 5) continue;
        const result = (action.result ?? {}) as { exitCode?: number; stdout?: string; stderr?: string; output?: string };
        const output = String(result.output ?? `${result.stdout ?? ""}${result.stderr ?? ""}`).trim().slice(-4000);
        commands.push(`$ ${String(action.arguments?.command ?? "")}\nexit code: ${result.exitCode ?? (action.status === "completed" ? 0 : "unknown")}\n${output}`);
      }
      if (commands.length >= 5) break;
    }
    return commands.length ? commands.reverse().join("\n\n") : "No commands have run in this project yet.";
  }

  /** What the project's check command reports now (Settings → Projects → Verify command). */
  private async problems(projectId: string, root: string, signal?: AbortSignal): Promise<string> {
    const command = await this.kernel.verify.commandFor(projectId, root);
    if (!command) return "No check command is set for this project (Settings → Projects → Verify command), so there is nothing to report.";
    const result = await this.kernel.verify.runCommand(command, root, signal);
    return result.ok ? `\`${command}\` passed with no output of note.` : `\`${command}\` failed (exit ${result.code ?? "?"}):\n${result.output}`;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

function relative(root: string, full: string): string {
  return path.relative(root, full).split(path.sep).join("/");
}

/** Whether a path exists as a file or folder (for the picker's validation). */
export async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
