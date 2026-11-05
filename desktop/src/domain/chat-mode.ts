import type { ChatMode, RunMode } from "./model.js";

/** The chat modes, in order of how much the assistant may do. */
export const CHAT_MODES: { id: ChatMode; label: string; hint: string }[] = [
  { id: "manual", label: "Manual", hint: "You write the code. The assistant only reads and explains." },
  { id: "pair", label: "Pair", hint: "The assistant proposes changes, and each one needs your approval." },
  { id: "delegate", label: "Delegate", hint: "Each message starts a task in its own worktree." },
];

/** The mode a chat is in. A chat nobody has set only reads. */
export function chatModeOf(thread: { chatMode?: ChatMode } | null | undefined): ChatMode {
  return thread?.chatMode ?? "manual";
}

/** The mode a message to the assistant runs in. Only a Pair chat changes anything here: a Delegate chat's work goes to a task. */
export function assistantRunMode(mode: ChatMode): RunMode {
  return mode === "pair" ? "agent" : "ask";
}

/** Says in words what the assistant can do now. Codex cannot ask before it writes, so in Pair it only reads. */
export function assistantRole(mode: ChatMode, provider?: string): string {
  if (mode === "pair" && provider === "codex") return "Codex cannot ask before it writes, so here it reads and proposes in words.";
  if (mode === "pair") return "Proposes changes; each one needs your approval.";
  if (mode === "delegate") return "Each message starts a task in its own worktree. Nothing reaches the project until you merge it.";
  return "Reads and explains. It changes nothing.";
}
