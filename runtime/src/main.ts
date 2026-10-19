import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { errorText, logger } from "./infrastructure/logger.js";
import { startTelemetry, telemetryStatus } from "./infrastructure/otel-sdk.js";
import { observeActiveRuns } from "./infrastructure/telemetry.js";
import { createApp } from "./presentation/app.js";
import { FileStore } from "./infrastructure/store.js";

const host = process.env.SATURN_RUNTIME_HOST ?? "127.0.0.1";
const port = Number(process.env.SATURN_RUNTIME_PORT ?? 4700);
const directory = process.env.SATURN_DATA_DIR ?? path.join(os.homedir(), ".saturn-app");

await mkdir(directory, { recursive: true });
const stopTelemetry = await startTelemetry(directory);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    logger.info("runtime", `Stopping (${signal})`);
    void stopTelemetry().finally(() => process.exit(0));
  });
}
// Observes crashes without changing them: the process still exits as Node decides.
process.on("uncaughtExceptionMonitor", (error, origin) => {
  logger.error("runtime", `Crashed (${origin}): ${errorText(error)}`, {
    "exception.type": error instanceof Error ? error.name : "Error",
    ...(error instanceof Error && error.stack ? { "exception.stacktrace": error.stack } : {}),
  });
});

const store = new FileStore(directory);
await store.load();
const { app, services } = createApp(store);
await services.kernel.runs.recoverInterrupted();
services.kernel.automations.start();
// Resumes runs that suspended themselves with a long computer_wait, including ones due while Saturn was closed.
services.kernel.runs.startWakeups();
services.kernel.groups.resume();
observeActiveRuns(() => store.state.runs.filter((run) => run.status === "running" || run.status === "queued").length);
const telemetry =
  telemetryStatus.mode === "disabled"
    ? "telemetry off"
    : `telemetry ${telemetryStatus.mode}${telemetryStatus.endpoint ? ` → ${telemetryStatus.endpoint}` : ""}`;
const state = store.state;
app.listen(port, host, () => {
  console.log(`Saturn Runtime listening on http://${host}:${port}`);
  logger.info(
    "runtime",
    `Listening on http://${host}:${port} · data ${directory} · ${state.agents.length} agents, ${state.models.length} models, ${state.automations.length} automations, ${state.runs.length} runs · ${telemetry}`,
  );
  if (process.env.SATURN_NO_WAKEUP !== "1") {
    void services.wakeupDefaultApp().catch((error) => {
      logger.warn("runtime", `Could not wake up default app: ${errorText(error)}`);
    });
  }
}).on("error", (error) => {
  logger.error("runtime", `Could not listen on ${host}:${port}: ${errorText(error)}`);
  process.exitCode = 1;
});
