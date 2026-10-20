import type { Run } from "../domain/model.js";
import type { RuntimeKernel } from "./kernel.js";

/** Which SDK session id a provider keeps: Claude Code's session, or Codex's thread. */
export type SessionKey = "claudeSessionId" | "codexThreadId";

/**
 * The session a Claude Code or Codex run resumes. A chat keeps one on its conversation; a group keeps one per
 * member agent, so every turn an agent takes in that group continues the same session instead of opening a new one.
 */
export function savedSession(kernel: RuntimeKernel, run: Run, key: SessionKey): string | undefined {
  if (run.groupId) return (kernel.store.state.groups ?? []).find((item) => item.id === run.groupId)?.sessions?.[run.agentId]?.[key];
  if (!run.threadId) return undefined;
  return (kernel.store.state.threads ?? []).find((item) => item.id === run.threadId)?.[key];
}

/** Keeps the session the run ended on, so the next turn of the same chat (or agent in the group) resumes it. */
export async function saveSession(kernel: RuntimeKernel, run: Run, key: SessionKey, value: string): Promise<void> {
  await kernel.store.update((state) => {
    if (run.groupId) {
      const group = (state.groups ?? []).find((item) => item.id === run.groupId);
      if (!group) return;
      group.sessions ??= {};
      group.sessions[run.agentId] = { ...group.sessions[run.agentId], [key]: value };
      return;
    }
    const thread = run.threadId ? (state.threads ?? []).find((item) => item.id === run.threadId) : undefined;
    if (thread) thread[key] = value;
  });
}
