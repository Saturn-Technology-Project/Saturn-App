import type { ModelConnection, RunAction } from "./model.js";

/**
 * Keeps what each model call carries bounded on long runs, in the spirit of the Claude API's context
 * editing and Claude Code / Cursor auto-summarization: the latest tool results stay whole, older ones
 * are cleared to a stub (the full result stays in the run for the UI), and one oversized result is
 * clipped to its head and tail. Earlier turns of the thread fit a budget sized to the model's context window;
 * when they do not, the oldest are summarized into the chat's running summary (see RunService.historyFor).
 */

export const CONTEXT_LIMITS = {
  /** Tool results from the most recent actions that are sent in full (still capped per result). */
  recentActions: 6,
  /** Characters of one tool result the model sees, head and tail together. */
  resultChars: 8_000,
  /** Characters of earlier turns sent before the current request, when the model's window is unknown. */
  historyChars: 60_000,
};

/** A rough 4 characters per token, the usual estimate for English and code. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Context windows by provider and model family, in tokens. A connection's own `contextTokens` wins. */
const CONTEXT_WINDOWS: { provider: string; model?: RegExp; tokens: number }[] = [
  { provider: "claude", tokens: 200_000 },
  { provider: "openai", model: /^gpt-6/, tokens: 400_000 },
  { provider: "openai", tokens: 128_000 },
  { provider: "gemini", tokens: 1_000_000 },
  { provider: "deepseek", tokens: 128_000 },
  { provider: "lmstudio", tokens: 32_000 },
];

export function contextTokensFor(model: Pick<ModelConnection, "provider" | "model" | "contextTokens">): number {
  if (model.contextTokens && model.contextTokens > 0) return model.contextTokens;
  const match = CONTEXT_WINDOWS.find((item) => item.provider === model.provider && (!item.model || item.model.test(model.model)));
  return match?.tokens ?? 128_000;
}

/**
 * Characters of earlier turns a request may carry: half the window, leaving the rest for the system prompt,
 * the tools, this turn's tool results and the answer.
 */
export function historyBudgetChars(model: Pick<ModelConnection, "provider" | "model" | "contextTokens">): number {
  return Math.floor((contextTokensFor(model) * CHARS_PER_TOKEN) / 2);
}

function serialized(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/** Head and tail of a long text, with what was cut in between. */
export function clipMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  return `${text.slice(0, head)}\n…[${text.length - head - tail} characters omitted]…\n${text.slice(-tail)}`;
}

/** The actions as the model should see them this round; the run keeps the originals. */
export function compactActions(actions: RunAction[], limits = CONTEXT_LIMITS): RunAction[] {
  const firstRecent = Math.max(0, actions.length - limits.recentActions);
  return actions.map((action, index) => {
    if (action.result === undefined) return action;
    const text = serialized(action.result);
    if (index < firstRecent) {
      return { ...action, result: `[result cleared to save context: ${text.length} characters. Call ${action.toolId} again if you need it.]` };
    }
    if (text.length <= limits.resultChars) return action;
    return { ...action, result: clipMiddle(text, limits.resultChars) };
  });
}

/**
 * Earlier turns (oldest first in `turns`), trimmed from the oldest end to fit the budget.
 * Returns the turns to send and how many were left out.
 */
export function budgetHistory<T extends { role: string; content: string }>(turns: T[], budget = CONTEXT_LIMITS.historyChars): { kept: T[]; omitted: number } {
  let used = 0;
  let start = turns.length;
  while (start > 0) {
    const size = turns[start - 1].content.length;
    if (used + size > budget && start < turns.length) break;
    used += size;
    start -= 1;
  }
  // Never open on an answer whose question was cut.
  while (start < turns.length && turns[start].role !== "user") start += 1;
  return { kept: turns.slice(start), omitted: start };
}

/**
 * Which earlier turns to fold into the summary: the oldest ones, so that what stays fits `keepChars`.
 * The newest turn always stays, so the model sees the exchange it is continuing.
 */
export function splitForCompaction<T extends { chars: number }>(turns: T[], keepChars: number): { old: T[]; recent: T[] } {
  let used = 0;
  let start = turns.length;
  while (start > 0) {
    const size = turns[start - 1]!.chars;
    if (used + size > keepChars && start < turns.length) break;
    used += size;
    start -= 1;
  }
  return { old: turns.slice(0, start), recent: turns.slice(start) };
}

/** The instruction the summarizing call gets; the turns follow as the conversation itself. */
export const COMPACTION_PROMPT =
  "You are compacting the earlier part of a conversation between a user and an AI agent so the agent can continue it with less context. " +
  "Write a summary for the agent, in the user's language, under 600 words. Keep what later turns depend on: the user's goal and the decisions made, " +
  "files, paths, commands and identifiers that mattered, what was done and what is still open, errors seen and how they were resolved, and the user's " +
  "preferences and constraints. Leave out pleasantries and anything superseded. If an earlier summary is given, fold it in rather than repeating it. " +
  "Answer with the summary only.";
