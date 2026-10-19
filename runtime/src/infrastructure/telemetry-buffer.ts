import { SpanKind, SpanStatusCode, type Attributes, type HrTime } from "@opentelemetry/api";
import type { ReadWriteLogRecord, LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { DataPointType, MetricReader } from "@opentelemetry/sdk-metrics";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";

/**
 * Keeps the runtime's own recent telemetry so the desktop Telemetry page can show it,
 * whether or not anything is exported. Plain JSON records, newest last; telemetry-file.ts saves them.
 */

export type SpanRecord = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: "internal" | "server" | "client" | "producer" | "consumer";
  scope: string;
  scopeVersion?: string;
  startMs: number;
  durationMs: number;
  status: "unset" | "ok" | "error";
  statusMessage?: string;
  attributes: Attributes;
  events: { name: string; timeMs: number; attributes: Attributes }[];
};

export type TraceSummary = {
  traceId: string;
  rootName: string;
  startMs: number;
  durationMs: number;
  spanCount: number;
  errorCount: number;
  /** A successful read such as the desktop polling GET /agents. The UI hides these by default. */
  routine: boolean;
};

export type LogRecordView = {
  timeMs: number;
  severity: string;
  severityNumber: number;
  body: string;
  attributes: Attributes;
  traceId?: string;
  spanId?: string;
};

export type MetricPoint = {
  attributes: Attributes;
  /** Start of the cumulative window and time of this reading, ms since epoch. */
  startMs: number;
  timeMs: number;
  value?: number;
  histogram?: { count: number; sum: number; min?: number; max?: number; boundaries: number[]; counts: number[] };
};

export type MetricView = {
  name: string;
  description: string;
  unit: string;
  type: "sum" | "gauge" | "histogram";
  monotonic?: boolean;
  points: MetricPoint[];
};

const KINDS: Record<SpanKind, SpanRecord["kind"]> = {
  [SpanKind.INTERNAL]: "internal",
  [SpanKind.SERVER]: "server",
  [SpanKind.CLIENT]: "client",
  [SpanKind.PRODUCER]: "producer",
  [SpanKind.CONSUMER]: "consumer",
};

function ms(time: HrTime): number {
  return time[0] * 1000 + time[1] / 1e6;
}

