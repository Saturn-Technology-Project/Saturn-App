// What a run does for the people watching it, whichever language runs it: long waits, editing a message, chats, images, Ask
// mode, sub-agents, approvals, usage and the live event streams. Driven over HTTP with a fake model; a few tests write
// state.json between two runs of a runtime, to put it in a state that would otherwise take hours or weeks to reach.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startRuntime } from "./runtime.mjs";

// A 1×1 transparent PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

let scratch;
let desktop;
let runtime;
let folder;
const models = [];

/** A runtime whose desktop programs are an empty folder, so nothing here can reach the real screen. */
const fresh = (options = {}) => startRuntime({ ...options, env: { SATURN_DESKTOP_BIN: desktop, ...options.env } });

before(async () => {
  scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "saturn-contract-runs-")));
  desktop = path.join(scratch, "no-desktop-programs");
  folder = path.join(scratch, "project");
  await mkdir(desktop);
  await mkdir(folder);
  runtime = await fresh();
});
after(async () => {
  await Promise.all(models.map((model) => model.stop()));
  await runtime?.stop();
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** One tool call in a model turn. */
const call = (name, args, id = `call_${name}`) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

/**
 * A fake OpenAI-compatible model. A request with tools (a turn of a run) takes the next of `steps`, or asks `answer` when
 * that is a function, and gets "done" when there is nothing left. Steps are text, a list of tool calls, { status, body } for
 * an error, or { content, calls, thinking }. A request without tools is background work (a title, memory) and takes nothing.
 */
async function fakeModel({ steps = [], answer, usage = { prompt_tokens: 10, completion_tokens: 2 } } = {}) {
  const requests = [];
  const authorizations = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw || "{}");
      requests.push(body);
      authorizations.push(request.headers.authorization);
      const step = !body.tools?.length ? "background" : answer ? answer(body) : steps.shift();
      if (step?.status) {
        response.writeHead(step.status, { "content-type": "application/json" }).end(JSON.stringify(step.body ?? { error: { message: "refused" } }));
        return;
      }
      const shaped = Array.isArray(step) ? { calls: step } : typeof step === "string" ? { content: step } : step ?? { content: "done" };
      const message = { role: "assistant", content: shaped.content ?? "", ...(shaped.thinking ? { thinking: shaped.thinking } : {}), ...(shaped.calls ? { tool_calls: shaped.calls } : {}) };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        id: "reply",
        object: "chat.completion",
        model: "fake",
        choices: [{ index: 0, finish_reason: shaped.calls ? "tool_calls" : "stop", message }],
        usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const model = {
    steps,
    requests,
    authorizations,
    /** The requests that were turns of a run, leaving out background work. */
    turns: () => requests.filter((body) => body.tools?.length),
    url: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
  models.push(model);
  return model;
}

/** An API call with the token: the status and the parsed answer, whatever they are. */
async function raw(target, method, route, body) {
  const token = (await readFile(path.join(target.dataDir, "runtime-token"), "utf8")).trim();
  const response = await fetch(`${target.origin}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // A page, not JSON: kept as text.
  }
  return { status: response.status, body: parsed };
}

/** An API call that must succeed. */
async function api(target, method, route, body) {
  const answer = await raw(target, method, route, body);
  assert.ok(answer.status < 300, `${method} ${route}: ${answer.status} ${JSON.stringify(answer.body)}`);
  return answer.body;
}

/** Polls `read` until `done` holds its value, and answers the value. */
async function until(what, read, done, ms = 30_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen: ${JSON.stringify(value)?.slice(0, 2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const getRun = (id, target = runtime) => api(target, "GET", `/runs/${id}`);
const finished = (run) => !["queued", "running", "waiting_approval", "sleeping"].includes(run.status);
const untilFinished = (id, target = runtime) => until("the end of the run", () => getRun(id, target), finished);
const untilStatus = (id, status, target = runtime) => until(`the run ${status}`, () => getRun(id, target), (run) => run.status === status || finished(run));

/** A model connection and an agent on it. */
async function agentOn(model, fields = {}, target = runtime) {
  const connection = await api(target, "POST", "/connections/models", { name: "Fake", provider: "openai", model: "fake", baseUrl: model.url });
  return await api(target, "POST", "/agents", { name: "Builder", modelConnectionId: connection.id, autonomy: "bypass", ...fields });
}

const startRun = (agent, input = "go", extra = {}, target = runtime) => api(target, "POST", `/agents/${agent.id}/runs`, { input, ...extra });

/** A run in a chat of its own, to its end. */
async function runToEnd(agent, input = "go", extra = {}, target = runtime) {
  const thread = extra.threadId ? undefined : await api(target, "POST", `/agents/${agent.id}/threads`, { title: "Contract" });
  const started = await startRun(agent, input, { ...(thread ? { threadId: thread.id } : {}), ...extra }, target);
  return await untilFinished(started.id, target);
}

/** Changes what a stopped runtime left in its state file. */
async function editState(dataDir, change) {
  const file = path.join(dataDir, "state.json");
  const state = JSON.parse(await readFile(file, "utf8"));
  change(state);
  await writeFile(file, JSON.stringify(state));
}

/** Everything one request sent the model, as text. */
const sent = (body) => JSON.stringify(body.messages);

/** The tools a request offered, by name. */
const offered = (body) => (body.tools ?? []).map((tool) => tool.function?.name);

/** Reads a server-sent event stream into a list, until closed. */
async function openStream(target, route) {
  const token = (await readFile(path.join(target.dataDir, "runtime-token"), "utf8")).trim();
  const controller = new AbortController();
  const response = await fetch(`${target.origin}${route}`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
  const events = [];
  if (response.ok) {
    void (async () => {
      const decoder = new TextDecoder();
      let text = "";
      for await (const chunk of response.body) {
        text += decoder.decode(chunk, { stream: true });
        const parts = text.split("\n\n");
        text = parts.pop();
        for (const part of parts) {
          const event = /^event: (.*)$/m.exec(part)?.[1];
          const data = /^data: (.*)$/m.exec(part)?.[1];
          if (event && data) events.push({ event, data: JSON.parse(data) });
        }
      }
    })().catch(() => undefined);
  }
  return { response, events, close: () => controller.abort() };
}

/** An agent that can wait, on a model that asks for the given waits one after the other. */
async function waiter(steps, target) {
  const model = await fakeModel({ steps });
  const agent = await agentOn(model, { name: "Waiter", mcpConnectionIds: ["computer-use"] }, target);
  return { model, agent };
}
let waits = 0;
const wait = (ms, reason) => [call("computer_wait", { ms, ...(reason ? { reason } : {}) }, `wait_${waits += 1}`)];

test("a long wait suspends the run without calling the model, a restart keeps it asleep, and it wakes when due", async () => {
  const first = await fresh({ keepData: true });
  let second;
  let third;
  try {
    const { model, agent } = await waiter([wait(300_000, "reply from Alice"), "got the reply"], first);
    const started = await startRun(agent, "wait 5 minutes for a reply", {}, first);
    const asleep = await untilStatus(started.id, "sleeping", first);
    assert.equal(asleep.status, "sleeping", asleep.error);
    assert.equal(asleep.wake.reason, "reply from Alice");
    assert.equal(asleep.wake.requestedMs, 300_000);
    assert.equal(asleep.actions[0].status, "sleeping");
    assert.equal(model.turns().length, 1, "no model call while the run waits");
    await first.stop();

    second = await fresh({ dataDir: first.dataDir, keepData: true });
    const kept = await getRun(started.id, second);
    assert.equal(kept.status, "sleeping", "a restart does not fail a sleeping run");
    assert.equal(model.turns().length, 1, "not due yet: nothing happens");
    await second.stop();

    // The time passes while Saturn is closed.
    const past = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
    await editState(first.dataDir, (state) => {
      const wake = state.runs.find((item) => item.id === started.id).wake;
      wake.since = past(6);
      wake.at = past(1);
    });
    third = await fresh({ dataDir: first.dataDir });
    const run = await untilFinished(started.id, third);
    assert.equal(run.status, "completed", run.error);
    assert.equal(run.output, "got the reply");
    assert.equal(run.wake, undefined);
    assert.equal(run.sleeps, 1);
    const result = run.actions[0].result;
    assert.equal(run.actions[0].status, "completed");
    assert.equal(result.requested_ms, 300_000);
    assert.equal(result.reason, "reply from Alice");
    assert.equal(result.woke, "on time");
    assert.ok(result.waited_ms >= 300_000, `waited ${result.waited_ms}`);
    assert.match(sent(model.turns().at(-1)), /waited_ms/, "the model hears how long it waited");
  } finally {
    await (third ?? second ?? first).stop();
  }
});

test("a sleeping run can be woken early, and a run that is not waiting cannot", async () => {
  const { agent, model } = await waiter([wait(30 * 60_000, "the deploy"), "awake"]);
  const started = await startRun(agent, "wait for the deploy");
  const asleep = await untilStatus(started.id, "sleeping");
  assert.equal(asleep.status, "sleeping", asleep.error);
  await api(runtime, "POST", `/runs/${started.id}/wake`);
  const run = await untilFinished(started.id);
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.actions[0].result.woke, "early, by the user");
  assert.ok(run.actions[0].result.waited_ms < 30 * 60_000);
  assert.match(sent(model.turns().at(-1)), /early, by the user/);
  const again = await raw(runtime, "POST", `/runs/${started.id}/wake`);
  assert.equal(again.status, 409);
  assert.match(again.body.error, /not waiting/);
  assert.equal((await raw(runtime, "POST", "/runs/run_none/wake")).status, 404);
});

test("stopping a sleeping run cancels it for good", async () => {
  const { agent, model } = await waiter([wait(30 * 60_000), "never said"]);
  const started = await startRun(agent, "wait again");
  await untilStatus(started.id, "sleeping");
  const stopped = await api(runtime, "POST", `/runs/${started.id}/stop`);
  assert.equal(stopped.status, "cancelled");
  assert.equal(stopped.wake, undefined);
  assert.equal((await raw(runtime, "POST", `/runs/${started.id}/wake`)).status, 409);
  assert.equal(model.turns().length, 1);
});

test("one wait is at most an hour", async () => {
  const { agent } = await waiter([wait(10 * 3_600_000)]);
  const started = await startRun(agent, "wait all day");
  const asleep = await untilStatus(started.id, "sleeping");
  assert.equal(asleep.wake.requestedMs, 3_600_000);
  assert.ok(Date.parse(asleep.wake.at) - Date.parse(asleep.wake.since) <= 3_600_000);
  await api(runtime, "POST", `/runs/${started.id}/stop`);
});

test("a run that has slept too often is told to finish instead of sleeping again", async () => {
  const first = await fresh({ keepData: true });
  let second;
  try {
    const { agent, model } = await waiter([wait(60_000), wait(60_000), "finished with what I have"], first);
    const started = await startRun(agent, "poll forever", {}, first);
    await untilStatus(started.id, "sleeping", first);
    await first.stop();
    await editState(first.dataDir, (state) => {
      const run = state.runs.find((item) => item.id === started.id);
      run.sleeps = 48;
      run.wake.at = new Date(Date.now() - 1000).toISOString();
    });
    second = await fresh({ dataDir: first.dataDir });
    const run = await untilFinished(started.id, second);
    assert.equal(run.status, "completed", run.error);
    assert.equal(run.output, "finished with what I have");
    assert.equal(run.actions[1].status, "completed");
    assert.match(run.actions[1].result.error, /already waited 48 times/);
    assert.match(sent(model.turns().at(-1)), /already waited/);
  } finally {
    await (second ?? first).stop();
  }
});

test("a turn that runs out of tool steps says so instead of ending silently", async () => {
  let serial = 0;
  const model = await fakeModel({ answer: () => ({ content: "Checking again.", calls: [call("code", { command: "true" }, `c${serial += 1}`)] }) });
  const agent = await agentOn(model);
  const run = await runToEnd(agent);
  assert.equal(run.status, "completed", run.error);
  assert.ok(run.actions.length >= 60 && run.actions.length <= 61, `ran ${run.actions.length} steps`);
  assert.equal(run.output, 'Checking again.\n\nI stopped after 60 tool steps, the limit for one turn, before finishing. Reply "continue" and I will pick up from here.');
});

test("editing a message reruns that turn and drops the ones after it", async () => {
  const model = await fakeModel({
    answer: (body) => {
      const said = body.messages.filter((item) => item.role === "user").at(-1)?.content ?? "";
      return { content: `echo ${said}`, thinking: `consider ${said}` };
    },
  });
  const agent = await agentOn(model);
  const alpha = await runToEnd(agent, "alpha", { threadId: undefined });
  const threadId = alpha.threadId;
  assert.equal(alpha.output, "echo alpha");
  assert.equal(alpha.thinking, "consider alpha");
  const beta = await untilFinished((await startRun(agent, "beta", { threadId })).id);
  assert.equal(beta.output, "echo beta");
  const delta = await untilFinished((await startRun(agent, "delta", { threadId })).id);
  assert.equal(delta.output, "echo delta");

  const revised = await api(runtime, "PATCH", `/runs/${beta.id}`, { input: "gamma" });
  assert.equal(revised.run.input, "gamma");
  assert.deepEqual(revised.removed, [delta.id]);
  const rerun = await until("the rerun", () => getRun(beta.id), (run) => finished(run) && run.output === "echo gamma");
  assert.equal(rerun.status, "completed", rerun.error);
  assert.deepEqual(rerun.actions, []);
  assert.equal((await raw(runtime, "GET", `/runs/${alpha.id}`)).status, 200);
  assert.equal((await raw(runtime, "GET", `/runs/${delta.id}`)).status, 404);

  const replay = model.turns().find((body) => body.messages.some((item) => item.role === "user" && item.content === "gamma"));
  assert.ok(replay.messages.some((item) => item.role === "user" && item.content === "alpha"));
  assert.ok(replay.messages.some((item) => item.role === "assistant" && item.content === "echo alpha"));
  assert.ok(!replay.messages.some((item) => item.content === "beta" || item.content === "delta"), "what was edited away is gone");
  const listed = await api(runtime, "GET", `/agents/${agent.id}/messages?threadId=${threadId}`);
  assert.deepEqual(listed.map((item) => item.input), ["alpha", "gamma"]);

  assert.equal((await raw(runtime, "PATCH", `/runs/${beta.id}`, { input: "   " })).status, 400);
});

test("a run without a chat continues the agent's chat", async () => {
  const model = await fakeModel({ steps: ["first answer", "second answer"] });
  const agent = await agentOn(model);
  const first = await untilFinished((await startRun(agent, "first question")).id);
  const second = await untilFinished((await startRun(agent, "second question")).id);
  assert.equal(second.threadId, first.threadId);
  assert.match(sent(model.turns()[1]), /first answer/);
  assert.deepEqual((await api(runtime, "GET", `/agents/${agent.id}/messages`)).map((item) => item.input), ["first question", "second question"]);
});

test("an agent has many chats, kept apart, and they can be renamed and deleted", async () => {
  const model = await fakeModel({ steps: ["said in one", "said in two"] });
  const agent = await agentOn(model);
  const route = `/agents/${agent.id}/threads`;
  const one = await api(runtime, "POST", route, { title: "Conversation One" });
  assert.equal(one.title, "Conversation One");
  const two = await api(runtime, "POST", route, { title: "Conversation Two" });
  assert.deepEqual((await api(runtime, "GET", route)).map((item) => item.id).sort(), [one.id, two.id].sort());

  await untilFinished((await startRun(agent, "question in one", { threadId: one.id })).id);
  await untilFinished((await startRun(agent, "question in two", { threadId: two.id })).id);
  assert.doesNotMatch(sent(model.turns()[1]), /question in one|said in one/);
  assert.deepEqual((await api(runtime, "GET", `/agents/${agent.id}/messages?threadId=${two.id}`)).map((item) => item.input), ["question in two"]);

  assert.equal((await api(runtime, "PATCH", `/threads/${one.id}`, { title: "Renamed" })).title, "Renamed");
  assert.equal((await api(runtime, "GET", route)).find((item) => item.id === one.id).title, "Renamed");
  assert.equal((await raw(runtime, "DELETE", `/threads/${two.id}`)).status, 204);
  assert.deepEqual((await api(runtime, "GET", route)).map((item) => item.id), [one.id]);
});

test("no agents to begin with, and General Skills stays on every agent and cannot be deleted", async () => {
  const target = await fresh();
  try {
    assert.deepEqual(await api(target, "GET", "/agents"), []);
    const skills = (await api(target, "GET", "/connections/mcp")).find((item) => item.id === "general-skills");
    assert.equal(skills.name, "General Skills");
    assert.equal(skills.url, "builtin://general-skills");
    assert.deepEqual(skills.tools.map((item) => item.toolId), ["files", "code", "code_output", "code_stop", "skill", "load_tools", "delegate", "mcp", "web", "multi_step"]);
    const agent = await api(target, "POST", "/agents", { name: "Research" });
    assert.ok(agent.mcpConnectionIds.includes("general-skills"));
    assert.deepEqual((await api(target, "PATCH", `/agents/${agent.id}`, { mcpConnectionIds: [] })).mcpConnectionIds, ["general-skills"]);
    assert.equal((await raw(target, "DELETE", "/mcp/general-skills")).status, 403);
    assert.equal((await raw(target, "DELETE", `/agents/${agent.id}`)).status, 204);
    assert.equal((await raw(target, "GET", `/agents/${agent.id}`)).status, 404);
  } finally {
    await target.stop();
  }
});

test("agents and MCP servers are made and removed without signing in", async () => {
  const server = await api(runtime, "POST", "/connections/mcp", { name: "GitHub", url: "http://127.0.0.1:9/mcp" });
  assert.equal(server.origin, "local");
  const agent = await api(runtime, "POST", "/agents", { name: "Research", mcpConnectionIds: [server.id] });
  assert.ok(agent.mcpConnectionIds.includes(server.id));
  assert.ok(agent.mcpConnectionIds.includes("general-skills"));
  assert.equal((await raw(runtime, "DELETE", `/mcp/${server.id}`)).status, 204);
  assert.ok(!(await api(runtime, "GET", "/connections/mcp")).some((item) => item.id === server.id));
  assert.equal((await raw(runtime, "DELETE", `/agents/${agent.id}`)).status, 204);
});

test("a tool whose MCP server cannot be reached is a failed step that says which server, and the model carries on", async () => {
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const server = await api(runtime, "POST", "/connections/mcp", { name: "CRM", url: `http://127.0.0.1:${port}/mcp`, tools: [{ toolId: "crm.list_customers", description: "List customers" }] });
  const model = await fakeModel({ steps: [[call("crm.list_customers", {})], "could not"] });
  const agent = await agentOn(model, { mcpConnectionIds: [server.id] });
  const run = await runToEnd(agent);
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.output, "could not");
  assert.equal(run.actions[0].status, "failed");
  assert.match(run.actions[0].reason, new RegExp(`Could not reach the MCP server at 127\\.0\\.0\\.1:${port}`));
});

test("a model's key goes to its server as the bearer token, and stays out of every answer", async () => {
  const secret = "contract-model-key-123";
  const model = await fakeModel({ steps: ["Hello from the model"] });
  const connection = await api(runtime, "POST", "/connections/models", { name: "Keyed", provider: "openai", model: "fake", baseUrl: model.url, secret });
  assert.equal(connection.hasSecret, true);
  assert.ok(!JSON.stringify(connection).includes(secret));
  assert.ok(!JSON.stringify(await api(runtime, "GET", "/connections/models")).includes(secret));
  const agent = await api(runtime, "POST", "/agents", { name: "Keyed", modelConnectionId: connection.id });
  const run = await runToEnd(agent, "Hi");
  assert.equal(run.output, "Hello from the model");
  assert.equal(model.authorizations[0], `Bearer ${secret}`);
});

test("the in-app browser does not relay the runtime's own API, however its address is spelled", async () => {
  const { port } = new URL(runtime.origin);
  for (const target of [`${runtime.origin}/agents`, `http://localhost:${port}/agents`, `http://[::ffff:127.0.0.1]:${port}/agents`, `http://[::1]:${port}/agents`]) {
    const { body } = await raw(runtime, "GET", `/workspace/browser/proxy?url=${encodeURIComponent(target)}`);
    assert.match(body, /Could not load page/, target);
    assert.match(body, /not allowed/, target);
    assert.doesNotMatch(body, /"mcpConnectionIds"/, "nothing from the target leaks");
  }
});

test("a folder that shares the workspace's name as a prefix is outside it", async () => {
  const target = await fresh();
  try {
    const sibling = `${path.join(target.dataDir, "workspace")}-other`;
    await mkdir(sibling);
    await writeFile(path.join(sibling, "private.txt"), "not for the file view");
    const listed = await api(target, "GET", `/workspace/files?path=${encodeURIComponent(sibling)}`);
    assert.equal(listed.path, ".", "falls back to the workspace's root");
    assert.ok(!JSON.stringify(listed).includes("private.txt"));
  } finally {
    await target.stop();
  }
});

test("attached images are checked: known types only, within a size and a count", async () => {
  const model = await fakeModel();
  const agent = await agentOn(model);
  const refused = async (images, status, message) => {
    const answer = await raw(runtime, "POST", `/agents/${agent.id}/runs`, { input: "look", images });
    assert.equal(answer.status, status, JSON.stringify(answer.body));
    assert.match(answer.body.error, message);
  };
  await refused("not a list", 400, /must be a list/);
  await refused([`data:image/svg+xml;base64,${PNG}`], 400, /PNG, JPEG, WebP or GIF/);
  await refused(["not an image"], 400, /not a base64 image/);
  await refused(Array.from({ length: 5 }, () => `data:image/png;base64,${PNG}`), 400, /at most 4/);
  await refused([{ mimeType: "image/png", base64: "A".repeat(8 * 1024 * 1024) }], 413, /larger than 5 MB/);
  assert.equal(model.turns().length, 0, "nothing reached the model");
  assert.deepEqual(await api(runtime, "GET", `/agents/${agent.id}/messages`), []);
});

test("a message's images reach the model with it, can be shown again, and later turns only mention them", async () => {
  const model = await fakeModel({ steps: ["a red square", "still a square"] });
  const agent = await agentOn(model);
  const thread = await api(runtime, "POST", `/agents/${agent.id}/threads`, { title: "Pictures" });
  const first = await untilFinished((await startRun(agent, "what is this?", { threadId: thread.id, images: [`data:image/png;base64,${PNG}`, { mimeType: "image/png", base64: PNG }] })).id);
  assert.equal(first.status, "completed", first.error);
  const user = model.turns()[0].messages.at(-1);
  assert.ok(Array.isArray(user.content), "the user turn is multimodal");
  assert.ok(JSON.stringify(user.content).includes(PNG), "the image's bytes went to the model");

  const token = (await readFile(path.join(runtime.dataDir, "runtime-token"), "utf8")).trim();
  const shown = await fetch(`${runtime.origin}/runs/${first.id}/images/0`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get("content-type")?.split(";")[0], "image/png");
  assert.equal(Buffer.from(await shown.arrayBuffer()).toString("base64"), PNG);
  assert.equal((await raw(runtime, "GET", `/runs/${first.id}/images/2`)).status, 404);

  await untilFinished((await startRun(agent, "and now?", { threadId: thread.id })).id);
  const history = sent(model.turns()[1]);
  assert.ok(!history.includes(PNG), "an earlier image is not sent again");
  assert.match(history, /2 images were attached/, "the earlier turn says it had images");
});

test("a model that cannot see refuses images before anything is asked of it", async () => {
  const model = await fakeModel();
  const connection = await api(runtime, "POST", "/connections/models", { name: "Blind", provider: "deepseek", model: "deepseek-chat", baseUrl: model.url, secret: "contract-test-value" });
  const agent = await api(runtime, "POST", "/agents", { name: "Blind", modelConnectionId: connection.id });
  const answer = await raw(runtime, "POST", `/agents/${agent.id}/runs`, { input: "look", images: [`data:image/png;base64,${PNG}`] });
  assert.equal(answer.status, 409, JSON.stringify(answer.body));
  assert.match(answer.body.error, /cannot take images/);
  assert.equal(model.requests.length, 0);
  assert.deepEqual(await api(runtime, "GET", `/agents/${agent.id}/messages`), []);
});

test("an Ask turn is offered only reading tools, is told so, and a write it tries anyway is refused", async () => {
  const model = await fakeModel({ steps: [[call("code", { command: "echo hi > out.txt" })], "It prints hi."] });
  const agent = await agentOn(model, { autonomy: "fully_autonomous" });
  const run = await runToEnd(agent, "what does the script print?", { mode: "ask" });
  assert.equal(run.status, "completed", "a refused write is expected in Ask mode, not a failure");
  const tools = offered(model.turns()[0]);
  assert.ok(tools.includes("files") && !tools.includes("code"), tools.join(", "));
  assert.match(String(model.turns()[0].messages[0].content), /Ask mode/);
  assert.deepEqual(run.actions.map((action) => [action.toolId, action.status]), [["code", "denied"]]);
  assert.match(run.actions[0].reason, /Switch to Agent mode/);
});

test("a run's mode must be one Saturn knows", async () => {
  const agent = await agentOn(await fakeModel());
  const answer = await raw(runtime, "POST", `/agents/${agent.id}/runs`, { input: "go", mode: "yolo" });
  assert.equal(answer.status, 400);
  assert.match(answer.body.error, /mode must be agent, ask or plan/);
});

test("a project's rule files reach the agent's prompt", async () => {
  const site = path.join(scratch, "ruled");
  await mkdir(path.join(site, ".saturn/rules"), { recursive: true });
  await writeFile(path.join(site, "AGENTS.md"), "Use pnpm.");
  await writeFile(path.join(site, ".saturn/rules/a-tests.md"), "Every fix gets a test.");
  const project = await api(runtime, "POST", "/projects", { path: site, grant: true });
  const model = await fakeModel({ steps: ["ok"] });
  const agent = await agentOn(model);
  const run = await untilFinished((await startRun(agent, "hi", { projectId: project.id })).id);
  assert.equal(run.status, "completed", run.error);
  const system = String(model.turns()[0].messages[0].content);
  assert.match(system, /# Project rules/);
  assert.match(system, /Use pnpm\.[\s\S]*Every fix gets a test\./);
});

test("the Agents board lists the runs still going first, then the latest finished, per project", async () => {
  const git = (cwd, ...args) => assert.equal(spawnSync("git", ["-c", "user.name=Contract", "-c", "user.email=contract@example.invalid", ...args], { cwd }).status, 0, args.join(" "));
  const inA = path.join(scratch, "board-a");
  const inB = path.join(scratch, "board-b");
  await mkdir(inA);
  await mkdir(inB);
  git(inA, "init", "-b", "main");
  git(inA, "commit", "--allow-empty", "-m", "start");
  const target = await fresh();
  try {
    const projectA = await api(target, "POST", "/projects", { path: inA, grant: true });
    const projectB = await api(target, "POST", "/projects", { path: inB, grant: true });
    const model = await fakeModel({ steps: ["old answer", [call("code", { command: "echo live" })], "b answer"] });
    const agent = await agentOn(model, { name: "Runner", autonomy: "review" }, target);
    const threadA = await api(target, "POST", `/agents/${agent.id}/threads`, { title: "In A", projectId: projectA.id });
    const threadB = await api(target, "POST", `/agents/${agent.id}/threads`, { title: "In B", projectId: projectB.id });
    const worktree = await api(target, "POST", `/threads/${threadA.id}/worktree`);

    const old = await untilFinished((await startRun(agent, 'old\n<saturn_context sources="x">hidden</saturn_context>', { threadId: threadA.id }, target)).id, target);
    const live = await untilStatus((await startRun(agent, "live", { threadId: threadA.id }, target)).id, "waiting_approval", target);
    const inProjectB = await untilFinished((await startRun(agent, "b", { threadId: threadB.id }, target)).id, target);

    assert.deepEqual((await api(target, "GET", "/runs")).map((run) => run.id), [live.id, inProjectB.id, old.id]);
    const listed = await api(target, "GET", `/runs?projectId=${projectA.id}`);
    assert.deepEqual(listed.map((run) => [run.id, run.branch, run.input]), [[live.id, worktree.branch, "live"], [old.id, worktree.branch, "old"]]);
    assert.deepEqual((await api(target, "GET", `/runs?projectId=${projectB.id}`)).map((run) => run.id), [inProjectB.id]);
    assert.deepEqual((await api(target, "GET", "/runs?limit=1")).map((run) => run.id), [live.id, inProjectB.id], "the limit is for finished runs; a run still going is always shown");
    await api(target, "POST", `/runs/${live.id}/stop`);
  } finally {
    await target.stop();
  }
});

/** How many model replies in a request called tools. */
const toolRounds = (messages) => messages.filter((item) => item.role === "assistant" && (item.tool_calls?.length || String(item.content ?? "").includes('"toolId"'))).length;

/** A model for a whole family of runs: what it does goes by the question or task of the request. */
function family(calls) {
  return (body) => {
    const users = body.messages.filter((item) => item.role === "user");
    const input = users.map((item) => String(item.content)).filter((text) => /^(hello|look into|CHILD)/.test(text)).at(-1) ?? "";
    const results = toolRounds(body.messages);
    calls.push({ input, tools: offered(body), history: users.length, text: sent(body) });
    const asking = (name, args) => ({ calls: [call(name, args, `c${results}`)] });
    if (input.startsWith("look into")) {
      return results === 0 ? asking("delegate", { tasks: ["CHILD: count the files", "CHILD: name the newest file"], tools: "read-only" }) : `parent done: ${sent(body).includes("answer for") ? "both answered" : "no answers"}`;
    }
    if (input.startsWith("CHILD: nest")) {
      return results === 0 ? asking("delegate", { task: "CHILD: nest" }) : `nested: ${sent(body).includes("may not delegate") ? "refused" : "ok"}`;
    }
    if (input.startsWith("CHILD:")) return results === 0 ? asking("files", { action: "list", path: "." }) : `answer for ${input.slice(7)}`;
    return "ok";
  };
}

test("delegate runs sub-agents with fresh contexts, nests them under the step, and hands back only their answers", async () => {
  const calls = [];
  const model = await fakeModel({ answer: family(calls) });
  const agent = await agentOn(model, { name: "Lead", autonomy: "default" });
  const project = await api(runtime, "POST", "/projects", { path: folder, grant: true });
  const thread = await api(runtime, "POST", `/agents/${agent.id}/threads`, { title: "Investigation", projectId: project.id });
  // An earlier turn, so the fresh context of a sub-agent can be told from the chat's history.
  const first = await untilFinished((await startRun(agent, "hello there", { threadId: thread.id })).id);
  const run = await untilFinished((await startRun(agent, "look into the folder", { threadId: thread.id })).id);
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.output, "parent done: both answered");

  const step = run.actions.find((item) => item.toolId === "delegate");
  assert.equal(step.status, "completed");
  assert.deepEqual(step.result.results.map((item) => [item.task, item.status, item.answer]), [
    ["CHILD: count the files", "completed", "answer for count the files"],
    ["CHILD: name the newest file", "completed", "answer for name the newest file"],
  ]);
  assert.ok(!JSON.stringify(step.result).includes('"actions"'), "only their answers come back");

  // In the chat, tied to the parent, in Ask mode (read-only). Read through the route the chat reads.
  const listed = await api(runtime, "GET", `/agents/${agent.id}/messages?threadId=${thread.id}`);
  assert.deepEqual(listed.map((item) => item.id), [first.id, run.id], "the chat lists the parent, never its children as turns");
  const children = listed[1].children;
  assert.equal(children.length, 2);
  assert.ok(children.every((child) => child.threadId === thread.id && child.parentRunId === run.id && child.mode === "ask" && child.delegated?.tools === "read-only"), JSON.stringify(children));
  assert.ok(children.every((child) => child.actions.some((item) => item.toolId === "files" && item.status === "completed")), "the read tool ran");
  assert.deepEqual(step.result.results.map((item) => item.runId).sort(), children.map((child) => child.id).sort());

  const childCalls = calls.filter((item) => item.input.startsWith("CHILD:"));
  assert.ok(childCalls.length >= 2);
  assert.ok(childCalls.every((item) => !item.text.includes("hello there")), "no earlier turn of the chat reaches a sub-agent");
  assert.ok(childCalls.every((item) => !item.tools.includes("code")), "a read-only sub-agent is not offered the shell");
  assert.ok(calls.some((item) => item.input.startsWith("look into") && item.text.includes("hello there")), "the parent keeps the chat's history");

  const board = await api(runtime, "GET", `/runs?projectId=${project.id}`);
  assert.ok(!board.some((item) => children.some((child) => child.id === item.id)), "the Agents board leaves them out");
  assert.equal((await api(runtime, "GET", `/threads/${thread.id}/context`)).turns, 2, "the context counts the chat's turns only");
});

test("a sub-agent may delegate once more, and the one below that is refused", async () => {
  const model = await fakeModel({ answer: family([]) });
  const agent = await agentOn(model, { name: "Lead" });
  const run = await runToEnd(agent, "CHILD: nest");
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.output, "nested: ok");
  const [listed] = await api(runtime, "GET", `/agents/${agent.id}/messages?threadId=${run.threadId}`);
  assert.equal(listed.children?.length, 1);
  assert.equal(listed.children[0].children?.length, 1);
  const deepest = listed.children[0].children[0];
  assert.equal(deepest.children, undefined);
  assert.match(deepest.actions.find((item) => item.toolId === "delegate").reason, /may not delegate further/);
  assert.equal(deepest.output, "nested: refused");
});

