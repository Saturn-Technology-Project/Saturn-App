/**
 * Permission rules: what an agent may do without asking, what it must ask about, and what it may never do.
 *
 * A rule names a tool and a pattern. For the shell (`code`) the pattern is a command prefix with `*` wildcards
 * (`npm test *`, `git *`); for files it is `<action> <path glob>` (`write src/**`, `read **`); for every other
 * tool it is matched against the call's first text argument, or `*` for any call. Rules live in layers (the
 * user's settings, a project, an agent, and the project's own settings files); `resolvePermission` combines them.
 */

export type PermissionEffect = "allow" | "deny" | "ask";

export type PermissionRule = {
  /** A tool id, or a glob over tool ids (`github_*`). */
  tool: string;
  pattern: string;
  effect: PermissionEffect;
};

export type PermissionScope = "user" | "project" | "agent" | "project-file" | "claude-file";

export type PermissionLayer = { scope: PermissionScope; rules: PermissionRule[]; path?: string };

export type PermissionDecision = { effect: PermissionEffect; rule: PermissionRule; scope: PermissionScope; path?: string };

const FILE_ACTIONS = ["list", "read", "write", "append", "delete", "move", "copy", "mkdir", "search", "patch", "edit"];

/** Deny beats ask beats allow, so one careful rule is never undone by a broader generous one. */
const PRIORITY: Record<PermissionEffect, number> = { deny: 3, ask: 2, allow: 1 };

