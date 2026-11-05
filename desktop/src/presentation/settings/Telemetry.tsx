import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { desktop } from "../../application/desktop";
import type { TelemetryExportFormat, NetworkView } from "../../application/telemetry";
import type {
  AttributeValue,
  Attributes,
  MetricPoint,
  MetricView,
  SpanRecord,
  TelemetryLog,
  TelemetryStatus,
  TraceSummary,
} from "../../domain/model";
import { Badge } from "../ui/base/Badge.js";
import { Button } from "../ui/base/Button.js";
import { Card } from "../ui/base/Card.js";
import { Checkbox } from "../ui/base/Checkbox.js";
import { classes } from "../ui/base/classes.js";
import { Choice } from "../ui/base/Field.js";
import { Input } from "../ui/base/Input.js";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../ui/base/Menu.js";
import { Notice } from "../ui/base/Notice.js";
import { Tabs, TabsList, TabsTrigger } from "../ui/base/Tabs.js";
import { SubTitle } from "./Parts";

type Tab = "traces" | "metrics" | "logs" | "network";

const EXPORTS: { format: TelemetryExportFormat; label: string; detail: string }[] = [
  { format: "saturn", label: "Saturn JSON", detail: "telemetry.json as saved, for this page" },
  { format: "otlp", label: "OTLP JSON", detail: "JSON Lines for the OpenTelemetry Collector (otlpjsonfile)" },
  { format: "siem", label: "SIEM · ECS NDJSON", detail: "One event per line for Elastic, Splunk, Sentinel" },
];

const SEVERITY_FLOORS: { label: string; value: number }[] = [
  { label: "All levels", value: 0 },
  { label: "Info and up", value: 9 },
  { label: "Warnings and up", value: 13 },
  { label: "Errors", value: 17 },
];

/** How a line of a table is set; the traces list and the waterfall share it. */
const TRACE_ROW = "grid min-h-[34px] w-full grid-cols-[minmax(120px,1fr)_48px_minmax(84px,180px)_64px] items-center gap-3.5 border-0 border-t border-border bg-transparent px-3.5 py-1.25 text-left text-[12.5px] text-foreground";
const HINT = "text-[12.5px] text-muted-foreground";
const SECTION_LABEL = "text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase";
const TABLE = "w-full border-collapse text-xs [&_code]:text-[11.5px] [&_code]:break-all [&_td]:border-t [&_td]:border-border [&_td]:px-2 [&_td]:py-1.25 [&_td]:text-left [&_th]:border-t [&_th]:border-border [&_th]:px-2 [&_th]:py-1.25 [&_th]:text-left [&_th]:text-[11px] [&_th]:font-semibold [&_th]:text-muted-foreground";

/** A small round mark that says whether something went well. */
function Dot(props: { tone: "good" | "bad" | "idle"; pulse?: boolean; title?: string }) {
  return <span className={classes("inline-block size-[7px] shrink-0 rounded-full", props.tone === "good" ? "bg-good" : props.tone === "bad" ? "bg-destructive" : "bg-muted-foreground", props.pulse && "animate-pulse")} title={props.title} />;
}

/** A short word that labels a record, such as the service it came from. */
function Tag(props: { children: ReactNode }) {
  return <Badge className="h-auto border border-border px-1.75 py-px text-[11px]">{props.children}</Badge>;
}

/** What a list shows when there is nothing in it yet, and what to do about it. */
function Nothing(props: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-[10px] border border-dashed border-input px-4 py-10 text-center">
      <strong>{props.title}</strong>
      <p className={classes("m-0", HINT)}>{props.children}</p>
    </div>
  );
}

