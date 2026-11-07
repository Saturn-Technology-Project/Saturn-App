import { useEffect, useRef, useState } from "react";
import { desktop } from "../../application/desktop.js";
import { t } from "../../domain/i18n.js";
import { plotPoints, type TrainingMetric } from "../../domain/research.js";
import { Button } from "../ui/base/Button.js";
import { Choice } from "../ui/base/Field.js";
import { messageOf } from "../ui/Parts.js";

/** How often a running run's new metrics are read. */
const FOLLOW_MS = 3000;
/** Pages read in one turn while following, so a burst of events comes in at once rather than one page a turn. */
const FOLLOW_PAGES = 10;

/**
 * Training events are plotted by their own step, never averaged as evaluation samples. While the run is still going
 * the curve follows it, reading what the program wrote after the last whole line already read, and once more as it ends.
 */
export function TrainingMetrics(props: { projectId: string; runId: string; live: boolean; notify: (text: string) => void }) {
  const { projectId, runId, live, notify } = props;
  const [events, setEvents] = useState<TrainingMetric[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [metric, setMetric] = useState("");
  const [busy, setBusy] = useState(false);
  /** Where the whole lines read so far end: the next read starts there. */
  const end = useRef(0);
  /** A read is under way, so a turn of the timer does not start another. */
  const reading = useRef(false);
  /** The run was followed while it went on, so its end gets one last read. */
  const followed = useRef(false);

  useEffect(() => {
    let current = true;
    setEvents([]);
    setNext(null);
    setLoaded(false);
    end.current = 0;
    followed.current = false;
    void desktop.research.metrics(projectId, runId).then((page) => {
      if (!current) return;
      setEvents(page.items);
      setNext(page.next);
      end.current = page.end;
      setLoaded(true);
    }).catch((error: unknown) => { if (current) notify(messageOf(error)); });
    return () => { current = false; };
  }, [projectId, runId, notify]);

  useEffect(() => {
    if (!loaded || (!live && !followed.current)) return;
    let current = true;
    const follow = async () => {
      if (reading.current) return;
      reading.current = true;
      try {
        for (let page = 0; page < FOLLOW_PAGES; page += 1) {
          const read = await desktop.research.metrics(projectId, runId, end.current);
          if (!current) return;
          end.current = read.end;
          if (read.items.length) setEvents((shown) => [...shown, ...read.items]);
          if (read.next === null) break;
        }
        // Following reads every page as it comes, so nothing is left to load by hand.
        setNext(null);
      } catch (error) {
        if (current) notify(messageOf(error));
      } finally {
        reading.current = false;
      }
    };
    if (!live) {
      // The run has just ended: what it wrote last is read once, and following stops.
      followed.current = false;
      void follow();
      return () => { current = false; };
    }
    followed.current = true;
    void follow();
    const timer = setInterval(() => void follow(), FOLLOW_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [projectId, runId, live, loaded, notify]);

  const names = [...new Set(events.flatMap((event) => Object.keys(event.values)))];
  const chosen = names.includes(metric) ? metric : names[0];
  if (!events.length) {
    if (!live) return null;
    return <section className="my-3 rounded-lg bg-panel p-3">
      <h2 className="mb-2 text-sm font-semibold">{t("Training metrics")}</h2>
      <p className="m-0 text-sm text-muted-foreground">{t("Waiting for the run's first training metrics…")}</p>
    </section>;
  }
  const points = events.filter((event) => chosen in event.values).map((event) => ({ step: event.step, value: event.values[chosen] }));
  // Gone through one by one: spreading a long run's points into Math.min would overflow the call stack.
  let minimum = Infinity;
  let maximum = -Infinity;
  let first = Infinity;
  let last = -Infinity;
  for (const point of points) {
    minimum = Math.min(minimum, point.value);
    maximum = Math.max(maximum, point.value);
    first = Math.min(first, point.step);
    last = Math.max(last, point.step);
  }
  const path = plotPoints(points).map((point, index) => `${index ? "L" : "M"}${48 + (point.step - first) / (last - first || 1) * 580},${142 - (point.value - minimum) / (maximum - minimum || 1) * 115}`).join(" ");
  async function more() {
    if (next === null || busy) return;
    setBusy(true);
    try {
      const page = await desktop.research.metrics(projectId, runId, next);
      setEvents((current) => [...current, ...page.items]);
      setNext(page.next);
      end.current = page.end;
    } catch (error) {
      notify(messageOf(error));
    } finally {
      setBusy(false);
    }
  }
  return <section className="my-3 rounded-lg bg-panel p-3">
    <h2 className="mb-2 text-sm font-semibold">{t("Training metrics")}</h2>
    <Choice label={t("Metric")} value={chosen} options={names.map((value) => ({ value, label: value }))} onChange={setMetric} />
    <figure className="m-0 mt-2"><svg viewBox="0 0 660 180" className="w-full" role="img" aria-label={t("{metric} by training step, {first} to {last}", { metric: chosen, first, last })}>
      <path d="M48 22V142H628" fill="none" stroke="var(--line-strong)" />
      <path d={path} fill="none" stroke="var(--series-1)" strokeWidth="2" />
      <text x="3" y="30" fill="var(--muted)" fontSize="10">{maximum.toPrecision(4)}</text><text x="3" y="142" fill="var(--muted)" fontSize="10">{minimum.toPrecision(4)}</text>
      <text x="48" y="160" fill="var(--muted)" fontSize="10">{first}</text><text x="610" y="160" fill="var(--muted)" fontSize="10">{last}</text><text x="310" y="176" fill="var(--muted)" fontSize="11">{t("Training step")}</text>
    </svg><figcaption className="text-xs text-muted-foreground">{next !== null ? t("{metric}, in its source units. {count} events loaded; more available. Missing metrics are omitted; events keep source order.", { metric: chosen, count: events.length }) : t("{metric}, in its source units. {count} events loaded. Missing metrics are omitted; events keep source order.", { metric: chosen, count: events.length })}{live ? ` ${t("The run is still going: new metrics appear as it writes them.")}` : ""}</figcaption></figure>
    {next !== null && !live ? <Button variant="outline" disabled={busy} onClick={() => void more()}>{t("Load more metrics")}</Button> : null}
  </section>;
}
