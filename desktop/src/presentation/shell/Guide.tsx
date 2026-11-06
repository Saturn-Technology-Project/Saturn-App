import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../../domain/i18n.js";
import { guidePlaces, type GuidePlace, type Screen } from "../../domain/workbench.js";
import { Button } from "../ui/base/Button.js";
import { followTourTarget, type TourBox } from "./tour-focus.js";

const EVENT = "saturn-guide";
const CARD_WIDTH = 300;
const GAP = 12;

const SHOWN_PLACES = new Map(guidePlaces(t).map((place) => [place.id, place]));

/** A place as the person reads it, in the interface's language; the assistant names it in English. */
export function shownPlace(place: GuidePlace): GuidePlace {
  return SHOWN_PLACES.get(place.id) ?? place;
}

/** Starts a walk through these places. A person's click is the only thing that calls it. */
export function startGuide(places: GuidePlace[]): void {
  window.dispatchEvent(new CustomEvent<GuidePlace[]>(EVENT, { detail: places }));
}

/**
 * A walk through places the assistant named: each screen opens in turn and its place is boxed, with the interface still
 * live under the box, so the person does the work themselves. It shows and opens, and never presses anything.
 */
export function Guide(props: { go: (screen: Screen) => void }) {
  const { go } = props;
  const [places, setPlaces] = useState<GuidePlace[]>([]);
  const [at, setAt] = useState(0);
  const [box, setBox] = useState<TourBox | null>(null);
  const shown = useRef<HTMLElement | null>(null);
  const named = places[at];
  const place = named ? shownPlace(named) : undefined;

  useEffect(() => {
    const listener = (event: Event) => {
      setPlaces((event as CustomEvent<GuidePlace[]>).detail);
      setAt(0);
    };
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, []);

  useEffect(() => {
    if (!place) return undefined;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setPlaces([]);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [place]);

  useLayoutEffect(() => {
    if (!place) return undefined;
    if (place.screen) go(place.screen);
    shown.current = null;
    setBox(null);
    return followTourTarget(
      () => {
        const element = document.querySelector<HTMLElement>(`[data-tour="${place.id}"]`);
        const rect = element?.getBoundingClientRect();
        if (!element || !rect || rect.width === 0 || rect.height === 0) return null;
        // Once, when it first appears: after that the page is the person's to scroll.
        if (shown.current !== element) {
          shown.current = element;
          element.scrollIntoView({ block: "center" });
        }
        return { top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 };
      },
      setBox,
      (callback) => window.requestAnimationFrame(callback),
      (frame) => window.cancelAnimationFrame(frame),
    );
  }, [go, place]);

  if (!place) return null;
  const last = at === places.length - 1;
  const room = { width: window.innerWidth, height: window.innerHeight };
  const beside = box && box.left + box.width + GAP + CARD_WIDTH < room.width - 16;
  const left = box ? (beside ? box.left + box.width + GAP : Math.max(16, Math.min(box.left, room.width - CARD_WIDTH - 16))) : Math.max(16, (room.width - CARD_WIDTH) / 2);
  const below = box ? box.top + box.height + GAP : 80;
  const top = box ? Math.max(16, Math.min(beside ? box.top : below > room.height - 200 ? box.top - 190 : below, room.height - 200)) : 80;

  return (
    <div className="pointer-events-none fixed inset-0 z-30">
      {box ? <div className="absolute rounded-lg border-2 border-primary shadow-[0_0_0_3px_var(--bg),0_0_0_5px_var(--accent)]" style={{ top: box.top, left: box.left, width: box.width, height: box.height }} /> : null}
      <section className="glass pointer-events-auto absolute flex max-w-[calc(100vw-32px)] flex-col gap-1.5 rounded-xl px-3.5 py-3 text-foreground shadow-lg ring-1 ring-foreground/10" aria-label={t("Walking you through it")} style={{ top, left, width: CARD_WIDTH }}>
        <div className="text-[11px] text-muted-foreground">
          {t("{step} of {count}", { step: at + 1, count: places.length })}
        </div>
        <h2 aria-live="polite" className="m-0! text-sm font-semibold">{place.title}</h2>
        <p className="text-xs text-muted-foreground">{place.hint}</p>
        {box ? null : <p className="text-xs text-wait">{place.when ? t("Not on this screen yet: it appears once {condition}.", { condition: place.when }) : t("Not on this screen yet.")}</p>}
        <div className="mt-2 flex items-center gap-2">
          <Button variant="ghost" onClick={() => setPlaces([])}>
            {t("Done")}
          </Button>
          <div className="flex-1" />
          {at > 0 ? (
            <Button variant="outline" onClick={() => setAt(at - 1)}>
              {t("Back")}
            </Button>
          ) : null}
          {last ? null : (
            <Button onClick={() => setAt(at + 1)}>
              {t("Next")}
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}
