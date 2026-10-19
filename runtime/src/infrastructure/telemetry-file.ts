import { readFile, rename, writeFile } from "node:fs/promises";
import type { LogRecordView, MetricView, SpanRecord, TelemetryBuffer } from "./telemetry-buffer.js";
import { errorText, logger } from "./logger.js";
import { VERSION } from "./telemetry.js";

/** The one JSON file the runtime keeps its telemetry in; also what the Telemetry page downloads. */
export type TelemetryDocument = {
  format: "saturn-telemetry";
  version: 1;
  service: { name: string; version: string };
  savedAt: string;
  traces: { traceId: string; spans: SpanRecord[] }[];
  logs: LogRecordView[];
  /** Cumulative since the runtime started; not restored on the next start. */
  metrics: MetricView[];
};

export async function telemetryDocument(buffer: TelemetryBuffer, serviceName: string): Promise<TelemetryDocument> {
  const { traces, logs } = buffer.persistable();
  return {
    format: "saturn-telemetry",
    version: 1,
    service: { name: serviceName, version: VERSION },
    savedAt: new Date().toISOString(),
    traces,
    logs,
    metrics: await buffer.metrics(),
  };
}

/**
 * Saves the buffer to disk a few seconds after real work happens (polling never triggers a write),
 * and once more when the runtime stops. Writes go to a temp file first so a crash cannot leave half a file.
 */
export class TelemetryFile {
  savedAt: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly buffer: TelemetryBuffer,
    readonly path: string,
    private readonly serviceName: string,
    private readonly delayMs = 5000,
  ) {}

  /** Restores the previous run's traces and logs, then starts saving on change. */
  async open(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.path, "utf8")) as Partial<TelemetryDocument>;
      if (saved.format === "saturn-telemetry") {
        this.buffer.restore(saved);
        this.savedAt = saved.savedAt ?? null;
        logger.info("telemetry", `Restored ${saved.traces?.length ?? 0} traces and ${saved.logs?.length ?? 0} logs from ${this.path}`);
      } else {
        logger.warn("telemetry", `${this.path} is not a Saturn telemetry file; it will be replaced on the next save`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn("telemetry", `Could not read ${this.path} (${errorText(error)}); it will be replaced on the next save`);
      }
    }
    this.buffer.onChange = () => this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save().catch((error: unknown) => {
        logger.warn("telemetry", `Could not save ${this.path}: ${errorText(error)}`);
      });
    }, this.delayMs);
    this.timer.unref();
  }

  /** Writes the file now and returns what was written. */
  save(): Promise<TelemetryDocument> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const run = this.queue.then(async () => {
      const document = await telemetryDocument(this.buffer, this.serviceName);
      const temp = `${this.path}.tmp`;
      await writeFile(temp, JSON.stringify(document, null, 2));
      await rename(temp, this.path);
      this.savedAt = document.savedAt;
      return document;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
