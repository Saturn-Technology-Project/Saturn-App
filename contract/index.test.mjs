// The project's semantic code index, whichever language runs it, with a fake embedding model: what is indexed, what a
// search answers, and that one runtime reads the index file the other wrote.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { startRuntime } from "./runtime.mjs";

let runtime;
let scratch;
const servers = [];

before(async () => {
  runtime = await startRuntime();
  scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "saturn-contract-index-")));
});
after(async () => {
  await runtime?.stop();
  await Promise.all(servers.map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
  await rm(scratch, { recursive: true, force: true });
});

async function call(method, route, body) {
  const token = (await readFile(path.join(runtime.dataDir, "runtime-token"), "utf8")).trim();
  const response = await fetch(`${runtime.origin}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function api(method, route, body) {
  const answer = await call(method, route, body);
  assert.ok(answer.status < 300, `${method} ${route}: ${answer.status} ${JSON.stringify(answer.body)}`);
  return answer.body;
}

/** The vector for a text: which of the words it mentions, plus a little so no vector is all zeros. */
const vectorOf = (text) => [/token/i.test(text) ? 1 : 0, /sandbox/i.test(text) ? 1 : 0, 0.1];

/** A fake `/embeddings` endpoint; `hold` delays answers, `fail` answers with an error instead. */
async function embeddingServer() {
  const seen = { inputs: [], authorizations: [], paths: [], models: [] };
  const control = { hold: undefined, fail: undefined };
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", async () => {
      const body = JSON.parse(raw);
      seen.paths.push(request.url);
      seen.authorizations.push(request.headers.authorization);
      seen.models.push(body.model);
      seen.inputs.push(...body.input);
      if (control.hold) await control.hold;
      if (control.fail) {
        response.writeHead(control.fail.status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: control.fail.message } }));
        return;
      }
      const data = body.input.map((text, index) => {
        const vector = vectorOf(text);
        const embedding = body.encoding_format === "base64" ? Buffer.from(Float32Array.from(vector).buffer).toString("base64") : vector;
        return { object: "embedding", index, embedding };
      });
      // Out of order on purpose: the index field is what says which is which.
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", model: body.model, data: data.reverse(), usage: { prompt_tokens: 1, total_tokens: 1 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { seen, control, url: `http://127.0.0.1:${server.address().port}` };
}

/** A folder registered as a project, with `files` written into it. */
async function project(name, files) {
  const folder = path.join(scratch, name);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(folder, file)), { recursive: true });
    await writeFile(path.join(folder, file), content);
  }
  await mkdir(folder, { recursive: true });
  return { folder, ...(await api("POST", "/projects", { path: folder, grant: true })) };
}

async function until(what, read, done) {
  let value;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`never happened: ${what}; last ${JSON.stringify(value)}`);
}

const settledIndex = (id) => until("the index settles", () => api("GET", `/projects/${id}/index`), (status) => status.state !== "building");
const build = async (id, body) => {
  await api("POST", `/projects/${id}/index`, body);
  return settledIndex(id);
};

const AUTH = `// Reads the token.
export function readToken() {
  return "token";
}

export function runSandbox() {
  return "sandbox";
}
`;

// First in the file: no connection exists yet, so the OpenAI source has nothing to use.
test("the OpenAI source with no connection says to choose one", async () => {
  const empty = await project("no-connection", { "a.ts": "export const a = 1;\n" });
  await api("PATCH", "/settings", { embeddingSource: "openai" });
  const refused = await call("GET", `/projects/${empty.id}/index/search?q=a`);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /Choose the OpenAI-compatible connection/);
});

