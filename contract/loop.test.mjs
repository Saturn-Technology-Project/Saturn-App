// What the agent loop must do, whichever language runs it, driven only over HTTP with a scripted model.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startRuntime } from "./runtime.mjs";

/** One tool call in a scripted model turn. */
const call = (name, args, id = `call_${name}`) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

/**
 * A fake OpenAI-compatible model: each request takes the next turn of `script`, an answer as text, a list of tool calls,
 * { status, body } for an error, or a function for anything else. Every request's body is kept.
 */
async function scriptedModel(script) {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", async () => {
      const turn = script[requests.length];
      requests.push(JSON.parse(raw || "{}"));
      const answer = typeof turn === "function" ? await turn(request, response) : turn;
      if (response.writableEnded || answer === undefined && typeof turn === "function") return;
      if (answer?.status) {
        response.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body ?? { error: { message: "scripted failure" } }));
        return;
      }
      const message = Array.isArray(answer) ? { role: "assistant", content: "", tool_calls: answer } : { role: "assistant", content: answer ?? "finished" };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        id: "reply",
        object: "chat.completion",
        model: "scripted",
        choices: [{ index: 0, finish_reason: Array.isArray(answer) ? "tool_calls" : "stop", message }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

let runtime;
let folder;
const models = [];

before(async () => {
  runtime = await startRuntime();
  folder = await mkdtemp(path.join(os.tmpdir(), "saturn-contract-project-"));
});
after(async () => {
  await Promise.all(models.map((model) => model.stop()));
  await runtime?.stop();
  await rm(folder, { recursive: true, force: true });
});

/** An API call with the token; refuses an unexpected status so a test reads as the flow it checks. */
async function api(target, method, route, body, expected = [200, 201, 204]) {
  const token = (await readFile(path.join(target.dataDir, "runtime-token"), "utf8")).trim();
  const response = await fetch(`${target.origin}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.ok(expected.includes(response.status), `${method} ${route}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

/** A new agent on a scripted model, working in a chat in the test's folder. */
async function agentOn(script, autonomy = "review", target = runtime) {
  const model = await scriptedModel(script);
  models.push(model);
  const connection = await api(target, "POST", "/connections/models", { name: "Scripted", provider: "openai", model: "scripted", baseUrl: model.url, apiKey: "scripted-test-value" });
  const agent = await api(target, "POST", "/agents", { name: "Builder", modelConnectionId: connection.id, autonomy });
  const project = await api(target, "POST", "/projects", { path: folder, grant: true });
  const thread = await api(target, "POST", `/agents/${agent.id}/threads`, { title: "Contract", projectId: project.id });
  return { model, agent, project, thread };
}

const start = (setup, input = "go", target = runtime) => api(target, "POST", `/agents/${setup.agent.id}/runs`, { input, threadId: setup.thread.id });

/** Reads a run until `done` says so. */
async function until(runId, done, target = runtime) {
  let run;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    run = await api(target, "GET", `/runs/${runId}`);
    if (done(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`run stuck at ${run?.status}: ${run?.error ?? ""}`);
}
const settled = (run) => !["queued", "running", "waiting_approval"].includes(run.status);
const waiting = (run) => run.status === "waiting_approval";

/** Everything the model was sent in one request, as text. */
const sent = (request) => JSON.stringify(request.messages);

test("a turn with no tool call completes with the model's answer", async () => {
  const setup = await agentOn(["the answer"]);
  const run = await until((await start(setup, "a question")).id, settled);
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.output, "the answer");
  assert.deepEqual(run.actions, []);
  assert.match(sent(setup.model.requests[0]), /a question/);
});

test("the next turn in a chat sees the earlier one", async () => {
  const setup = await agentOn(["first answer", "second answer"]);
  await until((await start(setup, "first question")).id, settled);
  const run = await until((await start(setup, "second question")).id, settled);
  assert.equal(run.output, "second answer");
  const context = sent(setup.model.requests[1]);
  assert.match(context, /first question/);
  assert.match(context, /first answer/);
  assert.match(context, /second question/);
});

test("a model error fails the run and says why", async () => {
  const setup = await agentOn([{ status: 400, body: { error: { message: "scripted refusal" } } }]);
  const run = await until((await start(setup)).id, settled);
  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /scripted refusal/);
});

test("in Review mode a command waits for approval; allowed, it runs and the model gets its output", async () => {
  const setup = await agentOn([[call("code", { command: "echo contract-output" })], "done"]);
  const running = await until((await start(setup)).id, waiting);
  const card = running.actions.find((action) => action.status === "waiting_approval");
  assert.equal(card.toolId, "code");
  assert.equal(card.arguments.command, "echo contract-output");
  assert.equal(setup.model.requests.length, 1, "nothing goes back to the model while it waits");

  await api(runtime, "POST", `/runs/${running.id}/actions/${card.id}/decision`, { allow: true });
  const run = await until(running.id, settled);
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.output, "done");
  assert.equal(run.actions[0].status, "completed");
  assert.match(sent(setup.model.requests[1]), /contract-output/);
});

test("a refused command does not run, and the model is told", async () => {
  const marker = path.join(folder, "must-not-exist");
  const setup = await agentOn([[call("code", { command: `echo no > ${JSON.stringify(marker)}` })], "understood"]);
  const running = await until((await start(setup)).id, waiting);
  await api(runtime, "POST", `/runs/${running.id}/actions/${running.actions[0].id}/decision`, { allow: false });
  const run = await until(running.id, settled);
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.actions[0].status, "denied");
  await assert.rejects(readFile(marker));
  assert.equal(setup.model.requests.length, 2);
});

