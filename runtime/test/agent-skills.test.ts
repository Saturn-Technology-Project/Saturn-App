import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { bridgedTools, skillsServer, toolResult } from "../src/application/agent-skills.js";
import type { Run } from "../src/domain/model.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-agent-skills-"));
  const store = new FileStore(directory);
  await store.load();
  return { directory, store, ...createApp(store) };
}

async function settle(services: Awaited<ReturnType<typeof setup>>["services"], runId: string, until = (run: Run) => run.status !== "running" && run.status !== "queued"): Promise<Run> {
  let current: Run = services.kernel.getRun(runId);
  for (let attempt = 0; attempt < 300 && !until(current); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    current = services.kernel.getRun(runId);
  }
  return current;
}

test("Claude Code and Codex get the agent's Saturn skills, but not General Skills, which are their own tools", async () => {
  const { services } = await setup();
  const model = await services.createModel({ provider: "codex", model: "default" });
  const agent = await services.createAgent({ name: "Coder", modelConnectionId: model.id });
  const names = bridgedTools(services.kernel, agent).map((tool) => tool.name);
  assert.ok(names.includes("automation_list"), names.join(", "));
  for (const own of ["files", "code", "web", "mcp", "multi_step"]) assert.equal(names.includes(own), false, `${own} is the program's own tool`);

  const detached = { ...agent, mcpConnectionIds: agent.mcpConnectionIds.filter((id) => id !== "automations") };
  assert.equal(bridgedTools(services.kernel, detached).some((tool) => tool.name === "automation_list"), false, "only attached servers");
});

test("the skills server lists the tools with their schemas and answers a call with its action's result", async () => {
  const calls: unknown[] = [];
  const server = skillsServer(
    [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
    async (toolId, args) => {
      calls.push([toolId, args]);
      return { id: "a1", toolId, arguments: args, status: "completed", result: { said: args.text } };
    },
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => [tool.name, tool.inputSchema.properties]), [["echo", { text: { type: "string" } }]]);
  const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
  assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify({ said: "hi" }) }]);
  const unknown = await client.callTool({ name: "other", arguments: {} });
  assert.equal(unknown.isError, true);
  assert.deepEqual(calls, [["echo", { text: "hi" }]]);
  await client.close();
});

test("a screenshot goes back as an image, and a denied or failed call as an error", () => {
  const shot = toolResult({ id: "a", toolId: "computer_screenshot", arguments: {}, status: "completed", result: { image: "data:image/jpeg;base64,QUJD", width: 10 } });
  assert.deepEqual(shot.content, [{ type: "image", mimeType: "image/jpeg", data: "QUJD" }, { type: "text", text: JSON.stringify({ width: 10 }) }]);
  const denied = toolResult({ id: "a", toolId: "x", arguments: {}, status: "denied", reason: "Denied by the user" });
  assert.equal(denied.isError, true);
  assert.deepEqual(denied.content, [{ type: "text", text: "Denied by the user" }]);
});

/**
 * A stand-in `codex` that, like the real one, reaches the configured `saturn` MCP server with the bearer token
 * from the named environment variable: it reports the call as started, calls automation_list, then finishes.
 */
async function fakeCodex(directory: string): Promise<{ bin: string; outFile: string }> {
  const bin = path.join(directory, "fake-codex.cjs");
  const outFile = path.join(directory, "fake-codex-out.json");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2).join(" ");