test("indexing: only code and text in the project, chunked by declaration, and a search ranks by similarity", async () => {
  const embeddings = await embeddingServer();
  const connection = await api("POST", "/connections/models", { name: "Embed", provider: "openai", model: "x", baseUrl: embeddings.url, secret: "embedding-test-value" });
  await api("PATCH", "/settings", { embeddingSource: "openai", embeddingModel: "embed-one", embeddingConnectionId: connection.id });

  await writeFile(path.join(scratch, "outside-secret.ts"), "export const OUTSIDE_SECRET = 'do not embed';\n");
  await mkdir(path.join(scratch, "outside-folder"), { recursive: true });
  await writeFile(path.join(scratch, "outside-folder", "inner.ts"), "export const OUTSIDE_INNER = 1;\n");
  await mkdir(path.join(scratch, "code-sibling"), { recursive: true });
  await writeFile(path.join(scratch, "code-sibling", "next.ts"), "export const SIBLING_FOLDER = 1;\n");
  const code = await project("code", {
    "src/auth.ts": AUTH,
    "README.md": "# Sandbox guide\n",
    ".github/ci.yml": "name: token check\n",
    ".env": "HIDDEN_VALUE=1\n",
    ".hidden/skip.ts": "export const HIDDEN_FOLDER = 1;\n",
    "node_modules/dep/index.js": "export const VENDORED = 1;\n",
    "dist/out.js": "export const BUILT = 1;\n",
    "photo.png": "export const NOT_TEXT_KIND = 1;\n",
    "binary.ts": "export const BINARY = 1;\0\n",
    "huge.ts": `// HUGE\n${"x".repeat(1_000_001)}\n`,
  });
  await symlink(path.join(scratch, "outside-secret.ts"), path.join(code.folder, "link.ts"));
  await symlink(path.join(scratch, "outside-folder"), path.join(code.folder, "linked-folder"));

  const empty = await api("GET", `/projects/${code.id}/index`);
  assert.deepEqual(empty, { projectId: code.id, state: "empty", files: 0, chunks: 0 });

  const ready = await build(code.id);
  assert.equal(ready.state, "ready", ready.error);
  assert.equal(ready.files, 3);
  assert.equal(ready.chunks, 4);
  assert.equal(ready.pending, undefined);
  assert.equal(ready.model, `openai:${embeddings.url}:embed-one`);
  assert.ok(!Number.isNaN(Date.parse(ready.updatedAt)));

  assert.ok(embeddings.seen.paths.every((item) => item === "/embeddings"), embeddings.seen.paths.join());
  assert.ok(embeddings.seen.authorizations.every((item) => item === "Bearer embedding-test-value"));
  assert.ok(embeddings.seen.models.every((item) => item === "embed-one"));
  const sent = embeddings.seen.inputs.join("\n");
  assert.ok(sent.includes(`src/auth.ts readToken\n// Reads the token.`), sent);
  assert.ok(sent.includes(".github/ci.yml\nname: token check"), sent);
  for (const skipped of ["OUTSIDE_SECRET", "OUTSIDE_INNER", "HIDDEN_VALUE", "HIDDEN_FOLDER", "VENDORED", "BUILT", "NOT_TEXT_KIND", "BINARY", "HUGE"]) {
    assert.ok(!sent.includes(skipped), `${skipped} was sent to the embedding model`);
  }

  const hits = await api("GET", `/projects/${code.id}/index/search?q=${encodeURIComponent("where is the token")}`);
  assert.deepEqual(hits.find((hit) => hit.path === ".github/ci.yml"), { path: ".github/ci.yml", start: 1, end: 2, score: 1, text: "name: token check\n" });
  assert.deepEqual(hits.find((hit) => hit.name === "readToken"), { path: "src/auth.ts", start: 1, end: 5, name: "readToken", score: 1, text: `// Reads the token.\nexport function readToken() {\n  return "token";\n}\n` });
  assert.deepEqual(hits.find((hit) => hit.name === "runSandbox"), { path: "src/auth.ts", start: 6, end: 9, name: "runSandbox", score: 0.01, text: `export function runSandbox() {\n  return "sandbox";\n}\n` });
  assert.equal(hits.length, 4);
  assert.deepEqual(hits.map((hit) => hit.score), [1, 1, 0.01, 0.01], "best first");
  assert.equal((await api("GET", `/projects/${code.id}/index/search?q=token&limit=1`)).length, 1);
  assert.deepEqual(await api("GET", `/projects/${code.id}/index/search?q=${encodeURIComponent("   ")}`), []);

  // Unchanged files are not embedded again; a changed one is, and one that is gone is forgotten.
  embeddings.seen.inputs.length = 0;
  await writeFile(path.join(code.folder, "README.md"), "# Sandbox manual\n");
  await rm(path.join(code.folder, ".github/ci.yml"));
  const changed = await build(code.id);
  assert.deepEqual(embeddings.seen.inputs, ["README.md\n# Sandbox manual\n"]);
  assert.equal(changed.files, 2);
  assert.equal(changed.chunks, 3);

  // A pass over named files: they get the same rules, so a link, a hidden file or a folder beside the project stays out.
  embeddings.seen.inputs.length = 0;
  await writeFile(path.join(code.folder, "src/new.ts"), "export const fresh = 'token';\n");
  const named = await build(code.id, { paths: ["src/new.ts", "src/auth.ts", "link.ts", "linked-folder/inner.ts", ".env", "photo.png", "node_modules/dep/index.js", "../code-sibling/next.ts", "../outside-secret.ts", "missing.ts"] });
  assert.deepEqual(embeddings.seen.inputs, ["src/new.ts\nexport const fresh = 'token';\n"]);
  assert.equal(named.files, 3, "a pass over named files forgets nothing else");
  assert.equal(named.state, "ready");
});

