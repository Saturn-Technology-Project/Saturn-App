import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, ConsoleLogRecordExporter, type LogRecordExporter, type LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { ConsoleMetricExporter, PeriodicExportingMetricReader, type IMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor, ConsoleSpanExporter, type SpanExporter, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import path from "node:path";
import { TelemetryBuffer } from "./telemetry-buffer.js";
import { TelemetryFile } from "./telemetry-file.js";
import { logger } from "./logger.js";
import { VERSION } from "./telemetry.js";

/**
 * "local": recorded for the desktop Telemetry page and saved to telemetry.json only (the default).
 * "otlp" / "console": also exported. "disabled": no SDK at all, nothing saved.
 */
export type TelemetryMode = "disabled" | "local" | "console" | "otlp";

export type TelemetryStatus = {
  mode: TelemetryMode;
  serviceName: string;
  endpoint: string | null;
  /** Where telemetry is saved as JSON, when it is. */
  file: string | null;
};

/** The runtime's recent spans, logs and metrics, read by the /telemetry endpoints. */
export const telemetryBuffer = new TelemetryBuffer();

export const telemetryStatus: TelemetryStatus = { mode: "disabled", serviceName: "saturn-runtime", endpoint: null, file: null };

let saved: TelemetryFile | null = null;

/** The telemetry.json writer, once startTelemetry has opened it. */
export function telemetryFile(): TelemetryFile | null {
  return saved;
}

/**
 * SATURN_OTEL picks the exporter: "otlp", "console" or "off" (local only).
 * Unset, it is "otlp" when any OTEL_EXPORTER_OTLP_*ENDPOINT is set and local only otherwise,
 * so a plain local run never tries to reach a collector. OTEL_SDK_DISABLED=true turns everything off.
 */
export function telemetryMode(env: NodeJS.ProcessEnv = process.env): TelemetryMode {
  if (env.OTEL_SDK_DISABLED === "true") return "disabled";
  const chosen = env.SATURN_OTEL?.trim().toLowerCase();
  if (chosen === "otlp" || chosen === "console") return chosen;
  if (chosen === "off") return "local";
  const endpoint = Object.keys(env).some((key) => /^OTEL_EXPORTER_OTLP_(\w+_)?ENDPOINT$/.test(key) && env[key]);
  return endpoint ? "otlp" : "local";
}

function otlpEndpoint(env: NodeJS.ProcessEnv): string {
  return env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";
}

/**
 * Starts the OTel SDK for traces, metrics and logs, restoring and saving `<directory>/telemetry.json`.
 * Returns a function that flushes everything, saves the file and stops.
 */
export async function startTelemetry(directory: string, env: NodeJS.ProcessEnv = process.env): Promise<() => Promise<void>> {
  const mode = telemetryMode(env);
  const serviceName = env.OTEL_SERVICE_NAME || "saturn-runtime";
  const file = mode === "disabled" ? null : path.join(directory, "telemetry.json");
  Object.assign(telemetryStatus, {
    mode,
    serviceName,
    endpoint: mode === "otlp" ? otlpEndpoint(env) : null,
    file,
  } satisfies TelemetryStatus);
  if (!file) {
    logger.warn("telemetry", "OTEL_SDK_DISABLED=true: no traces, metrics or logs are recorded or saved");
    return async () => undefined;
  }
  saved = new TelemetryFile(telemetryBuffer, file, serviceName);
  await saved.open();

  const spanProcessors: SpanProcessor[] = [telemetryBuffer.spanProcessor];
  const metricReaders: IMetricReader[] = [telemetryBuffer.metricReader];
  const logRecordProcessors: LogRecordProcessor[] = [telemetryBuffer.logProcessor];
  if (mode === "otlp" || mode === "console") {
    const spans: SpanExporter = mode === "console" ? new ConsoleSpanExporter() : new OTLPTraceExporter();
    const metricExporter: PushMetricExporter = mode === "console" ? new ConsoleMetricExporter() : new OTLPMetricExporter();
    const logExporter: LogRecordExporter = mode === "console" ? new ConsoleLogRecordExporter() : new OTLPLogExporter();
    spanProcessors.push(new BatchSpanProcessor(spans));
    metricReaders.push(new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: Number(env.OTEL_METRIC_EXPORT_INTERVAL) || 60_000,
    }));
    logRecordProcessors.push(new BatchLogRecordProcessor({ exporter: logExporter }));
  }

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: VERSION,
    }),
    spanProcessors,
    metricReaders,
    logRecordProcessors,
    // Outgoing fetch: LLM providers, MCP servers, RAG and web skills. Trace context is propagated to them.
    instrumentations: [new UndiciInstrumentation()],
  });
  sdk.start();
  logger.info(
    "telemetry",
    mode === "otlp"
      ? `Recording to ${file} and exporting over OTLP to ${telemetryStatus.endpoint}`
      : mode === "console"
        ? `Recording to ${file} and printing to the console`
        : `Recording to ${file}; set OTEL_EXPORTER_OTLP_ENDPOINT to export`,
  );

  let stopped: Promise<void> | null = null;
  return () => {
    stopped ??= sdk
      .shutdown()
      .catch(() => undefined)
      .then(() => saved?.save())
      .then(() => undefined, () => undefined);
    return stopped;
  };
}
