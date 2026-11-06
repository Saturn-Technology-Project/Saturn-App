import { useEffect, useRef, useState } from "react";
import { desktop } from "../../application/desktop.js";
import { t } from "../../domain/i18n.js";
import type { PointerPlace } from "../../domain/model.js";

/** How long the pointer stays after the assistant's last action. */
const LINGER_MS = 4000;
/** How long the pointer takes to glide to where it acts, a little under the runtime's lead before it acts. */
const GLIDE_MS = 200;

/** What the overlay shows now: where the pointer is, what it last did, and whether it is shown at all. */
type Shown = { x: number; y: number; kind: PointerPlace["kind"]; at: number; visible: boolean };

/**
 * The assistant's pointer, drawn in its own transparent window over the screen while it uses the computer: it glides to
 * each point before the action lands there, ripples on a click, says when it types, and fades once the assistant stops.
 * The window lets every click through and is kept out of screenshots, so it is only for the person watching.
 */
export function Pointer() {
  const [shown, setShown] = useState<Shown>({ x: window.innerWidth / 2, y: window.innerHeight / 2, kind: "move", at: 0, visible: false });
  const hide = useRef<number | undefined>(undefined);

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const stop = new AbortController();
    const place = (next: PointerPlace) => {
      setShown((current) => {
        const point = next.kind === "drag" && next.to ? next.to : next;
        return {
          x: typeof point.x === "number" ? point.x : current.x,
          y: typeof point.y === "number" ? point.y : current.y,
          kind: next.kind,
          at: next.at,
          visible: true,
        };
      });
      window.clearTimeout(hide.current);
      hide.current = window.setTimeout(() => setShown((current) => ({ ...current, visible: false })), LINGER_MS);
    };
    // The stream ends when the runtime restarts; it is opened again, as the rest of Saturn reconnects.
    const watch = async () => {
      while (!stop.signal.aborted) {
        await desktop.live.watchPointer(place, stop.signal).catch(() => undefined);
        if (!stop.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    };
    void watch();
    return () => {
      stop.abort();
      window.clearTimeout(hide.current);
    };
  }, []);

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden">
      {/* The edge glows while the assistant works, so it is clear the screen is not only the person's. */}
      <div className="absolute inset-0 rounded-[10px] transition-opacity duration-500" style={{ opacity: shown.visible ? 1 : 0, boxShadow: "inset 0 0 0 3px rgba(217, 119, 87, 0.85), inset 0 0 44px 10px rgba(217, 119, 87, 0.35)" }} />
      <div
        className="absolute top-0 left-0 transition-[transform,opacity] ease-out"
        style={{ transform: `translate(${shown.x}px, ${shown.y}px)`, opacity: shown.visible ? 1 : 0, transitionDuration: `${GLIDE_MS}ms, 400ms` }}
      >
        {shown.kind === "click" || shown.kind === "drag" ? <span key={shown.at} className="saturn-pointer-ripple absolute -top-4 -left-4 size-8 rounded-full border-2 border-[#d97757]" /> : null}
        <svg width="26" height="30" viewBox="0 0 26 30" className="-translate-x-[3px] -translate-y-[2px] drop-shadow-[0_2px_4px_rgba(0,0,0,0.35)]">
          <path d="M3 2 L3 24 L9 18.5 L13 27.5 L17 25.7 L13.2 17 L21 17 Z" fill="#d97757" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
        <span className="absolute top-6 left-5 rounded-full bg-[#d97757] px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-white shadow-md">
          {shown.kind === "type" ? t("Saturn · typing…") : "Saturn"}
        </span>
      </div>
    </div>
  );
}
