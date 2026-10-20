import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { desktop } from "../application/desktop";
import type { TelemetryExportFormat, NetworkView } from "../application/telemetry";
import type {
  AttributeValue,
  Attributes,
  MetricPoint,
  MetricView,
  SpanRecord,
  TelemetryLog,
  TelemetryStatus,
  TraceSummary,
} from "../domain/model";

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
    <div className="telemetry">
      <div className="telemetry-bar">
        <div className="telemetry-tabs" role="tablist">
          {(["traces", "metrics", "logs", "network"] as Tab[]).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? "telemetry-tab active" : "telemetry-tab"}
              onClick={() => setTab(id)}
            >
              {id === "traces" ? "Traces" : id === "metrics" ? "Metrics" : id === "logs" ? "Logs" : "Network"}
            </button>
          ))}
        </div>
        <div className="telemetry-actions">
          <button
            type="button"
            className={live ? "btn ghost tiny active-toggle" : "btn ghost tiny"}
            onClick={() => setLive((value) => !value)}
            title="Refresh every 3 seconds"
          >
            <span className={live ? "dot ok pulse" : "dot"} />
            Live
          </button>
          <button type="button" className="btn ghost tiny" onClick={() => setTick((value) => value + 1)}>Refresh</button>
          <DownloadMenu
            disabled={!status || status.mode === "disabled"}
            busy={downloading}
            savedTo={status?.file ? homeRelative(status.file) : null}
            onPick={(format) => void download(format)}
          />
          <button type="button" className="btn ghost tiny" onClick={() => void clear()} title="Empties the page and telemetry.json">Clear</button>
        </div>
      </div>

      {status?.mode === "disabled" ? (
        <p className="hint">Telemetry is off (OTEL_SDK_DISABLED=true), so nothing is recorded or saved.</p>
      ) : null}

      {error ? <p className="error">{error}</p> : null}

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
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div className="download-menu" ref={root}>
      <button
        type="button"
        className={open ? "btn ghost tiny active-toggle" : "btn ghost tiny"}
        disabled={props.disabled || props.busy}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={props.savedTo ? `Saved to ${props.savedTo}` : undefined}
      >
        {props.busy ? "Saving…" : "Download"}
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div className="download-menu-list" role="menu">
          {EXPORTS.map((item) => (
            <button
              key={item.format}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                props.onPick(item.format);
              }}
            >
              <strong>{item.label}</strong>
              <span>{item.detail}</span>
            </button>
          ))}
          {props.savedTo ? <div className="download-menu-foot">Saved to {props.savedTo}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/* ─── Traces ─── */

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

  return (
    <>
      <div className="telemetry-toolbar">
        <input placeholder="Filter by span name or trace id…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <label className="telemetry-check">
          <input type="checkbox" checked={hideRoutine} onChange={(event) => setHideRoutine(event.target.checked)} />
          Hide polling ({routine})
        </label>
        <label className="telemetry-check">
          <input type="checkbox" checked={errorsOnly} onChange={(event) => setErrorsOnly(event.target.checked)} />
          Errors only
        </label>
      </div>
      {shown.length === 0 ? (
        <div className="telemetry-empty">
          <strong>No traces yet</strong>
          <p className="hint">Send a message to an agent or run an automation, then come back.</p>
        </div>
      ) : (
        <section className="card telemetry-table">
          <div className="trace-row head">
            <span>Trace</span>
            <span>Spans</span>
            <span>Duration</span>
            <span>When</span>
          </div>
          {shown.map((trace) => (
            <button
              key={trace.traceId}
              type="button"
              className="trace-row"
              title={`${trace.rootName}\ntrace ${trace.traceId}`}
              onClick={() => props.onOpen(trace.traceId)}
            >
              <span className="trace-name">
                {trace.errorCount ? <span className="dot off" title={`${trace.errorCount} failed spans`} /> : <span className="dot ok" />}
                <strong>{trace.rootName}</strong>
              </span>
              <span className="trace-spans">
                {trace.spanCount}
                {trace.errorCount ? <em>{trace.errorCount} err</em> : null}
              </span>
              <span className="trace-duration">
                <span className="trace-duration-bar" style={{ width: `${Math.max(2, (trace.durationMs / longest) * 100)}%` }} />
                <span>{formatDuration(trace.durationMs)}</span>
              </span>
              <span className="hint" title={new Date(trace.startMs).toLocaleString()}>{formatAgo(trace.startMs)}</span>
            </button>
          ))}
        </section>
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
      <div className="trace-detail-head">
        <button type="button" className="btn ghost tiny" onClick={props.onBack}>← All traces</button>
        <div>
          <strong>{root?.name ?? "Trace"}</strong>
          <span className="hint">
            {formatDuration(total)} · {spans.length} spans{errors ? ` · ${errors} failed` : ""}
            {spans.length ? ` · ${new Date(start).toLocaleString()}` : ""}
          </span>
        </div>
        <code className="trace-id" title="Trace id">{props.traceId}</code>
      </div>
      {error ? <p className="error">{error}</p> : null}

      <section className="card waterfall">
        <div className="waterfall-scale">
          <span />
          <div className="waterfall-ticks">
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
                className={selected ? "waterfall-row selected" : "waterfall-row"}
                onClick={() => setOpen(selected ? null : span.spanId)}
              >
                <span className="waterfall-label" style={{ paddingLeft: 8 + span.depth * 14 }}>
                  <span className={`kind-chip ${span.kind}`}>{span.kind}</span>
                  <span className={span.status === "error" ? "waterfall-name failed" : "waterfall-name"}>{span.name}</span>
                </span>
                <span className="waterfall-track">
                  <span
                    className={`waterfall-bar ${span.kind}${span.status === "error" ? " failed" : ""}`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                  />
                  <span
                    className={left + width > 82 && width > 18 ? "waterfall-time inside" : "waterfall-time"}
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
      </section>

      {logs.length ? (
        <>
          <div className="section-subtitle">Logs in this trace</div>
          <section className="card telemetry-logs">
            {logs.map((line, index) => <LogRow key={`${line.timeMs}-${index}`} line={line} />)}
          </section>
        </>
      ) : null}
    </>
  );
}

function SpanDetail(props: { span: SpanRecord; traceStart: number }) {
  const { span } = props;
  const attributes = Object.entries(span.attributes).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="span-detail">
      <div className="span-facts">
        <Fact label="Duration" value={formatDuration(span.durationMs)} />
        <Fact label="Starts at" value={`+${formatDuration(span.startMs - props.traceStart)}`} />
        <Fact label="Kind" value={span.kind} />
        <Fact label="Status" value={span.status === "error" ? `error${span.statusMessage ? ` — ${span.statusMessage}` : ""}` : span.status} />
        <Fact label="Scope" value={span.scope} />
        <Fact label="Span id" value={span.spanId} mono />
      </div>
      {attributes.length ? <AttributeTable attributes={span.attributes} /> : <p className="hint">No attributes.</p>}
      {span.events.length ? (
        <div className="span-events">
          <div className="detail-label">Events</div>
          {span.events.map((event, index) => (
            <div key={`${event.name}-${index}`} className={event.name === "exception" ? "span-event exception" : "span-event"}>
              <div className="span-event-head">
                <strong>{event.name}</strong>
                <span className="hint">+{formatDuration(event.timeMs - props.traceStart)}</span>
              </div>
              {event.attributes["exception.message"] ? <p>{formatValue(event.attributes["exception.message"])}</p> : null}
              {event.attributes["exception.stacktrace"] ? (
                <details>
                  <summary>Stack trace</summary>
                  <pre>{formatValue(event.attributes["exception.stacktrace"])}</pre>
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
    <div className="span-fact">
      <span>{props.label}</span>
      {props.mono ? <code>{props.value}</code> : <strong>{props.value}</strong>}
    </div>
  );
}

function AttributeTable(props: { attributes: Attributes }) {
  const rows = Object.entries(props.attributes).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="attr-table">
      {rows.map(([key, value]) => (
        <Fragment key={key}>
          <code className="attr-key">{key}</code>
          <code className={typeof value === "number" ? "attr-value number" : "attr-value"}>{formatValue(value)}</code>
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
      <div className="telemetry-empty">
        <strong>No metrics recorded yet</strong>
        <p className="hint">Metrics appear once the runtime has handled requests or runs.</p>
      </div>
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
          <div className="section-subtitle">{section.title}</div>
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
    <section className="card metric-view">
      <div className="metric-view-head">
        <div>
          <code className="metric-name">{metric.name}</code>
          {metric.description ? <p className="hint">{metric.description}</p> : null}
        </div>
        <div className="metric-tags">
          <span className="tag">{metric.type === "sum" ? (metric.monotonic ? "counter" : "up-down") : metric.type}</span>
          {metric.unit ? <span className="tag">{metric.unit}</span> : null}
          {total !== null ? (
            <strong>
              {metric.type === "histogram" ? `${formatNumber(total)} recorded` : formatUnit(total, metric.unit)}
            </strong>
          ) : null}
        </div>
      </div>
      <div className={metric.type === "histogram" ? "metric-points histogram" : "metric-points"}>
        {metric.type === "histogram" ? (
          <div className="metric-point head">
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
    </section>
  );
}

function MetricRow(props: { point: MetricPoint; metric: MetricView }) {
  const { point, metric } = props;
  const chips = Object.entries(point.attributes);
  const labels = chips.length ? (
    <span className="attr-chips">
      {chips.map(([key, value]) => (
        <span key={key} className="attr-chip" title={key}>
          <em>{key.split(".").pop()}</em>
          {formatValue(value)}
        </span>
      ))}
    </span>
  ) : (
    <span className="hint">(no attributes)</span>
  );
  if (point.histogram) {
    const { count, sum, min, max, counts } = point.histogram;
    const peak = Math.max(1, ...counts);
    return (
      <div className="metric-point">
        {labels}
        <strong>{formatNumber(count)}</strong>
        <span>{count ? formatUnit(sum / count, metric.unit) : "—"}</span>
        <span className="hint">
          {min !== undefined ? formatUnit(min, metric.unit) : "—"} / {max !== undefined ? formatUnit(max, metric.unit) : "—"}
        </span>
        <span className="buckets" title="Bucket counts, low to high">
          {counts.map((value, index) => (
            <span key={index} style={{ height: `${value ? Math.max(12, (value / peak) * 100) : 0}%` }} />
          ))}
        </span>
      </div>
    );
  }
  return (
    <div className="metric-point">
      {labels}
      <strong>{formatUnit(point.value ?? 0, metric.unit)}</strong>
    </div>
  );
}

/* ─── Logs ─── */

function Logs(props: { logs: TelemetryLog[]; onOpenTrace: (traceId: string) => void }) {
  const [floor, setFloor] = useState(0);
  const [query, setQuery] = useState("");
  const shown = props.logs
    .filter((line) => line.severityNumber >= floor)
    .filter((line) => !query || line.body.toLowerCase().includes(query.toLowerCase()))
    .slice()
    .reverse();
  return (
    <>
      <div className="telemetry-toolbar">
        <input placeholder="Search log messages…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <select value={floor} onChange={(event) => setFloor(Number(event.target.value))} aria-label="Minimum severity">
          {SEVERITY_FLOORS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </div>
      {shown.length === 0 ? (
        <div className="telemetry-empty">
          <strong>No log records</strong>
          <p className="hint">Runtime log lines show up here as OpenTelemetry log records.</p>
        </div>
      ) : (
        <section className="card telemetry-logs">
          {shown.map((line, index) => (
            <LogRow key={`${line.timeMs}-${index}`} line={line} onOpenTrace={props.onOpenTrace} />
          ))}
        </section>
      )}
    </>
  );
}

function severityClass(severity: number): string {
  if (severity >= 17) return "error";
  if (severity >= 13) return "warn";
  if (severity >= 9) return "info";
  return "debug";
}

function LogRow(props: { line: TelemetryLog; onOpenTrace?: (traceId: string) => void }) {
  const { line } = props;
  const service = line.attributes["saturn.service"];
  return (
    <div className="log-record">
      <span className="log-time">{formatClock(line.timeMs)}</span>
      <span className={`severity ${severityClass(line.severityNumber)}`}>{line.severity}</span>
      {service ? <span className="tag">{formatValue(service)}</span> : <span />}
      <span className="log-body">{line.body}</span>
      {line.traceId && props.onOpenTrace ? (
        <button type="button" className="trace-link" onClick={() => props.onOpenTrace?.(line.traceId!)} title={line.traceId}>
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
  if (!view) return <p className="hint">Loading…</p>;
  const remote = view.hosts.filter((host) => !host.local);
  return (
    <div className="network-view">
      <p className="hint">
        Every HTTP(S) request the Saturn runtime has sent since {new Date(view.since).toLocaleString()}: hosts and paths only, never
        query strings or bodies. Claude Code, Codex and git run as their own programs and are not listed here; watch them with your
        system's firewall or network monitor.{view.file ? <> Also written to <code>{view.file}</code>.</> : null}
      </p>
      <section className="card telemetry-table">
        <div className="network-head">
          <strong>{remote.length} outside host{remote.length === 1 ? "" : "s"}</strong>
          <span className="hint">{view.hosts.length - remote.length} on this computer</span>
        </div>
        {view.hosts.length === 0 ? <p className="hint">No requests yet.</p> : null}
        <table>
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
      </section>
      <section className="card telemetry-table">
        <div className="network-head"><strong>Latest requests</strong></div>
        <table>
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
      </section>
    </div>
  );
}