test("stopping the delegating run stops its sub-agents, and the parent's stream shows them", async () => {
  const marker = path.join(scratch, "sub-agent-started");
  const model = await fakeModel({
    answer: (body) => {
      const input = body.messages.find((item) => item.role === "user")?.content ?? "";
      if (toolRounds(body.messages) > 0) return "done";
      if (String(input).startsWith("CHILD")) return [call("code", { command: `touch ${JSON.stringify(marker)}; sleep 20`, timeout: 25_000 })];
      return [call("delegate", { task: "CHILD wait", tools: "all" })];
    },
  });
  const agent = await agentOn(model, { name: "Lead" });
  const thread = await api(runtime, "POST", `/agents/${agent.id}/threads`, { title: "Stopping" });
  const run = await startRun(agent, "go", { threadId: thread.id });
  const stream = await openStream(runtime, `/runs/${run.id}/events`);
  try {
    await until("the sub-agent's command", () => stat(marker).then(() => true, () => false), Boolean);
    const seen = await until("the sub-agent on the parent's stream", () => stream.events.findLast((item) => item.event === "run" && item.data.children?.length), Boolean);
    const child = seen.data.children[0];
    assert.equal(child.delegated.tools, "all");
    assert.equal(child.mode, undefined, "all tools: the sub-agent inherits the agent's mode");
    await api(runtime, "POST", `/runs/${run.id}/stop`);
    assert.equal((await untilFinished(run.id)).status, "cancelled");
    assert.equal((await untilFinished(child.id)).status, "cancelled");
  } finally {
    stream.close();
  }
});

