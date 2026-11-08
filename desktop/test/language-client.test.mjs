// Startup failures and cancelled queries must not hang on the official client's replaced initialization promise.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceLanguageClient } from "../src/application/language-client.ts";

/** A transport whose initialization can succeed immediately or never answer. */
function transport(initialize) {
  let receive;
  const sent = [];
  return { sent, subscribe: handler => { receive = handler; }, unsubscribe: () => {}, send: raw => {
    const message = JSON.parse(raw); sent.push(message);
    if (initialize && message.method === "initialize") receive(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { capabilities: { textDocumentSync: 2 } } }));
  } };
}

test("a process that dies before initialization leaves an actionable failure instead of an endless connection", async () => {
  const client = new SourceLanguageClient({ timeout: 10 });
  const wire = transport(false); client.connect(wire);
  const ready = client.ready();
  client.notification("textDocument/didOpen", { textDocument: {} });
  client.stop("Server exited during startup.");
  await assert.rejects(ready, /Server exited during startup/);
  assert.equal(client.connected, false);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(wire.sent.map(message => message.method), ["initialize"], "queued document notifications must not run after the old initialization times out");
});

test("pending semantic queries become empty results when a connection closes", async () => {
  const client = new SourceLanguageClient({ timeout: 10 });
  const wire = transport(true); client.connect(wire); await client.ready();
  const hover = client.request("textDocument/hover", { textDocument: { uri: "file:///project/a.py" }, position: { line: 0, character: 0 } });
  await Promise.resolve();
  assert.ok(wire.sent.some(message => message.method === "textDocument/hover"));
  client.disconnect();
  assert.equal(await hover, null);
  client.notification("textDocument/didSave", {});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(!wire.sent.some(message => message.method === "textDocument/didSave"));
  assert.equal(client.connected, false);
});

test("live server errors remain errors rather than being reported as successful empty replies", async () => {
  const client = new SourceLanguageClient({ timeout: 10 });
  const wire = transport(true); client.connect(wire); await client.ready();
  await assert.rejects(client.request("textDocument/definition", {}));
  client.disconnect();
});
