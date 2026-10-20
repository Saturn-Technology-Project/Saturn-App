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

test("Tab completion streams line by line, speaks a code model's FIM format, and stops where the suffix resumes", async () => {
  const { fimFormat, cutAtStop } = await import("../src/domain/fim.js");
  assert.equal(fimFormat("qwen2.5-coder-7b-instruct")?.family, "qwen-coder");
  assert.equal(fimFormat("Codestral-22B-v0.1")?.family, "codestral");
  assert.equal(fimFormat("gpt-4.1-mini"), undefined);
  assert.equal(cutAtStop("foo();\n<|fim_pad|>bar", ["<|fim_pad|>"]), "foo();\n");

  // A raw-completion server (the legacy /completions endpoint) that records the prompt and streams a body.
  const prompts: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as { prompt: string; stop: string[] };
      prompts.push(body.prompt);
      res.setHeader("content-type", "text/event-stream");
      const pieces = ["  return a", " + b;\n", "}\n", "\nfunction next() {}", "<|fim_pad|>junk"];
      for (const text of pieces) res.write(`data: ${JSON.stringify({ choices: [{ text, index: 0 }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-fim-")));
    await store.load();
    const { app, services } = createApp(store);
    const model = await services.createModel({ name: "Coder", provider: "openai", model: "qwen2.5-coder-1.5b", baseUrl: `http://127.0.0.1:${address.port}` });
    await services.updateSettings({ completionModelId: model.id });

    const listening = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => listening.once("listening", () => resolve()));
    try {
      const port = (listening.address() as { port: number }).port;
      useRuntimeAuth(`http://127.0.0.1:${port}`);
      const response = await fetch(`http://127.0.0.1:${port}/complete/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          language: "typescript",
          path: "src/add.ts",
          prefix: "function add(a: number, b: number) {\n",
          suffix: "\nfunction next() {}\n",
          recentEdits: [{ line: 1, before: "function sum(a, b) {", after: "function add(a: number, b: number) {" }],
        }),
      });
      assert.equal(response.headers.get("content-type"), "application/x-ndjson");
      const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as { text: string; done?: boolean; model?: string });
      assert.deepEqual(lines.map((line) => line.text), ["  return a + b;\n", "}\n", ""], "whole lines as they arrive; the echoed suffix and the stop token are cut");
      assert.equal(lines.at(-1)?.done, true);
      assert.equal(lines.at(-1)?.model, "qwen2.5-coder-1.5b");
    } finally {
      await new Promise((resolve) => listening.close(() => resolve(undefined)));
    }
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /^<\|fim_prefix\|>\/\/ Recent edits in this file:\n\/\/ @@ line 1 @@\n\/\/ - function sum\(a, b\) \{\n\/\/ \+ function add/, "recent edits lead the FIM prefix");
    assert.match(prompts[0]!, /<\|fim_prefix\|>[\s\S]*<\|fim_suffix\|>\nfunction next\(\) \{\}\n<\|fim_middle\|>$/, "Qwen's FIM tokens");
  } finally {
    server.close();
  }
});

test("the code index splits files into declarations, ranks chunks by cosine similarity, and reports its state", async () => {
  const { chunkFile } = await import("../src/domain/chunks.js");
  const { cosine } = await import("../src/application/index.js");
  const source = [
    "import x from 'x';",
    "",
    "/** Adds two numbers. */",
    "export function add(a: number, b: number) {",
    "  return a + b;",
    "}",
    "",
    "export class Counter {",
    "  count = 0;",
    "  bump() { this.count += 1; }",
    "}",
    "",
    "const helper = () => 1;",
  ].join("\n");
  const chunks = chunkFile("src/math.ts", source);
  assert.deepEqual(chunks.map((chunk) => [chunk.name, chunk.start, chunk.end]), [[undefined, 1, 2], ["add", 3, 7], ["Counter", 8, 12], ["helper", 13, 13]], "one chunk per declaration, with its doc comment");
  assert.equal(chunks[1]!.text.split("\n")[0], "/** Adds two numbers. */");
  const windows = chunkFile("notes.md", Array.from({ length: 130 }, (_, i) => `line ${i + 1}`).join("\n"));
  assert.deepEqual(windows.map((chunk) => [chunk.start, chunk.end]), [[1, 60], [51, 110], [101, 130]], "files without declarations get overlapping windows");
  assert.equal(cosine(new Float32Array([1, 0]), new Float32Array([1, 0])), 1);
  assert.equal(Math.round(cosine(new Float32Array([1, 0]), new Float32Array([0, 1])) * 100), 0);

  const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-index-")));
  await store.load();
  const { app, services } = createApp(store);
  const folder = await mkdtemp(path.join(os.tmpdir(), "saturn-index-project-"));
  const project = await services.createProject({ name: "P", path: folder });
  const listening = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listening.once("listening", () => resolve()));
  try {
    const port = (listening.address() as { port: number }).port;
    useRuntimeAuth(`http://127.0.0.1:${port}`);
    const status = (await (await fetch(`http://127.0.0.1:${port}/projects/${project.id}/index`)).json()) as { state: string; files: number };
    assert.deepEqual([status.state, status.files], ["empty", 0]);
    // No LM Studio in tests: a search says so instead of failing silently.
    const search = await fetch(`http://127.0.0.1:${port}/projects/${project.id}/index/search?q=adds+numbers`);
    assert.equal(search.status, 503);
    assert.match(((await search.json()) as { error: string }).error, /LM Studio is not running/);
  } finally {
    await new Promise((resolve) => listening.close(() => resolve(undefined)));
  }
});
