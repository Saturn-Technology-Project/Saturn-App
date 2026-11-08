// Installed LSP processes are stand-ins. All boundaries, child lifetime, framing and settings run through real Rust.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { bench, posixOnly, until } from "./files-support.mjs";

let saturn, tools, token;
before(async () => {
  tools = await mkdtemp(path.join(os.tmpdir(), "saturn-lsp-tools-"));
  const fixture = fileURLToPath(new URL("./fixtures/language-server.mjs", import.meta.url));
  for (const name of ["basedpyright-langserver", "pyright-langserver", "typescript-language-server", "rust-analyzer"]) {
    await writeFile(path.join(tools, name), `#!${process.execPath}\nawait import(${JSON.stringify(pathToFileURL(fixture).href)});\n`);
    await chmod(path.join(tools, name), 0o755);
  }
  saturn = await bench({ env: { PATH: `${tools}${path.delimiter}${process.env.PATH}` } });
  token = (await readFile(path.join(saturn.runtime.dataDir, "runtime-token"), "utf8")).trim();
});
after(async () => { await saturn?.stop(); await rm(tools, { recursive: true, force: true }); });

/** A granted project with a selected interpreter; no interpreter or model is executed by the stand-in server. */
async function project(mode = "") {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "main.py"), "result = 1\n");
  await writeFile(path.join(folder, "helpers.py"), "\n\ndef train():\n    pass\n");
  if (mode) await writeFile(path.join(folder, "lsp-mode"), mode);
  const made = await saturn.api("POST", "/projects", { path: folder, grant: true });
  const base = `/projects/${made.id}/research`;
  await saturn.api("PUT", `${base}/environment`, { python: process.execPath });
  return { folder, base, id: made.id };
}

/** Open the authenticated event stream, gathering whole events while tests make requests. */
async function client(base, language = "python") {
  const session = await saturn.api("POST", `${base}/lsp/start`, { language });
  const route = `${base}/lsp/${session.id}`;
  const controller = new AbortController(), messages = [];
  const response = await fetch(`${saturn.runtime.origin}${route}/events`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const reading = (async () => {
    let buffer = ""; const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = /^data: (.*)$/m.exec(block)?.[1]; if (data) messages.push(JSON.parse(data));
        }
      }
    } catch (error) { if (!controller.signal.aborted) throw error; }
  })();
  let next = 0;
  const send = message => saturn.api("POST", `${route}/messages`, { messages: [{ jsonrpc: "2.0", ...message }] });
  const request = async (method, params) => {
    const id = ++next; await send({ id, method, params });
    const answer = await until(method, () => Promise.resolve(messages.find(event => event.message?.id === id)?.message), Boolean);
    assert.equal(answer.error, undefined, JSON.stringify(answer)); return answer.result;
  };
  return { session, route, messages, send, request, close: async () => { controller.abort(); await reading; await saturn.call("DELETE", route); } };
}

test("real stdio framing carries initialization, project Python settings, changes and semantic requests", posixOnly, async () => {
  const { folder, base } = await project(); const c = await client(base);
  try {
    assert.equal(c.session.server, "basedpyright");
    const capabilities = await c.request("initialize", { capabilities: {}, rootUri: "file:///wrong-root", initializationOptions: { plugins: [{ name: "unrequested-plugin" }] } });
    assert.equal(capabilities.capabilities.hoverProvider, true);
    const seen = await until("configuration reply", async () => (await readFile(path.join(folder, "lsp-received.jsonl"), "utf8")).trim().split("\n").map(JSON.parse), rows => rows.some(row => row.id === 900 && row.result));
    assert.equal(seen[0].params.rootUri, c.session.rootUri);
    assert.deepEqual(seen[0].params.initializationOptions, {});
    assert.equal(seen.find(row => row.id === 900).result[0].pythonPath, process.execPath);
    const refusedEdit = await until("server edit refusal", async () => (await readFile(path.join(folder, "lsp-received.jsonl"), "utf8")).trim().split("\n").map(JSON.parse).find(row => row.id === 901 && row.result));
    assert.equal(refusedEdit.result.applied, false);
    const uri = `${c.session.rootUri}main.py`;
    await c.send({ method: "initialized", params: {} });
    await c.send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "python", version: 1, text: 'name = "🪐"\nname.' } } });
    const position = { line: 1, character: 5 };
    assert.equal((await c.request("textDocument/completion", { textDocument: { uri }, position }))[0].label, "upper");
    assert.match((await c.request("textDocument/hover", { textDocument: { uri }, position })).contents.value, /result: int/);
    assert.equal((await c.request("textDocument/diagnostic", { textDocument: { uri } })).items[0].message, "Pulled type error");
    assert.match((await c.request("textDocument/signatureHelp", { textDocument: { uri }, position })).signatures[0].label, /steps: int/);
    assert.equal((await c.request("textDocument/definition", { textDocument: { uri }, position })).uri, `${c.session.rootUri}helpers.py`);
    await c.send({ method: "textDocument/didChange", params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: "bad = 1" }] } });
    const diagnostic = await until("diagnostic", () => Promise.resolve(c.messages.find(event => event.message?.method === "textDocument/publishDiagnostics")), Boolean);
    assert.equal(diagnostic.message.params.diagnostics[0].message, "型別錯誤 🪐");
    assert.ok(c.messages.some(event => event.message?.method === "workspace/diagnostic/refresh"));
    assert.equal(await readFile(path.join(folder, "main.py"), "utf8"), "result = 1\n", "didChange must not save code");
  } finally { await c.close(); }
});

