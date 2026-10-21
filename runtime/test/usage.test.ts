import { useRuntimeAuth } from "./runtime-token.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { describePrice, priceCall } from "../src/domain/llm/pricing.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

const call = (provider: string, model: string, at: string, inputTokens = 1_000_000, outputTokens = 1_000_000, hosted = true) =>
  priceCall({ provider, model, hosted, at: new Date(at), inputTokens, outputTokens });

test("official prices follow dates, prompt size and peak hours", () => {
  // Gemini 4 Argon doubles on 2026-12-01.
  assert.equal(call("gemini", "gemini-4-argon", "2026-11-30T23:59:00Z")?.costUsd, 12);
  assert.equal(call("gemini", "gemini-4-argon", "2026-12-01T00:00:00Z")?.costUsd, 24);
  // OpenAI long context starts above 272K input tokens.
  assert.equal(call("openai", "gpt-6.1-sol", "2026-10-18T00:00:00Z", 272_000, 0)?.inputRate, 2);
  const long = call("openai", "gpt-6.1-sol", "2026-10-18T00:00:00Z", 272_001, 0);
  assert.equal(long?.inputRate, 4);
  assert.equal(long?.tier, "long context");
  // DeepSeek: Monday 02:00 UTC is peak, Saturday is off-peak.
  assert.equal(call("deepseek", "deepseek-flash", "2026-10-19T02:00:00Z")?.tier, "peak");
  assert.equal(call("deepseek", "deepseek-flash", "2026-10-19T02:00:00Z")?.costUsd, 1.5);
  assert.equal(call("deepseek", "deepseek-flash", "2026-10-17T02:00:00Z")?.costUsd, 0.75);
  assert.equal(call("claude", "claude-opus-5-5", "2026-10-18T00:00:00Z", 1000, 1000)?.costUsd, 0.024);
  // Local is free; unknown models and custom endpoints are unpriced, never guessed.
  assert.equal(call("lmstudio", "qwen", "2026-10-18T00:00:00Z")?.costUsd, 0);
  assert.equal(call("gemini", "gemini-3.7-flash", "2026-10-18T00:00:00Z"), null);
  assert.equal(call("openai", "gpt-6-luna", "2026-10-18T00:00:00Z", 1, 1, false), null);
  assert.match(describePrice("gemini", "gemini-4-argon", new Date("2026-10-18T00:00:00Z")) ?? "", /\$2\.00 in \/ \$10\.00 out .* from 2026-12-01/);
});

test("usage is filed per call under the agent and the model that actually ran", async () => {
  const servers = await Promise.all([10, 100].map(async (scale) => {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: scale, completion_tokens: scale / 10 } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    return { server, url: `http://127.0.0.1:${address.port}` };
  }));
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-app-"));
  const store = new FileStore(directory);
  await store.load();
  const { services } = createApp(store);
  try {
    const small = await services.createModel({ name: "Small", provider: "openai", model: "small-local", baseUrl: servers[0]!.url });
    const large = await services.createModel({ name: "Large", provider: "openai", model: "large-local", baseUrl: servers[1]!.url });
    const agent = await services.createAgent({ name: "Writer", modelConnectionId: small.id });
    const finish = async () => {
      for (let i = 0; i < 80 && store.state.runs.some((run) => run.status === "running"); i += 1) await new Promise((r) => setTimeout(r, 20));
    };
    await services.startRun(agent.id, "first");
    await finish();
    // The user switches the agent to another model; the earlier call must stay on the first one.
    await services.updateAgent(agent.id, { modelConnectionId: large.id });
    await services.startRun(agent.id, "second");
    await finish();

    const records = services.usage();
    const smallCalls = records.filter((item) => item.model === "small-local").length;
    const largeCalls = records.filter((item) => item.model === "large-local").length;
    assert.ok(smallCalls > 0 && largeCalls > 0);
    // Calls made before the switch stay on the first model.
    const switched = records.filter((item) => item.model === "large-local").map((item) => item.createdAt);
    assert.ok(records.filter((item) => item.model === "small-local").every((item) => switched.every((at) => item.createdAt <= at)));
    assert.ok(records.every((item) => item.agentName === "Writer" && item.purpose === "run" && item.runId));
    assert.ok(records.every((item) => item.costUsd === null && item.pricing === "unpriced"), "custom endpoints are not billed at list price");

    const summary = services.usageSummary();
    assert.equal(summary.totals.inputTokens, 100 * largeCalls + 10 * smallCalls);
    assert.equal(summary.totals.outputTokens, 10 * largeCalls + smallCalls);
    assert.equal(summary.totals.unpricedCalls, records.length);
    assert.deepEqual(summary.models.map((item) => [item.model, item.inputTokens]), [["large-local", 100 * largeCalls], ["small-local", 10 * smallCalls]]);
    const writer = summary.agents.find((item) => item.agentId === agent.id);
    assert.deepEqual(writer?.models.map((item) => [item.label, item.inputTokens]), [["Large", 100 * largeCalls], ["Small", 10 * smallCalls]]);

    // Deleting the agent keeps its spend, under the name it had.
    await services.deleteAgent(agent.id);
    const after = services.usageSummary().agents.find((item) => item.agentId === agent.id);
    assert.equal(after?.name, "Writer");
    assert.equal(after?.exists, false);
  } finally {
    for (const { server } of servers) server.close();
  }
});

