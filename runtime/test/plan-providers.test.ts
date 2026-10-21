import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

/** A fake OpenAI-compatible server that counts requests and answers with `reply`. */
async function fakeApi(reply: string) {
  let requests = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { url: `http://127.0.0.1:${address.port}`, requests: () => requests, close: () => server.close() };
}

async function setup() {
  const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-plan-")));
  await store.load();
  return { store, ...createApp(store) };
}

test("a Claude (via Claude Code) or Codex model never sends an API request, whatever asks it to", async () => {
  const api = await fakeApi("hello");
  const { services } = await setup();
  try {
    for (const provider of ["claude-code", "codex"]) {
      const model = await services.createModel({ provider, model: provider === "codex" ? "gpt-5.5" : "claude-sonnet-5-5" });
      // Point it at a server that counts requests, as if a code path tried to call it like an API model.
      const pointed = { ...model, baseUrl: api.url };
      await assert.rejects(services.kernel.llm.complete(pointed, { context: { agentId: "a", agentName: "A", purpose: "memory" }, messages: [{ role: "user", content: "hi" }] }), /never sends API requests/);
      assert.throws(() => services.kernel.llm.adapterFor(pointed), /never sends API requests/);
    }
    assert.equal(api.requests(), 0, "no request left Saturn");
  } finally {
    api.close();
  }
});

test("plan models take no API key, and the provider is named Claude (via Claude Code)", async () => {
  const { services } = await setup();
  await assert.rejects(services.createModel({ provider: "claude-code", model: "claude-sonnet-5-5", secret: "sk-ant-xyz" }), /takes no API key/);
  const model = await services.createModel({ provider: "claude-code", model: "claude-sonnet-5-5" });
  await assert.rejects(services.updateModel(model.id, { secret: "sk-ant-xyz" }), /takes no API key/);
  const provider = services.kernel.catalog.llmProviders().find((item) => item.id === "claude-code");
  assert.equal(provider?.label, "Claude (via Claude Code)");
});

test("automations refuse agents on Claude (via Claude Code), when saved and again before every run", async () => {
  const api = await fakeApi("ok");
  const { store, services } = await setup();
  try {
    const plan = await services.createModel({ provider: "claude-code", model: "claude-sonnet-5-5" });
    const keyed = await services.createModel({ name: "API", provider: "openai", model: "m", baseUrl: api.url, secret: "k" });
    const planAgent = await services.createAgent({ name: "Plan agent", modelConnectionId: plan.id });
    const apiAgent = await services.createAgent({ name: "API agent", modelConnectionId: keyed.id });
    const trigger = { frequency: "daily" as const, time: "09:00", weekday: 1 };

    await assert.rejects(services.createAutomation({ name: "Report", prompt: "Summarize", agentId: planAgent.id, trigger, timeZone: "UTC" }), /violation of Anthropic's policy/);
    const automation = await services.createAutomation({ name: "Report", prompt: "Summarize", agentId: apiAgent.id, trigger, timeZone: "UTC" });
    await assert.rejects(services.updateAutomation(automation.id, { agentId: planAgent.id }), /violation of Anthropic's policy/);

    // The agent's model is switched to the subscription afterwards: the automation does not run on it.
    await store.update((state) => {
      state.agents.find((item) => item.id === apiAgent.id)!.modelConnectionId = plan.id;
    });
    const runsBefore = store.state.runs.length;
    const after = await services.runAutomation(automation.id);
    assert.match(after.lastError ?? "", /violation of Anthropic's policy/);
    assert.equal(store.state.runs.length, runsBefore, "no run was started");
  } finally {
    api.close();
  }
});

test("drafting an automation uses an API model, never the agent's subscription model", async () => {
  const api = await fakeApi(JSON.stringify({ name: "Daily summary", prompt: "Summarize yesterday", trigger: { frequency: "daily", time: "09:00" } }));
  const { services } = await setup();
  try {
    const plan = await services.createModel({ provider: "claude-code", model: "claude-sonnet-5-5" });
    const agent = await services.createAgent({ name: "Plan agent", modelConnectionId: plan.id });
    await assert.rejects(services.draftAutomation({ text: "every morning summarize", agentId: agent.id }), /needs a model with an API key/);

    await services.createModel({ name: "API", provider: "openai", model: "m", baseUrl: api.url, secret: "k" });
    const draft = await services.draftAutomation({ text: "every morning summarize", agentId: agent.id });
    assert.equal(draft.name, "Daily summary");
    assert.equal(api.requests(), 1, "the draft went to the API model");
  } finally {
    api.close();
  }
});
