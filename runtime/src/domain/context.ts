import type { RunAction } from "./model.js";

/**
 * Keeps what each model call carries bounded on long runs, in the spirit of the Claude API's context
 * editing and Claude Code / Cursor auto-summarization: the latest tool results stay whole, older ones
 * are cleared to a stub (the full result stays in the run for the UI), and one oversized result is
 * clipped to its head and tail. Earlier turns of the thread are kept newest-first within a budget.
 */

export const CONTEXT_LIMITS = {
  /** Tool results from the most recent actions that are sent in full (still capped per result). */
  recentActions: 6,
  /** Characters of one tool result the model sees, head and tail together. */
  resultChars: 8_000,
  /** Characters of earlier turns in the thread sent before the current request. */
  historyChars: 60_000,
};

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
