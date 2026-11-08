// LSP URI boundaries, transport order, replay and unsaved imported buffers; no browser, interpreter or credentials.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorState, Text } from "@codemirror/state";
import { documentPath, documentUri, languageError, protocolLanguage, serverLanguage } from "../src/domain/language-server.ts";
import { LanguageTransport } from "../src/application/language-transport.ts";
import { LanguageServices, SourceWorkspace } from "../src/application/language-services.ts";
import { DiagnosticRequests } from "../src/application/language-diagnostics.ts";

test("language families and file URIs preserve UTF-8 names without crossing the project boundary", () => {
  assert.equal(serverLanguage("tsx"), "typescript");
  assert.equal(protocolLanguage("tsx"), "typescriptreact");
  assert.equal(serverLanguage("json"), null);
  const root = "file:///tmp/research%20project/", path = "src/型別 100%.py";
  assert.equal(documentPath(root, documentUri(root, path)), path);
  for (const uri of ["https://example.org/file.py", "file:///etc/passwd", "file:///tmp/research%20project-neighbor/main.py", `${root}%2e%2e/private.py`, `${root}%2fetc/passwd`, `${root}.%2f../private.py`, `${root}file.py#fragment`]) assert.equal(documentPath(root, uri), null, uri);
  assert.throws(() => documentUri(root, "../escape.py"));
  assert.throws(() => documentUri(root, "C:\\private.py"));
});

test("JSON-RPC initialization failures preserve an actionable message", () => {
  assert.equal(languageError({ code: -32603, message: "Install a compatible TypeScript version." }), "Install a compatible TypeScript version.");
  assert.equal(languageError(new Error("Missing Python")), "Missing Python");
});

test("transport serializes document changes before semantic requests", async () => {
  const calls = [], releases = [];
  const api = { sendLanguageMessages: async (_project, _session, messages) => { calls.push(messages); await new Promise(resolve => releases.push(resolve)); } };
  const failures = [];
  const transport = new LanguageTransport(api, "project", "session", message => failures.push(message));
  transport.send(JSON.stringify({ method: "textDocument/didChange" }));
  transport.send(JSON.stringify({ id: 1, method: "textDocument/completion" }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  releases.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0].method, "textDocument/completion");
  releases.shift()(); transport.close();
  assert.deepEqual(failures, []);
});

test("transport ignores duplicate replay, detects missing responses and releases its stream", async () => {
  let hear, signal;
  const api = { languageEvents: async (_project, _session, _after, receive, abort) => { hear = receive; signal = abort; await new Promise(resolve => abort.addEventListener("abort", resolve)); } };
  const failures = [], received = [];
  const transport = new LanguageTransport(api, "project", "session", message => failures.push(message));
  transport.subscribe(message => received.push(JSON.parse(message)));
  hear("lsp", { seq: 0, message: { id: 1, result: "型別 🪐" } });
  hear("lsp", { seq: 0, message: { id: 1, result: "duplicate" } });
  assert.equal(received.length, 1);
  hear("lsp", { seq: 2, message: { id: 2, result: "missing seq 1" } });
  assert.equal(failures.length, 1);
  assert.ok(signal.aborted);
  assert.throws(() => transport.send("{}"), /closed/);
});

test("a failed write ends the transport before a queued query can see stale contents", async () => {
  let calls = 0;
  const failures = [];
  const transport = new LanguageTransport({ sendLanguageMessages: async () => { calls++; throw new Error("server stopped"); } }, "p", "s", message => failures.push(message));
  transport.send('{"method":"textDocument/didChange"}');
  transport.send('{"method":"textDocument/hover"}');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.deepEqual(failures, ["server stopped"]);
});

test("switching files retains an unsaved import; reattaching refreshes push diagnostics and closing discards it", () => {
  const notifications = [];
  const client = { connected: true, didOpen: file => notifications.push(["open", file.uri, file.doc.toString()]), didClose: uri => notifications.push(["close", uri]), notification: (method, params) => notifications.push([method, params]) };
  const workspace = new SourceWorkspace(client, async () => null);
  const view = { state: EditorState.create({ doc: "value = 1" }) };
  workspace.openFile("file:///project/helpers.py", "python", view);
  view.state = view.state.update({ changes: { from: 8, to: 9, insert: '"text"' } }).state;
  workspace.closeFile("file:///project/helpers.py", view);
  const kept = workspace.getFile("file:///project/helpers.py");
  assert.equal(kept.doc.toString(), 'value = "text"');
  assert.equal(kept.version, 1);
  assert.equal(kept.getView(), null);
  assert.equal(notifications.at(-1)[0], "textDocument/didChange");
  workspace.openFile("file:///project/helpers.py", "python", view);
  assert.equal(workspace.getFile("file:///project/helpers.py").version, 2);
  assert.deepEqual(notifications.slice(-2), [["close", "file:///project/helpers.py"], ["open", "file:///project/helpers.py", 'value = "text"']], "a new view must receive the server's diagnostics even when its text is unchanged");
  workspace.forget("file:///project/helpers.py");
  workspace.closeFile("file:///project/helpers.py", view);
  assert.equal(workspace.getFile("file:///project/helpers.py"), null);
  assert.deepEqual(notifications.at(-1), ["close", "file:///project/helpers.py"]);
});

