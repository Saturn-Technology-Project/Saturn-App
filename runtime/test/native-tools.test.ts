import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { toolTurns } from "../src/application/runs.js";
import type { RunAction, ToolRound } from "../src/domain/model.js";
import { claude } from "../src/infrastructure/llm/claude.js";
import { deepseek } from "../src/infrastructure/llm/deepseek.js";
import { geminiContents } from "../src/infrastructure/llm/gemini.js";
import { openAIChat, openAIResponses } from "../src/infrastructure/llm/openai.js";
import { flattenToolTurns } from "../src/infrastructure/llm/shared.js";
import type { ChatMessage } from "../src/infrastructure/llm/types.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

/** A server that records each JSON body and answers with `reply(body, index)`. */
async function recorder(reply: (body: Record<string, unknown>, index: number) => unknown) {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      bodies.push(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(reply(body, bodies.length - 1)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { bodies, server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

const PNG = "iVBORw0KGgo" + "A".repeat(300);

/** One round of two calls: the first ran and failed, the second never ran; then a round whose step took a screenshot. */
function sample(): { rounds: ToolRound[]; actions: RunAction[] } {
  return {
    rounds: [
      { calls: [{ id: "call_a", name: "code", arguments: { command: "npm test" } }, { id: "call_b", name: "files", arguments: { action: "read", path: "x" } }], text: "Running the tests.", thinking: "plan" },
      { calls: [{ id: "call_c", name: "browser_screenshot", arguments: {} }] },
    ],
    actions: [
      { id: "act_1", toolId: "code", arguments: { command: "npm test" }, status: "failed", reason: "exit 1", callId: "call_a" },
      { id: "act_2", toolId: "browser_screenshot", arguments: {}, status: "completed", result: { image: `data:image/png;base64,${PNG}` }, callId: "call_c" },
    ],
  };
}

test("a turn's steps become native tool turns: every call answered, failures marked, screenshots attached", () => {
  const { rounds, actions } = sample();
  const messages = toolTurns(rounds, actions);
  assert.deepEqual(messages.map((item) => item.role), ["assistant", "tool", "tool", "assistant", "tool"]);
  assert.deepEqual(messages[0]!.toolCalls?.map((call) => call.id), ["call_a", "call_b"]);
  assert.equal(messages[0]!.content, "Running the tests.");
  assert.equal(messages[0]!.reasoning, "plan");
  assert.equal(messages[1]!.toolCallId, "call_a");
  assert.equal(messages[1]!.failed, true);
  assert.deepEqual(JSON.parse(messages[1]!.content), { status: "failed", reason: "exit 1" });
  assert.match(messages[2]!.content, /not_run/, "the call the turn never ran still gets a result");
  assert.equal(messages[4]!.images?.[0]?.mimeType, "image/png");
  assert.doesNotMatch(messages[4]!.content, /base64/, "the pixels go as an image, not as text");

  // The text fallback reads like the format before: the steps as a JSON list, then a user turn.
  const flat = flattenToolTurns(messages);
  assert.deepEqual(flat.map((item) => item.role), ["assistant", "user", "assistant", "user"]);
  assert.deepEqual((JSON.parse(flat[0]!.content) as { toolId: string; status?: string }[]).map((step) => [step.toolId, step.status]), [["code", "failed"], ["files", "not_run"]]);
  assert.equal(flat[3]!.images?.length, 1);
});

test("Claude gets its own signed thinking and tool_use back, and results as tool_result; a round it did not write goes as text", async () => {
  const fake = await recorder((_body, index) => index === 0
    ? { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 }, content: [
      { type: "thinking", thinking: "I should run it.", signature: "sig-123" },
      { type: "text", text: "Running." },
      { type: "tool_use", id: "toolu_1", name: "code", input: { command: "ls" } },
    ] }
    : { id: "msg_2", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: "done" }] });
  const saved = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = fake.url;
  try {
    const base = { model: "claude-sonnet-5-5", baseUrl: "", apiKey: "k", tools: [{ type: "function", function: { name: "code", parameters: { type: "object", properties: {} } } }] };
    const first = await claude.complete({ ...base, messages: [{ role: "system", content: "sys" }, { role: "user", content: "list" }] });
    const message = (first.choices as { message: { tool_calls: { id: string }[]; replay?: { provider: string } } }[])[0]!.message;
    assert.equal(message.tool_calls[0]!.id, "toolu_1");
    assert.equal(message.replay?.provider, "claude");

    const turns: ChatMessage[] = [
      { role: "user", content: "list" },
      { role: "assistant", content: "Running.", toolCalls: [{ id: "toolu_1", name: "code", arguments: { command: "ls" } }], replay: message.replay as ChatMessage["replay"] },
      { role: "tool", content: JSON.stringify({ status: "completed", result: "a.txt" }), toolCallId: "toolu_1", toolName: "code" },
    ];
    await claude.complete({ ...base, messages: turns });
    const sent = fake.bodies[1]!.messages as { role: string; content: { type: string; signature?: string; id?: string; tool_use_id?: string }[] }[];
    assert.deepEqual(sent[1]!.content.map((block) => block.type), ["thinking", "text", "tool_use"]);
    assert.equal(sent[1]!.content[0]!.signature, "sig-123");
    assert.equal(sent[2]!.content[0]!.type, "tool_result");
    assert.equal(sent[2]!.content[0]!.tool_use_id, "toolu_1");

    // Another provider's round (no Claude reply to send back) while thinking is on: the steps go as text.
    await claude.complete({ ...base, messages: [turns[0]!, { ...turns[1]!, replay: undefined }, turns[2]!] });
    const fallback = fake.bodies[2]!.messages as { role: string; content: unknown }[];
    assert.equal(typeof fallback[1]!.content, "string");
    assert.match(String(fallback[1]!.content), /"toolId":"code"/);
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = saved;
    fake.server.close();
  }
});

test("OpenAI chat, OpenAI responses and DeepSeek get native tool calls with their ids; Gemini gets functionCall parts", async () => {
  const { rounds, actions } = sample();
  const messages: ChatMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "go" }, ...toolTurns(rounds, actions)];
  const chatReply = { id: "x", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }] };
  const chat = await recorder(() => chatReply);
  const responses = await recorder(() => ({ id: "r", object: "response", created_at: 0, model: "m", status: "completed", output: [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }] }));
  try {
    await openAIChat.complete({ model: "m", baseUrl: `${chat.url}/v1`, apiKey: "k", messages, tools: [] });
    const sent = chat.bodies[0]!.messages as { role: string; content: unknown; tool_calls?: { id: string }[]; tool_call_id?: string }[];
    assert.deepEqual(sent.map((item) => item.role), ["system", "user", "assistant", "tool", "tool", "assistant", "tool", "user"], "the screenshot follows the results as a user turn");
    assert.deepEqual(sent[2]!.tool_calls?.map((call) => call.id), ["call_a", "call_b"]);
    assert.equal(sent[3]!.tool_call_id, "call_a");

    await deepseek.complete({ model: "deepseek-chat", baseUrl: `${chat.url}/v1`, apiKey: "k", messages, tools: [{ type: "function", function: { name: "code" } }] });
    const ds = chat.bodies[1]!.messages as { role: string; reasoning_content?: string; tool_calls?: unknown[]; tool_call_id?: string }[];
    assert.equal(ds[2]!.reasoning_content, "plan", "DeepSeek gets its reasoning back with the calls");
    assert.equal(ds[3]!.tool_call_id, "call_a");

    await openAIResponses.complete({ model: "gpt-x", baseUrl: `${responses.url}/v1`, apiKey: "k", messages, tools: [] });
    const input = responses.bodies[0]!.input as { type?: string; role?: string; call_id?: string }[];
    assert.deepEqual(input.filter((item) => item.type === "function_call").map((item) => item.call_id), ["call_a", "call_b", "call_c"]);
    assert.deepEqual(input.filter((item) => item.type === "function_call_output").map((item) => item.call_id), ["call_a", "call_b", "call_c"]);
  } finally {
    chat.server.close();
    responses.server.close();
  }

  const gemini = geminiContents([{ role: "user", content: "go" }, { role: "assistant", content: "", toolCalls: [{ id: "g1", name: "code", arguments: { command: "ls" }, thoughtSignature: "ts-1" }] }, { role: "tool", content: JSON.stringify({ status: "completed", result: { out: "a" } }), toolCallId: "g1", toolName: "code" }]);
  assert.deepEqual(gemini.map((item) => item.role), ["user", "model", "user"]);
  assert.deepEqual(gemini[1]!.parts[0], { functionCall: { name: "code", args: { command: "ls" } }, thoughtSignature: "ts-1" });
  assert.equal((gemini[2]!.parts[0] as { functionResponse: { name: string } }).functionResponse.name, "code");
});

