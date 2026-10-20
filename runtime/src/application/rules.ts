import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/** Characters of project rules put in an agent's prompt. */
export const RULES_BUDGET = 6000;

/** Rule files, in the order they are read; folders contribute their `.md` files by name. */
export const RULE_FILES = ["AGENTS.md", "CLAUDE.md", ".saturn/rules", ".agents/rules", ".cursorrules"] as const;

export type RuleSource = { path: string; chars: number };

/**
 * The project's own instructions for agents, read from the files teams already keep: AGENTS.md, CLAUDE.md,
 * `.saturn/rules/*.md`, `.agents/rules/*.md`, `.cursorrules`, then the rules saved in Saturn's project settings.
 * `skip` leaves out files the agent's own tool reads by itself (Codex reads AGENTS.md).
 */
export async function projectRules(root: string, stored = "", skip: readonly string[] = []): Promise<{ text: string; sources: RuleSource[] }> {
  const pieces: { path: string; content: string }[] = [];
  for (const entry of RULE_FILES) {
    if (skip.includes(entry)) continue;
    const full = path.join(root, entry);
    if (entry.endsWith("/rules")) {
      let names: string[] = [];
      try {
        names = (await readdir(full)).filter((name) => name.endsWith(".md")).sort();
      } catch {
        continue;
      }
      for (const name of names) {
        const content = await read(path.join(full, name));
        if (content) pieces.push({ path: `${entry}/${name}`, content });
      }
    } else {
      const content = await read(full);
      if (content) pieces.push({ path: entry, content });
    }
  }
  if (stored.trim()) pieces.push({ path: "Saturn project settings", content: stored.trim() });
  if (!pieces.length) return { text: "", sources: [] };

  let room = RULES_BUDGET;
  const parts: string[] = [];
  for (const piece of pieces) {
    if (room <= 200) break;
    const body = piece.content.length > room ? `${piece.content.slice(0, room)}\n…(truncated)` : piece.content;
    room -= body.length;
    parts.push(`## ${piece.path}\n${body}`);
  }
  return {
    text: `# Project rules (the project's instructions for agents; follow them)\n${parts.join("\n\n")}`,
    sources: pieces.map((piece) => ({ path: piece.path, chars: piece.content.length })),
  };
}

async function read(file: string): Promise<string> {
  try {
    const content = await readFile(file, "utf8");
    return content.includes("\u0000") ? "" : content.trim();
  } catch {
    return "";
  }
}