test("restart can seed inactive unsaved files, and external content replaces their stale overlay", () => {
  const events = [];
  const client = { didOpen: file => events.push(["open", file.doc.toString()]), didClose: () => events.push(["close"]) };
  const workspace = new SourceWorkspace(client, async () => null);
  workspace.seed("file:///project/model.py", "python", Text.of(['name = "draft"']));
  workspace.connected();
  assert.equal(events[0][1], 'name = "draft"');
  workspace.openFile("file:///project/model.py", "python", { state: EditorState.create({ doc: "name = 2" }) });
  assert.deepEqual(events.slice(1), [["close"], ["open", "name = 2"]]);
  assert.equal(workspace.getFile("file:///project/model.py").version, 1);
});

test("diagnostic pulls accept only the synchronized document and ignore late results", async () => {
  const pending = [], accepted = [], cancelled = [];
  const client = { serverCapabilities: { diagnosticProvider: { identifier: "typescript" } }, request: (_method, params) => new Promise(resolve => pending.push({ resolve, params })), cancelRequest: params => cancelled.push(params) };
  let snapshot = { client, uri: "file:///project/app.ts", version: 1, document: {} };
  const requests = new DiagnosticRequests(() => snapshot, (_snapshot, items) => accepted.push(items), error => { throw error; });
  const first = requests.refresh();
  assert.equal(pending[0].params.identifier, "typescript");
  snapshot = { ...snapshot, version: 2, document: {} };
  requests.cancel();
  const second = requests.refresh();
  pending[0].resolve({ kind: "full", items: [{ message: "old error" }] });
  pending[1].resolve({ kind: "full", items: [{ message: "current error" }] });
  await Promise.all([first, second]);
  assert.deepEqual(accepted, [[{ message: "current error" }]]);
  assert.equal(cancelled.length, 1);
});

test("changed documents and destroyed editors cannot acquire stale diagnostics", async () => {
  let resolve, accepted = 0;
  const client = { serverCapabilities: { diagnosticProvider: {} }, request: () => new Promise(done => { resolve = done; }), cancelRequest: () => {} };
  let snapshot = { client, uri: "file:///project/app.ts", version: 1, document: {} };
  const requests = new DiagnosticRequests(() => snapshot, () => accepted++, error => { throw error; });
  const old = requests.refresh();
  snapshot = { ...snapshot, document: {} };
  resolve({ kind: "full", items: [] }); await old;
  assert.equal(accepted, 0);
  const closing = requests.refresh(); requests.cancel(); snapshot = null;
  resolve({ kind: "full", items: [] }); await closing;
  assert.equal(accepted, 0);
});

test("push-only servers are not queried for unsupported diagnostic pulls", async () => {
  let called = 0;
  const requests = new DiagnosticRequests(() => ({ client: { serverCapabilities: {}, request: () => called++ }, document: {}, uri: "file:///p.py", version: 1 }), () => { throw new Error("unexpected"); }, error => { throw error; });
  await requests.refresh(); assert.equal(called, 0);
});

test("a definition outside the project opens its installed package's file read-only, and a refusal is said", async () => {
  const file = "/venv/lib/python3.12/site-packages/torch/nn/modules/linear.py";
  const asked = [], opened = [], notes = [], view = { kind: "stand-in view" };
  const api = { libraryFile: async (project, session, uri) => { asked.push([project, session, uri]); return { path: file, content: "class Linear: ..." }; } };
  const services = new LanguageServices(api, "proj", async (path) => { opened.push(path); services.attach(view, path, "python", false, () => {}); }, (note) => notes.push(note));
  const session = { id: "lsp_1", rootUri: "file:///work/project/" };
  assert.equal(await services["display"](session, `file://${file}`), view, "the jump lands in the tab that opened");
  assert.deepEqual(asked, [["proj", "lsp_1", `file://${file}`]]);
  assert.deepEqual(opened, [`library:${file}`]);
  assert.equal(services.libraryText(`library:${file}`), "class Linear: ...");
  services.forget(`library:${file}`);
  assert.equal(services.libraryText(`library:${file}`), undefined, "closing the tab lets the text go");

  const refusing = new LanguageServices({ libraryFile: async () => { throw new Error("Only source files of the packages this language server uses open outside the project."); } }, "proj", async () => { opened.push("never"); }, (note) => notes.push(note));
  assert.equal(await refusing["display"](session, "file:///etc/hosts.py"), null);
  assert.match(notes.at(-1), /Only source files/);
  assert.ok(!opened.includes("never"));
});
