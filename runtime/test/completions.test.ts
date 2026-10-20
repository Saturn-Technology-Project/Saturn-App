import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";
import { useRuntimeAuth } from "./runtime-token.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

test("POST /complete serves Tab and Cmd+K from the completion model and records the usage", async () => {
  const bodies: { model: string; max_tokens?: number; tools?: unknown; messages: { role: string; content: string }[] }[] = [];
  const replies = ["```ts\nreturn a + b;\n```", "  return a - b;\n}\n", "const x = 1;"];
  const provider = createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      bodies.push(JSON.parse(data));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: replies[bodies.length - 1] ?? "" } }],
        usage: { prompt_tokens: 40, completion_tokens: 6 },
      }));
    });
  });
  const providerUrl = await listen(provider);
  const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-app-")));
  await store.load();
  const { app, services } = createApp(store);
  const runtime = createServer(app);
  const url = await listen(runtime);
  useRuntimeAuth(url);
  const post = (body: unknown) =>
    fetch(`${url}/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const none = await post({ kind: "inline", prefix: "a", suffix: "" });
    assert.equal(none.status, 409);
    assert.match((await none.json()).error, /Choose a completion model/);

    const fast = await services.createModel({ name: "Fast", provider: "openai", model: "fast-local", baseUrl: providerUrl });
    const settings = await (await fetch(`${url}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ completionModelId: fast.id }),
    })).json();
    assert.equal(settings.completionModelId, fast.id);

    const edit = await post({
      kind: "edit",
      language: "typescript",
      path: "src/math.ts",
      prefix: "function add(a: number, b: number) {\n",
      selection: "  return 0;",
      suffix: "\n}\n",
      instruction: "add the numbers",
    });
    assert.equal(edit.status, 200);
    assert.deepEqual(await edit.json(), { text: "return a + b;", modelId: fast.id, model: "fast-local" });
    assert.match(bodies[0]!.messages[1]!.content, /<selection>\n {2}return 0;\n<\/selection>/);
    assert.match(bodies[0]!.messages[1]!.content, /Instruction: add the numbers/);
    assert.equal(bodies[0]!.tools, undefined);

    // The model repeated the closing brace that already follows the cursor; it is dropped.
    const inline = await (await post({ kind: "inline", language: "typescript", prefix: "function sub(a, b) {\n", suffix: "\n}\n" })).json();
    assert.equal(inline.text, "  return a - b;");
    assert.match(bodies[1]!.messages[1]!.content, /\{\n<CURSOR>\n\}/);
    assert.ok((bodies[1]!.max_tokens ?? 0) <= 128);

    assert.equal((await post({ kind: "edit", instruction: " " })).status, 400);
    assert.equal((await post({ kind: "other" })).status, 400);

    const usage = store.state.usage.filter((record) => record.purpose === "completion");
    assert.equal(usage.length, 2);
    assert.equal(usage[0]!.agentId, "saturn-ide");
    assert.equal(usage[0]!.inputTokens, 40);

    await services.deleteConnection("models", fast.id);
    assert.equal(store.state.settings.completionModelId, null);
  } finally {
    runtime.close();
    provider.close();
  }
});

test("POST /complete writes a commit message from the diff, recent commits and draft", async () => {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  const replies = ["```\nCommit message: \"Math: add subtraction\n\nAdds sub() next to add().\"\n```"];
  const provider = createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      bodies.push(JSON.parse(data));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: replies[bodies.length - 1] ?? "" } }],
        usage: { prompt_tokens: 80, completion_tokens: 12 },
      }));
    });
  });
  const providerUrl = await listen(provider);
  const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-app-")));
  await store.load();
  const { app, services } = createApp(store);
  const runtime = createServer(app);
  const url = await listen(runtime);
  useRuntimeAuth(url);
  const post = (body: unknown) =>
    fetch(`${url}/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const fast = await services.createModel({ name: "Fast", provider: "openai", model: "fast-local", baseUrl: providerUrl });
    await services.updateSettings({ completionModelId: fast.id });

    assert.equal((await post({ kind: "commit", diff: " ", files: "" })).status, 400);

    const commit = await post({
      kind: "commit",
      branch: "main",
      files: "M src/math.ts",
      diff: "diff --git a/src/math.ts b/src/math.ts\n+export const sub = (a, b) => a - b;\n",
      recentCommits: ["Math: add add()\n\nlong body", "Docs: explain math"],
      draft: "add sub",
      instruction: "Write in English.",
    });
    assert.equal(commit.status, 200);
    assert.equal((await commit.json()).text, "Math: add subtraction\n\nAdds sub() next to add().");
    const prompt = bodies[0]!.messages[1]!.content;
    assert.match(prompt, /Branch: main/);
    assert.match(prompt, /<recent_commits>\n- Math: add add\(\)\n- Docs: explain math\n<\/recent_commits>/);
    assert.match(prompt, /<files>\nM src\/math\.ts\n<\/files>/);
    assert.match(prompt, /<draft>\nadd sub\n<\/draft>/);
    assert.match(prompt, /Instructions: Write in English\./);
  } finally {
    runtime.close();
    provider.close();
  }
});
