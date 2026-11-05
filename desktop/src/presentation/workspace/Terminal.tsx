import { useEffect, useRef, useState } from "react";
import { desktop } from "../../application/desktop.js";
import { Input } from "../ui/base/Input.js";
import { messageOf } from "../ui/Parts.js";

interface Entry {
  id: number;
  folder: string;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Runs one command at a time in the project's folder. It is not a full terminal: nothing interactive runs here. */
export function Terminal(props: { folder: string }) {
  const [folder, setFolder] = useState(props.folder);
  const [command, setCommand] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [running, setRunning] = useState(false);
  const counter = useRef(0);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [entries]);

  async function run() {
    const typed = command.trim();
    if (!typed || running) return;
    setCommand("");
    setRunning(true);
    const id = (counter.current += 1);
    try {
      const result = await desktop.workspace.exec(typed, folder);
      setFolder(result.cwd);
      setEntries((list) => [...list, { id, folder, command: typed, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }]);
    } catch (error) {
      setEntries((list) => [...list, { id, folder, command: typed, stdout: "", stderr: messageOf(error), exitCode: 1 }]);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex h-full flex-col rounded-md bg-(--term-bg) text-(--term-fg)">
      <div className="min-h-0 flex-1 overflow-auto px-2.5 py-2">
        {entries.map((entry) => (
          <div key={entry.id}>
            <div className="font-mono text-xs text-(--term-prompt)">$ {entry.command}</div>
            {entry.stdout ? <pre className="font-mono text-xs break-words whitespace-pre-wrap [overflow-wrap:anywhere]">{entry.stdout}</pre> : null}
            {entry.stderr ? <pre className="font-mono text-xs break-words whitespace-pre-wrap [overflow-wrap:anywhere] text-(--term-stderr)">{entry.stderr}</pre> : null}
            {entry.exitCode !== 0 ? <div className="text-xs text-wait">Exit code {entry.exitCode}</div> : null}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        className="flex flex-wrap items-center gap-2 border-t border-border px-2.5 py-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <span className="text-xs text-muted-foreground">{running ? "Running…" : folder}</span>
        <Input aria-label="Command" className="h-7 flex-[1_1_200px] border-0 bg-transparent font-mono text-xs shadow-none focus-visible:ring-0 dark:bg-transparent" value={command} onChange={(event) => setCommand(event.target.value)} spellCheck={false} disabled={running} />
      </form>
    </div>
  );
}
