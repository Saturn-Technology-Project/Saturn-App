import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { budgetHistory, compactActions, CONTEXT_LIMITS } from "../src/domain/context.js";
import type { Run, RunAction } from "../src/domain/model.js";
import { MAX_SLEEPS } from "../src/application/runs.js";
import { runComputerUseSkill } from "../src/infrastructure/skills.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

type Message = { role?: string; content?: string; tool_calls?: unknown[] };

/** An OpenAI-compatible model that asks for one long wait, then answers with what the wait returned. */
async function waitingModel(ms: number, delayMs = 0) {
  const batches: Message[][] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const messages = ((JSON.parse(raw || "{}") as { messages?: Message[] }).messages ?? []);
      batches.push(messages);
      // Saturn replays finished actions (with their results) as text in the conversation.
      const waited = messages.find((item) => typeof item.content === "string" && (item.content.includes("waited_ms") || item.content.includes("already waited")))?.content;
      res.setHeader("content-type", "application/json");
      const message = waited
        ? { content: `done after ${waited}` }
        : {
            content: "",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "computer_wait", arguments: JSON.stringify({ ms, reason: "reply from Alice" }) } }],
          };
      setTimeout(() => res.end(JSON.stringify({ choices: [{ message }] })), delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, url: `http://127.0.0.1:${address.port}`, batches };
}