test("the index file is the same on both runtimes: one reads what the other wrote", async () => {
  const embeddings = await embeddingServer();
  const connection = await api("POST", "/connections/models", { name: "Embed", provider: "openai", model: "x", baseUrl: embeddings.url });
  await api("PATCH", "/settings", { embeddingSource: "openai", embeddingModel: "embed-file", embeddingConnectionId: connection.id });
  const written = await project("written", { "only.ts": "export const token = 1;\n" });
  await build(written.id);
  const file = path.join(runtime.dataDir, "index", `${written.id}.db`);
  const reader = new DatabaseSync(file, { readOnly: true });
  const row = reader.prepare("SELECT path, start, end, name, text, vector FROM chunks").get();
  assert.equal(row.path, "only.ts");
  assert.equal(row.start, 1);
  assert.equal(row.text, "export const token = 1;\n");
  assert.equal(row.name, null);
  assert.deepEqual([...new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength))].map((value) => Math.round(value * 10) / 10), [1, 0, 0.1]);
  assert.equal(reader.prepare("SELECT value FROM meta WHERE key = 'embedder'").get().value, `openai:${embeddings.url}:embed-file`);
  assert.match(reader.prepare("SELECT hash FROM files").get().hash, /^[0-9a-f]{40}$/);
  reader.close();

  // An index written before this runtime started, with the same layout, answers searches.
  const seeded = await project("seeded", {});
  await mkdir(path.join(runtime.dataDir, "index"), { recursive: true });
  const writer = new DatabaseSync(path.join(runtime.dataDir, "index", `${seeded.id}.db`));
  writer.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, indexed_at TEXT NOT NULL);
    CREATE TABLE chunks (id INTEGER PRIMARY KEY, path TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, name TEXT, text TEXT NOT NULL, vector BLOB NOT NULL);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  writer.prepare("INSERT INTO files VALUES ('old.ts', 'abc', '2026-01-01T00:00:00.000Z')").run();
  writer.prepare("INSERT INTO chunks (path, start, end, name, text, vector) VALUES (?, ?, ?, ?, ?, ?)").run("old.ts", 3, 9, "oldName", "the old text", new Uint8Array(Float32Array.from([1, 0, 0]).buffer));
  writer.prepare("INSERT INTO meta VALUES ('embedder', ?)").run(`openai:${embeddings.url}:embed-file`);
  writer.prepare("INSERT INTO meta VALUES ('updated_at', '2026-01-01T00:00:00.000Z')").run();
  writer.close();
  assert.deepEqual(await api("GET", `/projects/${seeded.id}/index/search?q=token`), [{ path: "old.ts", start: 3, end: 9, name: "oldName", score: 0.995, text: "the old text" }]);
  const status = await api("GET", `/projects/${seeded.id}/index`);
  assert.deepEqual(status, { projectId: seeded.id, state: "ready", files: 1, chunks: 1, model: `openai:${embeddings.url}:embed-file`, updatedAt: "2026-01-01T00:00:00.000Z" });
});

test("another embedding model: a search asks to wait, and the index is rebuilt with it", async () => {
  const embeddings = await embeddingServer();
  const connection = await api("POST", "/connections/models", { name: "Embed", provider: "openai", model: "x", baseUrl: embeddings.url });
  await api("PATCH", "/settings", { embeddingSource: "openai", embeddingModel: "embed-a", embeddingConnectionId: connection.id });
  const code = await project("switching", { "a.ts": "export const token = 1;\n" });
  assert.equal((await build(code.id)).model, `openai:${embeddings.url}:embed-a`);

  await api("PATCH", "/settings", { embeddingModel: "embed-b" });
  const refused = await call("GET", `/projects/${code.id}/index/search?q=token`);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /built with openai:.*embed-a; it is being rebuilt with openai:.*embed-b\. Search again in a moment\./);
  const rebuilt = await until("the rebuild", () => api("GET", `/projects/${code.id}/index`), (status) => status.state === "ready" && status.model.endsWith("embed-b"));
  assert.equal(rebuilt.chunks, 1);
  assert.equal(embeddings.seen.models.at(-1), "embed-b");
  assert.equal((await api("GET", `/projects/${code.id}/index/search?q=token`)).length, 1);
});

