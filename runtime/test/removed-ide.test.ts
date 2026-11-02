import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

test("state saved by a version with Saturn IDE loads without its server, its tools or its settings", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-removed-ide-"));
  const store = new FileStore(directory);
  await store.load();
  const { services } = createApp(store);
  const connection = await services.createModel({ name: "Local", provider: "openai", baseUrl: "http://127.0.0.1:9" });
  const agent = await services.createAgent({ name: "Builder", modelConnectionId: connection.id, autonomy: "review" });
  await services.kernel.ensureBuiltins();
  await store.update(() => undefined);

  // What the earlier version left in the file.
  const file = path.join(directory, "state.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  saved.mcp.push({ id: "ide", name: "Saturn IDE", url: "builtin://ide", tools: [] });
  saved.agents.find((item: { id: string }) => item.id === agent.id).mcpConnectionIds.push("ide");
  saved.settings.launchApp = "ide";
  saved.settings.claudeCodeAuth = "api-key";
  await writeFile(file, JSON.stringify(saved));

  const reopened = new FileStore(directory);
  await reopened.load();
  const { services: after } = createApp(reopened);
  await after.kernel.ensureBuiltins();

  assert.equal(reopened.state.mcp.some((item) => item.id === "ide"), false);
  assert.equal(after.getAgent(agent.id).mcpConnectionIds.includes("ide"), false);
  assert.ok(after.getAgent(agent.id).mcpConnectionIds.length > 0, "the agent keeps its other tools");
  assert.deepEqual(Object.keys(reopened.state.settings).filter((key) => key === "launchApp" || key === "claudeCodeAuth"), []);
});
