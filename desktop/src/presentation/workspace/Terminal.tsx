import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { desktop } from "../../application/desktop.js";
import { t } from "../../domain/i18n.js";
import { emptyHistory, navigateHistory, rememberCommand } from "../../domain/terminal.js";
import { Input } from "../ui/base/Input.js";
import { messageOf } from "../ui/Parts.js";

interface Entry {
  id: number;
  folder: string;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  pending: boolean;
}

/** Runs one command at a time in the project's folder. It is not a full terminal: nothing interactive runs here. */
export function Terminal(props: { folder: string; active?: boolean }) {
  const [folder, setFolder] = useState(props.folder);
  const [command, setCommand] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState(emptyHistory);
  const counter = useRef(0);
  const generation = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const follow = useRef(true);

  // A project switch starts a fresh terminal; an earlier request must not write into it when it eventually returns.
  useEffect(() => {
    generation.current += 1;
    setFolder(props.folder); setCommand(""); setEntries([]); setHistory(emptyHistory()); setRunning(false);
    follow.current = true;
    return () => { generation.current += 1; };
  }, [props.folder]);

  // The prompt follows the last output in this scrollback, never a footer pinned to the panel's bottom.
  useLayoutEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [entries, running]);

  // Opening the panel or finishing a command returns to the prompt, without taking focus from the code editor.
  useEffect(() => {
    const focused = document.activeElement;
    if (props.active && !running && (focused === document.body || focused?.getAttribute("role") === "tab" || (focused && scroll.current?.contains(focused)))) input.current?.focus({ preventScroll: true });
  }, [props.active, running]);

  /** Clears scrollback while keeping any command that is still running and the command history. */
  function clear() {
    setEntries((current) => current.filter((entry) => entry.pending));
    follow.current = true;
    if (!running && props.active) input.current?.focus({ preventScroll: true });
  }

  async function run() {
    const typed = command.trim();
    if (!typed || running) return;
    setCommand("");
    setHistory((current) => rememberCommand(current, typed));
    if (typed === "clear") { clear(); return; }
    setRunning(true);
    follow.current = true;
    const id = (counter.current += 1);
    const startedIn = generation.current;
    setEntries((list) => [...list, { id, folder, command: typed, stdout: "", stderr: "", exitCode: null, pending: true }]);
    try {
      const result = await desktop.workspace.exec(typed, folder);
      if (generation.current !== startedIn) return;
      setFolder(result.cwd);
      setEntries((list) => list.map((entry) => entry.id === id ? { ...entry, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, pending: false } : entry));
    } catch (error) {
      if (generation.current === startedIn) setEntries((list) => list.map((entry) => entry.id === id ? { ...entry, stderr: messageOf(error), exitCode: 1, pending: false } : entry));
    } finally {
      if (generation.current === startedIn) setRunning(false);
    }
  }

  /** A compact working-folder prompt; its full path remains available on hover. */
  const prompt = (path: string) => <span title={path} className="flex-none text-(--term-prompt)">{path.split(/[/\\]/).filter(Boolean).at(-1) || path} $</span>;

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-(--term-bg) font-mono text-xs leading-[1.45] text-(--term-fg)" onKeyDown={(event) => {
      if (event.ctrlKey && event.key.toLowerCase() === "l") { event.preventDefault(); clear(); }
    }}>
      {/* Over the scrollback's corner rather than on a row of its own, so every line goes to output. */}
      <button type="button" className="absolute top-1 right-3.5 z-10 cursor-pointer rounded bg-(--term-bg) px-1.5 text-[11px] leading-5 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={clear}>{t("Clear terminal")}</button>
      <div ref={scroll} className="min-h-0 flex-1 cursor-text overflow-auto px-3 py-1.5" onScroll={() => {
        const pane = scroll.current;
        if (pane) follow.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 48;
      }} onClick={(event) => {
        if (!(event.target as HTMLElement).closest("button,input") && window.getSelection()?.isCollapsed !== false) input.current?.focus({ preventScroll: true });
      }}>
        <div role="log" aria-label={t("Terminal output")} aria-live="polite" aria-relevant="additions text">
          {entries.map((entry) => <div key={entry.id} className="mb-1.5">
            <div className="flex items-start gap-2">{prompt(entry.folder)}<span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{entry.command}</span></div>
            {entry.stdout ? <pre className="m-0 font-mono text-xs leading-[1.45] whitespace-pre-wrap [overflow-wrap:anywhere]">{entry.stdout}</pre> : null}
            {entry.stderr ? <pre className="m-0 font-mono text-xs leading-[1.45] whitespace-pre-wrap text-(--term-stderr) [overflow-wrap:anywhere]">{entry.stderr}</pre> : null}
            {entry.pending ? <div className="text-muted-foreground">{t("Running…")}</div> : null}
            {entry.exitCode !== null && entry.exitCode !== 0 ? <div className="text-wait">{t("Exit code {code}", { code: entry.exitCode })}</div> : null}
          </div>)}
        </div>
        <form className={running ? "hidden" : "flex items-center gap-2"} onSubmit={(event) => { event.preventDefault(); void run(); }}>
          {prompt(folder)}
          <Input ref={input} aria-label={t("Command")} className="h-[1.45em] min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 py-0 font-mono text-xs leading-[1.45] shadow-none focus-visible:ring-0 dark:bg-transparent" value={command} onChange={(event) => { setCommand(event.target.value); setHistory((current) => ({ ...current, index: null, draft: "" })); }} onKeyDown={(event) => {
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              const moved = navigateHistory(history, event.key === "ArrowUp" ? "up" : "down", command);
              setHistory(moved.history); setCommand(moved.command);
            }
          }} spellCheck={false} autoComplete="off" autoCapitalize="off" disabled={running} />
        </form>
      </div>
    </div>
  );
}