async function until(read: () => Run, done: (run: Run) => boolean): Promise<Run> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const run = read();
    if (done(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run stuck in ${read().status}`);
}

async function setup(directory: string, modelUrl: string) {
  const store = new FileStore(directory);
  await store.load();
  const { services } = createApp(store);
  const model = await services.createModel({ name: "Local", provider: "openai", baseUrl: modelUrl });
  const agent = await services.createAgent({
    name: "Waiter",
    modelConnectionId: model.id,
    autonomy: "fully_autonomous",
    mcpConnectionIds: ["computer-use"],
  });
  return { store, services, agent };
}

test("a long computer_wait suspends the run, survives a restart, and resumes with how long it waited", async () => {
  const model = await waitingModel(5 * 60_000);
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-wait-"));
  try {
    const { services, agent } = await setup(directory, model.url);
    const started = await services.startRun(agent.id, "Message Alice, wait 5 minutes for a reply");
    const asleep = await until(() => services.kernel.getRun(started.id), (run) => run.status !== "running" && run.status !== "queued");
    assert.equal(asleep.status, "sleeping", asleep.error);
    assert.equal(asleep.wake?.reason, "reply from Alice");
    assert.equal(asleep.wake?.requestedMs, 300_000);
    assert.equal(asleep.actions[0]?.status, "sleeping");
    assert.equal(model.batches.length, 1, "no model call while the run waits");

    // Not due yet: nothing happens.
    assert.deepEqual(await services.kernel.runs.wakeDue(new Date(Date.now() + 60_000)), []);

    // A fresh runtime on the same data picks the sleeping run up and resumes it when it is due.
    const reopened = new FileStore(directory);
    await reopened.load();
    const second = createApp(reopened).services;
    assert.equal(second.kernel.getRun(started.id).status, "sleeping");
    await second.kernel.runs.recoverInterrupted();
    assert.equal(second.kernel.getRun(started.id).status, "sleeping", "a restart does not fail a sleeping run");
    const due = new Date(Date.parse(asleep.wake!.at) + 1_000);
    assert.deepEqual(await second.kernel.runs.wakeDue(due), [started.id]);
    const finished = await until(() => second.kernel.getRun(started.id), (run) => run.status === "completed" || run.status === "failed");
    assert.equal(finished.status, "completed", finished.error);
    const result = finished.actions[0]?.result as { waited_ms: number; requested_ms: number; reason: string; woke: string };
    assert.equal(result.requested_ms, 300_000);
    assert.equal(result.reason, "reply from Alice");
    assert.equal(result.woke, "on time");
    assert.ok(result.waited_ms >= 300_000);
    assert.match(finished.output, /waited_ms/);
    assert.equal(finished.wake, undefined);
    assert.equal(finished.sleeps, 1);
  } finally {
    model.server.close();
  }
});

test("a sleeping run can be woken early or stopped", async () => {
  const model = await waitingModel(30 * 60_000);
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-wake-"));
  try {
    const { services, agent } = await setup(directory, model.url);
    const first = await services.startRun(agent.id, "wait for the deploy");
    await until(() => services.kernel.getRun(first.id), (run) => run.status === "sleeping");
    await services.wakeRun(first.id);
    const woken = await until(() => services.kernel.getRun(first.id), (run) => run.status === "completed");
    assert.equal((woken.actions[0]!.result as { woke: string }).woke, "early, by the user");
    await assert.rejects(() => services.wakeRun(first.id), /not waiting/);

    const thread = await services.createThread(agent.id);
    const second = await services.startRun(agent.id, "wait again", thread.id);
    await until(() => services.kernel.getRun(second.id), (run) => run.status === "sleeping");
    const stopped = await services.stopRun(second.id);
    assert.equal(stopped.status, "cancelled");
    assert.equal(stopped.wake, undefined);
    assert.deepEqual(await services.kernel.runs.wakeDue(new Date(Date.now() + 2 * 3_600_000)), []);
  } finally {
    model.server.close();
  }
});

test("a run that has slept too often is told to finish instead of sleeping again", async () => {
  const model = await waitingModel(60_000, 300);
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-sleeps-"));
  try {
    const { store, services, agent } = await setup(directory, model.url);
    const run = await services.startRun(agent.id, "poll forever");
    // The model is still answering: count this run as having used up its waits.
    await store.update((state) => {
      state.runs.find((item) => item.id === run.id)!.sleeps = MAX_SLEEPS;
    });
    const finished = await until(() => services.kernel.getRun(run.id), (item) => item.status === "completed" || item.status === "failed" || item.status === "sleeping");
    assert.equal(finished.status, "completed", finished.error);
    assert.match(String((finished.actions[0]!.result as { error?: string }).error), /already waited/);
  } finally {
    model.server.close();
  }
});

test("short waits block inline, read ms, and stop when the run is stopped", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-inline-"));
  const quick = (await runComputerUseSkill(directory, "computer_wait", { ms: 50, reason: "page load" })) as { elapsed_ms: number; reason: string };
  assert.ok(quick.elapsed_ms >= 45 && quick.elapsed_ms < 1_000);
  assert.equal(quick.reason, "page load");

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const aborted = (await runComputerUseSkill(directory, "computer_wait", { ms: 20_000 }, controller.signal)) as { elapsed_ms: number };
  assert.ok(aborted.elapsed_ms < 1_000);
});

test("old tool results are cleared and long ones clipped, so every round stays small", () => {
  const big = "x".repeat(50_000);
  const actions: RunAction[] = Array.from({ length: 10 }, (_, index) => ({
    id: `a${index}`,
    toolId: "files",
    arguments: {},
    status: "completed",
    result: { content: big },
  }));
  const compact = compactActions(actions);
  assert.equal(compact.length, 10);
  const old = JSON.stringify(compact[0]?.result);
  assert.match(old, /result cleared to save context/);
  assert.match(old, /Call files again/);
  const recent = JSON.stringify(compact.at(-1)?.result);
  assert.ok(recent.length < CONTEXT_LIMITS.resultChars + 500);
  assert.equal(actions[0]?.result && (actions[0].result as { content: string }).content.length, 50_000, "the stored run is untouched");

  const turns = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `${index} ${"y".repeat(5_000)}`,
  }));
  const { kept, omitted } = budgetHistory(turns);
  assert.ok(omitted > 0);
  assert.equal(kept[0]?.role, "user");
  assert.equal(kept.at(-1), turns.at(-1));
  assert.ok(kept.reduce((sum, turn) => sum + turn.content.length, 0) <= CONTEXT_LIMITS.historyChars);
});

test("the launch app setting defaults to the Agent App, accepts the IDE, and survives a reload", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-launch-"));
  const store = new FileStore(directory);
  await store.load();
  const { services } = createApp(store);
  assert.equal(services.settings().launchApp, "agent");
  assert.equal((await services.updateSettings({ launchApp: "ide" })).launchApp, "ide");
  assert.equal((await services.updateSettings({ name: "Renamed" })).launchApp, "ide", "other saves keep it");
  await assert.rejects(() => services.updateSettings({ launchApp: "browser" as never }), /launchApp/);
  const reopened = new FileStore(directory);
  await reopened.load();
  assert.equal(reopened.state.settings.launchApp, "ide");
});
