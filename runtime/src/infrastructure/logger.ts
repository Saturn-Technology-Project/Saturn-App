import type { Attributes } from "@opentelemetry/api";
import { emitLog } from "./telemetry.js";

export type LogLevel = "debug" | "info" | "warning" | "error";

export type LogLine = {
  seq: number;
  ts: string;
  service: string;
  level: LogLevel;
  message: string;
  attributes?: Attributes;
};

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warning: 2, error: 3 };

export function logLevel(value: unknown): LogLevel | null {
  return value === "debug" || value === "info" || value === "warning" || value === "error" ? value : null;
}

/**
 * The runtime's log. Each line goes to the Settings → Logs list, to OpenTelemetry logs (tied to the
 * active trace, so it lands in telemetry.json and every export), and, for warnings and errors, to stderr.
 * Lines below `level` (Settings → General → Logging level) are dropped everywhere.
 *
 * Log what spans cannot show: what a change was, why something was skipped, failures that are
 * swallowed on purpose, and the runtime's own lifecycle. Never log secrets, full prompts or command arguments.
 */
export class Logger {
  level: LogLevel = "info";
  private readonly lines: LogLine[] = [];
  private seq = 0;

  constructor(private readonly limit = 500) {}

  log(service: string, level: LogLevel, message: string, attributes?: Attributes): void {
    if (RANK[level] < RANK[this.level]) return;
    this.lines.push({
      seq: (this.seq += 1),
      ts: new Date().toISOString(),
      service,
      level,
      message,
      ...(attributes && Object.keys(attributes).length ? { attributes } : {}),
    });
    if (this.lines.length > this.limit) this.lines.shift();
    emitLog(service, level, message, attributes);
    if (level === "error") console.error(`[${service}] ${message}`);
    else if (level === "warning") console.warn(`[${service}] ${message}`);
  }

  debug(service: string, message: string, attributes?: Attributes): void {
    this.log(service, "debug", message, attributes);
  }

  info(service: string, message: string, attributes?: Attributes): void {
    this.log(service, "info", message, attributes);
  }

  warn(service: string, message: string, attributes?: Attributes): void {
    this.log(service, "warning", message, attributes);
  }

  error(service: string, message: string, attributes?: Attributes): void {
    this.log(service, "error", message, attributes);
  }

  recent(): LogLine[] {
    return [...this.lines];
  }
}

/** One log for the whole process, so the store and telemetry can log before the kernel exists. */
export const logger = new Logger();

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
