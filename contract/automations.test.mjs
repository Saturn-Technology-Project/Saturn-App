// Scheduled prompts, whichever language runs them, with a scripted model.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { startRuntime } from "./runtime.mjs";

let runtime;
const servers = [];

before(async () => {
  runtime = await startRuntime();
});
after(async () => {
  await runtime?.stop();
  await Promise.all(servers.map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
});

async function api(method, route, body, expected = [200, 201, 204]) {
  const token = (await readFile(path.join(runtime.dataDir, "runtime-token"), "utf8")).trim();
  const response = await fetch(`${runtime.origin}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.ok(expected.includes(response.status), `${method} ${route}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

/** A model answering with `reply(request)`; every request is kept. */
async function model(reply) {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "r", object: "chat.completion", model: "s", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: reply(body, requests.length) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const connection = await api("POST", "/connections/models", { name: "Scripted", provider: "openai", model: "s", baseUrl: `http://127.0.0.1:${server.address().port}` });
  return { requests, connection };
}

const agentOn = (connection, name, extra = {}) => api("POST", "/agents", { name, modelConnectionId: connection.id, autonomy: "bypass", ...extra });

async function until(what, read, done) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`never happened: ${what}`);
}

test("an automation checks what it is given, and shows when it runs next", async () => {
  const { connection } = await model(() => "ok");
  const agent = await agentOn(connection, "Scheduled");
  const valid = { name: "Daily", agentId: agent.id, prompt: "report", trigger: { frequency: "daily", time: "09:30" }, timeZone: "Asia/Taipei" };
  await api("POST", "/automations", { ...valid, name: " " }, [400]);
  await api("POST", "/automations", { ...valid, prompt: "" }, [400]);
  await api("POST", "/automations", { ...valid, agentId: "nobody" }, [404]);
  await api("POST", "/automations", { ...valid, timeZone: "Mars/Olympus" }, [400]);
  const made = await api("POST", "/automations", valid);
  assert.equal(made.agentName, "Scheduled");
  assert.equal(made.enabled, true);
  assert.deepEqual(made.trigger, { frequency: "daily", time: "09:30", weekday: 1 });
  assert.match(made.nextRun, /^\d{4}-\d\d-\d\d 09:30$/);
  const paused = await api("PATCH", `/automations/${made.id}`, { enabled: false });
  assert.equal(paused.nextRun, null);
  const weekly = await api("PATCH", `/automations/${made.id}`, { enabled: true, trigger: { frequency: "weekly", weekday: 3 } });
  assert.deepEqual(weekly.trigger, { frequency: "weekly", time: "09:30", weekday: 3 }, "what is not given stays");
  assert.ok((await api("GET", "/automations")).some((item) => item.id === made.id));
  await api("DELETE", `/automations/${made.id}`);
  await api("PATCH", `/automations/${made.id}`, { enabled: false }, [404]);
});

test("running an automation now starts a run and notes it", async () => {
  const { connection, requests } = await model(() => "the report");
  const agent = await agentOn(connection, "Runner");
  const made = await api("POST", "/automations", { name: "Now", agentId: agent.id, prompt: "write the report" });
  const ran = await api("POST", `/automations/${made.id}/run`);
  assert.ok(ran.lastRunId);
  assert.ok(ran.lastRunAt);
  const run = await until("the run", () => api("GET", `/runs/${ran.lastRunId}`), (item) => item.status === "completed");
  assert.equal(run.output, "the report");
  assert.match(JSON.stringify(requests[0].messages), /write the report/);
});

test("an agent on a Claude subscription cannot be scheduled", async () => {
  const connection = await api("POST", "/connections/models", { provider: "claude-code", model: "claude-opus-5-5" });
  assert.match(connection.name, /via Claude Code/);
  const agent = await api("POST", "/agents", { name: "Plan", modelConnectionId: connection.id });
  await api("POST", "/automations", { name: "No", agentId: agent.id, prompt: "x" }, [409]);
});

test("a draft comes from the model; an unusable answer is refused", async () => {
  const { connection } = await model((_body, count) => (count === 1 ? 'Sure:\n{"name":"Standup","prompt":"Summarize","frequency":"weekdays","time":"08:15"}' : "no json here"));
  const agent = await agentOn(connection, "Drafter");
  await api("POST", "/automations/draft", { text: " " }, [400]);
  assert.deepEqual(await api("POST", "/automations/draft", { text: "every weekday", agentId: agent.id }), { name: "Standup", prompt: "Summarize", trigger: { frequency: "weekdays", time: "08:15", weekday: 1 } });
  await api("POST", "/automations/draft", { text: "again", agentId: agent.id }, [502]);
});