test("a deny rule refuses a call with no approval card, and the run goes on", async () => {
  const setup = await agentOn([[call("code", { command: "rm -rf build" })], "moved on"]);
  await api(runtime, "POST", "/permissions/rules", { scope: "agent", agentId: setup.agent.id, rule: { tool: "code", pattern: "rm *", effect: "deny" } });
  const run = await until((await start(setup)).id, settled);
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.actions[0].status, "denied");
  assert.match(run.actions[0].reason ?? "", /Denied by a permission rule/);
});

test("an allow rule skips the card even in Review mode", async () => {
  const setup = await agentOn([[call("code", { command: "echo allowed-by-rule" })], "done"]);
  await api(runtime, "POST", "/permissions/rules", { scope: "agent", agentId: setup.agent.id, rule: { tool: "code", pattern: "echo *", effect: "allow" } });
  const run = await until((await start(setup)).id, settled);
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.actions[0].status, "completed");
  assert.match(sent(setup.model.requests[1]), /allowed-by-rule/);
});

test("a call to a tool the agent does not have fails, and the model is told", async () => {
  const setup = await agentOn([[call("no_such_tool", {})], "recovered"]);
  const start_ = await start(setup);
  let run = await until(start_.id, (item) => settled(item) || waiting(item));
  if (waiting(run)) {
    await api(runtime, "POST", `/runs/${run.id}/actions/${run.actions[0].id}/decision`, { allow: true });
    run = await until(run.id, settled);
  }
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.actions[0].status, "failed");
  assert.match(run.actions[0].reason ?? "", /Unknown tool: no_such_tool/);
  assert.match(sent(setup.model.requests[1]), /Unknown tool/);
});

test("Ask mode offers no tool that changes things", async () => {
  const setup = await agentOn(["only answering"]);
  const created = await api(runtime, "POST", `/agents/${setup.agent.id}/runs`, { input: "explain", threadId: setup.thread.id, mode: "ask" });
  const run = await until(created.id, settled);
  assert.equal(run.status, "completed", run.error);
  const offered = (setup.model.requests[0].tools ?? []).map((tool) => tool.function?.name);
  assert.ok(!offered.includes("code"), offered.join(","));
});

test("stopping a run ends it at once, while the model is still thinking", async () => {
  let release;
  const setup = await agentOn([() => new Promise((resolve) => { release = resolve; })]);
  const created = await start(setup);
  await until(created.id, () => setup.model.requests.length === 1);
  await api(runtime, "POST", `/runs/${created.id}/stop`);
  const run = await until(created.id, settled);
  assert.equal(run.status, "cancelled");
  release?.("too late");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await api(runtime, "GET", `/runs/${created.id}`)).status, "cancelled", "a late answer changes nothing");
});

