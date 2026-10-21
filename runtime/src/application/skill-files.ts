import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Skills: folders with a SKILL.md (a name, a description, and instructions) an agent loads only when a task calls
 * for them, so a project can carry many without filling every prompt. The prompt lists each skill's name and
 * description; the `skill` tool, or the user's `/name` in the composer, brings in the whole file.
 *
 * Read from the project's `.agents/skills`, `.saturn/skills` and `.claude/skills` (Claude Code's), then the user's
 * `~/.saturn-app/skills`. A name found twice keeps the first, so a project can override a personal skill.
 */

export type SkillSource = "project" | "user";

export type SkillInfo = { name: string; description: string; path: string; source: SkillSource; folder: string };

/** Project folders searched for skills, in order. */
export const PROJECT_SKILL_DIRS = [".agents/skills", ".saturn/skills", ".claude/skills"] as const;
/** Characters of a SKILL.md handed to the model. */
export const SKILL_LIMIT = 40_000;
/** Characters of the skill list in the system prompt. */
export const SKILL_LIST_LIMIT = 4_000;

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** The YAML-ish frontmatter of a SKILL.md (`name:` and `description:` lines), and the body after it. */
export function parseSkill(text: string, fallbackName: string): { name: string; description: string; body: string } {
  let body = text;
  const meta: Record<string, string> = {};
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (match) {
    body = text.slice(match[0].length);
    for (const line of match[1]!.split(/\r?\n/)) {
      const pair = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
      if (pair) meta[pair[1]!.toLowerCase()] = pair[2]!.trim().replace(/^["']|["']$/g, "");
    }
  }
  // Without frontmatter: the first paragraph that is not a heading describes the skill.
  const description = meta.description || body.split(/\r?\n\r?\n/).map((part) => part.trim()).find((part) => part && !part.startsWith("#"))?.replace(/\s+/g, " ").slice(0, 300) || "";
  const name = meta.name && NAME.test(meta.name) ? meta.name : fallbackName;
  return { name, description, body: body.trim() };
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function scan(dir: string, source: SkillSource): Promise<SkillInfo[]> {
  let names: string[] = [];
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory() && NAME.test(entry.name)).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
  const skills: SkillInfo[] = [];
  for (const folderName of names) {
    const file = path.join(dir, folderName, "SKILL.md");
    if (!(await exists(file))) continue;
    try {
      const parsed = parseSkill(await readFile(file, "utf8"), folderName);
      skills.push({ name: parsed.name, description: parsed.description, path: file, source, folder: path.join(dir, folderName) });
    } catch {
      // Unreadable: skipped.
    }
  }
  return skills;
}

/** Every skill available to a chat in `root` (a project folder, or none), the first of each name winning. */
export async function listSkills(root: string | undefined, userDir: string): Promise<SkillInfo[]> {
  const found: SkillInfo[] = [];
  if (root) for (const dir of PROJECT_SKILL_DIRS) found.push(...(await scan(path.join(root, dir), "project")));
  found.push(...(await scan(userDir, "user")));
  const seen = new Set<string>();
  return found.filter((skill) => {
    const key = skill.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One skill's whole file, with the other files in its folder listed (scripts, templates it refers to). */
export async function loadSkill(root: string | undefined, userDir: string, name: string): Promise<{ name: string; description: string; path: string; instructions: string; files: string[] } | undefined> {
  const skill = (await listSkills(root, userDir)).find((item) => item.name.toLowerCase() === name.trim().replace(/^\//, "").toLowerCase());
  if (!skill) return undefined;
  const parsed = parseSkill(await readFile(skill.path, "utf8"), skill.name);
  let files: string[] = [];
  try {
    files = (await readdir(skill.folder, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name !== "SKILL.md")
      .map((entry) => path.relative(skill.folder, path.join(entry.parentPath ?? skill.folder, entry.name)).split(path.sep).join("/"))
      .slice(0, 50);
  } catch {
    files = [];
  }
  const body = parsed.body.length > SKILL_LIMIT ? `${parsed.body.slice(0, SKILL_LIMIT)}\n…(truncated)` : parsed.body;
  return { name: skill.name, description: skill.description, path: skill.path, instructions: body, files };
}

/** The skills section of the system prompt: names and descriptions only. */
export function skillsPrompt(skills: SkillInfo[]): string {
  if (!skills.length) return "";
  const lines: string[] = [];
  let used = 0;
  for (const skill of skills) {
    const line = `- ${skill.name}: ${skill.description || "(no description)"}`;
    if (used + line.length > SKILL_LIST_LIMIT) {
      lines.push(`- …and ${skills.length - lines.length} more (call skill with a name to load one)`);
      break;
    }
    lines.push(line);
    used += line.length;
  }
  return `# Skills\nInstructions for particular tasks, loaded on demand. When a task matches one, call the \`skill\` tool with its name before starting, and follow it.\n${lines.join("\n")}`;
}

/**
 * Commands: prompt templates a user runs from the composer as `/name arguments`. A Markdown file in the project's
 * `.saturn/commands` or `.claude/commands` (Claude Code's), or the user's `~/.saturn-app/commands`; `$ARGUMENTS`
 * in it becomes what follows the name. Frontmatter `description:` (or the first line) says what it does.
 */
export const PROJECT_COMMAND_DIRS = [".saturn/commands", ".claude/commands"] as const;

export type CommandInfo = { name: string; description: string; path: string; source: SkillSource };

async function scanCommands(dir: string, source: SkillSource): Promise<CommandInfo[]> {
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".md") && NAME.test(name.slice(0, -3))).sort();
  } catch {
    return [];
  }
  const commands: CommandInfo[] = [];
  for (const file of names) {
    try {
      const parsed = parseSkill(await readFile(path.join(dir, file), "utf8"), file.slice(0, -3));
      commands.push({ name: file.slice(0, -3), description: parsed.description.split("\n")[0]!.slice(0, 160), path: path.join(dir, file), source });
    } catch {
      // Unreadable: skipped.
    }
  }
  return commands;
}

export async function listCommands(root: string | undefined, userDir: string): Promise<CommandInfo[]> {
  const found: CommandInfo[] = [];
  if (root) for (const dir of PROJECT_COMMAND_DIRS) found.push(...(await scanCommands(path.join(root, dir), "project")));
  found.push(...(await scanCommands(userDir, "user")));
  const seen = new Set<string>();
  return found.filter((command) => {
    const key = command.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A command's prompt with `$ARGUMENTS` (or, without it, an appended line) filled in. */
export async function expandCommand(root: string | undefined, userDir: string, name: string, args: string): Promise<{ name: string; prompt: string } | undefined> {
  const command = (await listCommands(root, userDir)).find((item) => item.name.toLowerCase() === name.trim().replace(/^\//, "").toLowerCase());
  if (!command) return undefined;
  const body = parseSkill(await readFile(command.path, "utf8"), command.name).body;
  const prompt = body.includes("$ARGUMENTS") ? body.split("$ARGUMENTS").join(args) : args ? `${body}\n\n${args}` : body;
  return { name: command.name, prompt: prompt.slice(0, SKILL_LIMIT) };
}
