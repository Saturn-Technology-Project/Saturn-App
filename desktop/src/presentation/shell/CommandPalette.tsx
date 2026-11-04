import { useEffect, useMemo, useRef, useState } from "react";

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** Everything the app can do, by typing. */
export function CommandPalette(props: { commands: PaletteCommand[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return props.commands.filter((command) => words.every((word) => command.label.toLowerCase().includes(word)));
  }, [props.commands, query]);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => setIndex(0), [query]);

  function choose(command?: PaletteCommand) {
    if (!command) return;
    props.onClose();
    command.run();
  }

  return (
    <div className="lab-palette-overlay" onMouseDown={props.onClose}>
      <div className="lab-palette" role="dialog" aria-label="Commands" onMouseDown={(event) => event.stopPropagation()}>
        <input
          ref={input}
          value={query}
          placeholder="Type a command"
          aria-label="Type a command"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") setIndex((current) => Math.min(current + 1, shown.length - 1));
            else if (event.key === "ArrowUp") setIndex((current) => Math.max(current - 1, 0));
            else if (event.key === "Enter") choose(shown[index]);
            else if (event.key === "Escape") props.onClose();
            else return;
            event.preventDefault();
          }}
        />
        <ul>
          {shown.map((command, position) => (
            <li key={command.id}>
              <button type="button" className={position === index ? "lab-palette-item active" : "lab-palette-item"} onMouseEnter={() => setIndex(position)} onClick={() => choose(command)}>
                <span>{command.label}</span>
                {command.hint ? <span className="lab-muted">{command.hint}</span> : null}
              </button>
            </li>
          ))}
          {shown.length === 0 ? <li className="lab-muted">Nothing matches.</li> : null}
        </ul>
      </div>
    </div>
  );
}
