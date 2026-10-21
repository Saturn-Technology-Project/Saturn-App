import type { PermissionRule } from "./model";

/** The rule offered on "Always allow": a command prefix, a folder of files, or any call of the tool. */
export function suggestedPattern(toolId: string, args: Record<string, unknown> = {}): string {
  if (toolId === "code") {
    const first = String(args.command ?? "").split(/\s*(?:&&|\|\||;|\||&|\n)\s*/)[0]?.trim().replace(/\s+/g, " ") ?? "";
    const words = first.split(" ");
    const head = words[0] ?? "";
    const second = words[1] && !words[1].startsWith("-") ? words[1] : "";
    return head ? `${head}${second ? ` ${second}` : ""} *` : "*";
  }
  if (toolId === "files") {
    const action = String(args.action ?? "*");
    const target = String(args.path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
    const folder = target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : "";
    return `${action === "append" ? "write" : action} ${folder ? `${folder}/**` : "**"}`;
  }
  return "*";
}

/** How a rule reads in a list: `code  npm test *`. */
export function describeRule(rule: PermissionRule): string {
  return `${rule.tool}: ${rule.pattern}`;
}

/** What a pattern means for a tool, for the hint under the input. */
export function patternHint(tool: string): string {
  if (tool === "code") return "A command prefix: a trailing * covers any arguments (npm test *). Chains are judged one command at a time.";
  if (tool === "files") return "An action and a path glob: write src/**, read, delete *.md.";
  if (tool === "*") return "Any tool; the pattern matches the call's first text argument, or * for every call.";
  return "Matched against the call's first text argument (a URL, a path, a name), or * for every call.";
}
