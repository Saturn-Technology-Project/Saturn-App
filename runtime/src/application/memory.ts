import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent, ModelConnection, Run } from "../domain/model.js";
import { textOf } from "../domain/policies.js";
import { errorText, logger } from "../infrastructure/logger.js";
import type { RuntimeKernel } from "./kernel.js";

/** Characters of memory put before an agent's instructions (project memory first, then global). */
const PROMPT_BUDGET = 2500;
/** Turns between extractions in one chat. */
const EVERY_TURNS = 6;
/** Entries kept per memory file. */
const MAX_ENTRIES = 60;

/**
 * What Saturn remembers across chats, as plain Markdown files the user can read and edit:
 * `<data>/memory/global.md` (how the user likes to work) and `<data>/memory/<projectId>.md` (that project's
 * conventions). Every few turns a small model call reads the recent conversation and adds what is worth keeping;
 * the files are put at the top of each agent's system prompt.
 */
export class MemoryService {
  private readonly extracting = new Set<string>();

  constructor(private readonly kernel: RuntimeKernel) {}

  dir(): string {
    return path.join(this.kernel.store.root, "memory");
  }

  file(scope: "global" | string): string {
    return path.join(this.dir(), `${scope === "global" ? "global" : scope.replace(/[^\w-]/g, "_")}.md`);
  }

  async read(scope: "global" | string): Promise<string> {
    try {
      return await readFile(this.file(scope), "utf8");
    } catch {
      return "";
    }
  }

  async write(scope: "global" | string, content: string): Promise<void> {
    await mkdir(this.dir(), { recursive: true, mode: 0o700 });
    await writeFile(this.file(scope), content.replace(/\s+$/, "") + (content.trim() ? "\n" : ""), "utf8");
  }

  /** The memory block for a system prompt: the project's notes, then the user's, within the budget. */
  async forPrompt(projectId?: string): Promise<string> {
    const enabled = (this.kernel.store.state.settings as { memory?: boolean }).memory !== false;
    if (!enabled) return "";
    const project = projectId ? (await this.read(projectId)).trim() : "";
    const global = (await this.read("global")).trim();
    if (!project && !global) return "";
    const parts: string[] = [];
    if (project) parts.push(`## About this project\n${project}`);
    if (global) parts.push(`## About the user\n${global}`);
    const text = parts.join("\n\n");
    const clipped = text.length > PROMPT_BUDGET ? `${text.slice(0, PROMPT_BUDGET)}\n…` : text;
    return `# Memory (notes Saturn kept from earlier chats; the user can edit them in Settings → Memory)\n${clipped}`;
  }

  /** After a run ends: every few turns, ask a model what the recent turns taught, and keep it. */
  async noteRun(run: Run): Promise<void> {
    const enabled = (this.kernel.store.state.settings as { memory?: boolean }).memory !== false;
    if (!enabled || !run.threadId || run.status !== "completed" || run.groupId) return;
    const turns = this.kernel.store.state.runs.filter((item) => item.threadId === run.threadId && item.status === "completed");
    if (turns.length % EVERY_TURNS !== 0) return;
    const key = run.threadId;
    if (this.extracting.has(key)) return;
    this.extracting.add(key);
    try {
      await this.extract(run, turns.slice(-EVERY_TURNS));
    } catch (error) {
      logger.debug("memory", `Could not extract memory: ${errorText(error)}`);
    } finally {
      this.extracting.delete(key);
    }
  }

  private async extract(run: Run, turns: Run[]): Promise<void> {
    const agent = this.kernel.store.state.agents.find((item) => item.id === run.agentId);
    const model = agent ? this.model(agent) : undefined;
    if (!agent || !model) return;
    const thread = (this.kernel.store.state.threads ?? []).find((item) => item.id === run.threadId);
    const projectId = thread?.projectId;
    const transcript = turns
      .map((turn) => `User: ${clip(turn.input, 1200)}\nAgent: ${clip(turn.output, 1200)}`)
      .join("\n\n");
    const current = { global: await this.read("global"), project: projectId ? await this.read(projectId) : "" };
    const body = await this.kernel.llm.complete(model, {
      context: { agentId: agent.id, agentName: agent.name, runId: run.id, purpose: "memory" },
      temperature: 0,
      maxOutput: 600,
      thinking: "low",
      messages: [
        {
          role: "system",
          content: [
            "You keep short notes about a user and their project for an AI coding assistant, so later chats start informed.",
            "From the recent conversation, pick out only durable facts worth remembering next week: the user's preferences and ways of working (global), and this project's conventions, structure, commands and decisions (project).",
            "Skip anything already noted, anything about this one task only, secrets, and guesses.",
            "Reply with JSON only: {\"global\": [\"…\"], \"project\": [\"…\"]}. Each entry is one short sentence. Empty arrays when there is nothing new.",
          ].join("\n"),
        },
        {
          role: "user",
          content: `Already noted (global):\n${current.global || "(nothing)"}\n\nAlready noted (project):\n${current.project || "(nothing)"}\n\nRecent conversation:\n${transcript}`,
        },
      ],
    });
    const parsed = parseNotes(textOf(body));
    if (parsed.global.length) await this.write("global", merge(current.global, parsed.global));
    if (projectId && parsed.project.length) await this.write(projectId, merge(current.project, parsed.project));
    if (parsed.global.length || parsed.project.length) logger.info("memory", `Remembered ${parsed.global.length + parsed.project.length} ${parsed.global.length + parsed.project.length === 1 ? "note" : "notes"} from ${agent.name}'s chat`);
  }

  /** A cheap model for extraction: the completion model when set, else the agent's own. */
  private model(agent: Agent): ModelConnection | undefined {
    const models = this.kernel.store.state.models;
    const completion = models.find((item) => item.id === this.kernel.store.state.settings.completionModelId);
    const own = models.find((item) => item.id === agent.modelConnectionId);
    const pick = completion ?? own;
    return pick && pick.provider !== "claude-code" && pick.provider !== "codex" ? pick : own && own.provider !== "claude-code" && own.provider !== "codex" ? own : undefined;
  }
}

export function parseNotes(text: string): { global: string[]; project: string[] } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { global: [], project: [] };
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as { global?: unknown; project?: unknown };
    const list = (items: unknown) => (Array.isArray(items) ? items.map((item) => String(item).trim()).filter((item) => item.length > 3 && item.length < 300) : []);
    return { global: list(value.global), project: list(value.project) };
  } catch {
    return { global: [], project: [] };
  }
}

/** Adds entries as "- " lines, skipping near-duplicates, and keeps the newest MAX_ENTRIES. */
export function merge(existing: string, entries: string[]): string {
  const lines = existing.split("\n").map((line) => line.trim()).filter(Boolean);
  const normalized = (line: string) => line.replace(/^-\s*/, "").toLowerCase().replace(/[^a-z0-9一-鿿]+/g, " ").trim();
  const have = new Set(lines.map(normalized));
  for (const entry of entries) {
    const key = normalized(entry);
    if (!key || have.has(key)) continue;
    have.add(key);
    lines.push(`- ${entry.replace(/^-\s*/, "")}`);
  }
  return lines.slice(-MAX_ENTRIES).join("\n");
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
