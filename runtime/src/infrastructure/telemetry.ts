import { SpanKind, SpanStatusCode, metrics, trace, type Attributes, type Meter, type Span } from "@opentelemetry/api";
import { SeverityNumber, logs } from "@opentelemetry/api-logs";

/**
 * OpenTelemetry for the runtime. Code calls the API only; whether anything is exported is decided
 * once at startup by `startTelemetry` (see otel-sdk.ts). Without an SDK every call here is a no-op.
 */
export const SCOPE = "saturn-runtime";
export const VERSION = "0.1.0";

export const tracer = trace.getTracer(SCOPE, VERSION);

export { SpanKind };

/** Runs `work` inside an active span; records the error and marks the span failed when it throws. */
export async function traced<T>(
  name: string,
  options: { kind?: SpanKind; attributes?: Attributes },
  work: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { kind: options.kind ?? SpanKind.INTERNAL, attributes: options.attributes }, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      failSpan(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

const failed = new WeakSet<Span>();

/** Tells an enclosing `traced` that an error passing through is expected flow, not a failure of this span. */
export function markHandled(span: Span): void {
  failed.add(span);
}

/** Marks a span failed once; a later call for the same span (e.g. from an outer `traced`) is ignored. */
export function failSpan(span: Span, error: unknown, type?: string): void {
  if (failed.has(span)) return;
  failed.add(span);
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error) span.recordException(error);
  span.setAttribute("error.type", type ?? (error instanceof Error ? error.name : "error"));
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

/** Milliseconds → seconds, the unit OTel semantic conventions use for durations. */
export function seconds(startedAt: number): number {
  return (performance.now() - startedAt) / 1000;
}

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];
const TOKEN_BUCKETS = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576];

function build(meter: Meter) {
  return {
    httpDuration: meter.createHistogram("http.server.request.duration", {
      unit: "s",
      description: "Duration of HTTP requests handled by the runtime.",
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    }),
    llmDuration: meter.createHistogram("gen_ai.client.operation.duration", {
      unit: "s",
      description: "Duration of LLM calls.",
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    }),
    llmTokens: meter.createHistogram("gen_ai.client.token.usage", {
      unit: "{token}",
      description: "Tokens used per LLM call, split by gen_ai.token.type.",
      advice: { explicitBucketBoundaries: TOKEN_BUCKETS },
    }),
    runs: meter.createCounter("saturn.agent.runs", { unit: "{run}", description: "Agent runs that ended, by outcome." }),
    runDuration: meter.createHistogram("saturn.agent.run.duration", {
      unit: "s",
      description: "Wall time of an agent run from start to its final state.",
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    }),
    tools: meter.createCounter("saturn.tool.calls", { unit: "{call}", description: "Tool calls, by tool and status." }),
    toolDuration: meter.createHistogram("saturn.tool.duration", {
      unit: "s",
      description: "Duration of tool calls.",
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    }),
    mcpDuration: meter.createHistogram("saturn.mcp.request.duration", {
      unit: "s",
      description: "Duration of MCP JSON-RPC requests.",
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    }),
    automations: meter.createCounter("saturn.automation.runs", { unit: "{run}", description: "Automation firings, by trigger and outcome." }),
    storeWrites: meter.createHistogram("saturn.store.write.duration", {
      unit: "s",
      description: "Time to persist runtime state to disk.",
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    }),
    commands: meter.createCounter("saturn.workspace.commands", { unit: "{command}", description: "Workspace terminal commands, by outcome." }),
  };
}

let cache: { provider: unknown; instruments: ReturnType<typeof build> } | null = null;

/**
 * Instruments are created against the global meter provider. The metrics API has no proxy,
 * so they are rebuilt if the provider changes (startup, or a test installing its own).
 */
export function instruments(): ReturnType<typeof build> {
  const provider = metrics.getMeterProvider();
  if (cache?.provider !== provider) cache = { provider, instruments: build(provider.getMeter(SCOPE, VERSION)) };
  return cache.instruments;
}

/** Reports how many runs are working right now, read from live state on each collection. */
export function observeActiveRuns(count: () => number): void {
  metrics
    .getMeterProvider()
    .getMeter(SCOPE, VERSION)
    .createObservableUpDownCounter("saturn.agent.runs.active", { unit: "{run}", description: "Runs still working." })
    .addCallback((result) => result.observe(count()));
}

const SEVERITY: Record<string, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warning: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

/** Mirrors a runtime log line to OTel logs; it is tied to the active span when there is one. */
export function emitLog(service: string, level: string, message: string, attributes: Attributes = {}): void {
  logs.getLogger(SCOPE, VERSION).emit({
    severityNumber: SEVERITY[level] ?? SeverityNumber.INFO,
    severityText: level.toUpperCase(),
    body: message,
    attributes: { ...attributes, "saturn.service": service },
  });
}
