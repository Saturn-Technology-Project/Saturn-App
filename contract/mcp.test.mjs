// Other MCP servers, whichever language runs the client: Streamable HTTP, plain JSON-RPC, a local program, and a sign-in.
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startRuntime } from "./runtime.mjs";

let runtime;
let folder;
const servers = [];

before(async () => {
  // Stands for a credential in the runtime's own environment, which a local server must not inherit.
  runtime = await startRuntime({ env: { CONTRACT_KEY_FROM_PARENT: "leaked-from-the-runtime" } });
  folder = await realpath(await mkdtemp(path.join(os.tmpdir(), "saturn-contract-mcp-")));
});
after(async () => {
  await runtime?.stop();
  await Promise.all(servers.map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
  await rm(folder, { recursive: true, force: true });
});

async function api(method, route, body, expected = [200, 201, 204]) {
  const token = (await readFile(path.join(runtime.dataDir, "runtime-token"), "utf8")).trim();
  const response = await fetch(`${runtime.origin}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.ok(expected.includes(response.status), `${method} ${route}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

/** A server on a free port. `handle` gets the request, its body as text, and the response. */
async function serve(handle) {
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => handle(request, raw, response));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

const TOOL = { name: "lookup", description: "Looks it up", inputSchema: { type: "object", properties: { q: { type: "string" } } } };

/** The answer an MCP server gives one message. */
function mcpAnswer(message) {
  if (message.method === "initialize") return { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } };
  if (message.method === "tools/list") return { tools: [TOOL] };
  if (message.method === "tools/call") return { content: [{ type: "text", text: `found ${message.params.arguments.q}` }] };
  return {};
}

/** A Streamable HTTP server. `stream` answers as an event stream instead of JSON. */
function streamable(calls, { stream = false, authorized = () => true } = {}) {
  return serve((request, raw, response) => {
    if (request.method !== "POST") return response.writeHead(405).end();
    if (!authorized(request)) return response.writeHead(401, { "www-authenticate": 'Bearer realm="x"' }).end();
    const message = JSON.parse(raw);
    calls.push({ method: message.method, session: request.headers["mcp-session-id"] });
    if (message.id === undefined) return response.writeHead(202).end();
    const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: mcpAnswer(message) });
    const headers = { "mcp-session-id": "session-1" };
    if (stream) response.writeHead(200, { ...headers, "content-type": "text/event-stream" }).end(`event: message\ndata: ${body}\n\n`);
    else response.writeHead(200, { ...headers, "content-type": "application/json" }).end(body);
  });
}

