import { SpanStatusCode, trace, type Attributes, type HrTime, type Span, type SpanKind, type SpanStatus } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { SimpleSpanProcessor, WebTracerProvider, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-web";
import { ATTR_URL_FULL } from "@opentelemetry/semantic-conventions";
import { RUNTIME_ORIGIN } from "./runtime-client.js";

/**
 * OpenTelemetry for the renderer. Screens and use cases call `userAction` only; without the bridge
 * every span is a no-op and fetch is left alone, so no traceparent reaches the runtime either.
 */
export const SCOPE = "saturn-desktop";
export const VERSION = "0.1.0";

const tracer = trace.getTracer(SCOPE, VERSION);

/** A finished span as it crosses IPC to Electron main, which rebuilds it in telemetry.cjs (`fromWire`). */
export type WireSpan = {
  name: string;
  kind: SpanKind;
  traceId: string;
  spanId: string;
  traceFlags: number;
  traceState?: string;
  parentSpanId?: string;
  startTime: HrTime;
  endTime: HrTime;
  duration: HrTime;
  status: SpanStatus;
  attributes: Attributes;
  events: { name: string; time: HrTime; attributes?: Attributes; droppedAttributesCount?: number }[];
  links: { traceId: string; spanId: string; traceFlags: number; attributes?: Attributes; droppedAttributesCount?: number }[];
  droppedAttributesCount: number;
  droppedEventsCount: number;
  droppedLinksCount: number;
  scope: { name: string; version?: string; schemaUrl?: string };
};

export type TelemetryBridge = { exportSpans(spans: WireSpan[]): void };

declare global {
  interface Window {
    /** Exposed by telemetry-preload.cjs, which main loads only when it exports (SATURN_OTEL=otlp|console). */
    saturnTelemetry?: TelemetryBridge;
  }
}

/**
 * Renderer spans are exported through Electron main rather than from here: a collector does not send
 * CORS headers for the app's origin, and the OTLP endpoint, headers and on/off switch live in the
 * environment, which only main can read. Each span crosses IPC as it ends; main batches them with its own.
 */
class MainProcessExporter implements SpanExporter {
  constructor(private readonly bridge: TelemetryBridge) {}

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    try {
      this.bridge.exportSpans(spans.map(toWire));
      done({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      done({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

function toWire(span: ReadableSpan): WireSpan {
  const { traceId, spanId, traceFlags, traceState } = span.spanContext();
  const { name, version, schemaUrl } = span.instrumentationScope;
  return {
    name: span.name,
    kind: span.kind,
    traceId,
    spanId,
    traceFlags,
    traceState: traceState?.serialize(),
    parentSpanId: span.parentSpanContext?.spanId,
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    status: span.status,
    attributes: withoutQuery(span.attributes),
    events: span.events.map(({ name, time, attributes, droppedAttributesCount }) => ({ name, time, attributes, droppedAttributesCount })),
    links: span.links.map(({ context, attributes, droppedAttributesCount }) => ({
      traceId: context.traceId,
      spanId: context.spanId,
      traceFlags: context.traceFlags,
      attributes,
      droppedAttributesCount,
    })),
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
    scope: { name, version, schemaUrl },
  };
}

/** Query strings carry workspace paths and local URLs; like the runtime (url.path), keep scheme, host and path. */
function withoutQuery(attributes: Attributes): Attributes {
  const url = attributes[ATTR_URL_FULL];
  if (typeof url !== "string") return attributes;
  try {
    const parsed = new URL(url);
    return { ...attributes, [ATTR_URL_FULL]: `${parsed.origin}${parsed.pathname}` };
  } catch {
    return attributes;
  }
}

const runtimeUrl = RUNTIME_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Called once before the first render. Does nothing unless main exposed the bridge. */
export function startTelemetry(bridge: TelemetryBridge | undefined = window.saturnTelemetry): void {
  if (!bridge) return;
  const provider = new WebTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new MainProcessExporter(bridge))] });
  provider.register();
  registerInstrumentations({
    instrumentations: [
      new FetchInstrumentation({
        // The runtime allows traceparent, tracestate and baggage in CORS and continues the trace.
        propagateTraceHeaderCorsUrls: [new RegExp(`^${runtimeUrl}/`)],
        // Only runtime calls are traced; in dev Vite's client fetches too.
        ignoreUrls: [new RegExp(`^(?!${runtimeUrl}/)`)],
        // The run poller would otherwise fill the resource timing buffer.
        clearTimingResources: true,
      }),
    ],
  });
}

/**
 * Runs a user action as an active span such as "ui.send_message". There is no async context manager
 * in the renderer, so only a runtime request `work` starts before its first await joins the span's
 * trace (and with it the server span and agent run on the runtime side).
 * Attributes carry ids and names only: never prompt text, API keys or file contents.
 */
export function userAction<T>(name: string, attributes: Attributes, work: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      if (error instanceof Error) span.recordException(error);
      span.setAttribute("error.type", error instanceof Error ? error.name : "error");
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}
