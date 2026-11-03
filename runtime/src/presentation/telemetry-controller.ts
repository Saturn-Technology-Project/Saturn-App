import { networkLog } from "../infrastructure/network-log.js";
import type { Express } from "express";
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
}
