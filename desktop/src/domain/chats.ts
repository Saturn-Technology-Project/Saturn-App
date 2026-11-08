// A project's assistant chats: which of the assistant's threads they are, in what order, and what each is called.
import { t } from "./i18n.ts";

/** The chat a project's assistant panel had before a project could have more than one. */
export const ASSISTANT_THREAD = "Research assistant";
/** What a task's chat is called, followed by what it was asked. */
export const TASK_PREFIX = "Task: ";
/** What a new assistant chat is called until its first message names it. */
export const NEW_CHAT = "New chat";

/** The names a chat is made with: the runtime's own, this panel's, and the one chat a project had before there were more. */
const UNNAMED = new Set([NEW_CHAT, ASSISTANT_THREAD, "New Chat", "Conversation", ""]);

/** A chat as the assistant panel lists it. */
type ChatThread = { projectId?: string; title: string; updatedAt: string };

/** A project's assistant chats, the most recently used first: the assistant's chats in that project, without its tasks. */
export function assistantChats<Chat extends ChatThread>(threads: Chat[], projectId: string): Chat[] {
  return threads
    .filter((thread) => thread.projectId === projectId && !thread.title.startsWith(TASK_PREFIX))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Whether a chat still has the name it was made with, so its first message may name it. */
export function unnamed(title: string): boolean {
  return UNNAMED.has(title.trim());
}

/** A chat's name from its first message: the first line with words in it, cut on a word near 60 characters. */
export function titleFromMessage(message: string): string {
  const line = message.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return `${(space > 30 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The name a chat is shown by. */
export function chatName(thread: { title: string }): string {
  return unnamed(thread.title) ? t("New chat") : thread.title;
}
