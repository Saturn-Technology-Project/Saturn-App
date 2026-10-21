import { useEffect, useMemo, useRef, useState } from "react";
import type { SlashEntry } from "../domain/slash";

/**
 * The composer's "/" menu: built-in commands, the project's skills and prompt commands, filtered by what follows
 * the slash. Arrow keys move, Enter or Tab picks, Escape closes; the textarea keeps the focus and forwards keys.
 */
export function SlashMenu(props: { entries: SlashEntry[]; query: string; onPick: (entry: SlashEntry) => void; onClose: () => void; keyRef: React.MutableRefObject<((event: React.KeyboardEvent) => boolean) | null> }) {
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement | null>(null);
  const shown = useMemo(() => {
    const query = props.query.toLowerCase();
    return props.entries.filter((entry) => entry.name.toLowerCase().startsWith(query) || (query.length > 1 && entry.name.toLowerCase().includes(query))).slice(0, 12);
  }, [props.entries, props.query]);

  useEffect(() => setActive(0), [props.query]);

  // The textarea hands its keys here first while the menu is open.
  props.keyRef.current = (event) => {
    if (!shown.length) {
      if (event.key === "Escape") {
        props.onClose();
        return true;
      }
      return false;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      setActive((value) => (value + (event.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      props.onPick(shown[active] ?? shown[0]!);
      return true;
    }
    if (event.key === "Escape") {
      props.onClose();
      return true;
    }
    return false;
  };

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(".slash-item.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!shown.length) return null;
  return (
    <div className="context-picker slash-menu" role="listbox" aria-label="Commands">
      <ul className="context-picker-list" ref={list}>
        {shown.map((entry, index) => (
          <li key={`${entry.kind}:${entry.name}`}>
            <button
              type="button"
              role="option"
              aria-selected={index === active}
              className={index === active ? "slash-item active" : "slash-item"}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                props.onPick(entry);
              }}
            >
              <strong>
                /{entry.name} <em className={`slash-kind ${entry.kind}`}>{entry.kind === "builtin" ? "Saturn" : entry.kind}</em>
              </strong>
              <span>{entry.description || "No description"}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
