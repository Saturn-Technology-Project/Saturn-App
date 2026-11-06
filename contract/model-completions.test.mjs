// The editor's completions, whichever language runs the runtime: the background model setting, what each kind asks the
// model, and how Tab streams from a code model's raw endpoint. All models here are fake, on this computer.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { api, fakeModel, fakeServer, request } from "./model-harness.mjs";
import { startRuntime } from "./runtime.mjs";

let runtime;
const stops = [];

before(async () => {
  runtime = await startRuntime();
});
after(async () => {
  await runtime?.stop();
  await Promise.all(stops.map((stop) => stop()));
});

/** A fake chat model answering each request with the next of `replies`. */
async function chatModel(replies) {
  let next = 0;
  const server = await fakeModel(() => replies[next++] ?? "");
  stops.push(server.stop);
  return server;
}

/** Makes `model` the background model and gives its connection. */
async function background(model, name = "fast-local") {
  const connection = await api(runtime, "POST", "/connections/models", { name: "Fast", provider: "openai", model: name, baseUrl: model.url, apiKey: "scripted-test-value" });
  assert.equal((await api(runtime, "PATCH", "/settings", { completionModelId: connection.id })).completionModelId, connection.id);
  return connection;
}

/** The prompt part of a completion request. */
const promptOf = (body) => body.messages[1].content;

/** The output limit a completion request gave. */
const limitOf = (body) => body.max_tokens ?? body.max_completion_tokens;

test("completions without a background model ask for one; with one they use it, clean its answer and file the usage; removing it turns them off", async () => {
  const none = await request(runtime, "POST", "/complete", { kind: "inline", prefix: "a", suffix: "" });
  assert.equal(none.status, 409);
  assert.match(none.body.error, /Choose a background model/);

  const model = await chatModel(["```ts\nreturn a + b;\n```", "  return a - b;\n}\n"]);
  const fast = await background(model);
  const before = (await api(runtime, "GET", "/usage/summary")).totals;

  const edit = await api(runtime, "POST", "/complete", {
    kind: "edit",
    language: "typescript",
    path: "src/math.ts",
    prefix: "function add(a: number, b: number) {\n",
    selection: "  return 0;",
    suffix: "\n}\n",
    instruction: "add the numbers",
  });
  assert.deepEqual(edit, { text: "return a + b;", modelId: fast.id, model: "fast-local" });
  assert.match(promptOf(model.requests[0]), /<selection>\n {2}return 0;\n<\/selection>/);
  assert.match(promptOf(model.requests[0]), /Instruction: add the numbers/);
  assert.equal(model.requests[0].tools, undefined, "a completion offers no tools");

  // The model repeated the closing brace that already follows the cursor; it is dropped.
  const inline = await api(runtime, "POST", "/complete", { kind: "inline", language: "typescript", prefix: "function sub(a, b) {\n", suffix: "\n}\n" });
  assert.equal(inline.text, "  return a - b;");
  assert.match(promptOf(model.requests[1]), /\{\n<CURSOR>\n\}/);
  assert.equal(limitOf(model.requests[1]), 1024, "the budget leaves thinking models room to answer");

  await api(runtime, "POST", "/complete", { kind: "inline", prefix: "a", suffix: "", maxTokens: 64 });
  assert.equal(limitOf(model.requests[2]), 64, "the editor can ask for less");
  await api(runtime, "POST", "/complete", { kind: "inline", prefix: "a", suffix: "", maxTokens: 1 });
  assert.equal(limitOf(model.requests[3]), 16, "but not for nothing");

  assert.equal((await request(runtime, "POST", "/complete", { kind: "edit", instruction: " " })).status, 400);
  assert.equal((await request(runtime, "POST", "/complete", { kind: "other" })).status, 400);
  assert.equal(model.requests.length, 4, "a refused request asks nothing");

  const usage = await api(runtime, "GET", "/usage/summary");
  assert.equal(usage.totals.calls - before.calls, 4);
  assert.equal(usage.totals.inputTokens - before.inputTokens, 160);
  assert.ok(usage.agents.some((item) => item.agentId === "saturn-ide" && item.name === "Editor features"));

  await api(runtime, "DELETE", `/connections/models/${fast.id}`);
  assert.equal((await api(runtime, "GET", "/settings")).completionModelId ?? null, null);
  assert.equal((await request(runtime, "POST", "/complete", { kind: "inline", prefix: "a", suffix: "" })).status, 409);
});