test("a reply with two calls that pauses for approval on the first: after approval, the second is answered as not run", async () => {
  const model = await fakeModel({ steps: [[call("code", { command: "echo one" }, "call_1"), call("code", { command: "echo two" }, "call_2")], "done"] });
  const agent = await agentOn(model, { autonomy: "review" });
  const thread = await api(runtime, "POST", `/agents/${agent.id}/threads`, { title: "Two calls" });
  const waiting = await untilStatus((await startRun(agent, "do two things", { threadId: thread.id })).id, "waiting_approval");
  assert.equal(waiting.actions.length, 1);
  assert.equal(waiting.actions[0].callId, "call_1");
  await api(runtime, "POST", `/runs/${waiting.id}/actions/${waiting.actions[0].id}/decision`, { allow: true });
  const run = await untilFinished(waiting.id);
  assert.equal(run.output, "done");
  const results = model.turns().at(-1).messages.filter((item) => item.role === "tool");
  assert.deepEqual(results.map((item) => item.tool_call_id), ["call_1", "call_2"]);
  assert.match(results[0].content, /"status":"completed"/);
  assert.match(results[1].content, /not_run/);
});

test("a server that rejects native tool turns gets them again as text, and the run goes on", async () => {
  const model = await fakeModel({
    answer: (body) => {
      if (body.messages.some((item) => item.role === "tool")) return { status: 400, body: { error: { message: "tool messages are not supported" } } };
      const ran = body.messages.some((item) => item.role === "assistant" && String(item.content ?? "").includes('"toolId"'));
      return ran ? "done as text" : [call("code", { command: "echo hi" }, "c1")];
    },
  });
  const agent = await agentOn(model, { name: "Old server" });
  const run = await runToEnd(agent);
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.output, "done as text");
});

