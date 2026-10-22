import assert from "node:assert/strict";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { SpanKind, metrics } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { telemetryBuffer, telemetryMode } from "../src/infrastructure/otel-sdk.js";
import { TelemetryBuffer } from "../src/infrastructure/telemetry-buffer.js";
import { TelemetryFile, type TelemetryDocument } from "../src/infrastructure/telemetry-file.js";
import { createApp } from "../src/presentation/app.js";
import { useRuntimeAuth } from "./runtime-token.js";
import { FileStore } from "../src/infrastructure/store.js";

class TestReader extends MetricReader {
  protected async onShutdown(): Promise<void> {}
  protected async onForceFlush(): Promise<void> {}
}

// Each test file runs in its own process, so these globals stay local to this file.
const spans = new InMemorySpanExporter();
new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans), telemetryBuffer.spanProcessor] }).register();
const reader = new TestReader();
metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader, telemetryBuffer.metricReader] }));
const logRecords = new InMemoryLogRecordExporter();
logs.setGlobalLoggerProvider(new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: logRecords }), telemetryBuffer.logProcessor] }));

async function listen(handler: (body: Record<string, unknown>, res: import("node:http").ServerResponse) => void) {
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      handler(JSON.parse(data || "{}"), res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function points(name: string) {
  const { resourceMetrics } = await reader.collect();
  const metric = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics).find((item) => item.descriptor.name === name);
  return metric?.dataPoints ?? [];
}

test("telemetry stays local unless an exporter is configured", () => {
  assert.equal(telemetryMode({}), "local");
  assert.equal(telemetryMode({ SATURN_OTEL: "off" }), "local");
  assert.equal(telemetryMode({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }), "otlp");
  assert.equal(telemetryMode({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector:4318/v1/traces" }), "otlp");
  assert.equal(telemetryMode({ SATURN_OTEL: "console" }), "console");
  assert.equal(telemetryMode({ SATURN_OTEL: "console", OTEL_SDK_DISABLED: "true" }), "disabled");
});

test("a run is traced end to end: request, agent, LLM, tool, MCP", async () => {
  const mcp = await listen((body, res) => {
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: body.method === "tools/call" ? { ok: true } : {} }));
  });
  let calls = 0;
  const model = await listen((_body, res) => {
    calls += 1;
    const message = calls === 1
      ? { tool_calls: [{ type: "function", function: { name: "github.search", arguments: "{\"q\":\"saturn\"}" } }] }
      : { content: "done" };
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 12, completion_tokens: 5 } }));
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-app-"));
  const store = new FileStore(directory);
  await store.load();
  const { app, services } = createApp(store);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  useRuntimeAuth(base);

  try {
    const createdModel = await services.createModel({ name: "Local", provider: "openai", model: "local-model", baseUrl: model.url });
    const createdMcp = await services.createMcp({ name: "GitHub", url: mcp.url, tools: [{ toolId: "github.search" }] });
    const agent = await services.createAgent({ name: "Research", modelConnectionId: createdModel.id, mcpConnectionIds: [createdMcp.id] });

    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const started = await fetch(`${base}/agents/${agent.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
      body: JSON.stringify({ input: "search saturn" }),
    });
    const run = (await started.json()) as { id: string };
    for (let attempt = 0; attempt < 80 && store.state.runs[0]?.status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(store.state.runs[0]?.status, "completed");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const finished = spans.getFinishedSpans();
    const named = (name: string) => finished.filter((span) => span.name === name);

    const request = named("POST /agents/:id/runs")[0];
    assert.ok(request, "server span is named by route template");
    assert.equal(request.attributes["http.route"], "/agents/:id/runs");
    assert.equal(request.attributes["http.response.status_code"], 201);
    assert.equal(request.spanContext().traceId, traceId, "incoming traceparent is continued");

    const invoke = named("invoke_agent Research")[0];
    assert.ok(invoke);
    assert.equal(invoke.spanContext().traceId, traceId);
    assert.equal(invoke.attributes["saturn.run.id"], run.id);
    assert.equal(invoke.attributes["saturn.run.status"], "completed");

    const chats = named("chat local-model");
    assert.equal(chats.length, 2);
    assert.equal(chats[0].attributes["gen_ai.provider.name"], "openai");
    assert.equal(chats[0].attributes["saturn.llm.adapter"], "openai-chat");
    assert.equal(chats[0].attributes["gen_ai.usage.input_tokens"], 12);
    assert.equal(chats[0].attributes["saturn.llm.tool_calls"], 1);
    assert.equal(chats[0].parentSpanContext?.spanId, invoke.spanContext().spanId);

    const tool = named("execute_tool github.search")[0];
    assert.ok(tool);
    assert.equal(tool.attributes["saturn.tool.status"], "completed");
    assert.equal(tool.attributes["saturn.tool.kind"], "mcp");
    const rpc = named("mcp tools/call github.search")[0];
    assert.ok(rpc);
    assert.equal(rpc.parentSpanContext?.spanId, tool.spanContext().spanId);
    assert.ok(named("store.persist").length > 0);

    const tokens = await points("gen_ai.client.token.usage");
    const input = tokens.find((point) => point.attributes["gen_ai.token.type"] === "input");
    assert.equal((input!.value as { sum: number }).sum, 24);
    const runs = await points("saturn.agent.runs");
    assert.equal(runs.find((point) => point.attributes["saturn.run.status"] === "completed")?.value, 1);
    const tools = await points("saturn.tool.calls");
    assert.equal(tools.find((point) => point.attributes["gen_ai.tool.name"] === "github.search")?.value, 1);
    assert.ok((await points("http.server.request.duration")).length > 0);

    const lines = logRecords.getFinishedLogRecords().map((record) => String(record.body));
    assert.ok(lines.some((line) => line.includes("Research completed")));

    // The Telemetry page reads the same data back from the in-memory buffer.
    await fetch(`${base}/agents`);
    const summaries = (await (await fetch(`${base}/telemetry/traces`)).json()) as { traceId: string; rootName: string; spanCount: number; routine: boolean }[];
    const summary = summaries.find((item) => item.traceId === traceId);
    assert.equal(summary?.rootName, "POST /agents/:id/runs");
    assert.ok((summary?.spanCount ?? 0) >= 6);
    assert.equal(summary?.routine, false);
    assert.ok(summaries.some((item) => item.routine), "plain GETs are marked routine");
    const traceSpans = (await (await fetch(`${base}/telemetry/traces/${traceId}`)).json()) as { name: string; parentSpanId: string | null; kind: string }[];
    assert.ok(traceSpans.some((span) => span.name === "invoke_agent Research"));
    assert.equal(traceSpans.find((span) => span.name.startsWith("POST"))?.kind, "server");
    const metricList = (await (await fetch(`${base}/telemetry/metrics`)).json()) as { name: string; type: string; points: { histogram?: { count: number } }[] }[];
    const usage = metricList.find((item) => item.name === "gen_ai.client.token.usage");
    assert.equal(usage?.type, "histogram");
    assert.ok((usage?.points[0]?.histogram?.count ?? 0) > 0);
    const traceLogs = (await (await fetch(`${base}/telemetry/logs?traceId=${traceId}`)).json()) as { body: string }[];
    assert.ok(traceLogs.some((line) => line.body.includes("Research completed")), "logs carry the trace they happened in");
    const before = summaries.length;
    await fetch(`${base}/telemetry/status`);
    const after = (await (await fetch(`${base}/telemetry/traces`)).json()) as unknown[];
    assert.equal(after.length, before, "reading telemetry is not itself traced");

    const exported = await fetch(`${base}/telemetry/export`);
    assert.match(exported.headers.get("content-disposition") ?? "", /attachment; filename="saturn-telemetry-.*\.json"/);
    const document = (await exported.json()) as TelemetryDocument;
    assert.equal(document.format, "saturn-telemetry");
    assert.ok(document.traces.some((trace) => trace.traceId === traceId));
    assert.ok(document.metrics.some((metric) => metric.name === "gen_ai.client.token.usage"));

    // OTLP/JSON lines: TracesData, LogsData, MetricsData, one per line.
    const otlpResponse = await fetch(`${base}/telemetry/export?format=otlp`);
    assert.match(otlpResponse.headers.get("content-disposition") ?? "", /saturn-telemetry-otlp-.*\.jsonl"/);
    const [tracesLine, logsLine, metricsLine] = (await otlpResponse.text()).trim().split("\n").map((line) => JSON.parse(line));
    const resourceAttrs = tracesLine.resourceSpans[0].resource.attributes as { key: string; value: { stringValue?: string } }[];
    assert.equal(resourceAttrs.find((item) => item.key === "service.name")?.value.stringValue, "saturn-runtime");
    const otlpSpans = tracesLine.resourceSpans[0].scopeSpans.flatMap((scope: { spans: unknown[] }) => scope.spans) as {
      traceId: string; name: string; kind: number; startTimeUnixNano: string; endTimeUnixNano: string; status: { code: number };
      attributes: { key: string; value: Record<string, unknown> }[];
    }[];
    const otlpRequest = otlpSpans.find((span) => span.name === "POST /agents/:id/runs");
    assert.equal(otlpRequest?.traceId, traceId);
    assert.equal(otlpRequest?.kind, 2, "SPAN_KIND_SERVER");
    assert.match(otlpRequest?.startTimeUnixNano ?? "", /^\d{19}$/);
    assert.ok(BigInt(otlpRequest!.endTimeUnixNano) >= BigInt(otlpRequest!.startTimeUnixNano));
    assert.deepEqual(otlpRequest?.attributes.find((item) => item.key === "http.response.status_code")?.value, { intValue: "201" });
    const otlpChat = otlpSpans.find((span) => span.name === "chat local-model");
    assert.deepEqual(otlpChat?.attributes.find((item) => item.key === "gen_ai.usage.input_tokens")?.value, { intValue: "12" });
    const otlpLog = logsLine.resourceLogs[0].scopeLogs[0].logRecords.find((record: { body: { stringValue: string } }) => record.body.stringValue.includes("Research completed"));
    assert.equal(otlpLog?.traceId, traceId);
    assert.equal(otlpLog?.severityNumber, 9);
    const otlpTokens = metricsLine.resourceMetrics[0].scopeMetrics[0].metrics.find((metric: { name: string }) => metric.name === "gen_ai.client.token.usage");
    assert.equal(otlpTokens.histogram.aggregationTemporality, 2);
    assert.ok(otlpTokens.histogram.dataPoints[0].bucketCounts.every((count: unknown) => typeof count === "string"));

    // SIEM: one ECS event per line.
    const siemResponse = await fetch(`${base}/telemetry/export?format=siem`);
    assert.match(siemResponse.headers.get("content-type") ?? "", /application\/x-ndjson/);
    const events = (await siemResponse.text()).trim().split("\n").map((line) => JSON.parse(line)) as Record<string, any>[];
    assert.ok(events.every((event) => typeof event["@timestamp"] === "string" && event.service?.name === "saturn-runtime"));
    const siemRequest = events.find((event) => event.event?.dataset === "saturn.traces" && event.event.action === "POST /agents/:id/runs");
    assert.equal(siemRequest?.http?.request?.method, "POST");
    assert.equal(siemRequest?.http?.response?.status_code, 201);
    assert.equal(siemRequest?.trace?.id, traceId);
    assert.equal(siemRequest?.event?.outcome, "unknown");
    assert.ok(events.some((event) => event.event?.dataset === "saturn.logs" && event.log?.level === "info" && event.trace?.id === traceId));
    assert.ok(events.some((event) => event.event?.kind === "metric" && event.metric?.name === "gen_ai.client.token.usage" && event.metric.count > 0));
  } finally {
    server.close();
    mcp.server.close();
    model.server.close();
  }
});

test("a refused LLM call marks its span failed with the reason", async () => {
  spans.reset();
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-app-"));
  const store = new FileStore(directory);
  await store.load();
  const { services } = createApp(store);
  const model = await services.createModel({ provider: "gemini", model: "gemini-3.8-flash" });
  await assert.rejects(() => services.kernel.llm.complete(model, { context: { agentId: "a", agentName: "A", purpose: "run" }, messages: [{ role: "user", content: "hi" }] }), /no Gemini API key/);
  const span = spans.getFinishedSpans().find((item) => item.name === "chat gemini-3.8-flash");
  assert.ok(span);
  assert.equal(span.status.code, 2);
  assert.equal(span.attributes["error.type"], "http_409");
  assert.equal(span.events.filter((event) => event.name === "exception").length, 1);
});

test("telemetry is saved to one JSON file, without polling, and restored on the next start", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-telemetry-"));
  const file = path.join(directory, "telemetry.json");
  const buffer = new TelemetryBuffer();
  const tracer = new NodeTracerProvider({ spanProcessors: [buffer.spanProcessor] }).getTracer("test");
  const logger = new LoggerProvider({ processors: [buffer.logProcessor] }).getLogger("test");
  const writer = new TelemetryFile(buffer, file, "saturn-runtime", 20);
  await writer.open();

  const poll = tracer.startSpan("GET /agents", { kind: SpanKind.SERVER, attributes: { "http.request.method": "GET" } });
  poll.end();
  await new Promise((resolve) => setTimeout(resolve, 60));
  await assert.rejects(() => readFile(file, "utf8"), "polling alone never writes the file");

  const work = tracer.startSpan("POST /agents/:id/runs", { kind: SpanKind.SERVER, attributes: { "http.request.method": "POST" } });
  const workId = work.spanContext().traceId;
  work.end();
  logger.emit({ body: "Research completed", severityText: "INFO", severityNumber: 9 });
  await new Promise((resolve) => setTimeout(resolve, 80));

  const saved = JSON.parse(await readFile(file, "utf8")) as TelemetryDocument;
  assert.equal(saved.format, "saturn-telemetry");
  assert.deepEqual(saved.traces.map((trace) => trace.traceId), [workId]);
  assert.equal(saved.logs[0]?.body, "Research completed");
  assert.ok(writer.savedAt);

  const next = new TelemetryBuffer();
  await new TelemetryFile(next, file, "saturn-runtime").open();
  assert.deepEqual(next.summaries().map((trace) => trace.rootName), ["POST /agents/:id/runs"]);
  assert.equal(next.logs()[0]?.body, "Research completed");

  buffer.clear();
  await writer.save();
  const cleared = JSON.parse(await readFile(file, "utf8")) as TelemetryDocument;
  assert.equal(cleared.traces.length + cleared.logs.length, 0);
});
