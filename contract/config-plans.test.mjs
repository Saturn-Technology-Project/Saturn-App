// Models on the user's own plan (Claude Code, Codex) and what automations may do with them, a saved key serving its
// provider, and automations outside the regular calls, whichever language runs them. No real provider is ever reached.
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { open } from "./config-harness.mjs";

let saturn;

before(async () => {
  saturn = await open();
});
after(async () => {
  await saturn?.close();
});

/** A server that counts what reaches it and answers like a model. */
async function counter(target, reply = "hello") {
  const seen = [];
  const url = await target.serve((_request, raw, response) => {
    seen.push(raw);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "r", object: "chat.completion", model: "s", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: reply } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  return { seen, url };
}

const POLICY = /violation of Anthropic's policy/;

test("a Claude (via Claude Code) or Codex model never sends an API request, whatever asks it to", async () => {
  const fresh = await open();
  try {
    const api = await counter(fresh);
    for (const [provider, name] of [["claude-code", "claude-sonnet-5-5"], ["codex", "gpt-5.5"]]) {
      const model = await fresh.api("POST", "/connections/models", { provider, model: name, baseUrl: api.url });
      const agent = await fresh.api("POST", "/agents", { name: `On ${provider}`, modelConnectionId: model.id });
      await fresh.refused("POST", "/automations/draft", { text: "every morning summarize", agentId: agent.id }, 409, /needs a model with an API key/);
    }
    assert.deepEqual(api.seen, [], "no request left Saturn");
  } finally {
    await fresh.close();
  }
});

test("plan models take no API key, and the provider is named Claude (via Claude Code)", async () => {
  for (const [provider, name] of [["claude-code", "claude-sonnet-5-5"], ["codex", "gpt-5.5"]]) {
    await saturn.refused("POST", "/connections/models", { provider, model: name, secret: "contract-value" }, 400, /takes no API key/);
    const model = await saturn.api("POST", "/connections/models", { provider, model: name });
    assert.equal(model.hasSecret, false);
    await saturn.refused("PATCH", `/connections/models/${model.id}`, { secret: "contract-value" }, 400, /takes no API key/);
    await saturn.api("DELETE", `/connections/models/${model.id}`);
  }
  const providers = await saturn.api("GET", "/llm/providers");
  assert.equal(providers.find((item) => item.id === "claude-code").label, "Claude (via Claude Code)");
});

test("automations refuse agents on Claude (via Claude Code), when saved and again before every run", async () => {
  const api = await counter(saturn, "report");
  const plan = await saturn.api("POST", "/connections/models", { provider: "claude-code", model: "claude-sonnet-5-5" });
  const keyed = await saturn.api("POST", "/connections/models", { name: "API", provider: "openai", model: "m", baseUrl: api.url, secret: "contract-value" });
  const planAgent = await saturn.api("POST", "/agents", { name: "Plan agent", modelConnectionId: plan.id });
  const apiAgent = await saturn.api("POST", "/agents", { name: "API agent", modelConnectionId: keyed.id });
  const trigger = { frequency: "daily", time: "09:00", weekday: 1 };

  await saturn.refused("POST", "/automations", { name: "Report", prompt: "Summarize", agentId: planAgent.id, trigger, timeZone: "UTC" }, 409, POLICY);
  const automation = await saturn.api("POST", "/automations", { name: "Report", prompt: "Summarize", agentId: apiAgent.id, trigger, timeZone: "UTC" });
  await saturn.refused("PATCH", `/automations/${automation.id}`, { agentId: planAgent.id }, 409, POLICY);
  assert.equal((await saturn.api("GET", "/automations")).find((item) => item.id === automation.id).agentId, apiAgent.id, "a refused change leaves it as it was");

  // The agent's model is switched to the subscription afterwards: the automation does not run on it.
  await saturn.api("PATCH", `/agents/${apiAgent.id}`, { modelConnectionId: plan.id });
  const ran = await saturn.api("POST", `/automations/${automation.id}/run`);
  assert.match(ran.lastError, POLICY);
  assert.deepEqual(await saturn.api("GET", `/agents/${apiAgent.id}/messages`), [], "no run was started");
  assert.deepEqual(api.seen, []);
  await saturn.api("DELETE", `/automations/${automation.id}`);
});

test("an agent on Codex's plan can be scheduled, since only Claude's terms forbid it", async () => {
  const plan = await saturn.api("POST", "/connections/models", { provider: "codex", model: "gpt-5.5" });
  const agent = await saturn.api("POST", "/agents", { name: "Codex agent", modelConnectionId: plan.id });
  const made = await saturn.api("POST", "/automations", { name: "Codex", prompt: "x", agentId: agent.id });
  assert.equal(made.agentId, agent.id);
  await saturn.api("DELETE", `/automations/${made.id}`);
});

test("drafting an automation uses an API model, never the agent's subscription model", async () => {
  const fresh = await open();
  try {
    const api = await counter(fresh, JSON.stringify({ name: "Daily summary", prompt: "Summarize yesterday", frequency: "daily", time: "09:00" }));
    const plan = await fresh.api("POST", "/connections/models", { provider: "claude-code", model: "claude-sonnet-5-5" });
    const agent = await fresh.api("POST", "/agents", { name: "Plan agent", modelConnectionId: plan.id });
    await fresh.refused("POST", "/automations/draft", { text: "every morning summarize", agentId: agent.id }, 409, /needs a model with an API key/);
    await fresh.api("POST", "/connections/models", { name: "API", provider: "openai", model: "m", baseUrl: api.url, secret: "contract-value" });
    const draft = await fresh.api("POST", "/automations/draft", { text: "every morning summarize", agentId: agent.id });
    assert.equal(draft.name, "Daily summary");
    assert.equal(api.seen.length, 1, "the draft went to the API model");
  } finally {
    await fresh.close();
  }
});

test("a provider's saved API key serves its other models, and a model without one says so before any request", async () => {
  const first = await saturn.api("POST", "/connections/models", { provider: "gemini", model: "gemini-flash", secret: "contract-gemini-value" });
  assert.equal(first.hasSecret, true);
  const second = await saturn.api("POST", "/connections/models", { provider: "gemini", model: "gemini-pro" });
  assert.equal(second.hasSecret, true);

  const keyless = await saturn.api("POST", "/connections/models", { provider: "claude", model: "claude-sonnet-5-5" });
  assert.equal(keyless.hasSecret, false);
  const agent = await saturn.api("POST", "/agents", { name: "Writer", modelConnectionId: keyless.id });
  await saturn.refused("POST", `/agents/${agent.id}/runs`, { input: "hi" }, 409, /no Claude API key/);

  assert.equal((await saturn.api("PATCH", `/connections/models/${keyless.id}`, { secret: "contract-claude-value" })).hasSecret, true);
  const listed = await saturn.api("GET", "/connections/models");
  assert.ok(listed.filter((item) => ["gemini", "claude"].includes(item.provider)).every((item) => item.hasSecret));
  assert.doesNotMatch(JSON.stringify(listed), /contract-gemini-value|contract-claude-value/);
});

test("a run an automation cannot start notes why; removing the agent removes its automations", async () => {
  const agent = await saturn.api("POST", "/agents", { name: "Reporter" });
  const made = await saturn.api("POST", "/automations", { name: "Morning report", agentId: agent.id, prompt: "Summarize", trigger: { frequency: "daily", time: "09:00", weekday: 1 }, timeZone: "Asia/Taipei" });
  const ran = await saturn.api("POST", `/automations/${made.id}/run`);
  assert.ok(ran.lastRunAt);
  assert.equal(ran.lastError, "Agent has no model connection");
  assert.equal((await saturn.api("GET", "/automations")).find((item) => item.id === made.id).lastError, "Agent has no model connection", "kept for the list");
  await saturn.api("DELETE", `/agents/${agent.id}`);
  assert.ok(!(await saturn.api("GET", "/automations")).some((item) => item.id === made.id));
});

test("a slot missed while the runtime was off runs once when it returns, and not again", async () => {
  const fresh = await open();
  try {
    const scripted = await fresh.model({ answer: () => "the report" });
    const agent = await fresh.api("POST", "/agents", { name: "Scheduled", modelConnectionId: scripted.connection.id, autonomy: "bypass" });
    const made = await fresh.api("POST", "/automations", { name: "Daily", agentId: agent.id, prompt: "write the report", trigger: { frequency: "daily", time: "09:00", weekday: 1 }, timeZone: "UTC" });
    assert.equal(made.lastRunAt ?? null, null, "made today, it waits for its next slot");

    await fresh.restart((state) => { state.automations[0].lastSlot = 0; });
    const fired = await fresh.until("the missed slot to run", () => fresh.api("GET", "/automations"), ([item]) => item.lastRunId);
    const run = await fresh.finished(fired[0].lastRunId);
    assert.equal(run.output, "the report");
    const runs = () => fresh.api("GET", `/agents/${agent.id}/messages`);
    assert.equal((await runs()).length, 1, "only the latest missed slot");

    await fresh.restart();
    await fresh.stays("the same slot not running again", runs, (list) => list.length === 1, 800);
  } finally {
    await fresh.close();
  }
});

test("polling reads do not rewrite the state file, and a state missing the built-ins is repaired at the next start", async () => {
  const fresh = await open();
  try {
    const file = path.join(fresh.dataDir, "state.json");
    const agent = await fresh.api("POST", "/agents", { name: "Reader" });
    assert.ok(agent.mcpConnectionIds.includes("general-skills"));
    // Whatever settling a new agent still writes is done before the reads below.
    const written = async () => { const info = await stat(file); return `${info.mtimeMs} ${info.size} ${await readFile(file, "utf8")}`; };
    await fresh.api("GET", "/agents");
    await fresh.api("GET", "/connections/mcp");
    const first = await written();
    await fresh.stays("reads leaving the state file alone", async () => {
      await fresh.api("GET", "/agents");
      await fresh.api("GET", "/connections/mcp");
      return await written();
    }, (now) => now === first, 500);

    await fresh.restart((state) => { state.agents.find((item) => item.id === agent.id).mcpConnectionIds = []; });
    const repaired = (await fresh.api("GET", "/agents")).find((item) => item.id === agent.id);
    assert.ok(repaired.mcpConnectionIds.includes("general-skills"), JSON.stringify(repaired.mcpConnectionIds));
  } finally {
    await fresh.close();
  }
});