test("in the default mode a sensitive command waits for the user, and an answered card cannot be answered twice", async () => {
  const site = path.join(scratch, "sensitive");
  const sandbox = path.join(site, "scratch");
  await mkdir(sandbox, { recursive: true });
  const project = await api(runtime, "POST", "/projects", { path: site, grant: true });
  const model = await fakeModel({ steps: [[call("code", { command: "rm -rf scratch" })], "skipped", [call("code", { command: "rm -rf scratch" })], "finished"] });
  const agent = await agentOn(model, { name: "Cleaner", autonomy: "default" });
  const thread = await api(runtime, "POST", `/agents/${agent.id}/threads`, { title: "Cleaning", projectId: project.id });

  const refused = await untilStatus((await startRun(agent, "clean up", { threadId: thread.id })).id, "waiting_approval");
  assert.equal(refused.status, "waiting_approval", refused.error);
  const card = refused.actions.find((item) => item.status === "waiting_approval");
  await api(runtime, "POST", `/runs/${refused.id}/actions/${card.id}/decision`, { allow: false });
  const denied = await untilFinished(refused.id);
  assert.equal(denied.status, "completed", "a refused command is not a failed run");
  assert.equal(denied.actions[0].status, "denied");
  assert.ok(await stat(sandbox), "the denied command did not run");
  const twice = await raw(runtime, "POST", `/runs/${refused.id}/actions/${card.id}/decision`, { allow: true });
  assert.equal(twice.status, 409);
  assert.match(twice.body.error, /no longer waiting/);
  assert.ok(await stat(sandbox), "and a late answer does not run it");

  const allowed = await untilStatus((await startRun(agent, "clean up again", { threadId: thread.id })).id, "waiting_approval");
  await api(runtime, "POST", `/runs/${allowed.id}/actions/${allowed.actions[0].id}/decision`, { allow: true });
  const done = await untilFinished(allowed.id);
  assert.equal(done.status, "completed", done.error);
  assert.equal(done.output, "finished");
  await assert.rejects(stat(sandbox), "the approved command ran");
});