test("a commit message is written from the diff, recent commits and draft, and comes back as just the message", async () => {
  const model = await chatModel(["```\nCommit message: \"Math: add subtraction\n\nAdds sub() next to add().\"\n```"]);
  await background(model);
  assert.equal((await request(runtime, "POST", "/complete", { kind: "commit", diff: " ", files: "" })).status, 400);
  const commit = await api(runtime, "POST", "/complete", {
    kind: "commit",
    branch: "main",
    files: "M src/math.ts",
    diff: "diff --git a/src/math.ts b/src/math.ts\n+export const sub = (a, b) => a - b;\n",
    recentCommits: ["Math: add add()\n\nlong body", "Docs: explain math"],
    draft: "add sub",
    instruction: "Write in English.",
  });
  assert.equal(commit.text, "Math: add subtraction\n\nAdds sub() next to add().");
  const prompt = promptOf(model.requests[0]);
  assert.match(prompt, /Branch: main/);
  assert.match(prompt, /<recent_commits>\n- Math: add add\(\)\n- Docs: explain math\n<\/recent_commits>/, "only each commit's first line");
  assert.match(prompt, /<files>\nM src\/math\.ts\n<\/files>/);
  assert.match(prompt, /<draft>\nadd sub\n<\/draft>/);
  assert.match(prompt, /Instructions: Write in English\./);
});

/** A raw-completion server streaming `pieces` to any request, keeping each prompt. */
async function rawCompletions(pieces) {
  const server = await fakeServer((_body, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const text of pieces) response.write(`data: ${JSON.stringify({ choices: [{ text, index: 0 }] })}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
  });
  stops.push(server.stop);
  return server;
}

/** The lines of a Tab stream. */
async function streamLines(body) {
  const answer = await request(runtime, "POST", "/complete/stream", body);
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get("content-type"), "application/x-ndjson");
  return (typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body)).trim().split("\n").map((line) => JSON.parse(line));
}

test("Tab streams whole lines from a code model, cuts the echoed suffix and the stop token, and leads with the recent edits", async () => {
  const server = await rawCompletions(["  return a", " + b;\n", "}\n", "\nfunction next() {}", "<|fim_pad|>junk"]);
  await background(server, "qwen2.5-coder-1.5b");
  const lines = await streamLines({
    language: "typescript",
    path: "src/add.ts",
    prefix: "function add(a: number, b: number) {\n",
    suffix: "\nfunction next() {}\n",
    recentEdits: [{ line: 1, before: "function sum(a, b) {", after: "function add(a: number, b: number) {" }],
  });
  assert.deepEqual(lines.map((line) => line.text), ["  return a + b;\n", "}\n", ""]);
  assert.equal(lines.at(-1).done, true);
  assert.equal(lines.at(-1).model, "qwen2.5-coder-1.5b");
  assert.equal(server.requests.length, 1);
  assert.match(server.requests[0].__url, /\/completions$/);
  const { prompt } = server.requests[0];
  assert.match(prompt, /^<\|fim_prefix\|>\/\/ Recent edits in this file:\n\/\/ @@ line 1 @@\n\/\/ - function sum\(a, b\) \{\n\/\/ \+ function add/);
  assert.match(prompt, /<\|fim_prefix\|>[\s\S]*<\|fim_suffix\|>\nfunction next\(\) \{\}\n<\|fim_middle\|>$/);
});

test("Tab gives a code model other files' definitions: as a repository when it has that format, as comments otherwise", async () => {
  const context = [{ path: "src/util.py", text: "def add(a, b): ..." }];
  const star = await rawCompletions(["x\n"]);
  await background(star, "starcoder2-3b");
  await streamLines({ language: "python", path: "main.py", prefix: "a", suffix: "b", context });
  assert.ok(star.requests[0].prompt.startsWith("<repo_name>project<file_sep>src/util.py\ndef add(a, b): ...\n<file_sep>main.py\n"), star.requests[0].prompt);

  const deepseek = await rawCompletions(["x\n"]);
  await background(deepseek, "deepseek-coder-6.7b");
  await streamLines({ language: "python", path: "main.py", prefix: "a", suffix: "b", context });
  assert.ok(deepseek.requests[0].prompt.includes("# From src/util.py:\n# def add(a, b): ...\n\n"), deepseek.requests[0].prompt);
  assert.ok(!deepseek.requests[0].prompt.includes("file_sep"), deepseek.requests[0].prompt);
});