test("a reply with two calls that pauses for approval on the first: after approval, the second is answered as not run", async () => {
  const fake = await recorder((body) => {
    const messages = body.messages as { role: string }[];
    const answered = messages.some((item) => item.role === "tool");
    return { choices: [{ message: answered ? { content: "done" } : { content: "", tool_calls: [
      { id: "call_1", type: "function", function: { name: "code", arguments: JSON.stringify({ command: "echo one" }) } },
      { id: "call_2", type: "function", function: { name: "code", arguments: JSON.stringify({ command: "echo two" }) } },
    ] } }] };
  });
  try {
    const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-native-")));
    await store.load();
    const { services } = createApp(store);
    const model = await services.createModel({ name: "M", provider: "openai", baseUrl: fake.url });
    const agent = await services.createAgent({ name: "Careful", modelConnectionId: model.id, autonomy: "review" });
    const run = await services.startRun(agent.id, "do two things");
    for (let i = 0; i < 200 && services.kernel.getRun(run.id).status !== "waiting_approval"; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const waiting = services.kernel.getRun(run.id);
    assert.equal(waiting.rounds?.length, 1);
    assert.equal(waiting.actions[0]?.callId, "call_1");
    await services.kernel.runs.decide(run.id, waiting.actions[0]!.id, true);
    for (let i = 0; i < 200 && services.kernel.getRun(run.id).status !== "completed"; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(services.kernel.getRun(run.id).output, "done");
    const last = fake.bodies.at(-1)!.messages as { role: string; tool_call_id?: string; content?: string; tool_calls?: { id: string }[] }[];
    const results = last.filter((item) => item.role === "tool");
    assert.deepEqual(results.map((item) => item.tool_call_id), ["call_1", "call_2"]);
    assert.match(results[0]!.content ?? "", /"status":"completed"/);
    assert.match(results[1]!.content ?? "", /not_run/);
  } finally {
    fake.server.close();
  }
});

test("a server that rejects native tool turns gets them again as text, and the run goes on", async () => {
  const fake = await recorder((body) => {
    const messages = body.messages as { role: string; content?: string }[];
    if (messages.some((item) => item.role === "tool")) return { error: { message: "tool messages are not supported" } };
    const ran = messages.some((item) => item.role === "assistant" && String(item.content ?? "").includes('"toolId"'));
    return { choices: [{ message: ran ? { content: "done as text" } : { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "code", arguments: JSON.stringify({ command: "echo hi" }) } }] } }] };
  });
  const original = fake.server.listeners("request")[0] as (req: IncomingMessage, res: ServerResponse) => void;
  fake.server.removeAllListeners("request");
  fake.server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    // Answer 400 when the recorder's reply is an error.
    const end = res.end.bind(res);
    res.end = ((chunk: string) => {
      if (String(chunk).startsWith('{"error"')) res.statusCode = 400;
      return end(chunk);
    }) as typeof res.end;
    original(req, res);
  });
  try {
    const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-native-fallback-")));
    await store.load();
    const { services } = createApp(store);
    const model = await services.createModel({ name: "Old server", provider: "openai", baseUrl: fake.url });
    const agent = await services.createAgent({ name: "A", modelConnectionId: model.id, autonomy: "bypass" });
    const run = await services.startRun(agent.id, "hi");
    for (let i = 0; i < 200 && !["completed", "failed"].includes(services.kernel.getRun(run.id).status); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(services.kernel.getRun(run.id).status, "completed", services.kernel.getRun(run.id).error);
    assert.equal(services.kernel.getRun(run.id).output, "done as text");
  } finally {
    fake.server.close();
  }
});