test("usage is filed per call under the agent and the model that actually ran, and outlives the agent", async () => {
  const target = await fresh();
  try {
    const small = await fakeModel({ steps: ["one"], usage: { prompt_tokens: 10, completion_tokens: 1 } });
    const large = await fakeModel({ steps: ["two"], usage: { prompt_tokens: 100, completion_tokens: 10 } });
    const smallConnection = await api(target, "POST", "/connections/models", { name: "Small", provider: "openai", model: "small-local", baseUrl: small.url });
    const largeConnection = await api(target, "POST", "/connections/models", { name: "Large", provider: "openai", model: "large-local", baseUrl: large.url });
    const agent = await api(target, "POST", "/agents", { name: "Writer", modelConnectionId: smallConnection.id });
    const first = await runToEnd(agent, "first", {}, target);
    // The user switches the agent to another model; the earlier call must stay on the first one.
    await api(target, "PATCH", `/agents/${agent.id}`, { modelConnectionId: largeConnection.id });
    const second = await runToEnd(agent, "second", {}, target);

    const records = await until("both calls on file", () => api(target, "GET", "/usage"), (items) => items.some((item) => item.runId === second.id));
    const of = (run) => records.filter((item) => item.runId === run.id);
    assert.deepEqual(of(first).map((item) => item.model), ["small-local"]);
    assert.deepEqual(of(second).map((item) => item.model), ["large-local"]);
    assert.ok(records.every((item) => item.agentName === "Writer" && item.purpose === "run" && item.runId), JSON.stringify(records));
    assert.ok(records.every((item) => item.costUsd === null && item.pricing === "unpriced"), "custom endpoints are not billed at list price");

    const summary = await api(target, "GET", "/usage/summary");
    assert.equal(summary.totals.inputTokens, 110);
    assert.equal(summary.totals.outputTokens, 11);
    assert.equal(summary.totals.calls, 2);
    assert.equal(summary.totals.unpricedCalls, 2);
    assert.deepEqual(summary.models.map((item) => [item.model, item.inputTokens]), [["large-local", 100], ["small-local", 10]]);
    const writer = summary.agents.find((item) => item.agentId === agent.id);
    assert.equal(writer.exists, true);
    assert.deepEqual(writer.models.map((item) => [item.label, item.inputTokens]), [["Large", 100], ["Small", 10]]);

    // Deleting the agent keeps its spend, under the name it had.
    await api(target, "DELETE", `/agents/${agent.id}`);
    const kept = (await api(target, "GET", "/usage/summary")).agents.find((item) => item.agentId === agent.id);
    assert.equal(kept.name, "Writer");
    assert.equal(kept.exists, false);
  } finally {
    await target.stop();
  }
});