test("messages cannot escape the project, invoke commands, apply edits, or name another project's session", posixOnly, async () => {
  const a = await project(), b = await project(); const c = await client(a.base);
  try {
    assert.equal((await saturn.call("GET", `${c.route}/events?after=18446744073709551615`)).status, 400);
    for (const uri of ["file:///etc/passwd", `${c.session.rootUri}.saturn/research/environment.json`, `${c.session.rootUri}.git/config`]) {
      const answer = await saturn.call("POST", `${c.route}/messages`, { messages: [{ jsonrpc: "2.0", id: 10, method: "textDocument/hover", params: { textDocument: { uri }, position: { line: 0, character: 0 } } }] });
      assert.equal(answer.status, 403, uri);
    }
    for (const method of ["workspace/executeCommand", "workspace/applyEdit", "textDocument/rename", "textDocument/formatting"]) {
      assert.equal((await saturn.call("POST", `${c.route}/messages`, { messages: [{ jsonrpc: "2.0", id: 2, method, params: {} }] })).status, 403);
    }
    assert.equal((await saturn.call("POST", `${c.route}/messages`, { messages: [{ jsonrpc: "2.0", method: "workspace/didChangeWatchedFiles", params: { changes: [{ uri: "file:///etc/passwd", type: 2 }] } }] })).status, 403);
    assert.equal((await saturn.call("POST", `${b.base}/lsp/${c.session.id}/messages`, { messages: [] })).status, 404);
    for (const params of ["wrong", { capabilities: [] }, { capabilities: "wrong" }]) assert.equal((await saturn.call("POST", `${c.route}/messages`, { messages: [{ jsonrpc: "2.0", id: 1, method: "initialize", params }] })).status, 400);
    await c.request("initialize", { capabilities: { workspace: "wrong", general: [] } });
  } finally { await c.close(); }
});

test("stop reaps the entire process group and access revocation ends an existing stream", posixOnly, async () => {
  const p = await project("child"), c = await client(p.base);
  try {
    await c.request("initialize", { capabilities: {} });
    const processIds = JSON.parse(await readFile(path.join(p.folder, "lsp-process.json"), "utf8"));
    await saturn.api("POST", `/projects/${p.id}/access`, { granted: false });
    await until("closed stream", () => Promise.resolve(c.messages.some(event => event.closed)), Boolean);
    for (const pid of [processIds.pid, processIds.child]) await until(`process ${pid} reaped`, () => { try { process.kill(pid, 0); return Promise.resolve(false); } catch { return Promise.resolve(true); } }, Boolean);
    assert.equal((await saturn.call("POST", `${c.route}/messages`, { messages: [] })).status, 403);
  } finally { await c.close(); }
});