test("a build that fails says why and never shows the key; the next one starts over; cancelling leaves no error", async () => {
  const embeddings = await embeddingServer();
  const connection = await api("POST", "/connections/models", { name: "Embed", provider: "openai", model: "x", baseUrl: embeddings.url, secret: "embedding-secret-value" });
  await api("PATCH", "/settings", { embeddingSource: "openai", embeddingModel: "embed-c", embeddingConnectionId: connection.id });
  const code = await project("failing", { "a.ts": "export const token = 1;\n", "b.ts": "export const sandbox = 2;\n" });

  embeddings.control.fail = { status: 500, message: "the model fell over" };
  const failed = await build(code.id);
  assert.equal(failed.state, "error");
  assert.match(failed.error, /the model fell over/);
  assert.ok(!JSON.stringify(failed).includes("embedding-secret-value"));

  embeddings.control.fail = undefined;
  const fine = await build(code.id);
  assert.equal(fine.state, "ready");
  assert.equal(fine.error, undefined);
  assert.equal(fine.files, 2);

  // Held on the first file: while it waits the status says building, and DELETE ends the pass.
  let release;
  embeddings.control.hold = new Promise((resolve) => { release = resolve; });
  await writeFile(path.join(code.folder, "a.ts"), "export const token = 2;\n");
  await writeFile(path.join(code.folder, "b.ts"), "export const sandbox = 3;\n");
  const count = embeddings.seen.inputs.length;
  await api("POST", `/projects/${code.id}/index`);
  const busy = await until("the embedding request", () => api("GET", `/projects/${code.id}/index`), (status) => status.state === "building" && status.pending === 2 && embeddings.seen.inputs.length > count);
  assert.equal(busy.pending, 2);
  // A second build while one runs is the same build.
  assert.equal((await api("POST", `/projects/${code.id}/index`)).state, "building");
  const answered = await api("DELETE", `/projects/${code.id}/index`);
  assert.equal(answered.projectId, code.id);
  release();
  embeddings.control.hold = undefined;
  const stopped = await settledIndex(code.id);
  assert.equal(stopped.state, "ready");
  assert.equal(stopped.error, undefined);
  assert.equal(embeddings.seen.inputs.length, count + 1, "the second file was never sent");
});

test("LM Studio: its own address and key, and a clear answer when it is off or lacks the model", async () => {
  const embeddings = await embeddingServer();
  await api("POST", "/connections/models", { name: "LM", provider: "lmstudio", model: "x", baseUrl: embeddings.url });
  await api("PATCH", "/settings", { embeddingSource: "lmstudio", embeddingModel: "nomic-test" });
  const code = await project("lmstudio", { "a.ts": "export const token = 1;\n" });
  const ready = await build(code.id);
  assert.equal(ready.state, "ready", ready.error);
  assert.equal(ready.model, "lmstudio:nomic-test");
  assert.deepEqual([...new Set(embeddings.seen.paths)], ["/v1/embeddings"]);
  assert.deepEqual([...new Set(embeddings.seen.authorizations)], ["Bearer lm-studio"]);

  embeddings.control.fail = { status: 404, message: "model not found" };
  const fresh = await project("lmstudio-missing", { "a.ts": "export const token = 1;\n" });
  const missing = await call("GET", `/projects/${fresh.id}/index/search?q=token`);
  assert.equal(missing.status, 409);
  assert.match(missing.body.error, /The embedding model "nomic-test" is not downloaded in LM Studio/);
  embeddings.control.fail = undefined;

  await new Promise((resolve) => { const server = servers.at(-1); server.closeAllConnections(); server.close(resolve); });
  servers.pop();
  const off = await call("GET", `/projects/${fresh.id}/index/search?q=token`);
  assert.equal(off.status, 503);
  assert.match(off.body.error, /LM Studio is not running/);
});

// Runs only where the built-in model is on disk (SATURN_MODELS_DIR), as the runtime's own test of it does.
test("the built-in model: a Chinese question finds the English code it is about", { skip: process.env.SATURN_MODELS_DIR ? false : "SATURN_MODELS_DIR is not set" }, async () => {
  await api("PATCH", "/settings", { embeddingSource: "builtin", embeddingModel: "" });
  const code = await project("builtin", {
    "images.js": "function parseImages(raw) { /* checks attached images: data URLs, known types, size limit */ }\nfunction other() {}\n",
    "rules.js": "export async function projectRules(root) { /* reads AGENTS.md and .cursorrules into the prompt */ }\nfunction other() {}\n",
    "revert.js": "class CheckpointService { revert(runId) { /* restore the original bytes of files an agent changed */ } }\nfunction other() {}\n",
  });
  const ready = await build(code.id);
  assert.equal(ready.state, "ready", ready.error);
  assert.equal(ready.model, "builtin:multilingual-e5-small");
  const best = async (question) => (await api("GET", `/projects/${code.id}/index/search?limit=1&q=${encodeURIComponent(question)}`))[0].path;
  assert.equal(await best("還原 agent 改過的檔案"), "revert.js");
  assert.equal(await best("讀取專案規則"), "rules.js");
  assert.equal(await best("檢查使用者附加的圖片大小"), "images.js");
});
