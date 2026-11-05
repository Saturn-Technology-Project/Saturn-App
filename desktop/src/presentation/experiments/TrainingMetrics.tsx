import { useEffect, useState } from "react";
import { desktop } from "../../application/desktop.js";
import type { TrainingMetric } from "../../domain/research.js";
import { Button } from "../ui/base/Button.js";
import { Choice } from "../ui/base/Field.js";
import { messageOf } from "../ui/Parts.js";

/** Training events are plotted by their own step, never averaged as evaluation samples. */
export function TrainingMetrics(props: { projectId: string; runId: string; notify: (text: string) => void }) {
  const [events, setEvents] = useState<TrainingMetric[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [metric, setMetric] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setEvents([]);
    setNext(null);
    void desktop.research.metrics(props.projectId, props.runId).then((page) => { if (live) { setEvents(page.items); setNext(page.next); } }).catch((error: unknown) => { if (live) props.notify(messageOf(error)); });
    return () => { live = false; };
  }, [props.projectId, props.runId, props.notify]);
  const names = [...new Set(events.flatMap((event) => Object.keys(event.values)))];
  const chosen = names.includes(metric) ? metric : names[0];
  if (!events.length) return null;
  const points = events.filter((event) => chosen in event.values).map((event) => ({ step: event.step, value: event.values[chosen] }));
  const minimum = Math.min(...points.map((point) => point.value));
  const maximum = Math.max(...points.map((point) => point.value));
  const first = Math.min(...points.map((point) => point.step));
  const last = Math.max(...points.map((point) => point.step));
  const path = points.map((point, index) => `${index ? "L" : "M"}${48 + (point.step - first) / (last - first || 1) * 580},${142 - (point.value - minimum) / (maximum - minimum || 1) * 115}`).join(" ");
  async function more() {
    if (next === null || busy) return;
    setBusy(true);
    try { const page = await desktop.research.metrics(props.projectId, props.runId, next); setEvents((current) => [...current, ...page.items]); setNext(page.next); }
    catch (error) { props.notify(messageOf(error)); }
    finally { setBusy(false); }
  }
  return <section className="my-3 rounded-lg bg-panel p-3">
    <h2 className="mb-2 text-sm font-semibold">Training metrics</h2>
    <Choice label="Metric" value={chosen} options={names.map((value) => ({ value, label: value }))} onChange={setMetric} />
    <figure className="m-0 mt-2"><svg viewBox="0 0 660 180" className="w-full" role="img" aria-label={`${chosen} by training step, ${first} to ${last}`}>
      <path d="M48 22V142H628" fill="none" stroke="var(--line-strong)" />
      <path d={path} fill="none" stroke="var(--series-1)" strokeWidth="2" />
      <text x="3" y="30" fill="var(--muted)" fontSize="10">{maximum.toPrecision(4)}</text><text x="3" y="142" fill="var(--muted)" fontSize="10">{minimum.toPrecision(4)}</text>
      <text x="48" y="160" fill="var(--muted)" fontSize="10">{first}</text><text x="610" y="160" fill="var(--muted)" fontSize="10">{last}</text><text x="310" y="176" fill="var(--muted)" fontSize="11">Training step</text>
    </svg><figcaption className="text-xs text-muted-foreground">{chosen}, in its source units. {events.length} events loaded{next !== null ? "; more available" : ""}. Missing metrics are omitted; events keep source order.</figcaption></figure>
    {next !== null ? <Button variant="outline" disabled={busy} onClick={() => void more()}>Load more metrics</Button> : null}
  </section>;
}