const url = args.match(/mcp_servers\\.saturn\\.url="([^"]+)"/)[1];
const tokenVariable = args.match(/mcp_servers\\.saturn\\.bearer_token_env_var="([^"]+)"/)[1];
const token = process.env[tokenVariable];
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const rpc = async (id, method, params, bearer = token) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + bearer },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
};
process.stdin.resume();
process.stdin.on("end", async () => {
  emit({ type: "thread.started", thread_id: "thr_1" });
  const wrong = await rpc(0, "tools/list", {}, "not-the-token");
  await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "0" } });
  const list = await rpc(2, "tools/list", {});
  emit({ type: "item.started", item: { id: "mcp1", type: "mcp_tool_call", server: "saturn", tool: "automation_list", arguments: {}, status: "in_progress" } });
  const call = await rpc(3, "tools/call", { name: "automation_list", arguments: {} });
  fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ wrong: wrong.status, tools: list.body.result.tools.map((t) => t.name), call: call.body.result, sawToken: process.env.SATURN_SKILLS_TOKEN !== undefined }));
  emit({ type: "item.completed", item: { id: "mcp1", type: "mcp_tool_call", server: "saturn", tool: "automation_list", arguments: {}, result: call.body.result, status: call.body.result.isError ? "failed" : "completed" } });
  emit({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "done" } });
  emit({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } });
});
`;
  await writeFile(bin, script);
  await chmod(bin, 0o755);
  return { bin, outFile };
}

async function withRuntime<T>(app: Awaited<ReturnType<typeof setup>>["app"], body: () => Promise<T>): Promise<T> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const saved = process.env.SATURN_RUNTIME_PORT;
  process.env.SATURN_RUNTIME_PORT = String((server.address() as AddressInfo).port);
  try {
    return await body();
  } finally {
    if (saved === undefined) delete process.env.SATURN_RUNTIME_PORT;
    else process.env.SATURN_RUNTIME_PORT = saved;
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

test("a Codex turn calls the agent's Saturn skills over the runtime's endpoint, with a token only that turn holds", async () => {
  const { directory, app, services } = await setup();
  const { bin, outFile } = await fakeCodex(directory);
  services.kernel.codex.cliPath = () => bin;
  const model = await services.createModel({ provider: "codex", model: "default" });
  const agent = await services.createAgent({ name: "Coder", modelConnectionId: model.id, autonomy: "bypass" });
  await withRuntime(app, async () => {
    const run = await services.startRun(agent.id, "list my automations");
    const done = await settle(services, run.id);
    assert.equal(done.status, "completed", done.error);
    const out = JSON.parse(await readFile(outFile, "utf8")) as { wrong: number; tools: string[]; call: { isError?: boolean }; sawToken: boolean };
    assert.equal(out.wrong, 401, "another token does not open the endpoint");
    assert.ok(out.tools.includes("automation_list"));
    assert.equal(out.tools.includes("code"), false);
    assert.equal(out.call.isError, undefined);
    assert.deepEqual(done.actions.map((action) => [action.toolId, action.status]), [["automation_list", "completed"]]);

    const after = await fetch(`http://127.0.0.1:${process.env.SATURN_RUNTIME_PORT}/agent-mcp`, { method: "POST", headers: { authorization: "Bearer x" } });
    assert.equal(after.status, 401);
  });
});

test("on Review, a Codex skill call waits on Saturn's approval card, and a denial reaches Codex as an error", async () => {
  const { directory, app, services } = await setup();
  const { bin, outFile } = await fakeCodex(directory);
  services.kernel.codex.cliPath = () => bin;
  const model = await services.createModel({ provider: "codex", model: "default" });
  const agent = await services.createAgent({ name: "Coder", modelConnectionId: model.id, autonomy: "review" });
  await withRuntime(app, async () => {
    const run = await services.startRun(agent.id, "list my automations");
    const waiting = await settle(services, run.id, (current) => current.status === "waiting_approval" || current.status === "failed" || current.status === "completed");
    assert.equal(waiting.status, "waiting_approval", waiting.error);
    const card = waiting.actions.filter((action) => action.status === "waiting_approval");
    assert.equal(card.length, 1);
    assert.equal(card[0]!.toolId, "automation_list");
    assert.equal(services.kernel.codex.waiting(run.id, card[0]!.id), true);
    services.kernel.codex.decide(run.id, card[0]!.id, false);

    const done = await settle(services, run.id, (current) => current.status === "completed" || current.status === "failed");
    assert.equal(done.status, "completed", done.error);
    const out = JSON.parse(await readFile(outFile, "utf8")) as { call: { isError?: boolean } };
    assert.equal(out.call.isError, true);
    assert.deepEqual(done.actions.map((action) => [action.toolId, action.status]), [["automation_list", "denied"]], "one action, the card's");
  });
});