function text(body: unknown): string {
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

class LocalMetricReader extends MetricReader {
  protected async onShutdown(): Promise<void> {}
  protected async onForceFlush(): Promise<void> {}
}

export class TelemetryBuffer {
  /** Trace id → spans, in insertion order so the oldest trace is evicted first. */
  private readonly traces = new Map<string, SpanRecord[]>();
  private readonly logLines: LogRecordView[] = [];
  readonly metricReader = new LocalMetricReader();
  /** Called when something worth saving changed: a span of real work, a log line, or a clear. Polling is not. */
  onChange?: () => void;

  constructor(
    private readonly limits = { traces: 400, routineTraces: 150, spansPerTrace: 500, logs: 2000 },
  ) {}

  readonly spanProcessor: SpanProcessor = {
    onStart: () => undefined,
    onEnd: (span: ReadableSpan) => this.addSpan(span),
    forceFlush: async () => undefined,
    shutdown: async () => undefined,
  };

  readonly logProcessor: LogRecordProcessor = {
    onEmit: (record: ReadWriteLogRecord) => this.addLog(record),
    forceFlush: async () => undefined,
    shutdown: async () => undefined,
  };

  addSpan(span: ReadableSpan): void {
    const context = span.spanContext();
    const record: SpanRecord = {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: span.parentSpanContext?.spanId ?? null,
      name: span.name,
      kind: KINDS[span.kind] ?? "internal",
      scope: span.instrumentationScope.name,
      ...(span.instrumentationScope.version ? { scopeVersion: span.instrumentationScope.version } : {}),
      startMs: ms(span.startTime),
      durationMs: ms(span.duration),
      status: span.status.code === SpanStatusCode.ERROR ? "error" : span.status.code === SpanStatusCode.OK ? "ok" : "unset",
      ...(span.status.message ? { statusMessage: span.status.message } : {}),
      attributes: { ...span.attributes },
      events: span.events.map((event) => ({ name: event.name, timeMs: ms(event.time), attributes: { ...(event.attributes ?? {}) } })),
    };
    let spans = this.traces.get(record.traceId);
    if (!spans) {
      spans = [];
      this.traces.set(record.traceId, spans);
    }
    if (spans.length < this.limits.spansPerTrace) spans.push(record);
    this.evict();
    const kept = this.traces.get(record.traceId);
    if (kept && !isRoutine(kept)) this.onChange?.();
  }

  addSpanRecord(record: SpanRecord): void {
    let spans = this.traces.get(record.traceId);
    if (!spans) {
      spans = [];
      this.traces.set(record.traceId, spans);
    }
    if (spans.length < this.limits.spansPerTrace) spans.push(record);
    this.evict();
    const kept = this.traces.get(record.traceId);
    if (kept && !isRoutine(kept)) this.onChange?.();
  }

  addLog(record: ReadWriteLogRecord): void {
    this.logLines.push({
      timeMs: ms(record.hrTime),
      severity: record.severityText ?? "INFO",
      severityNumber: record.severityNumber ?? 9,
      body: text(record.body),
      attributes: { ...record.attributes } as Attributes,
      ...(record.spanContext ? { traceId: record.spanContext.traceId, spanId: record.spanContext.spanId } : {}),
    });
    if (this.logLines.length > this.limits.logs) this.logLines.splice(0, this.logLines.length - this.limits.logs);
    this.onChange?.();
  }

  addLogRecord(log: LogRecordView): void {
    this.logLines.push(log);
    if (this.logLines.length > this.limits.logs) this.logLines.splice(0, this.logLines.length - this.limits.logs);
    this.onChange?.();
  }

  /** What is worth keeping on disk: every trace except polling, and all log records. */
  persistable(): { traces: { traceId: string; spans: SpanRecord[] }[]; logs: LogRecordView[] } {
    return {
      traces: [...this.traces.entries()]
        .filter(([, spans]) => !isRoutine(spans))
        .map(([traceId, spans]) => ({ traceId, spans: [...spans] })),
      logs: [...this.logLines],
    };
  }

  /** Puts saved traces and logs back, oldest first, ahead of anything recorded since startup. */
  restore(saved: { traces?: { traceId: string; spans: SpanRecord[] }[]; logs?: LogRecordView[] }): void {
    const live = [...this.traces.entries()];
    this.traces.clear();
    for (const trace of saved.traces ?? []) {
      if (trace.traceId && Array.isArray(trace.spans) && trace.spans.length) {
        this.traces.set(trace.traceId, trace.spans.slice(0, this.limits.spansPerTrace));
      }
    }
    for (const [id, spans] of live) this.traces.set(id, [...(this.traces.get(id) ?? []), ...spans]);
    this.evict();
    this.logLines.unshift(...(saved.logs ?? []).filter((line) => line && typeof line.body === "string"));
    if (this.logLines.length > this.limits.logs) this.logLines.splice(0, this.logLines.length - this.limits.logs);
  }

  /** Drops the oldest routine traces first, then the oldest of everything, so polling never pushes out real work. */
  private evict(): void {
    let routine = 0;
    for (const spans of this.traces.values()) if (isRoutine(spans)) routine += 1;
    for (const [id, spans] of this.traces) {
      if (routine <= this.limits.routineTraces) break;
      if (!isRoutine(spans)) continue;
      this.traces.delete(id);
      routine -= 1;
    }
    for (const id of this.traces.keys()) {
      if (this.traces.size <= this.limits.traces) break;
      this.traces.delete(id);
    }
  }

  summaries(): TraceSummary[] {
    return [...this.traces.entries()]
      .map(([traceId, spans]) => {
        const ids = new Set(spans.map((span) => span.spanId));
        const root = spans.find((span) => !span.parentSpanId || !ids.has(span.parentSpanId)) ?? spans[0];
        const start = Math.min(...spans.map((span) => span.startMs));
        const end = Math.max(...spans.map((span) => span.startMs + span.durationMs));
        return {
          traceId,
          rootName: root?.name ?? "",
          startMs: start,
          durationMs: end - start,
          spanCount: spans.length,
          errorCount: spans.filter((span) => span.status === "error").length,
          routine: isRoutine(spans),
        };
      })
      .sort((a, b) => b.startMs - a.startMs);
  }

  trace(traceId: string): SpanRecord[] | null {
    const spans = this.traces.get(traceId);
    return spans ? [...spans].sort((a, b) => a.startMs - b.startMs) : null;
  }

  logs(filter: { traceId?: string; minSeverity?: number } = {}): LogRecordView[] {
    return this.logLines.filter((line) => {
      if (filter.traceId && line.traceId !== filter.traceId) return false;
      if (filter.minSeverity && line.severityNumber < filter.minSeverity) return false;
      return true;
    });
  }

  /** Current metric values; empty when the reader is not attached to a MeterProvider (telemetry disabled). */
  async metrics(): Promise<MetricView[]> {
    let collected: Awaited<ReturnType<LocalMetricReader["collect"]>>;
    try {
      collected = await this.metricReader.collect();
    } catch {
      return [];
    }
    const { resourceMetrics } = collected;
    return resourceMetrics.scopeMetrics
      .flatMap((scope) => scope.metrics)
      .map((metric): MetricView => {
        const base = {
          name: metric.descriptor.name,
          description: metric.descriptor.description,
          unit: metric.descriptor.unit,
        };
        if (metric.dataPointType === DataPointType.HISTOGRAM) {
          return {
            ...base,
            type: "histogram",
            points: metric.dataPoints.map((point) => ({
              attributes: point.attributes,
              startMs: ms(point.startTime),
              timeMs: ms(point.endTime),
              histogram: {
                count: point.value.count,
                sum: point.value.sum ?? 0,
                min: point.value.min,
                max: point.value.max,
                boundaries: point.value.buckets.boundaries,
                counts: point.value.buckets.counts,
              },
            })),
          };
        }
        if (metric.dataPointType === DataPointType.SUM) {
          return {
            ...base,
            type: "sum",
            monotonic: metric.isMonotonic,
            points: metric.dataPoints.map((point) => ({
              attributes: point.attributes,
              startMs: ms(point.startTime),
              timeMs: ms(point.endTime),
              value: point.value,
            })),
          };
        }
        if (metric.dataPointType === DataPointType.GAUGE) {
          return {
            ...base,
            type: "gauge",
            points: metric.dataPoints.map((point) => ({
              attributes: point.attributes,
              startMs: ms(point.startTime),
              timeMs: ms(point.endTime),
              value: point.value,
            })),
          };
        }
        return { ...base, type: "gauge", points: [] };
      })
      .filter((metric) => metric.points.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  clear(): void {
    this.traces.clear();
    this.logLines.length = 0;
    this.onChange?.();
  }
}

/**
 * A successful GET whose only children are state writes — what the desktop's 2-second polling produces
 * (GET /agents rewrites the state file on every call).
 */
function isRoutine(spans: SpanRecord[]): boolean {
  const roots = spans.filter((span) => span.kind === "server");
  if (roots.length !== 1) return false;
  const [root] = roots;
  if (root.attributes["http.request.method"] !== "GET" || root.status === "error") return false;
  return spans.every((span) => span === root || (span.name === "store.persist" && span.status !== "error"));
}
