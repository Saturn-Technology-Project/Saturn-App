import type { Attributes, AttributeValue } from "@opentelemetry/api";
import type { LogRecordView, MetricView, SpanRecord } from "./telemetry-buffer.js";
import type { TelemetryDocument } from "./telemetry-file.js";

/**
 * Turns telemetry.json into formats other tools read:
 * - OTLP/JSON lines: one TracesData, LogsData and MetricsData object per line, the encoding the
 *   OpenTelemetry Collector's file exporter writes and its otlpjsonfile receiver reads.
 * - SIEM: one ECS-style event per line (NDJSON) for Elastic, Splunk, Sentinel and similar.
 */

export type ExportFormat = "saturn" | "otlp" | "siem";

export const EXPORT_FORMATS: Record<ExportFormat, { extension: string; contentType: string }> = {
  saturn: { extension: "json", contentType: "application/json" },
  otlp: { extension: "jsonl", contentType: "application/x-ndjson" },
  siem: { extension: "ndjson", contentType: "application/x-ndjson" },
};

export function exportFormat(value: unknown): ExportFormat {
  return value === "otlp" || value === "siem" ? value : "saturn";
}

export function render(document: TelemetryDocument, format: ExportFormat): string {
  if (format === "otlp") return toOtlpJsonLines(document);
  if (format === "siem") return toSiemNdjson(document);
  return JSON.stringify(document, null, 2);
}

/* ─── OTLP/JSON ─── */

type AnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: AnyValue[] } };
type KeyValue = { key: string; value: AnyValue };

/** OTLP/JSON encodes 64-bit integers as decimal strings. */
function nanos(ms: number): string {
  return (BigInt(Math.floor(ms)) * 1_000_000n + BigInt(Math.round((ms % 1) * 1e6))).toString();
}

function anyValue(value: AttributeValue | null | undefined): AnyValue {
  if (Array.isArray(value)) return { arrayValue: { values: value.map((item) => anyValue(item as AttributeValue)) } };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  return { stringValue: value === null || value === undefined ? "" : String(value) };
}

function keyValues(attributes: Attributes): KeyValue[] {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ key, value: anyValue(value) }));
}

function resource(document: TelemetryDocument) {
  return {
    attributes: keyValues({
      "service.name": document.service.name,
      "service.version": document.service.version,
      "telemetry.sdk.language": "nodejs",
      "telemetry.sdk.name": "opentelemetry",
    }),
  };
}

const KIND_NUMBER: Record<SpanRecord["kind"], number> = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 };
const STATUS_NUMBER: Record<SpanRecord["status"], number> = { unset: 0, ok: 1, error: 2 };
/** AGGREGATION_TEMPORALITY_CUMULATIVE: the runtime's metrics count up from process start. */
const CUMULATIVE = 2;

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

export function otlpTraces(document: TelemetryDocument) {
  const spans = document.traces.flatMap((trace) => trace.spans);
  return {
    resourceSpans: [{
      resource: resource(document),
      scopeSpans: [...groupBy(spans, (span) => `${span.scope}@${span.scopeVersion ?? ""}`).values()].map((group) => ({
        scope: { name: group[0].scope, ...(group[0].scopeVersion ? { version: group[0].scopeVersion } : {}) },
        spans: group.map((span) => ({
          traceId: span.traceId,
          spanId: span.spanId,
          ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
          name: span.name,
          kind: KIND_NUMBER[span.kind] ?? 1,
          startTimeUnixNano: nanos(span.startMs),
          endTimeUnixNano: nanos(span.startMs + span.durationMs),
          attributes: keyValues(span.attributes),
          events: span.events.map((event) => ({
            timeUnixNano: nanos(event.timeMs),
            name: event.name,
            attributes: keyValues(event.attributes),
          })),
          status: { code: STATUS_NUMBER[span.status] ?? 0, ...(span.statusMessage ? { message: span.statusMessage } : {}) },
        })),
      })),
    }],
  };
}

export function otlpLogs(document: TelemetryDocument) {
  return {
    resourceLogs: [{
      resource: resource(document),
      scopeLogs: [{
        scope: { name: "saturn-runtime", version: document.service.version },
        logRecords: document.logs.map((line: LogRecordView) => ({
          timeUnixNano: nanos(line.timeMs),
          observedTimeUnixNano: nanos(line.timeMs),
          severityNumber: line.severityNumber,
          severityText: line.severity,
          body: { stringValue: line.body },
          attributes: keyValues(line.attributes),
          ...(line.traceId ? { traceId: line.traceId } : {}),
          ...(line.spanId ? { spanId: line.spanId } : {}),
        })),
      }],
    }],
  };
}