function globToRegExp(glob: string, { path = false } = {}): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === "*") {
      if (path && glob[i + 1] === "*") {
        // `**` crosses folders; `**/` also matches nothing at all (`src/**/x` matches `src/x`).
        if (glob[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += path ? "[^/]*" : ".*";
      }
    } else if (char === "?") {
      source += path ? "[^/]" : ".";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "s");
}

function matchesGlob(glob: string, value: string, options?: { path?: boolean }): boolean {
  return globToRegExp(glob.trim(), options).test(value);
}

/** The pieces of a shell line that run one after another: `a && b | c; d` has four. Quotes are respected. */
export function commandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && i + 1 < command.length) current += command[++i];
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if (char === "\\" && i + 1 < command.length) {
      current += char + command[++i];
    } else if (char === ";" || char === "\n" || ((char === "&" || char === "|") && command[i + 1] === char)) {
      segments.push(current);
      current = "";
      if (char === "&" || char === "|") i += 1;
    } else if (char === "|" || char === "&") {
      segments.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

/** Collapses runs of whitespace so `npm   test` and `npm test` read the same. */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/**
 * Whether a shell pattern covers one command segment. A pattern that ends in ` *` is a prefix: `npm test *`
 * covers `npm test` and `npm test --watch`, but not `npm testing`.
 */
export function matchesCommand(pattern: string, segment: string): boolean {
  const normalized = normalizeCommand(segment);
  const rule = normalizeCommand(pattern);
  if (rule === "*") return true;
  if (rule.endsWith(" *")) {
    const prefix = rule.slice(0, -2);
    if (normalized === prefix) return true;
    if (normalized.startsWith(`${prefix} `)) return true;
    // Wildcards inside the prefix too (`git * --dry-run *`).
    if (prefix.includes("*")) return matchesGlob(`${prefix} *`, normalized) || matchesGlob(prefix, normalized);
    return false;
  }
  return matchesGlob(rule, normalized);
}

function fileParts(pattern: string): { action: string; glob: string } {
  const trimmed = pattern.trim();
  const space = trimmed.indexOf(" ");
  if (space < 0) return FILE_ACTIONS.includes(trimmed) ? { action: trimmed, glob: "**" } : { action: "*", glob: trimmed };
  const head = trimmed.slice(0, space);
  if (FILE_ACTIONS.includes(head) || head === "*") return { action: head, glob: trimmed.slice(space + 1).trim() };
  return { action: "*", glob: trimmed };
}

/** The text a non-shell, non-file rule is matched against: the call's first string argument. */
export function primaryArgument(args: Record<string, unknown>): string {
  for (const key of ["url", "path", "query", "command", "name", "title", "text", "input"]) {
    if (typeof args[key] === "string") return args[key] as string;
  }
  for (const value of Object.values(args)) if (typeof value === "string") return value;
  return "";
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Whether one rule covers one tool call (for the shell: one command segment). */
export function matchesRule(rule: PermissionRule, toolId: string, args: Record<string, unknown>, segment?: string): boolean {
  if (rule.tool !== "*" && rule.tool !== toolId && !(rule.tool.includes("*") && matchesGlob(rule.tool, toolId))) return false;
  if (toolId === "code") return matchesCommand(rule.pattern, segment ?? String(args.command ?? ""));
  if (toolId === "files") {
    const { action, glob } = fileParts(rule.pattern);
    const called = String(args.action ?? "");
    if (action !== "*" && action !== called && !(action === "write" && called === "append")) return false;
    const target = normalizePath(String(args.path ?? args.from ?? args.source ?? ""));
    return glob === "**" || glob === "*" ? true : matchesGlob(glob, target, { path: true });
  }
  const pattern = rule.pattern.trim();
  return pattern === "*" || pattern === "" || matchesGlob(pattern, primaryArgument(args));
}

function strongest(decisions: PermissionDecision[]): PermissionDecision | undefined {
  let best: PermissionDecision | undefined;
  for (const decision of decisions) if (!best || PRIORITY[decision.effect] > PRIORITY[best.effect]) best = decision;
  return best;
}

/**
 * The decision the layers make about one tool call, or undefined when no rule applies (the agent's own
 * approval setting decides then). A shell line is judged by its segments: every segment must be allowed for the
 * line to be allowed, and the strictest segment wins otherwise.
 */
export function resolvePermission(layers: PermissionLayer[], toolId: string, args: Record<string, unknown>): PermissionDecision | undefined {
  const judge = (segment?: string): PermissionDecision | undefined => {
    const hits: PermissionDecision[] = [];
    for (const layer of layers) {
      for (const rule of layer.rules) {
        if (matchesRule(rule, toolId, args, segment)) hits.push({ effect: rule.effect, rule, scope: layer.scope, ...(layer.path ? { path: layer.path } : {}) });
      }
    }
    return strongest(hits);
  };
  if (toolId !== "code") return judge();
  const segments = commandSegments(String(args.command ?? ""));
  if (!segments.length) return undefined;
  const decisions = segments.map((segment) => judge(segment));
  const decided = decisions.filter((item): item is PermissionDecision => Boolean(item));
  const strict = strongest(decided);
  if (strict && strict.effect !== "allow") return strict;
  // Allowed only when every segment is covered by an allow rule.
  return decided.length === segments.length ? strict : undefined;
}

/** A readable form for cards and logs: `code: npm test *`. */
export function describeRule(rule: PermissionRule): string {
  return `${rule.tool}: ${rule.pattern}`;
}

/**
 * Converts a rule from Claude Code's `.claude/settings.json` (`Bash(npm test:*)`, `Read(src/**)`, `Edit`,
 * `WebFetch(domain:example.com)`, `mcp__github__create_issue`) to a Saturn rule, or undefined when there is no
 * equivalent.
 */
export function fromClaudeRule(text: string, effect: PermissionEffect): PermissionRule | undefined {
  const match = /^([A-Za-z_][\w-]*)(?:\((.*)\))?$/.exec(text.trim());
  if (!match) return undefined;
  const [, name, inner = ""] = match;
  const spec = inner.trim();
  switch (name) {
    case "Bash": {
      if (!spec) return { tool: "code", pattern: "*", effect };
      const prefix = spec.endsWith(":*") ? `${spec.slice(0, -2)} *` : spec;
      return { tool: "code", pattern: prefix, effect };
    }
    case "Read":
    case "Glob":
    case "Grep":
      return { tool: "files", pattern: spec ? `read ${spec}` : "read", effect };
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return { tool: "files", pattern: spec ? `write ${spec}` : "write", effect };
    case "WebFetch":
    case "WebSearch": {
      const domain = /^domain:(.+)$/.exec(spec)?.[1];
      return { tool: "web", pattern: domain ? `*${domain}*` : "*", effect };
    }
    default:
      if (name.startsWith("mcp__")) {
        const [, , tool] = name.split("__");
        return { tool: tool ? `*${tool}` : "*", pattern: "*", effect };
      }
      return undefined;
  }
}

/** A sensible rule to offer when the user picks "Always allow" on a waiting call. */
export function suggestedPattern(toolId: string, args: Record<string, unknown>): string {
  if (toolId === "code") {
    const segments = commandSegments(String(args.command ?? ""));
    const first = normalizeCommand(segments[0] ?? "");
    const words = first.split(" ");
    const head = words[0] ?? "";
    const second = words[1] && !words[1].startsWith("-") ? words[1] : "";
    return head ? `${head}${second ? ` ${second}` : ""} *` : "*";
  }
  if (toolId === "files") {
    const action = String(args.action ?? "*");
    const target = normalizePath(String(args.path ?? ""));
    const folder = target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : "";
    return `${action === "append" ? "write" : action} ${folder ? `${folder}/**` : "**"}`;
  }
  return "*";
}

export function isPermissionRule(value: unknown): value is PermissionRule {
  const rule = value as PermissionRule;
  return Boolean(rule) && typeof rule.tool === "string" && rule.tool.trim() !== "" && typeof rule.pattern === "string" && ["allow", "deny", "ask"].includes(rule.effect);
}
