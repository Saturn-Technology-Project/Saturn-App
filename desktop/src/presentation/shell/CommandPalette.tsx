import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/base/Button.js";
import { classes } from "../ui/base/classes.js";
import { Dialog, DialogContent } from "../ui/base/Dialog.js";
import { Input } from "../ui/base/Input.js";

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

  useEffect(() => setIndex(0), [query]);

  function choose(command?: PaletteCommand) {
    if (!command) return;
    props.onClose();
    command.run();
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent aria-label="Commands" initialFocus={input} className="top-[12vh] flex max-h-[60vh] w-[min(560px,calc(100vw-2rem))] max-w-none translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <Input
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          ref={input}
          className="h-11 rounded-none border-0 border-b border-border px-3.5 shadow-none focus-visible:ring-0"
          value={query}
          placeholder="Type a command"
          aria-label="Type a command"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") setIndex((current) => Math.min(current + 1, shown.length - 1));
            else if (event.key === "ArrowUp") setIndex((current) => Math.max(current - 1, 0));
            else if (event.key === "Enter") choose(shown[index]);
            else return;
            event.preventDefault();
          }}
        />
        <ul className="m-0 list-none overflow-auto p-1.5">
          {shown.map((command, position) => (
            <li key={command.id}>
              <Button variant="ghost" className={classes("h-auto min-h-9 w-full justify-between gap-3 px-2.5 py-1.5 text-left font-normal", position === index && "bg-muted")} onMouseEnter={() => setIndex(position)} onClick={() => choose(command)}>
                <span>{command.label}</span>
                {command.hint ? <span className="text-xs text-muted-foreground">{command.hint}</span> : null}
              </Button>
            </li>
          ))}
          {shown.length === 0 ? <li className="px-2.5 py-1.5 text-xs text-muted-foreground">Nothing matches.</li> : null}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
