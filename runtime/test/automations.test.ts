import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { localMinute, nextSlot, previousSlot, slotLabel } from "../src/domain/schedule.js";
import { createApp } from "../src/presentation/app.js";
import { FileStore } from "../src/infrastructure/store.js";

test("slots follow the automation's time zone", () => {
  // 2026-10-19 (Monday) 08:30 in Taipei.
  const now = new Date("2026-10-19T00:30:00Z");
  const local = localMinute(now, "Asia/Taipei");
  assert.equal(slotLabel(local), "2026-10-19 08:30");
  const daily = { frequency: "daily" as const, time: "09:00", weekday: 1 };
  assert.equal(slotLabel(nextSlot(daily, local)), "2026-10-19 09:00");
  assert.equal(slotLabel(previousSlot(daily, local)), "2026-10-18 09:00");
  const weekdays = { frequency: "weekdays" as const, time: "09:00", weekday: 1 };
  assert.equal(slotLabel(previousSlot(weekdays, local)), "2026-10-16 09:00");
  const weekly = { frequency: "weekly" as const, time: "07:15", weekday: 3 };
  assert.equal(slotLabel(nextSlot(weekly, local)), "2026-10-21 07:15");
  const hourly = { frequency: "hourly" as const, time: "00:45", weekday: 1 };
  assert.equal(slotLabel(nextSlot(hourly, local)), "2026-10-19 08:45");
  assert.equal(slotLabel(previousSlot(hourly, local)), "2026-10-19 07:45");
});

test("an automation fires once per slot", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-app-"));
  const store = new FileStore(directory);
  await store.load();
  const { services } = createApp(store);
  const agent = await services.createAgent({ name: "Reporter" });
  const automations = services.kernel.automations;
  const created = await automations.create(
    {
      name: "Morning report",
      agentId: agent.id,
      prompt: "Summarize the workspace",
      trigger: { frequency: "daily", time: "09:00", weekday: 1 },
      timeZone: "Asia/Taipei",
    },
    new Date("2026-10-19T00:30:00Z"),
  );
  assert.equal(created.nextRun, "2026-10-19 09:00");
  assert.equal(created.agentName, "Reporter");

  await automations.tick(new Date("2026-10-19T00:45:00Z"));
  assert.equal(store.state.automations[0]?.lastRunAt, undefined);

  await automations.tick(new Date("2026-10-19T01:01:00Z"));
  const fired = store.state.automations[0];
  assert.ok(fired?.lastRunAt);
  // The agent has no model, so the run is refused and the reason is kept for the list.
  assert.equal(fired?.lastError, "Agent has no model connection");

  const firstRunAt = fired?.lastRunAt;
  await automations.tick(new Date("2026-10-19T02:00:00Z"));
  assert.equal(store.state.automations[0]?.lastRunAt, firstRunAt);

  await services.deleteAgent(agent.id);
  assert.equal(store.state.automations.length, 0);
});

test("a provider's saved API key is reused by its other models", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-app-"));
  const store = new FileStore(directory);
  await store.load();
  const { services } = createApp(store);
  const first = await services.createModel({ provider: "gemini", model: "gemini-flash", secret: "gem-key-1" });
  assert.equal(first.hasSecret, true);
  const second = await services.createModel({ provider: "gemini", model: "gemini-pro" });
  assert.equal(second.hasSecret, true);
  assert.equal(services.kernel.llm.keyFor(second), "gem-key-1");

  const keyless = await services.createModel({ provider: "claude", model: "claude-sonnet-5-5" });
  assert.equal(keyless.hasSecret, false);
  const agent = await services.createAgent({ name: "Writer", modelConnectionId: keyless.id });
  await assert.rejects(() => services.startRun(agent.id, "hi"), /no Claude API key/);

  const bound = await services.updateModel(keyless.id, { secret: "claude-key" });
  assert.equal(bound.hasSecret, true);
  const listed = (await services.listConnections("models")) as { hasSecret: boolean }[];
  assert.ok(listed.every((item) => item.hasSecret));
  assert.equal(JSON.stringify(listed).includes("gem-key-1"), false);
});

test("polling reads do not rewrite the state file once built-ins are installed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-app-"));
  const store = new FileStore(directory);
  await store.load();
  const { services } = createApp(store);
  await services.createAgent({ name: "Reader" });
  let writes = 0;
  const update = store.update.bind(store);
  store.update = (change) => {
    writes += 1;
    return update(change);
  };
  await services.listAgents();
  await services.listConnections("mcp");
  await services.listAgents();
  assert.equal(writes, 0);

  // A state that is missing the built-ins is still repaired on the next read.
  store.state.agents[0]!.mcpConnectionIds = [];
  await services.listAgents();
  assert.equal(writes, 1);
  assert.ok(store.state.agents[0]?.mcpConnectionIds.includes("general-skills"));
});