test("a malformed server frame closes its connection, and Rust and TypeScript use separate processes", posixOnly, async () => {
  const p = await project("malformed"), broken = await client(p.base);
  try {
    await broken.send({ id: 1, method: "initialize", params: { capabilities: {} } });
    await until("malformed frame closes server", () => Promise.resolve(broken.messages.some(event => event.closed)), Boolean);
  } finally { await broken.close(); }
  const healthy = await project();
  for (const language of ["typescript", "rust"]) {
    const c = await client(healthy.base, language);
    try { assert.ok((await c.request("initialize", { capabilities: {} })).capabilities.definitionProvider); }
    finally { await c.close(); }
  }
  assert.equal((await saturn.call("POST", `${healthy.base}/lsp/start`, { language: "shell" })).status, 400);
});

test("TypeScript 7's project compiler runs its own LSP without a legacy tsserver", posixOnly, async () => {
  const p = await project();
  const packageRoot = path.join(p.folder, "node_modules", "typescript");
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await mkdir(path.join(p.folder, "node_modules", ".bin"));
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "typescript", version: "7.0.2" }));
  const executable = path.join(packageRoot, "bin", "tsc");
  await writeFile(executable, `#!${process.execPath}\nawait import(${JSON.stringify(new URL("./fixtures/language-server.mjs", import.meta.url).href)});\n`);
  await chmod(executable, 0o755);
  await symlink("../typescript/bin/tsc", path.join(p.folder, "node_modules", ".bin", "tsc"));
  const c = await client(p.base, "typescript");
  try {
    assert.equal(c.session.server, "typescript-native");
    await c.request("initialize", { capabilities: {} });
  } finally { await c.close(); }
});

test("changing Python or the project folder stops its old language-server session", posixOnly, async () => {
  const p = await project(), c = await client(p.base);
  try {
    await c.request("initialize", { capabilities: {} });
    await saturn.api("PUT", `${p.base}/environment`, { python: "/bin/sh" });
    await until("Python change closes server", () => Promise.resolve(c.messages.some(event => event.closed)));
  } finally { await c.close(); }
  const next = await client(p.base);
  try {
    assert.equal(next.session.python, "/bin/sh");
    await next.request("initialize", { capabilities: {} });
    const folder = await saturn.folder();
    await saturn.api("PATCH", `/projects/${p.id}`, { folders: [folder] });
    await until("folder change closes server", () => Promise.resolve(next.messages.some(event => event.closed)));
  } finally { await next.close(); }
});

test("an absent selected interpreter cannot silently fall back to another Python", posixOnly, async () => {
  const p = await project();
  await saturn.api("PUT", `${p.base}/environment`, { python: "/no-such-python/bin/python" });
  const answer = await saturn.call("POST", `${p.base}/lsp/start`, { language: "python" });
  assert.equal(answer.status, 422);
  assert.match(answer.body.error, /selected Python/);
});

test("a definition in an installed package opens read-only, and nothing else outside the project does", posixOnly, async (context) => {
  const found = spawnSync("python3", ["-c", "import json, os, sys; print(json.dumps({'python': os.path.realpath(sys.executable), 'file': json.__file__}))"], { encoding: "utf8" });
  if (found.status !== 0) { context.skip("needs python3"); return; }
  const { python, file } = JSON.parse(found.stdout);
  const p = await project();
  await saturn.api("PUT", `${p.base}/environment`, { python });
  const c = await client(p.base);
  try {
    const library = (target) => saturn.call("GET", `${c.route}/library?uri=${encodeURIComponent(pathToFileURL(target).href)}`);
    const opened = await library(file);
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(opened.body.content, await readFile(file, "utf8"), "the standard library's json module, as on disk");
    // Outside the interpreter's packages, a folder, and a file of another kind are refused.
    const elsewhere = path.join(await saturn.folder(), "secret.py");
    await writeFile(elsewhere, "TOKEN = 'made-up'\n");
    assert.equal((await library(elsewhere)).status, 403);
    assert.equal((await library(path.dirname(file))).status, 403);
    assert.equal((await saturn.call("GET", `${c.route}/library?uri=${encodeURIComponent("https://example.com/x.py")}`)).status, 400);
    // A link is read as where it leads: one inside the project that leads out of the packages is refused.
    await symlink(elsewhere, path.join(p.folder, "linked.py"));
    assert.equal((await library(path.join(p.folder, "linked.py"))).status, 403);
  } finally { await c.close(); }
});
