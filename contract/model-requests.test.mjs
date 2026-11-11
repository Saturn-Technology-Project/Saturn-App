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

/**
 * What the stand-in for Anthropic says of two models when asked about one (`GET /v1/models/:id`), in the form its Models
 * API answers. Saturn reads what a model accepts from this and from nothing else: no rule about a model's name is in it.
 */
const supported = (value) => ({ supported: value });
const DESCRIBED = {
  "claude-opus-5-5": { max_input_tokens: 1_000_000, max_tokens: 128_000, capabilities: { effort: supported(true), thinking: { supported: true, types: { adaptive: supported(true), enabled: supported(false) } } } },
  "claude-haiku-4-5": { max_input_tokens: 200_000, max_tokens: 64_000, capabilities: { effort: supported(false), thinking: { supported: true, types: { adaptive: supported(false), enabled: supported(true) } } } },
};
/** The stand-in's requests that asked about a model. */
const describing = (id) => claude.requests.filter((item) => item.__url === `/v1/models/${id}`);

before(async () => {
  // Answers as Anthropic does: it describes the models it knows, has nothing to say of any other, and refuses an effort
  // from the model that cannot take one here.
  claude = await fakeServer((body, response, incoming) => {
    if (incoming.method === "GET") {
      const id = incoming.url.replace("/v1/models/", "");
      const known = DESCRIBED[id];
      response.writeHead(known ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify(known
        ? { type: "model", id, display_name: id, ...known }
        : { type: "error", error: { type: "not_found_error", message: `model: ${id}` } }));
      return;
    }
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
  // The sixth turn of a chat is followed by a call that asks what to remember, which is background work.
  for (let index = 1; index <= 6; index += 1) assert.equal((await turn(runtime, setup, `question ${index}.`)).status, "completed");
  const noting = (body) => JSON.stringify(body.system ?? "").includes("You keep short notes");
  const sent = (await until("the call that asks what to remember", () => claude.requests.filter(noting), (found) => found.length > 0))[0];
  assert.equal(sent.thinking, undefined);
  assert.deepEqual(sent.output_config, { effort: "low" });
  assert.equal(sent.temperature, undefined);
});

test("Claude: a model that Anthropic says takes no effort and no adaptive thinking gets neither, and keeps its sampling", async () => {
  // Connected by its ID alone, so the first call asks Anthropic what the model accepts and saves the answer.
  const setup = await onClaude("claude-haiku-4-5", "high");
  const run = await turn(runtime, setup);
  assert.equal(run.status, "completed", run.error);
  const sent = claude.requests.find((body) => body.tools?.length);
  assert.equal(sent.output_config, undefined);
  assert.equal(sent.thinking, undefined);
  assert.equal(typeof sent.temperature, "number");
  assert.equal(claude.requests.indexOf(describing("claude-haiku-4-5")[0]) < claude.requests.indexOf(sent), true, "asked before the first request");
  const saved = (await api(runtime, "GET", "/connections/models")).find((item) => item.id === setup.connection.id);
  assert.deepEqual(saved.capabilities, { adaptiveThinking: false, budgetThinking: true, effort: false });
  assert.equal(saved.contextTokens, 200_000, "and its context window, which the connection did not have");
  // Asked once: the answer is on the connection.
  assert.equal((await turn(runtime, setup, "again")).status, "completed");
  assert.equal(describing("claude-haiku-4-5").length, 1);
});

test("Claude: a model connected with what the provider's list said of it is not asked about", async () => {
  const setup = await agentOn(runtime, claude, { connection: { name: "Listed", provider: "claude", model: "claude-listed-1", secret: "made-up-claude-key", contextTokens: 500_000, capabilities: { adaptiveThinking: true, budgetThinking: false, effort: false } } });
  claude.requests.length = 0;
  assert.equal((await turn(runtime, setup)).status, "completed");
  const sent = claude.requests.find((body) => body.tools?.length);
  assert.deepEqual(sent.thinking, { type: "adaptive", display: "summarized" });
  assert.equal(sent.output_config, undefined, "no effort, as the list said");
  assert.equal(sent.temperature, undefined);
  assert.equal(describing("claude-listed-1").length, 0);
});

test("Claude: a model Anthropic says nothing of is asked as a current one, and an effort it rejects is dropped", async () => {
  // The stand-in does not know this model, as a proxy or an address without the Models API would not.
  const setup = await onClaude("claude-sonnet-4-6", "low");
  const run = await turn(runtime, setup);
  assert.equal(run.status, "completed", run.error);
  const asked = claude.requests.filter((body) => body.tools?.length);
  assert.deepEqual(asked[0].thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(asked[0].output_config, { effort: "low" });
  assert.equal(asked[0].temperature, undefined, "no sampling setting where nothing says the model takes one");
  assert.equal(asked[1].output_config, undefined);
  const saved = (await api(runtime, "GET", "/connections/models")).find((item) => item.id === setup.connection.id);
  assert.equal(saved.capabilities, undefined, "nothing was said, so nothing is saved");
  // Not asked again with every call while the runtime runs.
  assert.equal((await turn(runtime, setup, "again")).status, "completed");
  assert.equal(describing("claude-sonnet-4-6").length, 1);
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
  const agent = await api(runtime, "POST", "/agents", { name: "On Gemini", modelConnectionId: connection.id });
  const refused = await request(runtime, "POST", "/automations/draft", { text: "every morning summarize", agentId: agent.id });
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