function otlpMetric(metric: MetricView) {
  const base = { name: metric.name, description: metric.description, unit: metric.unit };
  const times = (point: MetricView["points"][number]) => ({
    attributes: keyValues(point.attributes),
    startTimeUnixNano: nanos(point.startMs),
    timeUnixNano: nanos(point.timeMs),
  });
  if (metric.type === "histogram") {
    return {
      ...base,
      histogram: {
        aggregationTemporality: CUMULATIVE,
        dataPoints: metric.points.map((point) => ({
          ...times(point),
          count: String(point.histogram?.count ?? 0),
          sum: point.histogram?.sum ?? 0,
          ...(point.histogram?.min === undefined ? {} : { min: point.histogram.min }),
          ...(point.histogram?.max === undefined ? {} : { max: point.histogram.max }),
          bucketCounts: (point.histogram?.counts ?? []).map(String),
          explicitBounds: point.histogram?.boundaries ?? [],
        })),
      },
    };
  }
  const dataPoints = metric.points.map((point) => ({ ...times(point), asDouble: point.value ?? 0 }));
  if (metric.type === "sum") {
    return { ...base, sum: { aggregationTemporality: CUMULATIVE, isMonotonic: Boolean(metric.monotonic), dataPoints } };
  }
  return { ...base, gauge: { dataPoints } };
}

export function otlpMetrics(document: TelemetryDocument) {
  return {
    resourceMetrics: [{
      resource: resource(document),
      scopeMetrics: [{
        scope: { name: "saturn-runtime", version: document.service.version },
        metrics: document.metrics.map(otlpMetric),
      }],
    }],
  };
}

export function toOtlpJsonLines(document: TelemetryDocument): string {
  const lines: string[] = [];
  if (document.traces.length) lines.push(JSON.stringify(otlpTraces(document)));
  if (document.logs.length) lines.push(JSON.stringify(otlpLogs(document)));
  if (document.metrics.length) lines.push(JSON.stringify(otlpMetrics(document)));
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/* ─── SIEM: ECS-style NDJSON ─── */

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Lifts the attributes ECS has fields for; everything else stays under otel.attributes. */
function ecsFromAttributes(attributes: Attributes) {
  const method = attributes["http.request.method"];
  const status = attributes["http.response.status_code"];
  const urlPath = attributes["url.path"];
  const errorType = attributes["error.type"];
  return {
    ...(method || status ? { http: { request: method ? { method } : undefined, response: status ? { status_code: status } : undefined } } : {}),
    ...(urlPath ? { url: { path: urlPath } } : {}),
    ...(errorType ? { error: { type: errorType } } : {}),
  };
}

function spanEvent(document: TelemetryDocument, span: SpanRecord) {
  const exception = span.events.find((event) => event.name === "exception");
  const lifted = ecsFromAttributes(span.attributes);
  return {
    "@timestamp": iso(span.startMs),
    message: span.name,
    event: {
      kind: "event",
      dataset: "saturn.traces",
      module: "saturn",
      action: span.name,
      category: span.kind === "server" || span.kind === "client" ? ["web"] : ["process"],
      type: ["info"],
      outcome: span.status === "error" ? "failure" : span.status === "ok" ? "success" : "unknown",
      start: iso(span.startMs),
      end: iso(span.startMs + span.durationMs),
      duration: Math.round(span.durationMs * 1e6),
    },
    service: { name: document.service.name, version: document.service.version },
    trace: { id: span.traceId },
    span: { id: span.spanId },
    ...(span.parentSpanId ? { parent: { id: span.parentSpanId } } : {}),
    ...lifted,
    ...(exception || span.statusMessage
      ? {
          error: {
            ...("error" in lifted ? lifted.error : {}),
            message: String(exception?.attributes["exception.message"] ?? span.statusMessage ?? ""),
            ...(exception?.attributes["exception.stacktrace"] ? { stack_trace: String(exception.attributes["exception.stacktrace"]) } : {}),
          },
        }
      : {}),
    otel: { kind: span.kind, status: span.status, scope: span.scope, attributes: span.attributes },
  };
}

function logEvent(document: TelemetryDocument, line: LogRecordView) {
  return {
    "@timestamp": iso(line.timeMs),
    message: line.body,
    log: { level: line.severity.toLowerCase(), logger: String(line.attributes["saturn.service"] ?? "runtime") },
    event: { kind: "event", dataset: "saturn.logs", module: "saturn", severity: line.severityNumber },
    service: { name: document.service.name, version: document.service.version },
    ...(line.traceId ? { trace: { id: line.traceId } } : {}),
    ...(line.spanId ? { span: { id: line.spanId } } : {}),
    otel: { attributes: line.attributes },
  };
}

function metricEvents(document: TelemetryDocument, metric: MetricView) {
  return metric.points.map((point) => ({
    "@timestamp": iso(point.timeMs),
    message: metric.name,
    event: { kind: "metric", dataset: "saturn.metrics", module: "saturn" },
    service: { name: document.service.name, version: document.service.version },
    metric: {
      name: metric.name,
      unit: metric.unit,
      type: metric.type,
      ...(point.histogram
        ? {
            count: point.histogram.count,
            sum: point.histogram.sum,
            avg: point.histogram.count ? point.histogram.sum / point.histogram.count : 0,
            min: point.histogram.min,
            max: point.histogram.max,
          }
        : { value: point.value ?? 0 }),
    },
    otel: { attributes: point.attributes, start: iso(point.startMs) },
  }));
}

export function toSiemNdjson(document: TelemetryDocument): string {
  const events = [
    ...document.traces.flatMap((trace) => trace.spans.map((span) => spanEvent(document, span))),
    ...document.logs.map((line) => logEvent(document, line)),
    ...document.metrics.flatMap((metric) => metricEvents(document, metric)),
  ].sort((a, b) => a["@timestamp"].localeCompare(b["@timestamp"]));
  return events.length ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n` : "";
}
