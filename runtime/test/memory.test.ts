import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { merge, parseNotes } from "../src/application/memory.js";
import { BROWSER_TOOLS } from "../src/domain/browser-tools.js";
import type { Agent } from "../src/domain/model.js";
import { buildSystemPrompt } from "../src/domain/policies.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";
import { useRuntimeAuth } from "./runtime-token.js";

test("memory notes are parsed from the model's JSON and merged without duplicates", () => {
  assert.deepEqual(parseNotes('Sure. {"global": ["Prefers tabs over spaces", "x"], "project": ["Tests run with npm test"]}'), {
    global: ["Prefers tabs over spaces"],
    project: ["Tests run with npm test"],
  });
  assert.deepEqual(parseNotes("no json here"), { global: [], project: [] });
  const merged = merge("- Prefers tabs over spaces\n", ["prefers tabs over spaces!", "Writes commit messages in English"]);
  assert.equal(merged, "- Prefers tabs over spaces\n- Writes commit messages in English");
});

test("memory goes at the top of the system prompt; the plan gate and the browser section appear when set", () => {
  const agent: Agent = { id: "a", name: "A", instructions: "Be brief.", description: "", status: "active", modelConnectionId: null, mcpConnectionIds: ["general-skills", "browser"], ragConnectionIds: [], responseStyle: "concise", autonomy: "default", temperature: 0.2, maxOutput: 4000 };
  const prompt = buildSystemPrompt({ agent, memory: "# Memory\n- Prefers tabs", planApproval: true });
  assert.ok(prompt.startsWith("# Memory\n- Prefers tabs"), "memory first");
  assert.match(prompt, /Reply 'go' to proceed/);
  assert.match(prompt, /### Browser/);
  assert.match(prompt, /## Summary/);
  const plain = buildSystemPrompt({ agent: { ...agent, mcpConnectionIds: ["general-skills"] } });
  assert.doesNotMatch(plain, /Reply 'go' to proceed|### Browser/);
  assert.match(plain, /call `multi_step` first with the plan/);
});

test("the browser tool server is installed for new agents, and memory files are read and written through the API", async () => {
  assert.ok(BROWSER_TOOLS.some((tool) => tool.toolId === "browser_navigate"));
  assert.ok(BROWSER_TOOLS.every((tool) => tool.serverId === "browser"));
  const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-memory-")));
  await store.load();
  const { app, services } = createApp(store);
  const agent = await services.createAgent({ name: "Fresh" });
  assert.ok(agent.mcpConnectionIds.includes("browser"), `new agents get the browser: ${agent.mcpConnectionIds.join(",")}`);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    useRuntimeAuth(base);
    assert.deepEqual(await (await fetch(`${base}/memory/global`)).json(), { scope: "global", content: "" });
    const written = await (await fetch(`${base}/memory/global`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "- Likes short answers" }) })).json();
    assert.deepEqual(written, { scope: "global", content: "- Likes short answers\n" });
    assert.equal(await readFile(path.join(store.root, "memory", "global.md"), "utf8"), "- Likes short answers\n");
    assert.match(await services.kernel.memory.forPrompt(), /## About the user\n- Likes short answers/);
    await services.updateSettings({ memory: false });
    assert.equal(await services.kernel.memory.forPrompt(), "", "memory can be turned off");
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test("a browser tool call without a browser fails with a clear reason, not a hang", async () => {
  const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-browser-")));
  await store.load();
  const { services } = createApp(store);
  const previous = { browser: process.env.SATURN_BROWSER, electron: process.env.SATURN_ELECTRON };
  process.env.SATURN_BROWSER = "/nonexistent/chrome";
  delete process.env.SATURN_ELECTRON;
  try {
    const agent = await services.createAgent({ name: "Surfer" });
    const action = await services.kernel.runs.executeTool({ agentId: agent.id, toolId: "browser_navigate", arguments: { url: "https://example.com" }, runId: "run_x", actionId: "act_x" });
    assert.equal(action.status, "failed");
    assert.match(action.reason ?? "", /could not start|did not start|No browser found/);
    const local = await services.kernel.runs.executeTool({ agentId: agent.id, toolId: "browser_navigate", arguments: { url: "http://127.0.0.1:4700/" }, runId: "run_x", actionId: "act_y" });
    assert.match(local.reason ?? "", /not allowed/, "private addresses are refused before any browser starts");
  } finally {
    if (previous.browser === undefined) delete process.env.SATURN_BROWSER; else process.env.SATURN_BROWSER = previous.browser;
    if (previous.electron !== undefined) process.env.SATURN_ELECTRON = previous.electron;
  }
});