/* ─── Formatting ─── */

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "0";
  if (ms < 1) return `${Math.max(1, Math.round(ms * 1000))} µs`;
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(2) : ms < 100 ? ms.toFixed(1) : Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${date.toLocaleTimeString([], { hour12: false })}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function formatAgo(ms: number): string {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

/** Formats a metric value by its OTel unit: seconds as durations, "{token}" style units as counts. */
function formatUnit(value: number, unit: string): string {
  if (unit === "s") return formatDuration(value * 1000);
  if (unit === "ms") return formatDuration(value);
  const curly = /^\{(.+)\}$/.exec(unit);
  if (curly) return `${formatNumber(value)} ${curly[1]}${value === 1 ? "" : "s"}`;
  return unit ? `${formatNumber(value)} ${unit}` : formatNumber(value);
}

function formatValue(value: AttributeValue): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

/** Shows paths under the home folder as ~/…, the way people type them. */
function homeRelative(file: string): string {
  return file.replace(/^\/(?:Users|home)\/[^/]+/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~");
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/* ─── Page ─── */

export function Telemetry() {
  const [tab, setTab] = useState<Tab>("traces");
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [metrics, setMetrics] = useState<MetricView[]>([]);
  const [logs, setLogs] = useState<TelemetryLog[]>([]);
  const [network, setNetwork] = useState<NetworkView | null>(null);
  const [openTrace, setOpenTrace] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [downloading, setDownloading] = useState(false);

  async function load() {
    try {
      const [nextStatus] = await Promise.all([
        desktop.telemetry.status(),
        tab === "traces" && !openTrace ? desktop.telemetry.traces().then(setTraces) : null,
        tab === "metrics" ? desktop.telemetry.metrics().then(setMetrics) : null,
        tab === "logs" ? desktop.telemetry.logs().then(setLogs) : null,
        tab === "network" ? desktop.telemetry.network().then(setNetwork) : null,
      ]);
      setStatus(nextStatus);
      setError("");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "";
      setError(/not found|cannot get/i.test(message) || message.startsWith("<")
        ? "This runtime does not serve telemetry yet. Restart it to load the new version."
        : message || "Could not reach the runtime");
    }
  }

  useEffect(() => {
    void load();
  }, [tab, openTrace, tick]);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 3000);
    return () => window.clearInterval(timer);
  }, [live]);

  async function download(format: TelemetryExportFormat) {
    setDownloading(true);
    try {
      const { blob, filename } = await desktop.telemetry.export(format);
      const url = URL.createObjectURL(blob);
      const link = Object.assign(window.document.createElement("a"), { href: url, download: filename });
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setTick((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not download telemetry");
    } finally {
      setDownloading(false);
    }
  }

  async function clear() {
    try {
      await desktop.telemetry.clear();
      setOpenTrace(null);
      setTraces([]);
      setLogs([]);
      setTick((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not clear telemetry");
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <Tabs value={tab} onValueChange={(id) => setTab(id as Tab)}>
          <TabsList>
            {(["traces", "metrics", "logs", "network"] as Tab[]).map((id) => (
              <TabsTrigger key={id} value={id} className="px-3.5">
                {id === "traces" ? "Traces" : id === "metrics" ? "Metrics" : id === "logs" ? "Logs" : "Network"}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant={live ? "soft" : "outline"}
            size="small"
            onClick={() => setLive((value) => !value)}
            title="Refresh every 3 seconds"
          >
            <Dot tone={live ? "good" : "idle"} pulse={live} />
            Live
          </Button>
          <Button type="button" variant="outline" size="small" onClick={() => setTick((value) => value + 1)}>Refresh</Button>
          <DownloadMenu
            disabled={!status || status.mode === "disabled"}
            busy={downloading}
            savedTo={status?.file ? homeRelative(status.file) : null}
            onPick={(format) => void download(format)}
          />
          <Button type="button" variant="outline" size="small" onClick={() => void clear()} title="Empties the page and telemetry.json">Clear</Button>
        </div>
      </div>

      {status?.mode === "disabled" ? (
        <p className={HINT}>Telemetry is off (OTEL_SDK_DISABLED=true), so nothing is recorded or saved.</p>
      ) : null}

      {error ? <Notice tone="bad">{error}</Notice> : null}

      {tab === "traces" ? (
        openTrace ? (
          <TraceDetail traceId={openTrace} tick={tick} onBack={() => setOpenTrace(null)} />
        ) : (
          <TraceList traces={traces} onOpen={setOpenTrace} />
        )
      ) : null}
      {tab === "metrics" ? <Metrics metrics={metrics} /> : null}
      {tab === "network" ? <Network view={network} /> : null}
      {tab === "logs" ? (
        <Logs
          logs={logs}
          onOpenTrace={(traceId) => {
            setTab("traces");
            setOpenTrace(traceId);
          }}
        />
      ) : null}
    </div>
  );
}

function DownloadMenu(props: {
  disabled: boolean;
  busy: boolean;
  savedTo: string | null;
  onPick: (format: TelemetryExportFormat) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        disabled={props.disabled || props.busy}
        title={props.savedTo ? `Saved to ${props.savedTo}` : undefined}
        render={<Button type="button" variant="outline" size="small" />}
      >
        {props.busy ? "Saving…" : "Download"}
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </MenuTrigger>
      <MenuContent className="w-72">
        {EXPORTS.map((item) => (
          <MenuItem key={item.format} className="flex-col items-start gap-px px-2.5 py-1.75" onClick={() => props.onPick(item.format)}>
            <strong className="text-[12.5px] font-medium">{item.label}</strong>
            <span className="text-[11.5px] text-muted-foreground">{item.detail}</span>
          </MenuItem>
        ))}
        {props.savedTo ? <div className="mt-1 border-t border-border px-2.5 pt-1.5 pb-1 text-[11px] text-muted-foreground">Saved to {props.savedTo}</div> : null}
      </MenuContent>
    </Menu>
  );
}

/* ─── Traces ─── */

/** The way a checkbox and its words sit side by side. */
const CHECK = "inline-flex items-center gap-1.5 text-[12.5px] whitespace-nowrap text-muted-foreground";

/** How many rows a long list shows at a time, so that a page stays short enough to find its way around. */
const PAGE = 25;

/** The way to the rest of a long list. */
function ShowMore(props: { left: number; onMore: () => void }) {
  if (props.left <= 0) return null;
  return (
    <Button type="button" variant="outline" size="small" className="mx-auto my-2.5 self-center" onClick={props.onMore}>
      Show {Math.min(PAGE, props.left)} more ({props.left} left)
    </Button>
  );
}

function TraceList(props: { traces: TraceSummary[]; onOpen: (traceId: string) => void }) {
  const [query, setQuery] = useState("");
  const [hideRoutine, setHideRoutine] = useState(true);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const routine = props.traces.filter((trace) => trace.routine).length;
  const shown = props.traces.filter((trace) => {
    if (hideRoutine && trace.routine) return false;
    if (errorsOnly && trace.errorCount === 0) return false;
    if (query && !`${trace.rootName} ${trace.traceId}`.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });
  const longest = Math.max(1, ...shown.map((trace) => trace.durationMs));
  const [limit, setLimit] = useState(PAGE);

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Input className="min-w-50 flex-1" aria-label="Filter traces" placeholder="Filter by span name or trace id…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <label className={CHECK}>
          <Checkbox checked={hideRoutine} onCheckedChange={setHideRoutine} />
          Hide polling ({routine})
        </label>
        <label className={CHECK}>
          <Checkbox checked={errorsOnly} onCheckedChange={setErrorsOnly} />
          Errors only
        </label>
      </div>
      {shown.length === 0 ? (
        <Nothing title="No traces yet">Send a message to an agent or run an automation, then come back.</Nothing>
      ) : (
        <Card className="gap-0 overflow-hidden p-0">
          <div className={classes(TRACE_ROW, "border-t-0 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase")}>
            <span>Trace</span>
            <span>Spans</span>
            <span>Duration</span>
            <span>When</span>
          </div>
          {shown.slice(0, limit).map((trace) => (
            <button
              key={trace.traceId}
              type="button"
              className={classes(TRACE_ROW, "cursor-pointer hover:bg-muted")}
              title={`${trace.rootName}\ntrace ${trace.traceId}`}
              onClick={() => props.onOpen(trace.traceId)}
            >
              <span className="flex min-w-0 items-center gap-2">
                {trace.errorCount ? <Dot tone="bad" title={`${trace.errorCount} failed spans`} /> : <Dot tone="good" />}
                <strong className="truncate font-medium">{trace.rootName}</strong>
              </span>
              <span className="flex items-baseline gap-1.5 tabular-nums">
                {trace.spanCount}
                {trace.errorCount ? <span className="text-[11px] text-destructive">{trace.errorCount} err</span> : null}
              </span>
              <span className="relative flex items-center gap-2 tabular-nums">
                <span className="h-1.5 max-w-[60%] flex-none rounded-[3px] bg-info/55" style={{ width: `${Math.max(2, (trace.durationMs / longest) * 100)}%` }} />
                <span>{formatDuration(trace.durationMs)}</span>
              </span>
              <span className={HINT} title={new Date(trace.startMs).toLocaleString()}>{formatAgo(trace.startMs)}</span>
            </button>
          ))}
          <ShowMore left={shown.length - limit} onMore={() => setLimit((current) => current + PAGE)} />
        </Card>
      )}
    </>
  );
}

type SpanNode = SpanRecord & { depth: number };

/** Orders spans parent-first (children by start time) and records each one's depth for indenting. */
function flatten(spans: SpanRecord[]): SpanNode[] {
  const ids = new Set(spans.map((span) => span.spanId));
  const children = new Map<string, SpanRecord[]>();
  const roots: SpanRecord[] = [];
  for (const span of spans) {
    if (span.parentSpanId && ids.has(span.parentSpanId)) {
      const list = children.get(span.parentSpanId) ?? [];
      list.push(span);
      children.set(span.parentSpanId, list);
    } else {
      roots.push(span);
    }
  }
  const out: SpanNode[] = [];
  const walk = (span: SpanRecord, depth: number) => {
    out.push({ ...span, depth });
    for (const child of (children.get(span.spanId) ?? []).sort((a, b) => a.startMs - b.startMs)) walk(child, depth + 1);
  };
  for (const root of roots.sort((a, b) => a.startMs - b.startMs)) walk(root, 0);
  return out;
}

/** A line of the waterfall: the span's name on the left, where it sits in time on the right. */
const WATERFALL_ROW = "grid grid-cols-[minmax(220px,38%)_minmax(0,1fr)] items-center";

function TraceDetail(props: { traceId: string; tick: number; onBack: () => void }) {
  const [spans, setSpans] = useState<SpanRecord[]>([]);
  const [logs, setLogs] = useState<TelemetryLog[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.all([desktop.telemetry.trace(props.traceId), desktop.telemetry.logs({ traceId: props.traceId })])
      .then(([nextSpans, nextLogs]) => {
        setSpans(nextSpans);
        setLogs(nextLogs);
        setError("");
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load the trace"));
  }, [props.traceId, props.tick]);

  const nodes = useMemo(() => flatten(spans), [spans]);
  const start = Math.min(...spans.map((span) => span.startMs));
  const end = Math.max(...spans.map((span) => span.startMs + span.durationMs));
  const total = Math.max(end - start, 0.001);
  const root = nodes[0];
  const errors = spans.filter((span) => span.status === "error").length;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="small" onClick={props.onBack}>← All traces</Button>
        <div className="flex min-w-0 flex-1 flex-col">
          <strong className="text-sm">{root?.name ?? "Trace"}</strong>
          <span className={HINT}>
            {formatDuration(total)} · {spans.length} spans{errors ? ` · ${errors} failed` : ""}
            {spans.length ? ` · ${new Date(start).toLocaleString()}` : ""}
          </span>
        </div>
        <code className="text-[11px] text-muted-foreground" title="Trace id">{props.traceId}</code>
      </div>
      {error ? <Notice tone="bad">{error}</Notice> : null}

      <Card className="gap-0.5 overflow-hidden px-0 py-1.5">
        <div className={classes(WATERFALL_ROW, "border-b border-border pr-3.5 pb-1.5")}>
          <span />
          <div className="relative h-4 text-[10.5px] text-muted-foreground tabular-nums [&>span]:absolute [&>span]:top-0 [&>span]:-translate-x-1/2 [&>span]:whitespace-nowrap [&>span:first-child]:translate-x-0 [&>span:last-child]:-translate-x-full">
            {[0, 0.25, 0.5, 0.75, 1].map((step) => (
              <span key={step} style={{ left: `${step * 100}%` }}>{formatDuration(total * step)}</span>
            ))}
          </div>
        </div>
        {nodes.map((span) => {
          const left = ((span.startMs - start) / total) * 100;
          const width = Math.max((span.durationMs / total) * 100, 0.4);
          const selected = open === span.spanId;
          return (
            <Fragment key={span.spanId}>
              <button
                type="button"
                className={classes(WATERFALL_ROW, "w-full cursor-pointer border-0 bg-transparent py-[3px] pr-3.5 text-left text-foreground hover:bg-muted", selected && "bg-muted")}
                onClick={() => setOpen(selected ? null : span.spanId)}
              >
                <span className="flex min-w-0 items-center gap-[7px] text-[12.5px]" style={{ paddingLeft: 8 + span.depth * 14 }}>
                  <Badge tone={span.kind === "server" ? "info" : span.kind === "client" ? "violet" : "neutral"} className="h-auto w-13 flex-none rounded px-0 py-px text-[10px] font-semibold tracking-wide uppercase">{span.kind}</Badge>
                  <span className={classes("truncate", span.status === "error" && "font-medium text-destructive")}>{span.name}</span>
                </span>
                <span className="relative h-5 bg-[linear-gradient(to_right,var(--line)_1px,transparent_1px)] bg-[length:25%_100%]">
                  <span
                    className={classes("absolute top-[5px] h-2.5 rounded-[3px]", span.status === "error" ? "bg-destructive" : span.kind === "server" ? "bg-info" : span.kind === "client" ? "bg-violet" : "bg-muted-foreground")}
                    style={{ left: `${left}%`, width: `${width}%` }}
                  />
                  <span
                    className={classes("absolute text-[10.5px] whitespace-nowrap tabular-nums", left + width > 82 && width > 18 ? "top-1 text-[9.5px] font-semibold text-white" : "top-0.5 text-muted-foreground")}
                    style={
                      left + width <= 82
                        ? { left: `calc(${left + width}% + 6px)` }
                        : width > 18
                          ? { right: `calc(${100 - left - width}% + 6px)` }
                          : { right: `calc(${100 - left}% + 6px)` }
                    }
                  >
                    {formatDuration(span.durationMs)}
                  </span>
                </span>
              </button>
              {selected ? <SpanDetail span={span} traceStart={start} /> : null}
            </Fragment>
          );
        })}
      </Card>

      {logs.length ? (
        <>
          <SubTitle>Logs in this trace</SubTitle>
          <Card className="gap-0 px-0 py-1 text-xs">
            {logs.map((line, index) => <LogRow key={`${line.timeMs}-${index}`} line={line} />)}
          </Card>
        </>
      ) : null}
    </>
  );
}

function SpanDetail(props: { span: SpanRecord; traceStart: number }) {
  const { span } = props;
  const attributes = Object.entries(span.attributes).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="mx-3.5 mt-0.5 mb-2 flex flex-col gap-3 rounded-lg border border-border bg-stage px-3.5 py-3">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5">
        <Fact label="Duration" value={formatDuration(span.durationMs)} />
        <Fact label="Starts at" value={`+${formatDuration(span.startMs - props.traceStart)}`} />
        <Fact label="Kind" value={span.kind} />
        <Fact label="Status" value={span.status === "error" ? `error${span.statusMessage ? ` — ${span.statusMessage}` : ""}` : span.status} />
        <Fact label="Scope" value={span.scope} />
        <Fact label="Span id" value={span.spanId} mono />
      </div>
      {attributes.length ? <AttributeTable attributes={span.attributes} /> : <p className={HINT}>No attributes.</p>}
      {span.events.length ? (
        <div className="flex flex-col gap-2">
          <div className={SECTION_LABEL}>Events</div>
          {span.events.map((event, index) => (
            <div key={`${event.name}-${index}`} className={classes("flex flex-col gap-1 border-l-2 pl-2.5 text-[12.5px]", event.name === "exception" ? "border-destructive" : "border-input")}>
              <div className="flex items-baseline gap-2">
                <strong>{event.name}</strong>
                <span className={HINT}>+{formatDuration(event.timeMs - props.traceStart)}</span>
              </div>
              {event.attributes["exception.message"] ? <p className="m-0 text-destructive">{formatValue(event.attributes["exception.message"])}</p> : null}
              {event.attributes["exception.stacktrace"] ? (
                <details>
                  <summary>Stack trace</summary>
                  <pre className="max-h-55 overflow-auto rounded-md bg-muted p-2 text-[11px]">{formatValue(event.attributes["exception.stacktrace"])}</pre>
                </details>
              ) : null}
              {Object.keys(event.attributes).some((key) => !key.startsWith("exception.")) ? (
                <AttributeTable
                  attributes={Object.fromEntries(Object.entries(event.attributes).filter(([key]) => !key.startsWith("exception.")))}
                />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Fact(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[11px] text-muted-foreground">{props.label}</span>
      {props.mono ? <code className="text-[12.5px] [overflow-wrap:anywhere]">{props.value}</code> : <strong className="text-[12.5px] [overflow-wrap:anywhere]">{props.value}</strong>}
    </div>
  );
}

function AttributeTable(props: { attributes: Attributes }) {
  const rows = Object.entries(props.attributes).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="grid grid-cols-[minmax(160px,max-content)_minmax(0,1fr)] overflow-hidden rounded-md border border-border text-xs">
      {rows.map(([key, value]) => (
        <Fragment key={key}>
          <code className="border-t border-border bg-muted px-2.5 py-1.25 text-muted-foreground [overflow-wrap:anywhere] first:border-t-0">{key}</code>
          <code className={classes("border-t border-border px-2.5 py-1.25 [overflow-wrap:anywhere] nth-2:border-t-0", typeof value === "number" && "text-info")}>{formatValue(value)}</code>
        </Fragment>
      ))}
    </div>
  );
}

/* ─── Metrics ─── */

const GROUPS: { prefix: string; title: string }[] = [
  { prefix: "gen_ai.", title: "LLM" },
  { prefix: "saturn.agent", title: "Agents" },
  { prefix: "saturn.tool", title: "Tools" },
  { prefix: "saturn.mcp", title: "MCP" },
  { prefix: "saturn.automation", title: "Automations" },
  { prefix: "http.", title: "HTTP" },
  { prefix: "", title: "Runtime" },
];

function Metrics(props: { metrics: MetricView[] }) {
  if (props.metrics.length === 0) {
    return (
      <Nothing title="No metrics recorded yet">Metrics appear once the runtime has handled requests or runs.</Nothing>
    );
  }
  const used = new Set<string>();
  const sections = GROUPS.map((group) => {
    const items = props.metrics.filter((metric) => !used.has(metric.name) && metric.name.startsWith(group.prefix));
    for (const item of items) used.add(item.name);
    return { ...group, items };
  }).filter((group) => group.items.length);

  return (
    <>
      {sections.map((section) => (
        <Fragment key={section.title}>
          <SubTitle>{section.title}</SubTitle>
          {section.items.map((metric) => <MetricCard key={metric.name} metric={metric} />)}
        </Fragment>
      ))}
    </>
  );
}

function MetricCard(props: { metric: MetricView }) {
  const { metric } = props;
  const total = metric.type === "histogram"
    ? metric.points.reduce((sum, point) => sum + (point.histogram?.count ?? 0), 0)
    : metric.type === "sum"
      ? metric.points.reduce((sum, point) => sum + (point.value ?? 0), 0)
      : null;
  return (
    <Card className="gap-2.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <code className="text-[13px] font-semibold text-foreground">{metric.name}</code>
          {metric.description ? <p className={classes("mt-0.5", HINT)}>{metric.description}</p> : null}
        </div>
        <div className="flex flex-none items-center gap-1.5">
          <Tag>{metric.type === "sum" ? (metric.monotonic ? "counter" : "up-down") : metric.type}</Tag>
          {metric.unit ? <Tag>{metric.unit}</Tag> : null}
          {total !== null ? (
            <strong className="ml-1 text-[13px] tabular-nums">
              {metric.type === "histogram" ? `${formatNumber(total)} recorded` : formatUnit(total, metric.unit)}
            </strong>
          ) : null}
        </div>
      </div>
      <div className="flex flex-col border-t border-border">
        {metric.type === "histogram" ? (
          <div className={classes(POINT, HISTOGRAM_POINT, "text-[11px] font-semibold tracking-wider text-muted-foreground uppercase")}>
            <span>Count</span>
            <span>Avg</span>
            <span>Min / Max</span>
            <span>Distribution</span>
          </div>
        ) : null}
        {metric.points.map((point, index) => (
          <MetricRow key={index} point={point} metric={metric} />
        ))}
      </div>
    </Card>
  );
}

/** A line of a metric: what it was measured on, and the figure. A histogram's has more columns. */
const POINT = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3.5 border-b border-border py-1.5 text-[12.5px] tabular-nums last:border-b-0";
const HISTOGRAM_POINT = "grid-cols-[minmax(50px,0.7fr)_minmax(70px,1fr)_minmax(110px,1.4fr)_minmax(80px,1.2fr)] gap-y-1";

function MetricRow(props: { point: MetricPoint; metric: MetricView }) {
  const { point, metric } = props;
  const chips = Object.entries(point.attributes);
  const labels = chips.length ? (
    <span className="flex min-w-0 flex-wrap gap-1">
      {chips.map(([key, value]) => (
        <span key={key} className="inline-flex max-w-full gap-1.25 overflow-hidden rounded-[5px] bg-muted px-1.75 py-px font-mono text-[11px] text-ellipsis whitespace-nowrap" title={key}>
          <em className="text-muted-foreground not-italic">{key.split(".").pop()}</em>
          {formatValue(value)}
        </span>
      ))}
    </span>
  ) : (
    <span className={HINT}>(no attributes)</span>
  );
  if (point.histogram) {
    const { count, sum, min, max, counts } = point.histogram;
    const peak = Math.max(1, ...counts);
    return (
      <div className={classes(POINT, HISTOGRAM_POINT, "[&>:first-child]:col-span-full")}>
        {labels}
        <strong>{formatNumber(count)}</strong>
        <span>{count ? formatUnit(sum / count, metric.unit) : "—"}</span>
        <span className={HINT}>
          {min !== undefined ? formatUnit(min, metric.unit) : "—"} / {max !== undefined ? formatUnit(max, metric.unit) : "—"}
        </span>
        <span className="flex h-5.5 items-end gap-px [&>span]:min-w-0.5 [&>span]:flex-1 [&>span]:rounded-t-[1px] [&>span]:bg-info/70" title="Bucket counts, low to high">
          {counts.map((value, index) => (
            <span key={index} style={{ height: `${value ? Math.max(12, (value / peak) * 100) : 0}%` }} />
          ))}
        </span>
      </div>
    );
  }
  return (
    <div className={POINT}>
      {labels}
      <strong>{formatUnit(point.value ?? 0, metric.unit)}</strong>
    </div>
  );
}

/* ─── Logs ─── */

function Logs(props: { logs: TelemetryLog[]; onOpenTrace: (traceId: string) => void }) {
  const [limit, setLimit] = useState(PAGE);
  const [floor, setFloor] = useState(0);
  const [query, setQuery] = useState("");
  const shown = props.logs
    .filter((line) => line.severityNumber >= floor)
    .filter((line) => !query || line.body.toLowerCase().includes(query.toLowerCase()))
    .slice()
    .reverse();
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Input className="min-w-50 flex-1" placeholder="Search log messages…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <Choice ariaLabel="Minimum severity" value={String(floor)} options={SEVERITY_FLOORS.map((item) => ({ value: String(item.value), label: item.label }))} onChange={(next) => setFloor(Number(next))} />
      </div>
      {shown.length === 0 ? (
        <Nothing title="No log records">Runtime log lines show up here as OpenTelemetry log records.</Nothing>
      ) : (
        <Card className="gap-0 px-0 py-1 text-xs">
          {shown.slice(0, limit).map((line, index) => (
            <LogRow key={`${line.timeMs}-${index}`} line={line} onOpenTrace={props.onOpenTrace} />
          ))}
          <ShowMore left={shown.length - limit} onMore={() => setLimit((current) => current + PAGE)} />
        </Card>
      )}
    </>
  );
}

/** How loud a log record is, as the tone of its label. */
const SEVERITY_TONES = { error: "bad", warn: "wait", info: "info", debug: "neutral" } as const;

function severityClass(severity: number): keyof typeof SEVERITY_TONES {
  if (severity >= 17) return "error";
  if (severity >= 13) return "warn";
  if (severity >= 9) return "info";
  return "debug";
}

function LogRow(props: { line: TelemetryLog; onOpenTrace?: (traceId: string) => void }) {
  const { line } = props;
  const service = line.attributes["saturn.service"];
  return (
    <div className="grid grid-cols-[96px_58px_max-content_minmax(0,1fr)_max-content] items-baseline gap-2.5 border-b border-border px-3.5 py-1.25 last:border-b-0">
      <span className="font-mono text-[11px] text-muted-foreground">{formatClock(line.timeMs)}</span>
      <Badge tone={SEVERITY_TONES[severityClass(line.severityNumber)]} className="h-auto w-full rounded px-0 py-px text-[10px] font-semibold tracking-wide">{line.severity}</Badge>
      {service ? <Tag>{formatValue(service)}</Tag> : <span />}
      <span className="[overflow-wrap:anywhere]">{line.body}</span>
      {line.traceId && props.onOpenTrace ? (
        <button type="button" className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[11px] text-info hover:underline" onClick={() => props.onOpenTrace?.(line.traceId!)} title={line.traceId}>
          trace {shortId(line.traceId)}
        </button>
      ) : <span />}
    </div>
  );
}

/**
 * Every host the runtime has sent a request to since it started, and the latest requests: the model providers and
 * tools you use, and nothing else. The same records are appended to network.log for `tail -f` or your own tools.
 */
function Network(props: { view: NetworkView | null }) {
  const view = props.view;
  if (!view) return <p className={HINT}>Loading…</p>;
  const remote = view.hosts.filter((host) => !host.local);
  return (
    <div className="flex flex-col gap-3">
      <p className={HINT}>
        Every HTTP(S) request the Saturn runtime has sent since {new Date(view.since).toLocaleString()}: hosts and paths only, never
        query strings or bodies. Claude Code, Codex and git run as their own programs and are not listed here; watch them with your
        system's firewall or network monitor.{view.file ? <> Also written to <code>{view.file}</code>.</> : null}
      </p>
      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex items-baseline gap-2.5 p-2">
          <strong>{remote.length} outside host{remote.length === 1 ? "" : "s"}</strong>
          <span className={HINT}>{view.hosts.length - remote.length} on this computer</span>
        </div>
        {view.hosts.length === 0 ? <p className={classes("px-2 pb-2", HINT)}>No requests yet.</p> : null}
        <table className={TABLE}>
          <thead>
            <tr><th>Host</th><th>Where</th><th>Requests</th><th>Methods</th><th>Last</th></tr>
          </thead>
          <tbody>
            {view.hosts.map((host) => (
              <tr key={host.host}>
                <td><code>{host.host}</code></td>
                <td>{host.local ? "this computer" : "internet"}</td>
                <td>{host.requests}</td>
                <td>{host.methods.join(", ")}</td>
                <td>{new Date(host.last).toLocaleTimeString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex items-baseline gap-2.5 p-2"><strong>Latest requests</strong></div>
        <table className={TABLE}>
          <tbody>
            {view.recent.slice(0, 100).map((entry, index) => (
              <tr key={`${entry.at}-${index}`}>
                <td>{new Date(entry.at).toLocaleTimeString()}</td>
                <td>{entry.method}</td>
                <td><code>{entry.host}{entry.path}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

