/** One entry of the composer's "/" menu. */
export type SlashEntry = { name: string; description: string; kind: "builtin" | "skill" | "command" };

/** Commands Saturn itself understands in the composer. */
export const BUILTIN_COMMANDS: SlashEntry[] = [
  { name: "compact", description: "Fold this chat's earlier turns into a summary now", kind: "builtin" },
  { name: "plan", description: "Send the rest as a Plan turn: the agent reads and plans, changes nothing", kind: "builtin" },
  { name: "ask", description: "Send the rest as an Ask turn: the agent reads and answers, changes nothing", kind: "builtin" },
  { name: "new", description: "Start a new chat in this project", kind: "builtin" },
];

/** `/name rest` → the name and the rest, or undefined when the text is not a command. */
export function parseSlash(text: string): { name: string; rest: string } | undefined {
  const match = /^\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1]!, rest: (match[2] ?? "").trim() } : undefined;
}

/** The hidden block a skill or command adds to a message (the chat shows only what the user typed). */
export function hiddenContext(source: string, text: string): string {
  return `\n\n<saturn_context sources="${source.replace(/"/g, "'")}">\n<attached_context>\n${text}\n</attached_context>\n</saturn_context>`;
}