test("stopping a run that waits for approval runs nothing", async () => {
  const marker = path.join(folder, "stopped-must-not-exist");
  const setup = await agentOn([[call("code", { command: `echo no > ${JSON.stringify(marker)}` })], "never asked"]);
  const running = await until((await start(setup)).id, waiting);
  await api(runtime, "POST", `/runs/${running.id}/stop`);
  assert.equal((await until(running.id, settled)).status, "cancelled");
  await assert.rejects(readFile(marker));
  assert.equal(setup.model.requests.length, 1);
});

test("the event stream sends the run as it changes, up to its end", async () => {
  const setup = await agentOn([[call("code", { command: "echo streamed" })], "done"]);
  const running = await until((await start(setup)).id, waiting);
  const token = (await readFile(path.join(runtime.dataDir, "runtime-token"), "utf8")).trim();
  const stream = await fetch(`${runtime.origin}/runs/${running.id}/events`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
  await api(runtime, "POST", `/runs/${running.id}/actions/${running.actions[0].id}/decision`, { allow: true });
  const decoder = new TextDecoder();
  const seen = [];
  let text = "";
  for await (const chunk of stream.body) {
    text += decoder.decode(chunk, { stream: true });
    const parts = text.split("\n\n");
    text = parts.pop();
    for (const part of parts) {
      const data = part.split("\n").find((line) => line.startsWith("data: "));
      if (part.includes("event: run") && data) seen.push(JSON.parse(data.slice(6)).status);
    }
    if (seen.at(-1) === "completed") break;
  }
  assert.equal(seen[0], "waiting_approval");
  assert.equal(seen.at(-1), "completed");
});

test("an approval still waits after the runtime restarts, and a run cut off mid-turn is marked interrupted", async () => {
  const first = await startRuntime({ keepData: true });
  let second;
  try {
    const setup = await agentOn([[call("code", { command: "echo after-restart" })], "done"], "review", first);
    const waitingRun = await until((await start(setup, "go", first)).id, waiting, first);
    const cutOff = await agentOn([() => new Promise(() => {})], "review", first);
    const midTurn = await start(cutOff, "go", first);
    await until(midTurn.id, () => cutOff.model.requests.length === 1, first);
    await first.stop();

    second = await startRuntime({ dataDir: first.dataDir });
    const interrupted = await until(midTurn.id, settled, second);
    assert.equal(interrupted.status, "failed");
    assert.match(interrupted.error ?? "", /Interrupted/);
    assert.equal((await api(second, "GET", `/runs/${waitingRun.id}`)).status, "waiting_approval");
    await api(second, "POST", `/runs/${waitingRun.id}/actions/${waitingRun.actions[0].id}/decision`, { allow: true });
    const run = await until(waitingRun.id, settled, second);
    assert.equal(run.status, "completed", run.error);
    assert.match(sent(setup.model.requests.at(-1)), /after-restart/);
  } finally {
    await second?.stop();
  }
});

test("compacting folds a chat's earlier turns into a summary the next turn sees", async () => {
  const setup = await agentOn(["first answer", "the scripted summary", "after compaction"]);
  await until((await start(setup, "first question")).id, settled);
  await api(runtime, "POST", `/threads/${setup.thread.id}/compact`);
  const run = await until((await start(setup, "next question")).id, settled);
  assert.equal(run.output, "after compaction");
  assert.match(sent(setup.model.requests.at(-1)), /the scripted summary/);
});

test("delegate runs a sub-agent with its own context and gives the parent its answer", async () => {
  const setup = await agentOn([[call("delegate", { task: "look into it", tools: "read-only" })], "the sub-agent's findings", "parent done"], "bypass");
  const run = await until((await start(setup)).id, settled);
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.output, "parent done");
  assert.equal(run.actions[0].toolId, "delegate");
  assert.equal(run.actions[0].status, "completed");
  assert.match(sent(setup.model.requests.at(-1)), /the sub-agent's findings/);
  assert.doesNotMatch(sent(setup.model.requests[1]), /call_delegate/, "its own context, not the parent's");
});