/** A runtime whose state holds the given usage records, as if made back then. */
async function withUsage(records) {
  const first = await fresh({ keepData: true });
  await api(first, "POST", "/agents", { name: "Writes the state file" });
  await first.stop();
  await editState(first.dataDir, (state) => { state.usage = records; });
  return await fresh({ dataDir: first.dataDir });
}

test("usage from before costs were stored is priced at the time it was made", async () => {
  const second = await withUsage([
    { id: "u1", runId: "r1", agentId: "gone", modelId: "m1", provider: "gemini", model: "gemini-4-argon", inputTokens: 1_000_000, outputTokens: 0, createdAt: "2026-11-01T00:00:00Z" },
    { id: "u2", runId: "r2", agentId: "gone", modelId: "m1", provider: "gemini", model: "gemini-4-argon", inputTokens: 1_000_000, outputTokens: 0, createdAt: "2026-12-02T00:00:00Z" },
  ]);
  try {
    const summary = await api(second, "GET", "/usage/summary");
    assert.equal(summary.totals.costUsd, 6);
    assert.equal(summary.models[0].label, "Gemini 4 Argon");
    assert.equal(summary.agents[0].name, "Deleted agent");
    assert.equal(summary.since, "2026-11-01T00:00:00Z");
  } finally {
    await second.stop();
  }
});

