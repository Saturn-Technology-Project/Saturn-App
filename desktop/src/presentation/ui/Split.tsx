import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { classes } from "./base/classes.js";
import { t } from "../../domain/i18n.js";

/** Reads a remembered size; it only sets where a splitter starts. */
function rememberedSize(key: string, fallback: number): number {
  try {
    const saved = Number(localStorage.getItem(`saturn-split-${key}`));
    return Number.isFinite(saved) && saved > 0 ? saved : fallback;
  } catch {
    return fallback;
  }
}

/**
 * A main area and a side pane with a splitter between them, by mouse or arrow keys. `side` is where the pane sits; a
 * closed pane takes no room and leaves the main area as it is.
 */
export function Split(props: {
  id: string;
  side: "left" | "right" | "bottom";
  size: number;
  minimum?: number;
  open?: boolean;
  label: string;
  pane: ReactNode;
  children: ReactNode;
}) {
  const { id, side, minimum = 120 } = props;
  const [size, setSize] = useState(() => rememberedSize(id, props.size));
  const dragging = useRef<{ start: number; size: number } | null>(null);
  const vertical = side === "bottom";

  const apply = useCallback(
    (next: number) => {
      const limit = (vertical ? window.innerHeight : window.innerWidth) * 0.7;
      const bounded = Math.round(Math.min(Math.max(next, minimum), limit));
      setSize(bounded);
      try {
        localStorage.setItem(`saturn-split-${id}`, String(bounded));
      } catch {
        // Only where the splitter starts next time.
      }
    },
    [id, minimum, vertical],
  );

  const position = (event: PointerEvent) => (vertical ? event.clientY : event.clientX);
  const growsWith = side === "left" ? 1 : -1;

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = { start: position(event), size };
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (dragging.current) apply(dragging.current.size + (position(event) - dragging.current.start) * growsWith);
  }

  function onKeyDown(event: KeyboardEvent) {
    const forward = vertical ? "ArrowDown" : "ArrowRight";
    const backward = vertical ? "ArrowUp" : "ArrowLeft";
    if (event.key === forward) apply(size + 24 * growsWith);
    else if (event.key === backward) apply(size - 24 * growsWith);
    else return;
    event.preventDefault();
  }

  const open = props.open ?? true;
  const pane = open ? (
    <section className="flex min-h-0 min-w-0 flex-none flex-col overflow-hidden" aria-label={props.label} style={vertical ? { height: size } : { width: size }}>
      {props.pane}
    </section>
  ) : null;
  const splitter = open ? (
    <div
      className={classes("z-2 flex-none touch-none bg-[linear-gradient(var(--line),var(--line))] bg-no-repeat hover:bg-info/15 focus-visible:bg-info/15", vertical ? "-my-0.5 h-[5px] cursor-row-resize bg-[length:100%_1px] bg-center" : "-mx-0.5 w-[5px] cursor-col-resize bg-[length:1px_100%] bg-center")}
      role="separator"
      tabIndex={0}
      aria-label={t("Resize {pane}", { pane: props.label })}
      aria-orientation={vertical ? "horizontal" : "vertical"}
      aria-valuenow={size}
      aria-valuemin={minimum}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => {
        dragging.current = null;
      }}
      onKeyDown={onKeyDown}
    />
  ) : null;

  return (
    <div className={classes("flex min-h-0 min-w-0 flex-1", vertical && "flex-col")}>
      {side === "left" ? pane : null}
      {side === "left" ? splitter : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{props.children}</div>
      {side !== "left" ? splitter : null}
      {side !== "left" ? pane : null}
    </div>
  );
}
