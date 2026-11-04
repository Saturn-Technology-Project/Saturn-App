import { useEffect, useRef, useState } from "react";
import { desktop } from "../../application/desktop.js";
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
    <div className="lab-terminal">
      <div className="lab-terminal-log">
        {entries.map((entry) => (
          <div key={entry.id}>
            <div className="lab-terminal-command">$ {entry.command}</div>
            {entry.stdout ? <pre className="lab-text">{entry.stdout}</pre> : null}
            {entry.stderr ? <pre className="lab-text lab-terminal-error">{entry.stderr}</pre> : null}
            {entry.exitCode !== 0 ? <div className="lab-warning">Exit code {entry.exitCode}</div> : null}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        className="lab-terminal-input"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <span className="lab-muted">{running ? "Running…" : folder}</span>
        <input aria-label="Command" value={command} onChange={(event) => setCommand(event.target.value)} spellCheck={false} disabled={running} />
      </form>
    </div>
  );
}