test("the usage summary can be limited to a time window: from is inclusive, to is exclusive", async () => {
  const made = (id, createdAt) => ({ id, runId: id, agentId: "a", modelId: "m", provider: "lmstudio", model: "local", inputTokens: 10, outputTokens: 1, costUsd: 1, createdAt });
  const second = await withUsage([made("u1", "2026-10-05T12:00:00Z"), made("u2", "2026-10-12T00:00:00Z"), made("u3", "2026-10-19T23:59:59Z"), made("u4", "2026-10-20T00:00:00Z")]);
  try {
    const window = (query) => api(second, "GET", `/usage/summary${query}`);
    assert.equal((await window("")).totals.calls, 4, "no window: everything");
    const week = await window(`?from=${encodeURIComponent("2026-10-12T00:00:00Z")}&to=${encodeURIComponent("2026-10-20T00:00:00Z")}`);
    assert.equal(week.totals.calls, 2);
    assert.equal(week.totals.costUsd, 2);
    assert.equal(week.since, "2026-10-12T00:00:00Z");
    assert.deepEqual(week.range, { from: "2026-10-12T00:00:00.000Z", to: "2026-10-20T00:00:00.000Z" });
    assert.equal((await window(`?from=${encodeURIComponent("2026-10-19T00:00:00Z")}`)).totals.calls, 2, "an open end");
    assert.equal((await window(`?to=${encodeURIComponent("2026-10-01T00:00:00Z")}`)).totals.calls, 0);
    assert.match((await raw(second, "GET", "/usage/summary?from=nope")).body.error, /from must be a date/);
    assert.match((await raw(second, "GET", "/usage/summary?from=2026-10-20&to=2026-10-01")).body.error, /end after it starts/);
  } finally {
    await second.stop();
  }
});

