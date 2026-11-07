/** The commands entered on this terminal, and the unfinished line remembered while looking back. */
export interface CommandHistory { entries: string[]; index: number | null; draft: string }

/** A newly opened terminal has no earlier commands. */
export function emptyHistory(): CommandHistory { return { entries: [], index: null, draft: "" }; }

/** Consecutive duplicate commands share one history entry; the latest 200 are kept in this terminal. */
export function rememberCommand(history: CommandHistory, command: string): CommandHistory {
  const entries = history.entries.at(-1) === command ? history.entries : [...history.entries, command].slice(-200);
  return { entries, index: null, draft: "" };
}

/** Up visits earlier commands; down returns to the line that was being typed when navigation began. */
export function navigateHistory(history: CommandHistory, direction: "up" | "down", current: string): { history: CommandHistory; command: string } {
  if (!history.entries.length || (direction === "down" && history.index === null)) return { history, command: current };
  const draft = history.index === null ? current : history.draft;
  const index = direction === "up" ? Math.max(0, (history.index ?? history.entries.length) - 1) : (history.index ?? -1) + 1;
  return index >= history.entries.length
    ? { history: { ...history, index: null, draft: "" }, command: draft }
    : { history: { ...history, index, draft }, command: history.entries[index] };
}
