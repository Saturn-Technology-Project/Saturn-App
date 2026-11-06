import { t } from "./i18n.ts";
import type { ChatMode, RunMode } from "./model.js";

/** The chat modes, in order of how much the assistant may do. */
export const CHAT_MODES: { id: ChatMode; label: string; hint: string }[] = [
  { id: "manual", label: "Ask", hint: t("You write the code. The assistant only reads and explains.") },
  { id: "pair", label: "Approve", hint: t("The assistant proposes changes, and each one needs your approval.") },
  { id: "delegate", label: "Auto", hint: t("The assistant works here, on the project itself, and asks before anything sensitive.") },
  { id: "delegate_auto", label: "Agent", hint: t("The assistant works here, on the project itself, and asks nothing.") },
];

/** The mode a chat is in. A chat nobody has set only reads. */
export function chatModeOf(thread: { chatMode?: ChatMode } | null | undefined): ChatMode {
  return thread?.chatMode ?? "manual";
}

/** The mode a message to the assistant runs in, in this same chat. Only an Ask chat leaves everything as it is. */
export function assistantRunMode(mode: ChatMode): RunMode {
  return mode === "manual" ? "ask" : "agent";
}

/** Says in words what the assistant can do now. Codex cannot ask before it writes, so in Approve it only reads. */
export function assistantRole(mode: ChatMode, provider?: string): string {
  if (mode === "pair" && provider === "codex") return t("Codex cannot ask before it writes, so here it reads and proposes in words.");
  if (mode === "pair") return t("Proposes changes; each one needs your approval.");
  if (mode === "delegate") return t("Works here, on the project itself, and asks before anything sensitive. For work to keep apart, it can start a task.");
  if (mode === "delegate_auto") return t("Works here, on the project itself, and asks nothing. For work to keep apart, it can start a task.");
  return t("Reads and explains. It changes nothing.");
}
