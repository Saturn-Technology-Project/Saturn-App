import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { logger } from "../src/infrastructure/logger.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

async function boot(prepare?: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-app-"));
  await prepare?.(directory);
  const store = new FileStore(directory);
  await store.load();
  return { directory, store, ...createApp(store) };
}

const messages = () => logger.recent().map((line) => `${line.level} ${line.service} ${line.message}`);

test("the Settings logging level decides what is recorded, and the change itself is logged", async () => {
  const { services } = await boot();
  assert.equal(logger.level, "info");
  logger.debug("test", "hidden at info");
  assert.ok(!messages().some((line) => line.includes("hidden at info")));

  await services.updateSettings({ logging: "debug" });
  assert.equal(logger.level, "debug");
  logger.debug("test", "shown at debug");
  assert.ok(messages().some((line) => line === "debug test shown at debug"));

  await services.updateSettings({ logging: "error" });
  assert.ok(messages().some((line) => line.includes("Logging level changed from debug to error")));
  logger.warn("test", "hidden at error");
  assert.ok(!messages().some((line) => line.includes("hidden at error")));

  await services.updateSettings({ logging: "info" });
  assert.ok(messages().some((line) => line.includes("Logging level changed from error to info")), "turning logging up is recorded too");
});

test("an unreadable state file is kept aside and logged instead of silently replaced", async () => {
  const { directory, store } = await boot(async (dir) => {
    await writeFile(path.join(dir, "state.json"), "{ not json");
  });
  assert.equal(store.state.agents.length, 0);
  const files = await readdir(directory);
  assert.ok(files.some((name) => name.startsWith("state.json.unreadable-")), "the broken file is preserved");
  assert.ok(messages().some((line) => line.startsWith("error store state.json is not valid JSON")));
});

test("configuration changes are logged with what changed, and never the key", async () => {
  const { services } = await boot();
  const model = await services.createModel({ provider: "claude", model: "claude-sonnet-5-5" });
  assert.ok(messages().some((line) => line.includes("Model Claude Sonnet 5.5 connected (Claude, no key)")));
  assert.ok(messages().some((line) => line.startsWith("warning catalog Claude Sonnet 5.5 has no Claude API key")));

  await services.updateModel(model.id, { secret: "sk-very-secret" });
  assert.ok(messages().some((line) => line.includes("Model Claude Sonnet 5.5 updated: API key")));
  assert.ok(!JSON.stringify(logger.recent()).includes("sk-very-secret"));

  const agent = await services.createAgent({ name: "Writer", modelConnectionId: model.id });
  await services.updateAgent(agent.id, { autonomy: "fully_autonomous", instructions: "private text" });
  assert.ok(messages().some((line) => line.includes(`Agent "Writer" updated: instructions, autonomy`)));
  assert.ok(!JSON.stringify(logger.recent()).includes("private text"));

  await services.createAutomation({
    name: "Digest",
    agentId: agent.id,
    prompt: "Summarize",
    trigger: { frequency: "daily", time: "09:00", weekday: 1 },
    timeZone: "UTC",
  });
  const [automation] = services.listAutomations();
  await services.updateAutomation(automation!.id, { enabled: false });
  assert.ok(messages().some((line) => line.includes("Automation Digest paused")));

  await services.deleteAgent(agent.id);
  assert.ok(messages().some((line) => line.includes(`Agent "Writer" deleted with 0 runs and 1 automations`)));
});
