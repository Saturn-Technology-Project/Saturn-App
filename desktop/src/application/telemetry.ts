import type { MetricView, SpanRecord, TelemetryLog, TelemetryStatus, TraceSummary } from "../domain/model.js";
import type { RuntimeClient } from "../infrastructure/runtime-client.js";

export type TelemetryExportFormat = "saturn" | "otlp" | "siem";

/** The runtime's recent OpenTelemetry traces, metrics and logs. */
export class TelemetryService {
  constructor(private readonly runtime: RuntimeClient) {}

  status(): Promise<TelemetryStatus> {
    return this.runtime.request<TelemetryStatus>("/telemetry/status");
  }

  traces(): Promise<TraceSummary[]> {
    return this.runtime.request<TraceSummary[]>("/telemetry/traces");
  }

  trace(traceId: string): Promise<SpanRecord[]> {
    return this.runtime.request<SpanRecord[]>(`/telemetry/traces/${traceId}`);
  }

  metrics(): Promise<MetricView[]> {
    return this.runtime.request<MetricView[]>("/telemetry/metrics");
  }

  logs(filter: { traceId?: string; minSeverity?: number } = {}): Promise<TelemetryLog[]> {
    const query = new URLSearchParams();
    if (filter.traceId) query.set("traceId", filter.traceId);
    if (filter.minSeverity) query.set("minSeverity", String(filter.minSeverity));
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.runtime.request<TelemetryLog[]>(`/telemetry/logs${suffix}`);
  }

  /**
   * Has the runtime save telemetry.json now and returns it as a file:
   * "saturn" (the file itself), "otlp" (OTLP/JSON lines) or "siem" (ECS NDJSON).
   */
  export(format: TelemetryExportFormat): Promise<{ blob: Blob; filename: string }> {
    return this.runtime.download(`/telemetry/export?format=${format}`);
  }

  clear(): Promise<void> {
    return this.runtime.request("/telemetry", { method: "DELETE" });
  }
}