/** An agent on a scripted model that calls `tool` and then answers. Gives the finished run and what the model was sent. */
async function agentCalling(serverId, tool, autonomy = "bypass") {
  const requests = [];
  const turns = [{ tool_calls: [{ id: "c1", type: "function", function: { name: tool, arguments: JSON.stringify({ q: "it" }) } }] }, { content: "done" }];
  const modelUrl = await serve((_request, raw, response) => {
    requests.push(JSON.parse(raw));
    // Background work (a chat's title, memory) asks without tools and must not take a step meant for the run.
    const turn = (JSON.parse(raw).tools?.length ? turns.shift() : undefined) ?? { content: "extra" };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "r", object: "chat.completion", model: "s", choices: [{ index: 0, finish_reason: turn.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: turn.content ?? "", ...turn } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  const model = await api("POST", "/connections/models", { name: "Scripted", provider: "openai", model: "s", baseUrl: modelUrl });
  const agent = await api("POST", "/agents", { name: "Caller", modelConnectionId: model.id, autonomy, mcpConnectionIds: ["general-skills", serverId] });
  const created = await api("POST", `/agents/${agent.id}/runs`, { input: "go" });
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const run = await api("GET", `/runs/${created.id}`);
    if (!["queued", "running"].includes(run.status)) return { run, requests };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the run did not settle");
}

for (const stream of [false, true]) {
  test(`a Streamable HTTP server answering ${stream ? "as a stream" : "with JSON"}: its tools are listed and an agent calls them`, async () => {
    const calls = [];
    const url = await streamable(calls, { stream });
    const server = await api("POST", "/connections/mcp", { name: "Remote", url });
    const found = await api("POST", `/connections/mcp/${server.id}/discover`);
    assert.deepEqual(found.tools.map((tool) => tool.toolId), ["lookup"]);
    assert.equal(found.tools[0].serverId, server.id);
    const { run, requests } = await agentCalling(server.id, "lookup");
    assert.equal(run.status, "completed", run.error);
    assert.equal(run.actions[0].status, "completed");
    assert.match(JSON.stringify(requests[1].messages), /found it/);
    assert.equal(calls[0].method, "initialize");
    assert.equal(calls[0].session, undefined);
    assert.equal(calls.at(-1).session, "session-1", "the session goes with later requests");
    await api("DELETE", `/mcp/${server.id}`);
  });
}

test("a server that only takes plain JSON-RPC still works", async () => {
  const url = await serve((_request, raw, response) => {
    const message = JSON.parse(raw);
    const result = message.method === "initialize" ? { ok: true } : mcpAnswer(message);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  const server = await api("POST", "/connections/mcp", { name: "Plain", url });
  assert.deepEqual((await api("POST", `/connections/mcp/${server.id}/discover`)).tools.map((tool) => tool.toolId), ["lookup"]);
  const { run } = await agentCalling(server.id, "lookup");
  assert.equal(run.status, "completed", run.error);
  await api("DELETE", `/mcp/${server.id}`);
});

test("a tool's failure is a failed step the model hears about, and its refusal is a denied one", async () => {
  const url = await serve((_request, raw, response) => {
    const message = JSON.parse(raw);
    const refused = message.method === "tools/call";
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...(refused ? { error: { code: 1, message: "policy_denied" } } : { result: message.method === "initialize" ? { ok: true } : mcpAnswer(message) }) }));
  });
  const server = await api("POST", "/connections/mcp", { name: "Refusing", url });
  await api("POST", `/connections/mcp/${server.id}/discover`);
  const { run } = await agentCalling(server.id, "lookup");
  assert.equal(run.actions[0].status, "denied");
  assert.equal(run.actions[0].reason, "Policy denied");
  await api("DELETE", `/mcp/${server.id}`);
});

const LOCAL_SERVER = `
const rl = require("node:readline").createInterface({ input: process.stdin });
console.error("local server up, secret is " + (process.env.CONTRACT_KEY_FROM_PARENT ?? "absent") + " " + (process.env.MY_VAR ?? ""));
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === "initialize"
    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "local", version: "1" } }
    : message.method === "tools/list"
      ? { tools: [{ name: "local_tool", description: "x", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: "from " + (process.env.CONTRACT_KEY_FROM_PARENT ?? "no parent key") + " " + process.env.MY_VAR }] };
  console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
});`;

test("a local program starts only once its exact command is allowed, with only the environment it was given", async () => {
  const script = path.join(folder, "server.cjs");
  await writeFile(script, LOCAL_SERVER);
  const server = await api("POST", "/connections/mcp", { name: "Local", command: { program: process.execPath, args: [script], env: { MY_VAR: "given" } } });
  const refused = await fetch(`${runtime.origin}/connections/mcp/${server.id}/discover`, { method: "POST", headers: { authorization: `Bearer ${(await readFile(path.join(runtime.dataDir, "runtime-token"), "utf8")).trim()}` } });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /Allow it in Saturn Settings/);
  await api("POST", `/connections/mcp/${server.id}/approve`, { fingerprint: server.commandFingerprint });
  assert.deepEqual((await api("POST", `/connections/mcp/${server.id}/discover`)).tools.map((tool) => tool.toolId), ["local_tool"]);
  const { run, requests } = await agentCalling(server.id, "local_tool");
  assert.equal(run.status, "completed", run.error);
  assert.match(JSON.stringify(requests[1].messages), /no parent key given/, "nothing of the runtime's own environment");
  await api("DELETE", `/mcp/${server.id}`);
});

test("the sign-in callback refuses what Saturn did not start, and escapes what a provider says", async () => {
  const unknown = await fetch(`${runtime.origin}/oauth/callback?code=x&state=nobody`);
  assert.equal(unknown.status, 400);
  assert.match(await unknown.text(), /unknown or has already finished/);
  const denied = await fetch(`${runtime.origin}/oauth/callback?error=access_denied&error_description=${encodeURIComponent("<b>no</b>")}`);
  assert.equal(denied.status, 400);
  assert.doesNotMatch(await denied.text(), /<b>no<\/b>/);
});

test("integrations are listed, and a token integration asks for its token", async () => {
  const entries = await api("GET", "/marketplace");
  assert.equal(entries[0].id, "saturn-mcp");
  assert.equal(entries.find((item) => item.id === "dukascopy").available, false);
  await api("POST", "/marketplace/github/install", {}, [400]);
  await api("POST", "/marketplace/nobody/install", {}, [404]);
  await api("POST", "/marketplace/dukascopy/install", {}, [409]);
  await api("POST", "/marketplace/slack/install", {}, [400]);
  await api("DELETE", "/marketplace/github");
});
