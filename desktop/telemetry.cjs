const { SpanStatusCode, propagation, trace } = require("@opentelemetry/api");
const { version: VERSION } = require("./package.json");

/**
 * OpenTelemetry for Electron main: its own startup spans, plus the renderer's spans, which arrive
 * over IPC from telemetry-preload.cjs (see MainProcessExporter in src/infrastructure/telemetry.ts).
 */
const tracer = trace.getTracer("saturn-desktop-main", VERSION);

/**
 * Mirrors telemetryMode in runtime/src/infrastructure/otel-sdk.ts; the runtime main spawns gets the
 * same environment. The desktop has no in-memory store, so it exports only for "otlp" and "console".
 * For "local" (the runtime's default) and "disabled" nothing is installed here or in the renderer.
 */
function telemetryMode(env = process.env) {
  if (env.OTEL_SDK_DISABLED === "true") return "disabled";
  const chosen = env.SATURN_OTEL?.trim().toLowerCase();
  if (chosen === "otlp" || chosen === "console") return chosen;
  if (chosen === "off") return "local";
  const endpoint = Object.keys(env).some((key) => /^OTEL_EXPORTER_OTLP_(\w+_)?ENDPOINT$/.test(key) && env[key]);
  return endpoint ? "otlp" : "local";
}

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const MAX_RENDERER_SPANS = 512;

/** Starts the SDK when exporting. Otherwise `enabled` is false and every span is a no-op. */
function startTelemetry(env = process.env) {
  const mode = telemetryMode(env);
  if (mode !== "otlp" && mode !== "console") {
    return { enabled: false, exportRendererSpans: () => undefined, shutdown: async () => undefined };
  }

  const { TraceState, W3CTraceContextPropagator } = require("@opentelemetry/core");
  const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-proto");
  const { resourceFromAttributes } = require("@opentelemetry/resources");
  const { BasicTracerProvider, BatchSpanProcessor, ConsoleSpanExporter } = require("@opentelemetry/sdk-trace-base");
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require("@opentelemetry/semantic-conventions");

  // OTEL_SERVICE_NAME is left to the runtime, which inherits this environment.
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: "saturn-desktop", [ATTR_SERVICE_VERSION]: VERSION });
  const processor = new BatchSpanProcessor(mode === "console" ? new ConsoleSpanExporter() : new OTLPTraceExporter());
  const provider = new BasicTracerProvider({ resource, spanProcessors: [processor] });
  trace.setGlobalTracerProvider(provider);
  // No context manager: main passes parent contexts explicitly (see `traced`).
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  console.log(`Saturn desktop OpenTelemetry ${mode === "otlp" ? "exporting over OTLP" : "printing to the console"}`);

  /** Rebuilds a renderer WireSpan as the ReadableSpan the processor and exporters expect. */
  function fromWire(wire) {
    if (!wire || !TRACE_ID.test(wire.traceId) || !SPAN_ID.test(wire.spanId)) return null;
    const context = {
      traceId: wire.traceId,
      spanId: wire.spanId,
      traceFlags: wire.traceFlags,
      traceState: wire.traceState ? new TraceState(wire.traceState) : undefined,
    };
    return {
      name: String(wire.name),
      kind: wire.kind,
      spanContext: () => context,
      parentSpanContext: SPAN_ID.test(wire.parentSpanId ?? "")
        ? { traceId: wire.traceId, spanId: wire.parentSpanId, traceFlags: wire.traceFlags }
        : undefined,
      startTime: wire.startTime,
      endTime: wire.endTime,
      duration: wire.duration,
      ended: true,
      status: wire.status ?? { code: SpanStatusCode.UNSET },
      attributes: wire.attributes ?? {},
      events: wire.events ?? [],
      links: (wire.links ?? []).map((link) => ({
        context: { traceId: link.traceId, spanId: link.spanId, traceFlags: link.traceFlags },
        attributes: link.attributes,
        droppedAttributesCount: link.droppedAttributesCount,
      })),
      resource,
      instrumentationScope: wire.scope ?? { name: "unknown" },
      droppedAttributesCount: wire.droppedAttributesCount ?? 0,
      droppedEventsCount: wire.droppedEventsCount ?? 0,
      droppedLinksCount: wire.droppedLinksCount ?? 0,
    };
  }

  let stopped = null;
  return {
    enabled: true,
    exportRendererSpans(spans) {
      if (!Array.isArray(spans)) return;
      for (const wire of spans.slice(0, MAX_RENDERER_SPANS)) {
        const span = fromWire(wire);
        if (span) processor.onEnd(span);
      }
    },
    /** Flushes what is queued; gives up after a few seconds so an unreachable collector cannot hold up quitting. */
    shutdown() {
      stopped ??= Promise.race([provider.shutdown(), new Promise((resolve) => setTimeout(resolve, 3000))]).catch(() => undefined);
      return stopped;
    },
  };
}

/** Runs `work` in a span under `parent` and hands it the span's context; the span fails if `work` throws. */
async function traced(name, parent, work) {
  const span = tracer.startSpan(name, {}, parent);
  try {
    return await work(span, trace.setSpan(parent, span));
  } catch (error) {
    if (error instanceof Error) span.recordException(error);
    span.setAttribute("error.type", error instanceof Error ? error.name : "error");
    span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    span.end();
  }
}

module.exports = { startTelemetry, telemetryMode, traced };
