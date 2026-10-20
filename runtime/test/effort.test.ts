import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { flatInputSchema, withOptionalFields } from "../src/infrastructure/llm/shared.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

test("an optional field the provider rejects is dropped and the call retried; other errors pass through", async () => {
  const sent: Record<string, unknown>[] = [];
  const reply = await withOptionalFields(
    { effort: { value: "low", rejectedWhen: /effort/ }, temperature: { value: 0, rejectedWhen: /temperature/ } },
    async (active) => {
      sent.push({ ...active });
      if ("effort" in active) throw Object.assign(new Error("Unrecognized request argument: effort"), { status: 400 });
      return "ok";
    },
  );
  assert.equal(reply, "ok");
  assert.deepEqual(sent, [{ effort: "low", temperature: 0 }, { temperature: 0 }]);

  // A rejection that names no optional field, or that is not a 400, is the caller's problem.
  await assert.rejects(
    withOptionalFields({ effort: { value: "low", rejectedWhen: /effort/ } }, async () => {
      throw Object.assign(new Error("Invalid API key"), { status: 401 });
    }),
    /Invalid API key/,
  );
});

/** An OpenAI-compatible server that rejects reasoning_effort, and records every request body it gets. */
async function strictServer() {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      bodies.push(body);
      res.setHeader("content-type", "application/json");
      if ("reasoning_effort" in body) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: "Unrecognized request argument supplied: reasoning_effort", type: "invalid_request_error" } }));
        return;
      }
      res.end(JSON.stringify({ choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, bodies, url: `http://127.0.0.1:${address.port}` };
}

test("a model's effort reaches the provider, and a server without effort support still answers", async () => {
  const fake = await strictServer();
  try {
    const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-effort-")));
    await store.load();
    const { services } = createApp(store);
    const model = await services.createModel({ name: "Local", provider: "openai", model: "local-model", baseUrl: fake.url, effort: "high" });
    assert.equal(model.effort, "high");

    const body = await services.kernel.llm.complete(services.kernel.store.state.models.find((item) => item.id === model.id)!, {
      context: { agentId: "a", agentName: "A", purpose: "completion" },
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal((body.choices as { message: { content: string } }[])[0]!.message.content, "hello");
    assert.equal(fake.bodies[0]!.reasoning_effort, "high", "the effort is sent first");
    assert.equal("reasoning_effort" in fake.bodies[1]!, false, "and dropped when the server rejects it");

    // Effort can be changed and cleared on an existing connection.
    assert.equal((await services.updateModel(model.id, { effort: "low" })).effort, "low");
    assert.equal((await services.updateModel(model.id, { effort: null })).effort, undefined);
  } finally {
    fake.server.close();
  }
});

/** A fake provider that records request bodies and answers in the shape the adapter expects. */
async function recorder(answer: (body: Record<string, unknown>) => { status?: number; json: unknown }) {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      bodies.push(body);
      const reply = answer(body);
      res.statusCode = reply.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(reply.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, bodies, url: `http://127.0.0.1:${address.port}` };
}

const claudeMessage = { id: "msg_1", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };

test("Claude: low thinking omits thinking and asks for low effort; effort and sampling follow each model's rules", async () => {
  const fake = await recorder((body) =>
    body.model === "claude-sonnet-4-6" && body.output_config
      ? { status: 400, json: { type: "error", error: { type: "invalid_request_error", message: "output_config.effort: unsupported value" } } }
      : { json: claudeMessage },
  );
  const previous = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = fake.url;
  try {
    const { claude } = await import("../src/infrastructure/llm/claude.js");
    const call = (model: string, extra: Record<string, unknown>) =>
      claude.complete({ model, baseUrl: "", apiKey: "k", messages: [{ role: "user", content: "hi" }], tools: [], temperature: 0.2, maxOutput: 64, ...extra });
    const pick = (body: Record<string, unknown>) => ({ thinking: body.thinking ?? null, output_config: body.output_config ?? null, temperature: body.temperature ?? null });

    await call("claude-opus-5-5", { thinking: "low" });
    assert.deepEqual(pick(fake.bodies.at(-1)!), { thinking: null, output_config: { effort: "low" }, temperature: null }, "Opus 5.5 cannot disable thinking: low effort, no sampling");

    await call("claude-opus-5-5", { effort: "xhigh" });
    assert.deepEqual(pick(fake.bodies.at(-1)!), { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "xhigh" }, temperature: null });

    await call("claude-haiku-4-5", { thinking: "low", effort: "high" });
    assert.deepEqual(pick(fake.bodies.at(-1)!), { thinking: null, output_config: null, temperature: 0.2 }, "Haiku 4.5: no effort, no adaptive thinking, sampling allowed");

    const before = fake.bodies.length;
    await call("claude-sonnet-4-6", { effort: "low" });
    assert.equal(fake.bodies.length - before, 2, "a rejected effort is retried once");
    assert.equal(fake.bodies.at(-1)!.output_config, undefined);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previous;
    fake.server.close();
  }
});

test("OpenAI Responses: reasoning models get a reasoning effort and no temperature; others the reverse", async () => {
  const fake = await recorder(() => ({ json: { id: "r", object: "response", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 1, output_tokens: 1 } } }));
  try {
    const { openAIResponses } = await import("../src/infrastructure/llm/openai.js");
    const call = (model: string, extra: Record<string, unknown>) =>
      openAIResponses.complete({ model, baseUrl: fake.url, apiKey: "k", messages: [{ role: "user", content: "hi" }], tools: [], temperature: 0.2, maxOutput: 64, ...extra });
    await call("gpt-5-mini", { thinking: "low" });
    assert.deepEqual({ reasoning: fake.bodies.at(-1)!.reasoning, temperature: fake.bodies.at(-1)!.temperature }, { reasoning: { summary: "auto", effort: "low" }, temperature: undefined });
    await call("gpt-5", { effort: "max" });
    assert.deepEqual(fake.bodies.at(-1)!.reasoning, { summary: "auto", effort: "high" }, "xhigh/max map to high");
    await call("gpt-4.1-mini", { effort: "high" });
    assert.deepEqual({ reasoning: fake.bodies.at(-1)!.reasoning, temperature: fake.bodies.at(-1)!.temperature }, { reasoning: undefined, temperature: 0.2 });
  } finally {
    fake.server.close();
  }
});

test("tool schemas with a top-level oneOf, anyOf or allOf are flattened into one object schema", () => {
  const target = {
    type: "object",
    properties: { pid: { type: "integer" }, bundle_id: { type: "string" } },
    oneOf: [{ required: ["pid"] }, { required: ["bundle_id"] }],
  };
  assert.deepEqual(flatInputSchema(target), {
    schema: { type: "object", properties: { pid: { type: "integer" }, bundle_id: { type: "string" } } },
    note: "Give exactly one of: pid, bundle_id.",
  });
  assert.deepEqual(
    flatInputSchema({ allOf: [{ properties: { a: { type: "string" } }, required: ["a"] }, { properties: { b: { type: "number" } } }] }).schema,
    { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a"] },
  );
  const plain = { type: "object", properties: { x: { anyOf: [{ type: "string" }, { type: "null" }] } }, required: ["x"] };
  assert.deepEqual(flatInputSchema(plain), { schema: plain }, "nested combinators and plain schemas are untouched");
});

test("Claude: a tool whose schema has a top-level oneOf is still accepted", async () => {
  // Rejects the request the way Anthropic does when any tool schema has a top-level combinator.
  const fake = await recorder((body) => {
    const bad = ((body.tools as { input_schema: Record<string, unknown> }[] | undefined) ?? []).findIndex((tool) => ["oneOf", "anyOf", "allOf"].some((key) => key in tool.input_schema));
    return bad >= 0
      ? { status: 400, json: { type: "error", error: { type: "invalid_request_error", message: `tools.${bad}.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level` } } }
      : { json: claudeMessage };
  });
  const previous = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = fake.url;
  try {
    const { claude } = await import("../src/infrastructure/llm/claude.js");
    const tool = { type: "function", function: { name: "computer_app_launch", description: "Open an app.", parameters: { type: "object", properties: { pid: { type: "integer" }, app_name: { type: "string" } }, oneOf: [{ required: ["pid"] }, { required: ["app_name"] }] } } };
    await claude.complete({ model: "claude-opus-5-5", baseUrl: "", apiKey: "k", messages: [{ role: "user", content: "hi" }], tools: [tool], temperature: 0, maxOutput: 64 } as never);
    const sent = (fake.bodies.at(-1)!.tools as { description: string; input_schema: Record<string, unknown> }[])[0]!;
    assert.equal("oneOf" in sent.input_schema, false);
    assert.equal(sent.description, "Open an app. Give exactly one of: pid, app_name.");
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previous;
    fake.server.close();
  }
});
