import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { contextTokensFor, historyBudgetChars, splitForCompaction } from "../src/domain/context.js";
import type { Run } from "../src/domain/model.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

type Seen = { system: string; messages: { role: string; content: string }[] };

/** A model that answers a summarizing request with a summary, and anything else with "done". Records every request. */
async function recordingModel() {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const messages = (JSON.parse(raw || "{}") as { messages?: { role: string; content: string }[] }).messages ?? [];
      const system = messages.find((item) => item.role === "system")?.content ?? "";
      seen.push({ system, messages });
      const summarizing = system.includes("compacting the earlier part");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: summarizing ? `SUMMARY of ${messages.filter((item) => item.role === "user").length - 1} user messages` : "done" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { seen, server, url: `http://127.0.0.1:${address.port}` };
}

async function until(read: () => Run, done: (run: Run) => boolean): Promise<Run> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const run = read();
    if (done(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`run stuck at ${read().status}`);
}
const settled = (run: Run) => run.status !== "running" && run.status !== "queued" && run.status !== "waiting_approval";

test("context windows come from the catalog unless the connection says otherwise; the split keeps the newest turns", () => {
  assert.equal(contextTokensFor({ provider: "claude", model: "claude-sonnet-5-5" }), 200_000);
  assert.equal(contextTokensFor({ provider: "openai", model: "gpt-6-astra" }), 400_000);
  assert.equal(contextTokensFor({ provider: "openai", model: "gpt-4o" }), 128_000);
  assert.equal(contextTokensFor({ provider: "lmstudio", model: "qwen", contextTokens: 8_000 }), 8_000);
  assert.equal(historyBudgetChars({ provider: "lmstudio", model: "x", contextTokens: 1_000 }), 2_000);
  const turns = [{ id: 1, chars: 500 }, { id: 2, chars: 500 }, { id: 3, chars: 500 }, { id: 4, chars: 500 }];
  assert.deepEqual(splitForCompaction(turns, 1_000).old.map((item) => item.id), [1, 2]);
  assert.deepEqual(splitForCompaction(turns, 10).recent.map((item) => item.id), [4], "the newest turn always stays");
});

test("a long chat is summarized by its model before the turn that would overflow, and later turns ride on the summary", async () => {
  const model = await recordingModel();
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-compaction-"));
  try {
    const store = new FileStore(directory);
    await store.load();
    const { services } = createApp(store);
    // A tiny window: 2,000 tokens → 8,000 chars → 4,000 chars of history.
    const connection = await services.createModel({ name: "Small", provider: "openai", baseUrl: model.url });
    await store.update((state) => {
      state.models.find((item) => item.id === connection.id)!.contextTokens = 2_000;
    });
    const agent = await services.createAgent({ name: "Writer", modelConnectionId: connection.id, autonomy: "default" });
    const thread = await services.kernel.runs.createThread(agent.id, "Long chat");
    // Six finished turns of 1,000 characters each: well over the budget.
    const now = new Date().toISOString();
    await store.update((state) => {
      for (let index = 1; index <= 6; index += 1) {
        state.runs.unshift({ id: `run_${index}`, agentId: agent.id, threadId: thread.id, input: `question ${index} ${"q".repeat(500)}`, status: "completed", output: `answer ${index} ${"a".repeat(480)}`, actions: [], generation: 0 } as Run);
        state.threads!.find((item) => item.id === thread.id)!.updatedAt = now;
      }
    });

    const usageBefore = services.kernel.runs.contextUsage(thread.id);
    assert.equal(usageBefore.turns, 6);
    assert.ok(usageBefore.percent >= 100, `over budget: ${usageBefore.percent}%`);

    const run = await services.startRun(agent.id, "question 7", thread.id);
    const done = await until(() => services.kernel.getRun(run.id), settled);
    assert.equal(done.status, "completed", done.error);
    assert.equal(done.output, "done");

    // One summarizing call, then the turn's own call carrying the summary and only the newest turns.
    assert.equal(model.seen.length, 2);
    const [summarizing, turn] = model.seen as [Seen, Seen];
    assert.match(summarizing.system, /compacting the earlier part/);
    assert.ok(summarizing.messages.some((item) => item.content.startsWith("question 1 ")), "the oldest turn went to the summarizer");
    const summaryMessage = turn.messages.find((item) => item.content.startsWith("[Summary of the earlier conversation"));
    assert.ok(summaryMessage, "the turn carries the summary");
    assert.match(summaryMessage.content, /SUMMARY of/);
    assert.ok(!turn.messages.some((item) => item.content.startsWith("question 1 ")), "the oldest turn is not sent whole");
    assert.ok(turn.messages.some((item) => item.content.startsWith("question 6 ")), "the newest turn is sent whole");

    const saved = store.state.threads!.find((item) => item.id === thread.id)!.summary!;
    assert.equal(done.compacted?.turns, saved.turns, "the turn records how many turns were folded");
    assert.ok(saved.throughRunId.startsWith("run_"));
    const usageAfter = services.kernel.runs.contextUsage(thread.id);
    assert.ok(usageAfter.percent < 100, `fits now: ${usageAfter.percent}%`);
    assert.equal(usageAfter.summary?.turns, saved.turns);

    // The next turn fits: no second summary, and the same summary is sent again.
    const again = await services.startRun(agent.id, "question 8", thread.id);
    await until(() => services.kernel.getRun(again.id), settled);
    assert.equal(model.seen.length, 3, "no summarizing call this time");
    assert.ok(model.seen[2]!.messages.some((item) => item.content.includes("SUMMARY of")));

    // "/compact" folds everything that is left, with the earlier summary handed to the model.
    const compacted = await services.kernel.runs.compactThread(thread.id);
    assert.ok(compacted.folded >= 2);
    assert.ok(model.seen[3]!.messages.some((item) => item.content.startsWith("Earlier summary:")));
    await assert.rejects(services.kernel.runs.compactThread(thread.id), /already/);
  } finally {
    model.server.close();
  }
});