test("records from before costs were stored are priced at the time they were made", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-app-"));
  const store = new FileStore(directory);
  await store.load();
  const { services } = createApp(store);
  await store.update((state) => {
    state.usage.push(
      { id: "u1", runId: "r1", agentId: "gone", modelId: "m1", provider: "gemini", model: "gemini-4-argon", inputTokens: 1_000_000, outputTokens: 0, createdAt: "2026-11-01T00:00:00Z" },
      { id: "u2", runId: "r2", agentId: "gone", modelId: "m1", provider: "gemini", model: "gemini-4-argon", inputTokens: 1_000_000, outputTokens: 0, createdAt: "2026-12-02T00:00:00Z" },
    );
  });
  const summary = services.usageSummary();
  assert.equal(summary.totals.costUsd, 6);
  assert.equal(summary.models[0]?.label, "Gemini 4 Argon");
  assert.equal(summary.agents[0]?.name, "Deleted agent");
  assert.equal(summary.since, "2026-11-01T00:00:00Z");
});

test("the summary can be limited to a time window, and a bad window is refused", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-app-"));
  const store = new FileStore(directory);
  await store.load();
  const { app, services } = createApp(store);
  const call = (id: string, createdAt: string) => ({ id, runId: id, agentId: "a", modelId: "m", provider: "lmstudio", model: "local", inputTokens: 10, outputTokens: 1, costUsd: 1, createdAt });
  await store.update((state) => {
    state.usage.push(call("u1", "2026-10-05T12:00:00Z"), call("u2", "2026-10-12T00:00:00Z"), call("u3", "2026-10-19T23:59:59Z"), call("u4", "2026-10-20T00:00:00Z"));
  });
  assert.equal(services.usageSummary().totals.calls, 4, "no window: everything");
  const week = services.usageSummary({ from: "2026-10-12T00:00:00Z", to: "2026-10-20T00:00:00Z" });
  assert.equal(week.totals.calls, 2, "from is inclusive, to is exclusive");
  assert.equal(week.totals.costUsd, 2);
  assert.equal(week.since, "2026-10-12T00:00:00Z");
  assert.deepEqual(week.range, { from: "2026-10-12T00:00:00.000Z", to: "2026-10-20T00:00:00.000Z" });
  assert.equal(services.usageSummary({ from: "2026-10-19T00:00:00Z" }).totals.calls, 2, "an open end");
  assert.equal(services.usageSummary({ to: "2026-10-01T00:00:00Z" }).totals.calls, 0);
  assert.throws(() => services.usageSummary({ from: "nope" }), /from must be a date/);
  assert.throws(() => services.usageSummary({ from: "2026-10-20", to: "2026-10-01" }), /end after it starts/);

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const base = `http://127.0.0.1:${address.port}`;
    useRuntimeAuth(base);
    const response = await fetch(`${base}/usage/summary?from=${encodeURIComponent("2026-10-12T00:00:00Z")}&to=${encodeURIComponent("2026-10-20T00:00:00Z")}`);
    assert.equal(((await response.json()) as { totals: { calls: number } }).totals.calls, 2);
    assert.equal((await fetch(`${base}/usage/summary?from=garbage`)).status, 400);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test("a plain reply finishes the run with one model call, and restarts fail stuck runs", async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-app-"));
  const store = new FileStore(directory);
  await store.load();
  const { services } = createApp(store);
  try {
    const model = await services.createModel({ name: "Local", provider: "openai", model: "m", baseUrl: `http://127.0.0.1:${address.port}` });
    const agent = await services.createAgent({ name: "Chat", modelConnectionId: model.id });
    const run = await services.startRun(agent.id, "hi");
    for (let i = 0; i < 80 && store.state.runs[0]?.status === "running"; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.state.runs[0]?.status, "completed");
    assert.equal(store.state.runs[0]?.output, "hello");
    assert.equal(calls, 1);
    assert.equal(services.usage().length, 1);

    // Simulate a restart that cut off a run mid-flight.
    await store.update((state) => {
      state.runs[0]!.status = "running";
    });
    const next = new FileStore(directory);
    await next.load();
    const restarted = createApp(next).services;
    assert.equal(await restarted.kernel.runs.recoverInterrupted(), 1);
    const recovered = next.state.runs.find((item) => item.id === run.id);
    assert.equal(recovered?.status, "failed");
    assert.match(recovered?.error ?? "", /Interrupted when the runtime restarted/);
    assert.equal(await restarted.kernel.runs.recoverInterrupted(), 0);
  } finally {
    server.close();
  }
});

test("a turn that recovers from a failed tool call and answers is completed; one that ends without an answer failed", async () => {
  // Each scenario: the model first reads a file that does not exist (the tool fails), then says what it says.
  for (const [final, expected] of [["The file is missing, so I created it instead.", "completed"], ["", "failed"]] as const) {
    let calls = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        calls += 1;
        res.setHeader("content-type", "application/json");
        const message = calls === 1
          ? { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "files", arguments: JSON.stringify({ action: "read", path: "missing.txt" }) } }] }
          : { content: final };
        res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-app-")));
    await store.load();
    const { services } = createApp(store);
    try {
      const model = await services.createModel({ name: "Local", provider: "openai", model: "m", baseUrl: `http://127.0.0.1:${address.port}` });
      const agent = await services.createAgent({ name: "Chat", modelConnectionId: model.id, autonomy: "auto" });
      await services.startRun(agent.id, "read missing.txt");
      for (let i = 0; i < 150 && store.state.runs[0]?.status === "running"; i += 1) await new Promise((r) => setTimeout(r, 20));
      const run = store.state.runs[0]!;
      assert.equal(run.actions[0]?.status, "failed", "the tool call itself failed");
      assert.equal(run.status, expected, `final reply ${JSON.stringify(final)}`);
    } finally {
      server.close();
    }
  }
});
