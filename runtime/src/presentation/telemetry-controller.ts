import { networkLog } from "../infrastructure/network-log.js";
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { telemetryBuffer, telemetryFile, telemetryStatus } from "../infrastructure/otel-sdk.js";
import { EXPORT_FORMATS, exportFormat, render } from "../infrastructure/telemetry-formats.js";
import { telemetryDocument } from "../infrastructure/telemetry-file.js";
import { HttpError } from "../domain/errors.js";
import { param, respond } from "./http.js";

/** Read-only views of the runtime's recent OpenTelemetry data, for the desktop Telemetry page. */
export function mountTelemetry(app: Express): void {
  // Every HTTP(S) request the runtime has sent since it started: by host, and the latest ones (no queries, no bodies).
  app.get("/network", (req, res) => {
    res.json(networkLog.view(Math.min(500, Number(req.query.limit) || 200)));
  });

  app.get("/telemetry/status", (_req, res) => {
    const traces = telemetryBuffer.summaries();
    res.json({
      ...telemetryStatus,
      savedAt: telemetryFile()?.savedAt ?? null,
      traces: traces.length,
      errorTraces: traces.filter((trace) => trace.errorCount > 0).length,
      logs: telemetryBuffer.logs().length,
    });
  });

  app.get("/telemetry/traces", (_req, res) => {
    res.json(telemetryBuffer.summaries());
  });

  app.get("/telemetry/traces/:id", (req, res, next) => {
    respond(res, next, () => {
      const spans = telemetryBuffer.trace(param(req.params.id));
      if (!spans) throw new HttpError(404, "Trace is no longer in memory");
      return spans;
    });
  });

  app.get("/telemetry/metrics", (_req, res, next) => {
    respond(res, next, () => telemetryBuffer.metrics());
  });

  app.get("/telemetry/logs", (req, res) => {
    res.json(telemetryBuffer.logs({
      traceId: typeof req.query.traceId === "string" ? req.query.traceId : undefined,
      minSeverity: Number(req.query.minSeverity) || undefined,
    }));
  });

  /**
   * Saves telemetry.json now and sends it as ?format=saturn (the file itself), otlp (OTLP/JSON lines)
   * or siem (ECS NDJSON).
   */
  app.get("/telemetry/export", async (req, res, next) => {
    try {
      const format = exportFormat(req.query.format);
      const file = telemetryFile();
      const document = file ? await file.save() : await telemetryDocument(telemetryBuffer, telemetryStatus.serviceName);
      const { extension, contentType } = EXPORT_FORMATS[format];
      const stamp = document.savedAt.slice(0, 19).replace(/[:T]/g, "-");
      const name = format === "saturn" ? "saturn-telemetry" : `saturn-telemetry-${format}`;
      res.setHeader("Content-Type", `${contentType}; charset=utf-8`);
      res.setHeader("Content-Disposition", `attachment; filename="${name}-${stamp}.${extension}"`);
      res.send(render(document, format));
    } catch (error) {
      next(error);
    }
  });

  app.delete("/telemetry", (_req, res, next) => {
    respond(res, next, async () => {
      telemetryBuffer.clear();
      await telemetryFile()?.save();
    }, 204);
  });

  /* ─── OpenTelemetry OTLP Ingestion (Agent Host & IDE Traces) ─── */

  app.post("/v1/traces", (req, res) => {
    try {
      let body = req.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch { body = {}; }
      }
      const resourceSpans = body?.resourceSpans;
      if (Array.isArray(resourceSpans)) {
        for (const rs of resourceSpans) {
          const resAttrs = parseOtlpAttributes(rs.resource?.attributes);
          for (const ss of rs.scopeSpans ?? []) {
            const scopeName = ss.scope?.name ?? "external";
            const scopeVersion = ss.scope?.version;
            for (const span of ss.spans ?? []) {
              const startMs = parseNanoToMs(span.startTimeUnixNano);
              const endMs = parseNanoToMs(span.endTimeUnixNano);
              const durationMs = Math.max(0, endMs - startMs);
              const status = span.status?.code === 2 ? "error" : span.status?.code === 1 ? "ok" : "unset";
              const attributes = { ...resAttrs, ...parseOtlpAttributes(span.attributes) };
              const events = Array.isArray(span.events) ? span.events.map((e: any) => ({
                name: e.name ?? "event",
                timeMs: parseNanoToMs(e.timeUnixNano),
                attributes: parseOtlpAttributes(e.attributes),
              })) : [];

              telemetryBuffer.addSpanRecord({
                traceId: span.traceId || randomUUID().replace(/-/g, ""),
                spanId: span.spanId || randomUUID().replace(/-/g, "").slice(0, 16),
                parentSpanId: span.parentSpanId || null,
                name: span.name ?? "unnamed-span",
                kind: KINDS[span.kind] ?? "internal",
                scope: scopeName,
                scopeVersion,
                startMs,
                durationMs,
                status,
                statusMessage: span.status?.message,
                attributes,
                events,
              });
            }
          }
        }
      }
      res.status(200).json({});
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.post("/v1/logs", (req, res) => {
    try {
      let body = req.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch { body = {}; }
      }
      const resourceLogs = body?.resourceLogs;
      if (Array.isArray(resourceLogs)) {
        for (const rl of resourceLogs) {
          const resAttrs = parseOtlpAttributes(rl.resource?.attributes);
          for (const sl of rl.scopeLogs ?? []) {
            for (const log of sl.logRecords ?? []) {
              const timeMs = parseNanoToMs(log.timeUnixNano);
              telemetryBuffer.addLogRecord({
                timeMs,
                severity: log.severityText ?? "INFO",
                severityNumber: log.severityNumber ?? 9,
                body: typeof log.body === "object" ? JSON.stringify(log.body) : String(log.body ?? ""),
                attributes: { ...resAttrs, ...parseOtlpAttributes(log.attributes) },
                traceId: log.traceId,
                spanId: log.spanId,
              });
            }
          }
        }
      }
      res.status(200).json({});
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });
}

const KINDS: Record<number, "internal" | "server" | "client" | "producer" | "consumer"> = {
  1: "internal",
  2: "server",
  3: "client",
  4: "producer",
  5: "consumer"
};

function parseNanoToMs(nanoStr: string | number | undefined): number {
  if (!nanoStr) return Date.now();
  try {
    return Number(BigInt(nanoStr) / 1_000_000n);
  } catch {
    return Number(nanoStr) / 1e6 || Date.now();
  }
}

function parseOtlpValue(val: any): any {
  if (!val || typeof val !== "object") return val;
  if ("stringValue" in val) return val.stringValue;
  if ("boolValue" in val) return val.boolValue;
  if ("intValue" in val) return Number(val.intValue);
  if ("doubleValue" in val) return val.doubleValue;
  if ("arrayValue" in val && Array.isArray(val.arrayValue.values)) {
    return val.arrayValue.values.map(parseOtlpValue);
  }
  return val;
}

function parseOtlpAttributes(attrs: any[] | undefined): Record<string, any> {
  const result: Record<string, any> = {};
  if (!Array.isArray(attrs)) return result;
  for (const item of attrs) {
    if (item && item.key) {
      result[item.key] = parseOtlpValue(item.value);
    }
  }
  return result;
}
