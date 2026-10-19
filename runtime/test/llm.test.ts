import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { ModelConnection } from "../src/domain/model.js";
import { LlmBroker, providerKeyId } from "../src/infrastructure/llm.js";
import { deepseek } from "../src/infrastructure/llm/deepseek.js";
import { openAIChat } from "../src/infrastructure/llm/openai.js";

function vault(entries: Record<string, string>) {
  const keys = new Map(Object.entries(entries));
  return {
    keys,
    secret: (id: string) => keys.get(id),
    putSecret: async (id: string, value: string) => void keys.set(id, value),
  };
}

function model(provider: string, baseUrl: string, id = `mdl_${provider}`): ModelConnection {
  return { id, name: provider, provider, model: "m", baseUrl, hasSecret: false };
}

test("the broker sends each provider to its own SDK module", () => {
  const broker = new LlmBroker(vault({}));
  assert.equal(broker.adapterFor(model("gemini", "https://generativelanguage.googleapis.com")).id, "gemini");
  assert.equal(broker.adapterFor(model("claude", "https://api.anthropic.com")).id, "claude");
  assert.equal(broker.adapterFor(model("deepseek", "https://api.deepseek.com")).id, "deepseek");
  assert.equal(broker.adapterFor(model("lmstudio", "http://127.0.0.1:1234")).id, "lmstudio");
  assert.equal(broker.adapterFor(model("openai", "https://api.openai.com/v1")).id, "openai-responses");
  assert.equal(broker.adapterFor(model("openai", "http://127.0.0.1:8080/v1")).id, "openai-chat");
});

test("the broker picks the model's key before its provider's", async () => {
  const keys = vault({ [providerKeyId("gemini")]: "shared" });
  const broker = new LlmBroker(keys);
  const plain = model("gemini", "https://generativelanguage.googleapis.com", "mdl_a");
  const own = model("gemini", "https://generativelanguage.googleapis.com", "mdl_b");
  keys.keys.set("mdl_b", "own");
  assert.equal(broker.keyFor(plain), "shared");
  assert.equal(broker.keyFor(own), "own");

  await broker.saveKey(model("claude", "https://api.anthropic.com", "mdl_c"), "  ck  ");
  assert.equal(keys.keys.get("mdl_c"), "ck");
  assert.equal(keys.keys.get(providerKeyId("claude")), "ck");

  assert.throws(() => broker.requireKey(model("deepseek", "https://api.deepseek.com")), /no DeepSeek API key/);
  assert.doesNotThrow(() => broker.requireKey(model("openai", "http://127.0.0.1:8080/v1")));
});

test("DeepSeek gets reasoning_content back when tools are sent, and other servers never see it", async () => {
  const bodies: { messages: Record<string, unknown>[] }[] = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      bodies.push(JSON.parse(data));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const messages = [
    { role: "user" as const, content: "hi" },
    { role: "assistant" as const, content: "hello", reasoning: "greet back" },
    { role: "user" as const, content: "again" },
  ];
  const tool = { function: { name: "files", parameters: { type: "object", properties: {} } } };
  try {
    await deepseek.complete({ model: "deepseek-flash", baseUrl, apiKey: "k", messages, tools: [tool] });
    await deepseek.complete({ model: "deepseek-flash", baseUrl, apiKey: "k", messages, tools: [] });
    await openAIChat.complete({ model: "local", baseUrl, messages, tools: [] });
  } finally {
    server.close();
  }
  assert.equal(bodies[0]?.messages[1]?.reasoning_content, "greet back");
  assert.equal(bodies[1]?.messages[1]?.reasoning_content, undefined);
  assert.deepEqual(Object.keys(bodies[2]?.messages[1] ?? {}).sort(), ["content", "role"]);
});