test("a plain reply finishes the run with one model call on file", async () => {
  const target = await fresh();
  try {
    const model = await fakeModel({ steps: ["hello"], usage: { prompt_tokens: 5, completion_tokens: 1 } });
    const agent = await agentOn(model, {}, target);
    const run = await runToEnd(agent, "hi", {}, target);
    assert.equal(run.status, "completed", run.error);
    assert.equal(run.output, "hello");
    assert.equal(model.turns().length, 1);
    assert.equal((await api(target, "GET", "/usage")).filter((item) => item.runId === run.id).length, 1);
  } finally {
    await target.stop();
  }
});

test("a turn that recovers from a failed tool call and answers is completed; one that ends without an answer failed", async () => {
  for (const [final, expected] of [["The file is missing, so I created it instead.", "completed"], ["", "failed"]]) {
    const model = await fakeModel({ steps: [[call("files", { action: "read", path: "missing.txt" })], { content: final }] });
    const agent = await agentOn(model, { autonomy: "auto" });
    const run = await runToEnd(agent, "read missing.txt");
    assert.equal(run.actions[0].status, "failed", "the tool call itself failed");
    assert.equal(run.status, expected, `final reply ${JSON.stringify(final)}: ${run.error}`);
  }
});

test("the event streams tell which runs changed, and stream one run as it changes", async () => {
  const model = await fakeModel({ steps: ["streamed answer"] });
  const agent = await agentOn(model, { name: "Streamer" });
  const changes = await openStream(runtime, "/events");
  try {
    assert.match(changes.response.headers.get("content-type") ?? "", /^text\/event-stream/);
    await until("ready", () => changes.events[0], (first) => first?.event === "ready");

    const thread = await api(runtime, "POST", `/agents/${agent.id}/threads`, { title: "Streaming" });
    const run = await startRun(agent, "hello", { threadId: thread.id });
    const one = await openStream(runtime, `/runs/${run.id}/events`);
    try {
      await until("the first event", () => one.events[0], Boolean);
      assert.equal(one.events[0].event, "run");
      assert.equal(one.events[0].data.id, run.id, "the stream opens with the run as it is");
      // The stream may open after the end, and then its first event is the finished run.
      const last = await until("the completed run", () => one.events.at(-1), (item) => item.data.status === "completed");
      assert.equal(last.data.output, "streamed answer");
    } finally {
      one.close();
    }
    await until("a change naming the completed run", () => changes.events, (events) => events.some((item) => item.event === "change" && item.data.runs.some((entry) => entry.id === run.id && entry.status === "completed")));
    // Agents and chats change too: "other" is set on some change.
    const before = changes.events.length;
    await api(runtime, "POST", "/agents", { name: "Another" });
    await until("a change to something other than runs", () => changes.events.slice(before), (events) => events.some((item) => item.event === "change" && item.data.other));
  } finally {
    changes.close();
  }
  assert.equal((await raw(runtime, "GET", "/runs/run_missing/events")).status, 404);
  assert.equal((await fetch(`${runtime.origin}/events`)).status, 401, "the streams need the token like every route");
  assert.equal((await fetch(`${runtime.origin}/runs/run_missing/events`)).status, 401);
});
