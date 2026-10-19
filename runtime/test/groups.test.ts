import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_GROUP_DEPTH, mentions } from "../src/application/groups.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

/** A model that answers as whichever agent the group prompt says it is, by `reply(agent, latestMessage)`. */
async function groupModel(reply: (agent: string, latest: string, from: string) => string) {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const messages = (JSON.parse(raw || "{}") as { messages?: { role?: string; content?: string }[] }).messages ?? [];
      const input = messages.filter((item) => item.role === "user").at(-1)?.content ?? "";
      const agent = input.match(/^You are (\w+),/)?.[1] ?? "?";
      const latest = input.match(/Latest message, from (\w+):\n([\s\S]*)$/);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: reply(agent, latest?.[2] ?? "", latest?.[1] ?? "") } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function setup(reply: (agent: string, latest: string, from: string) => string) {
  const model = await groupModel(reply);
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-groups-"));
  const store = new FileStore(directory);
  await store.load();
  const { services } = createApp(store);
  const connection = await services.createModel({ name: "Local", provider: "openai", baseUrl: model.url });
  const make = (name: string, description: string) =>
    services.createAgent({ name, description, modelConnectionId: connection.id, autonomy: "fully_autonomous", mcpConnectionIds: [] });
  return { model, store, services, make };
}

async function settled(services: Awaited<ReturnType<typeof setup>>["services"], groupId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await services.kernel.groups.check();
    const { runs } = services.groupTranscript(groupId);
    if (runs.every((run) => ["completed", "failed", "cancelled"].includes(run.status))) {
      await services.kernel.groups.check();
      if (services.groupTranscript(groupId).runs.length === runs.length) return services.groupTranscript(groupId);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("group did not settle");
}

test("@mentions match whole agent names, case-insensitively", () => {
  assert.equal(mentions("hey @beta can you", "Beta"), true);
  assert.equal(mentions("ask @Code Reviewer now", "Code Reviewer"), true);
  assert.equal(mentions("@Betamax", "Beta"), false);
  assert.equal(mentions("mail me at a@Beta", "Beta"), false);
});

test("every member sees a user message and decides; a reply @mentioning an agent hands it the work", async () => {
  const { model, services, make } = await setup((agent, latest, from) => {
    if (agent === "Alpha") return from === "User" ? "On it. @Beta please write the code." : "PASS";
    if (agent === "Beta") return /@Beta/.test(latest) ? "Done: the code is written." : "PASS";
    return "PASS";
  });
  try {
    const alpha = await make("Alpha", "plans the work");
    const beta = await make("Beta", "writes code");
    const gamma = await make("Gamma", "designs");
    const group = await services.createGroup({ name: "Team", agentIds: [alpha.id, beta.id, gamma.id, "agent_missing"] });
    assert.deepEqual(group.agentIds, [alpha.id, beta.id, gamma.id], "unknown agents are dropped");

    await services.postGroupMessage(group.id, "Build a landing page");
    const { messages, runs } = await settled(services, group.id);
    assert.deepEqual(
      messages.map((item) => [item.agentId ?? "user", item.text, item.depth]),
      [
        ["user", "Build a landing page", 0],
        [alpha.id, "On it. @Beta please write the code.", 1],
        [beta.id, "Done: the code is written.", 2],
      ],
    );
    // All three considered the user's message (two passed); only Beta got Alpha's hand-off.
    assert.equal(runs.length, 4);
    const betaTurn = runs.find((run) => run.agentId === beta.id && run.output.startsWith("Done"));
    assert.match(betaTurn?.input ?? "", /\[User\]: Build a landing page/, "the transcript travels with the turn");
    assert.match(betaTurn?.input ?? "", /You were @mentioned/);

    // Group turns stay out of the agents' own chats.
    assert.equal((await services.messagesFor(beta.id)).length, 0);
    assert.equal((await services.listThreads(beta.id)).length, 0);

    // A user message that @mentions one agent goes only to it.
    await services.postGroupMessage(group.id, "@Gamma what colors?");
    const after = await settled(services, group.id);
    assert.equal(after.runs.length, 5);
    assert.equal(after.runs.at(-1)?.agentId, gamma.id);

    await services.deleteGroup(group.id);
    assert.equal(services.listGroups().length, 0);
    assert.equal(services.kernel.store.state.runs.some((run) => run.groupId === group.id), false);
  } finally {
    model.server.close();
  }
});

test("agents that keep @mentioning each other stop after the hop limit", async () => {
  const { model, services, make } = await setup((agent) => (agent === "Alpha" ? "@Beta your turn" : "@Alpha your turn"));
  try {
    const alpha = await make("Alpha", "");
    const beta = await make("Beta", "");
    const group = await services.createGroup({ name: "Loop", agentIds: [alpha.id, beta.id] });
    await services.postGroupMessage(group.id, "start");
    const { messages } = await settled(services, group.id);
    const replies = messages.filter((item) => item.agentId);
    // Both answer the user, and each chain ends at the hop limit.
    assert.equal(replies.length, 2 * MAX_GROUP_DEPTH);
    assert.equal(Math.max(...replies.map((item) => item.depth)), MAX_GROUP_DEPTH);
  } finally {
    model.server.close();
  }
});
