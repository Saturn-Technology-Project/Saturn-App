import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { openAIChat } from "../src/infrastructure/llm/openai.js";
import { retryAfterMs, withTransientRetry } from "../src/infrastructure/llm/shared.js";
import { clip, TEXT_LIMIT } from "../src/infrastructure/skills/text.js";

test("Retry-After is read in seconds or as a date, from the error or its cause, and waited for", async () => {
  assert.equal(retryAfterMs({ status: 429, headers: new Headers({ "retry-after": "2" }) }), 2000);
  assert.equal(retryAfterMs({ cause: { response: { headers: { "retry-after": "Wed, 21 Oct 2026 08:00:10 GMT" } } } }, Date.parse("Wed, 21 Oct 2026 08:00:00 GMT")), 10_000);
  assert.equal(retryAfterMs(new Error("no headers")), undefined);

  let calls = 0;
  const started = Date.now();
  const answer = await withTransientRetry(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("rate limited"), { status: 429, headers: { "retry-after": "0.2" } });
    return "ok";
  }, { delayMs: 5_000 });
  assert.equal(answer, "ok");
  const waited = Date.now() - started;
  assert.ok(waited >= 180 && waited < 2_000, `waited what Retry-After asked (${waited} ms), not the 5 s default`);
  await assert.rejects(withTransientRetry(async () => { throw Object.assign(new Error("bad key"), { status: 401 }); }), /bad key/, "not transient: no retry");
});

test("a clipped tool result says how much was cut and how to read less", () => {
  assert.equal(clip("short"), "short");
  const long = clip("x".repeat(TEXT_LIMIT + 1234));
  assert.ok(long.startsWith("x".repeat(TEXT_LIMIT)));
  assert.match(long, /…\[1234 more characters cut\. Read a narrower part/);
});

test("OpenAI-compatible servers get no prompt_cache_key, and cached prompt tokens are reported", async () => {
  let received: Record<string, unknown> = {};
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      received = JSON.parse(raw || "{}") as Record<string, unknown>;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } }], usage: { prompt_tokens: 1200, completion_tokens: 3, total_tokens: 1203, prompt_tokens_details: { cached_tokens: 1024 } } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const body = await openAIChat.complete({ model: "m", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: "k", messages: [{ role: "user", content: "hello" }], tools: [], cacheKey: "saturn:agent_1" });
    assert.equal(received.prompt_cache_key, undefined, "only api.openai.com takes the cache key");
    assert.deepEqual(body.usage, { input_tokens: 1200, output_tokens: 3, cached_input_tokens: 1024 });
  } finally {
    server.close();
  }
});
