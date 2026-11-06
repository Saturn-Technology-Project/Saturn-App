// Telemetry and the network record, whichever language runs them: what a run leaves behind, the three export formats, the
// saved file, the modes, and every request the runtime sends. All servers here are fake, on this computer.
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startRuntime } from "./runtime.mjs";

let scratch;
const servers = [];
const stops = [];

before(async () => {
  scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "saturn-contract-telemetry-")));
});
after(async () => {
  for (const stop of stops) await stop().catch(() => undefined);
  await Promise.all(servers.map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
  await rm(scratch, { recursive: true, force: true });
});

async function start(options = {}) {
  const runtime = await startRuntime(options);
  if (!options.keepData) stops.push(runtime.stop);
  return runtime;
}

async function listen(handler) {
  const seen = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, raw });
      handler(raw, response, request);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { seen, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` };
}

async function raw(runtime, method, route, body, headers = {}) {
  const token = (await readFile(path.join(runtime.dataDir, "runtime-token"), "utf8")).trim();
  return fetch(`${runtime.origin}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function api(runtime, method, route, body, headers) {
  const response = await raw(runtime, method, route, body, headers);
  const text = await response.text();
  assert.ok(response.status < 300, `${method} ${route}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

async function until(what, read, done = Boolean) {
  let value;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`never happened: ${what}; last ${JSON.stringify(value)}`);
}

/** A model that calls `github.search` once, then answers; and an MCP server with that tool. */
async function scripted(runtime) {
  let calls = 0;
  const model = await listen((_raw, response) => {
    calls += 1;
    const message = calls === 1
      ? { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "github.search", arguments: '{"q":"saturn"}' } }] }
      : { role: "assistant", content: "done" };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "r", object: "chat.completion", model: "local-model", choices: [{ index: 0, finish_reason: "stop", message }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }));
  });
  const mcp = await listen((body, response) => {
    const request = JSON.parse(body || "{}");
    if (request.id === undefined) return response.writeHead(202).end();
    const result = request.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }
      : request.method === "tools/list"
        ? { tools: [{ name: "github.search", description: "Search", inputSchema: { type: "object", properties: {} } }] }
        : { content: [{ type: "text", text: "found" }] };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  });
  const connection = await api(runtime, "POST", "/connections/models", { name: "Local", provider: "openai", model: "local-model", baseUrl: `${model.url}/v1?key=SECRET` });
  const server = await api(runtime, "POST", "/connections/mcp", { name: "GitHub", url: mcp.url, tools: [{ toolId: "github.search", category: "read" }] });
  const agent = await api(runtime, "POST", "/agents", { name: "Research", modelConnectionId: connection.id, autonomy: "bypass", mcpConnectionIds: [server.id] });
  return { model, mcp, agent };
}

const finished = (runtime, id) => until("the run", () => api(runtime, "GET", `/runs/${id}`), (run) => !["queued", "running", "waiting_approval"].includes(run.status));

test("a run is traced end to end, and the Telemetry page and exports read it back", async () => {
  const runtime = await start();
  const status = await api(runtime, "GET", "/telemetry/status");
  assert.equal(status.mode, "local");
  assert.equal(status.serviceName, "saturn-runtime");
  assert.equal(status.endpoint, null);
  assert.equal(status.file, path.join(runtime.dataDir, "telemetry.json"));
  assert.equal(typeof status.traces, "number");

  const { model, agent } = await scripted(runtime);
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const started = await api(runtime, "POST", `/agents/${agent.id}/runs`, { input: "search saturn" }, { traceparent: `00-${traceId}-00f067aa0ba902b7-01` });
  const run = await finished(runtime, started.id);
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.actions[0].status, "completed", JSON.stringify(run.actions[0]));

  const spans = await until("the run's spans", () => api(runtime, "GET", `/telemetry/traces/${traceId}`).catch(() => []), (list) => list.filter((span) => span.name === "chat local-model").length === 2 && list.some((span) => span.name === "invoke_agent Research"));
  const named = (name) => spans.find((span) => span.name === name);

  const request = named("POST /agents/:id/runs");
  assert.ok(request, spans.map((span) => span.name).join(", "));
  assert.equal(request.kind, "server");
  assert.equal(request.parentSpanId, "00f067aa0ba902b7", "continues the caller's trace");
  assert.equal(request.attributes["http.route"], "/agents/:id/runs");
  assert.equal(request.attributes["http.request.method"], "POST");
  assert.equal(request.attributes["http.response.status_code"], 201);
  assert.equal(request.scope, "saturn-runtime");

  const invoke = named("invoke_agent Research");
  assert.equal(invoke.attributes["gen_ai.operation.name"], "invoke_agent");
  assert.equal(invoke.attributes["gen_ai.agent.id"], agent.id);
  assert.equal(invoke.attributes["gen_ai.agent.name"], "Research");
  assert.equal(invoke.attributes["saturn.run.id"], run.id);
  assert.equal(invoke.attributes["saturn.run.status"], "completed");
  assert.equal(invoke.attributes["saturn.run.actions"], 1);
  assert.equal(invoke.attributes["gen_ai.provider.name"], "openai");
  assert.equal(invoke.attributes["saturn.agent.autonomy"], "bypass");
  assert.equal(invoke.parentSpanId, request.spanId, "the run belongs to the request that started it");

  const chats = spans.filter((span) => span.name === "chat local-model");
  assert.equal(chats[0].kind, "client");
  assert.equal(chats[0].attributes["gen_ai.provider.name"], "openai");
  assert.equal(chats[0].attributes["gen_ai.request.model"], "local-model");
  assert.equal(chats[0].attributes["saturn.llm.adapter"], "openai-chat");
  assert.equal(chats[0].attributes["server.address"], "127.0.0.1");
  assert.equal(chats[0].attributes["gen_ai.usage.input_tokens"], 12);
  assert.equal(chats[0].attributes["gen_ai.usage.output_tokens"], 5);
  assert.equal(chats[0].attributes["saturn.llm.tool_calls"], 1);
  assert.equal(chats[0].parentSpanId, invoke.spanId);
  assert.ok(chats[0].attributes["saturn.llm.tools.offered"] >= 1);

  const tool = named("execute_tool github.search");
  assert.equal(tool.attributes["gen_ai.tool.name"], "github.search");
  assert.equal(tool.attributes["saturn.tool.kind"], "mcp");
  assert.equal(tool.attributes["saturn.tool.status"], "completed");
  assert.equal(tool.parentSpanId, invoke.spanId);
  const rpc = named("mcp tools/call github.search");
  assert.equal(rpc.kind, "client");
  assert.equal(rpc.attributes["mcp.method.name"], "tools/call");
  assert.equal(rpc.parentSpanId, tool.spanId);
  assert.ok(spans.some((span) => span.name === "store.persist"));

  // The trace reaches the servers the runtime talks to.
  assert.match(model.seen[0].headers.traceparent ?? "", new RegExp(`^00-${traceId}-[0-9a-f]{16}-0[01]$`));

  // Metrics.
  const metrics = await api(runtime, "GET", "/telemetry/metrics");
  assert.deepEqual(metrics.map((metric) => metric.name), [...metrics.map((metric) => metric.name)].sort((a, b) => a.localeCompare(b)));
  const metric = (name) => metrics.find((item) => item.name === name);
  const tokens = metric("gen_ai.client.token.usage");
  assert.equal(tokens.type, "histogram");
  assert.equal(tokens.unit, "{token}");
  const input = tokens.points.find((point) => point.attributes["gen_ai.token.type"] === "input");
  assert.equal(input.histogram.sum, 24);
  assert.equal(input.histogram.count, 2);
  assert.equal(input.histogram.min, 12);
  assert.equal(input.histogram.max, 12);
  assert.equal(input.histogram.counts.length, input.histogram.boundaries.length + 1);
  assert.deepEqual(input.histogram.boundaries, [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576]);
  assert.equal(input.histogram.counts[2], 2, "12 falls in the bucket up to 16");
  const runs = metric("saturn.agent.runs");
  assert.equal(runs.type, "sum");
  assert.equal(runs.monotonic, true);
  assert.equal(runs.points.find((point) => point.attributes["saturn.run.status"] === "completed").value, 1);
  assert.equal(metric("saturn.tool.calls").points.find((point) => point.attributes["gen_ai.tool.name"] === "github.search").value, 1);
  for (const name of ["gen_ai.client.operation.duration", "saturn.agent.run.duration", "saturn.tool.duration", "saturn.mcp.request.duration", "saturn.store.write.duration", "http.server.request.duration", "saturn.agent.runs.active"]) {
    assert.ok(metric(name)?.points.length, `${name} has points`);
  }
  assert.equal(metric("saturn.agent.runs.active").points[0].value, 0);

  // Logs carry the trace they happened in.
  const inTrace = await api(runtime, "GET", `/telemetry/logs?traceId=${traceId}`);
  assert.ok(inTrace.some((line) => line.body.includes("Research completed") && line.severity === "INFO" && line.severityNumber === 9 && line.attributes["saturn.service"]), JSON.stringify(inTrace.map((line) => line.body)));
  assert.deepEqual(await api(runtime, "GET", "/telemetry/logs?minSeverity=23"), []);

  // Plain reads are routine, and looking at telemetry is not itself traced.
  await api(runtime, "GET", "/agents");
  const summaries = await until("the summaries", () => api(runtime, "GET", "/telemetry/traces"), (list) => list.some((item) => item.routine));
  const summary = summaries.find((item) => item.traceId === traceId);
  assert.equal(summary.rootName, "POST /agents/:id/runs");
  assert.ok(summary.spanCount >= 6);
  assert.equal(summary.routine, false);
  assert.equal(summary.errorCount, 0);
  await api(runtime, "GET", "/telemetry/status");
  assert.equal((await api(runtime, "GET", "/telemetry/traces")).length, summaries.length);
  assert.ok(!summaries.some((item) => item.rootName.includes("/telemetry")));

  // A failed request is an error on its trace, under its route.
  assert.equal((await raw(runtime, "GET", "/runs/run_none")).status, 404);
  const failedTrace = await until("the failed request", () => api(runtime, "GET", "/telemetry/traces"), (list) => list.some((item) => item.rootName === "GET /runs/:id" && item.errorCount === 1));
  const failed = failedTrace.find((item) => item.rootName === "GET /runs/:id" && item.errorCount === 1);
  assert.equal(failed.routine, false);
  const [failedSpan] = await api(runtime, "GET", `/telemetry/traces/${failed.traceId}`);
  assert.equal(failedSpan.status, "error");
  assert.equal(failedSpan.statusMessage, "Run not found");
  assert.equal(failedSpan.events[0].name, "exception");
  assert.equal(failedSpan.events[0].attributes["exception.message"], "Run not found");
  assert.equal(failedSpan.attributes["http.response.status_code"], 404);
  assert.equal((await raw(runtime, "GET", "/telemetry/traces/none")).status, 404);

  // The three formats.
  const saved = await raw(runtime, "GET", "/telemetry/export");
  assert.match(saved.headers.get("content-disposition"), /attachment; filename="saturn-telemetry-\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d\.json"/);
  assert.match(saved.headers.get("content-type"), /application\/json; charset=utf-8/i);
  const document = await saved.json();
  assert.equal(document.format, "saturn-telemetry");
  assert.equal(document.version, 1);
  assert.equal(document.service.name, "saturn-runtime");
  assert.ok(document.traces.some((item) => item.traceId === traceId));
  assert.ok(document.metrics.some((item) => item.name === "gen_ai.client.token.usage"));
  assert.deepEqual(JSON.parse(await readFile(path.join(runtime.dataDir, "telemetry.json"), "utf8")).format, "saturn-telemetry");

  const otlp = await raw(runtime, "GET", "/telemetry/export?format=otlp");
  assert.match(otlp.headers.get("content-disposition"), /saturn-telemetry-otlp-.*\.jsonl"/);
  assert.match(otlp.headers.get("content-type"), /application\/x-ndjson/);
  const [traces, logs, metricLines] = (await otlp.text()).trim().split("\n").map((line) => JSON.parse(line));
  const otlpSpans = traces.resourceSpans[0].scopeSpans.flatMap((scope) => scope.spans);
  const otlpRequest = otlpSpans.find((span) => span.name === "POST /agents/:id/runs");
  assert.equal(otlpRequest.kind, 2);
  assert.match(otlpRequest.startTimeUnixNano, /^\d{19}$/);
  assert.deepEqual(otlpRequest.attributes.find((item) => item.key === "http.response.status_code").value, { intValue: "201" });
  assert.equal(logs.resourceLogs[0].scopeLogs[0].logRecords.find((record) => record.body.stringValue.includes("Research completed")).traceId, traceId);
  assert.equal(metricLines.resourceMetrics[0].scopeMetrics[0].metrics.find((item) => item.name === "gen_ai.client.token.usage").histogram.aggregationTemporality, 2);

  const siem = await raw(runtime, "GET", "/telemetry/export?format=siem");
  assert.match(siem.headers.get("content-disposition"), /saturn-telemetry-siem-.*\.ndjson"/);
  const events = (await siem.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event["@timestamp"]), events.map((event) => event["@timestamp"]).sort());
  assert.ok(events.some((event) => event.event.dataset === "saturn.traces" && event.trace.id === traceId));
  assert.ok(events.some((event) => event.event.dataset === "saturn.logs"));
  assert.ok(events.some((event) => event.event.dataset === "saturn.metrics"));

  // Clearing.
  assert.equal((await raw(runtime, "DELETE", "/telemetry")).status, 204);
  const emptied = await api(runtime, "GET", "/telemetry/status");
  assert.equal(emptied.errorTraces, 0);
  assert.equal(JSON.parse(await readFile(path.join(runtime.dataDir, "telemetry.json"), "utf8")).traces.length, 0);
  assert.equal((await raw(runtime, "GET", `/telemetry/traces/${traceId}`)).status, 404);
});

test("telemetry survives a restart, polling alone writes nothing, and a broken file is replaced", async () => {
  const dataDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "saturn-contract-telemetry-data-")));
  const file = path.join(dataDir, "telemetry.json");
  let runtime = await startRuntime({ dataDir, keepData: true });
  try {
    await api(runtime, "GET", "/agents");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await assert.rejects(stat(file), "polling alone writes nothing");
    assert.equal((await raw(runtime, "GET", "/runs/run_none")).status, 404);
    const before = await until("the failed request", () => api(runtime, "GET", "/telemetry/traces"), (list) => list.some((item) => item.rootName === "GET /runs/:id"));
  
    await runtime.stop();
    const stored = JSON.parse(await readFile(file, "utf8"));
    assert.equal(stored.format, "saturn-telemetry");
    assert.ok(stored.traces.some((trace) => trace.spans.some((span) => span.name === "GET /runs/:id")), "saved when the runtime stops");
    assert.ok(!stored.traces.some((trace) => trace.spans.some((span) => span.name === "GET /agents")), "polling is not worth saving");

    runtime = await startRuntime({ dataDir, keepData: true });
    const restored = await api(runtime, "GET", "/telemetry/traces");
    assert.ok(restored.some((item) => item.traceId === before.find((one) => one.rootName === "GET /runs/:id").traceId));
    assert.ok((await api(runtime, "GET", "/telemetry/status")).savedAt);
    await runtime.stop();

    await writeFile(file, "{ not json");
    runtime = await startRuntime({ dataDir, keepData: true });
    assert.equal((await api(runtime, "GET", "/telemetry/status")).savedAt, null);
    assert.equal((await raw(runtime, "GET", "/runs/run_none")).status, 404);
    await until("the save", () => api(runtime, "GET", "/telemetry/export").then((document) => document.format));
    assert.equal(JSON.parse(await readFile(file, "utf8")).format, "saturn-telemetry");
    await runtime.stop();
    runtime = undefined;
  } finally {
    await runtime?.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("turned off, nothing is recorded or saved", async () => {
  const runtime = await start({ env: { OTEL_SDK_DISABLED: "true" } });
  const status = await api(runtime, "GET", "/telemetry/status");
  assert.equal(status.mode, "disabled");
  assert.equal(status.file, null);
  await api(runtime, "GET", "/agents");
  assert.equal((await raw(runtime, "GET", "/runs/run_none")).status, 404);
  assert.deepEqual(await api(runtime, "GET", "/telemetry/traces"), []);
  assert.deepEqual(await api(runtime, "GET", "/telemetry/metrics"), []);
  const exported = await api(runtime, "GET", "/telemetry/export");
  assert.deepEqual(exported.traces, []);
  await assert.rejects(stat(path.join(runtime.dataDir, "telemetry.json")));
});

test("with an endpoint set, telemetry goes to the collector, with its headers", async () => {
  const collector = await listen((_raw, response) => {
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const runtime = await start({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: collector.url, OTEL_EXPORTER_OTLP_HEADERS: "x-collector-key=made-up-value", OTEL_BSP_SCHEDULE_DELAY: "100", OTEL_BLRP_SCHEDULE_DELAY: "100", OTEL_METRIC_EXPORT_INTERVAL: "200", OTEL_SERVICE_NAME: "my-saturn" } });
  const status = await api(runtime, "GET", "/telemetry/status");
  assert.equal(status.mode, "otlp");
  assert.equal(status.serviceName, "my-saturn");
  assert.equal(status.endpoint, collector.url);
  assert.equal((await raw(runtime, "GET", "/runs/run_none")).status, 404);
  const paths = () => new Set(collector.seen.map((request) => request.url));
  await until("traces and metrics at the collector", paths, (seen) => seen.has("/v1/traces") && seen.has("/v1/metrics") && seen.has("/v1/logs"));
  for (const request of collector.seen) {
    assert.equal(request.method, "POST");
    assert.equal(request.headers["x-collector-key"], "made-up-value");
  }
  // OTLP over HTTP, in its JSON form.
  {
    const sent = collector.seen.find((request) => request.url === "/v1/traces");
    assert.match(sent.headers["content-type"], /application\/json/);
    const body = JSON.parse(sent.raw);
    // A request's span may come in a later batch than the first.
    const spans = () => collector.seen.filter((request) => request.url === "/v1/traces").flatMap((request) => JSON.parse(request.raw).resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)));
    await until("the request's span", spans, (found) => found.some((span) => span.name === "GET /runs/:id"));
    assert.equal(body.resourceSpans[0].resource.attributes.find((item) => item.key === "service.name").value.stringValue, "my-saturn");
  }
  assert.ok(!(await readFile(path.join(runtime.dataDir, "network.log"), "utf8")).includes("made-up-value"));
});

test("every request the runtime sends is on record, by host, without its query", async () => {
  const runtime = await start();
  const empty = await api(runtime, "GET", "/network");
  assert.equal(empty.file, path.join(runtime.dataDir, "network.log"));
  assert.match(empty.since, /^\d{4}-/);
  assert.ok(Array.isArray(empty.hosts));
  assert.ok(Array.isArray(empty.recent));

  const { model, mcp, agent } = await scripted(runtime);
  const started = await api(runtime, "POST", `/agents/${agent.id}/runs`, { input: "go" });
  await finished(runtime, started.id);

  const view = await until("the requests", () => api(runtime, "GET", "/network"), (seen) => seen.hosts.some((host) => host.host === `127.0.0.1:${model.port}` && host.requests >= 2) && seen.hosts.some((host) => host.host === `127.0.0.1:${mcp.port}`));
  const host = view.hosts.find((item) => item.host === `127.0.0.1:${model.port}`);
  assert.equal(host.local, true);
  assert.ok(host.methods.includes("POST"));
  assert.ok(host.first <= host.last);
  assert.equal(view.hosts.toSorted((a, b) => b.last.localeCompare(a.last))[0].last, view.hosts[0].last, "the latest used first");
  const entry = view.recent.find((item) => item.host === `127.0.0.1:${model.port}`);
  assert.equal(entry.method, "POST");
  assert.match(entry.path, /chat\/completions$/);
  assert.equal(entry.local, true);
  assert.match(entry.at, /^\d{4}-\d\d-\d\dT/);
  assert.ok(view.recent[0].at >= view.recent.at(-1).at, "the newest first");
  assert.equal((await api(runtime, "GET", "/network?limit=1")).recent.length, 1);

  // Files for `tail -f`, for this user alone; no query strings, which some APIs put keys in.
  const file = path.join(runtime.dataDir, "network.log");
  const text = await until("the log", () => readFile(file, "utf8").catch(() => ""), (content) => content.includes("chat/completions"));
  assert.ok(!text.includes("SECRET"));
  assert.ok(!JSON.stringify(view).includes("SECRET"));
  const line = JSON.parse(text.trim().split("\n")[0]);
  assert.deepEqual(Object.keys(line).sort(), ["at", "host", "local", "method", "path"]);
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
});
