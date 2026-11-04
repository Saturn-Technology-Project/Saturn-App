// What reaches a model provider, whichever language runs the runtime: a connection's effort, the shape of a conversation
// after tool calls, and what is left behind when a call is refused. All providers here are fake, on this computer.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { actedSinceAsking, agentOn, api, call, fakeModel, fakeServer, request, turn, until } from "./model-harness.mjs";
import { startRuntime } from "./runtime.mjs";

const anthropicMessage = { id: "msg_1", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };

let runtime;
let claude;
const stops = [];

before(async () => {
  // Answers as Anthropic does, and refuses an effort from the model that cannot take one here.
  claude = await fakeServer((body, response) => {
    const refused = body.model === "claude-sonnet-4-6" && body.output_config;
    response.writeHead(refused ? 400 : 200, { "content-type": "application/json" }).end(JSON.stringify(refused
      ? { type: "error", error: { type: "invalid_request_error", message: "output_config.effort: unsupported value" } }
      : anthropicMessage));
  });
  stops.push(claude.stop);
  // No key from the developer's own environment can reach these tests.
  runtime = await startRuntime({ env: { ANTHROPIC_BASE_URL: claude.url, ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "", GOOGLE_API_KEY: "" } });
});
after(async () => {
  await runtime?.stop();
  await Promise.all(stops.map((stop) => stop()));
});

/** A fake model that stops with the runtime. */
async function model(reply) {
  const server = await fakeModel(reply);
  stops.push(server.stop);
  return server;
}

test("a connection's effort reaches the provider, a server that rejects it still answers, and it can be changed and cleared", async () => {
  const strict = await model((body) => ("reasoning_effort" in body
    ? { status: 400, body: { error: { message: "Unrecognized request argument supplied: reasoning_effort", type: "invalid_request_error" } } }
    : "hello"));
  const setup = await agentOn(runtime, strict, { connection: { effort: "high" } });
  assert.equal(setup.connection.effort, "high");

  const run = await turn(runtime, setup, "a question");
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.output, "hello");
  const asked = strict.requests.filter((body) => body.tools?.length);
  assert.equal(asked[0].reasoning_effort, "high", "the effort is sent first");
  assert.equal("reasoning_effort" in asked[1], false, "and dropped when the server rejects it");

  const route = `/connections/models/${setup.connection.id}`;
  assert.equal((await api(runtime, "PATCH", route, { effort: "low" })).effort, "low");
  assert.equal((await api(runtime, "PATCH", route, { name: "Renamed" })).effort, "low", "a change to something else keeps it");
  assert.equal((await api(runtime, "PATCH", route, { effort: null })).effort, undefined);
  strict.requests.length = 0;
  assert.equal((await turn(runtime, setup, "again")).status, "completed");
  assert.ok(strict.requests.every((body) => !("reasoning_effort" in body)), "a cleared effort is not sent");
});

/** A new agent on a Claude model, its calls going to the fake Anthropic server. */
async function onClaude(modelName, effort) {
  const setup = await agentOn(runtime, claude, { connection: { name: modelName, provider: "claude", model: modelName, secret: "made-up-claude-key", ...(effort ? { effort } : {}) } });
  claude.requests.length = 0;
  return setup;
}

test("Claude: a run on a new model asks for the connection's effort with adaptive thinking and no sampling", async () => {
  const setup = await onClaude("claude-opus-5-5", "xhigh");
  const run = await turn(runtime, setup);
  assert.equal(run.status, "completed", run.error);
  const sent = claude.requests.find((body) => body.tools?.length);
  assert.deepEqual(sent.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(sent.output_config, { effort: "xhigh" });
  assert.equal(sent.temperature, undefined);
});

test("Claude: background work on a new model asks for low effort instead of turning thinking off", async () => {
  const setup = await onClaude("claude-opus-5-5");
  const answer = await api(runtime, "POST", "/complete", { kind: "inline", modelId: setup.connection.id, prefix: "a", suffix: "b" });
  assert.equal(answer.text, "ok");
  const sent = claude.requests.at(-1);
  assert.equal(sent.thinking, undefined);
  assert.deepEqual(sent.output_config, { effort: "low" });
  assert.equal(sent.temperature, undefined);
});

test("Claude: Haiku 4.5 takes no effort and no adaptive thinking, and keeps its sampling", async () => {
  const setup = await onClaude("claude-haiku-4-5", "high");
  const run = await turn(runtime, setup);
  assert.equal(run.status, "completed", run.error);
  const sent = claude.requests.find((body) => body.tools?.length);
  assert.equal(sent.output_config, undefined);
  assert.notEqual(sent.thinking?.type, "adaptive");
  assert.equal(typeof sent.temperature, "number");
});

test("Claude: an effort the model rejects is dropped, and the run goes on", async () => {
  const setup = await onClaude("claude-sonnet-4-6", "low");
  const run = await turn(runtime, setup);
  assert.equal(run.status, "completed", run.error);
  const asked = claude.requests.filter((body) => body.tools?.length);
  assert.deepEqual(asked[0].output_config, { effort: "low" });
  assert.equal(asked[1].output_config, undefined);
});

test("after a round of tool calls, the next model call never ends on the assistant", async () => {
  const scripted = await model((body) => (body.tools?.length && !actedSinceAsking(body.messages) ? [call("code", { command: "echo hi" }, "c1")] : "done"));
  const setup = await agentOn(runtime, scripted);
  const run = await turn(runtime, setup, "plan it");
  assert.equal(run.status, "completed", run.error);
  assert.ok(scripted.requests.filter((body) => body.tools?.length).length >= 2, "a second model call followed the tool round");
  const ends = scripted.requests.map((body) => body.messages.at(-1).role);
  assert.ok(ends.every((role) => role === "user" || role === "tool"), JSON.stringify(ends));
});

test("a call refused for a missing key says so, and its span fails with the reason", async () => {
  const connection = await api(runtime, "POST", "/connections/models", { name: "Gemini", provider: "gemini", model: "gemini-3.8-flash" });
  const refused = await request(runtime, "POST", "/complete", { kind: "edit", modelId: connection.id, instruction: "two", selection: "x" });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /no Gemini API key/);

  const spans = await until("the refused call's span", async () => {
    const traces = await api(runtime, "GET", "/telemetry/traces");
    const lists = await Promise.all(traces.map((item) => api(runtime, "GET", `/telemetry/traces/${item.traceId}`)));
    return lists.flat().filter((span) => span.name === "chat gemini-3.8-flash");
  }, (found) => found.length > 0);
  assert.equal(spans[0].status, "error");
  assert.equal(spans[0].attributes["error.type"], "http_409");
  assert.equal(spans[0].events.filter((event) => event.name === "exception").length, 1);
});
