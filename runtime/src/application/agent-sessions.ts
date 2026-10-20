import type { Agent, Run } from "../domain/model.js";
import { errorText } from "../infrastructure/logger.js";
import { projectRules } from "./rules.js";
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

/**
 * What Saturn knows going into a Claude Code or Codex turn, as every other provider gets it: the memory notes
 * for the chat's project and the user, and what the agent's knowledge sources return for this message. A
 * knowledge source that cannot be reached is logged and left out, so the turn still runs.
 */
export async function turnContext(kernel: RuntimeKernel, agent: Agent, run: Run, signal?: AbortSignal, skipRules: readonly string[] = []): Promise<{ memory: string; knowledge: string; rules: string }> {
  const thread = run.threadId ? (kernel.store.state.threads ?? []).find((item) => item.id === run.threadId) : undefined;
  const [memory, rules, knowledge] = await Promise.all([
    kernel.memory.forPrompt(thread?.projectId),
    rulesFor(kernel, run, skipRules),
    kernel.runs.ragContext(agent, run.input, signal).catch((error: unknown) => {
      if (!signal?.aborted) kernel.log("agent", "warning", `${agent.name}: knowledge sources skipped: ${errorText(error)}`, { "saturn.run.id": run.id });
      return "";
    }),
  ]);
  return { memory: memory.trim(), knowledge: knowledge.trim(), rules };
}

/** The rules of the project a run's chat works in (see rules.ts); nothing outside a project. */
export async function rulesFor(kernel: RuntimeKernel, run: Run, skip: readonly string[] = []): Promise<string> {
  const thread = run.threadId ? (kernel.store.state.threads ?? []).find((item) => item.id === run.threadId) : undefined;
  if (!thread?.projectId) return "";
  let root: string | undefined;
  try {
    root = kernel.projects.workdirFor(thread);
  } catch {
    return "";
  }
  if (!root) return "";
  const project = (kernel.store.state.projects ?? []).find((item) => item.id === thread.projectId);
  return (await projectRules(root, project?.rules ?? "", skip)).text;
}

/** The user's message, after what the knowledge sources returned for it. */
export function withKnowledge(input: string, knowledge: string): string {
  return knowledge ? `<knowledge>\nRelevant knowledge from this agent's sources, for the message below:\n${knowledge}\n</knowledge>\n\n${input}` : input;
}
