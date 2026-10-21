import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_GROUP_DEPTH, mentions } from "../src/application/groups.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";
import { toolSteps } from "./tool-steps.js";

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

test("a member takes one turn at a time: a message that reaches it mid-turn waits for its next turn", async () => {
  let inFlight = 0;
  let most = 0;
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      const messages = (JSON.parse(raw || "{}") as { messages?: { role?: string; content?: string }[] }).messages ?? [];
      const input = messages.filter((item) => item.role === "user").at(-1)?.content ?? "";
      seen.push(input.match(/Latest message, from \w+:\n([\s\S]*)$/)?.[1] ?? "");
      setTimeout(() => {
        inFlight -= 1;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
      }, 150);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-groups-"));
    const store = new FileStore(directory);
    await store.load();
    const { services } = createApp(store);
    const connection = await services.createModel({ name: "Local", provider: "openai", baseUrl: `http://127.0.0.1:${address.port}` });
    const solo = await services.createAgent({ name: "Solo", modelConnectionId: connection.id, mcpConnectionIds: [] });
    const group = await services.createGroup({ name: "One", agentIds: [solo.id] });

    await services.postGroupMessage(group.id, "first");
    await services.postGroupMessage(group.id, "second");
    await services.postGroupMessage(group.id, "third");
    assert.equal(services.groupTranscript(group.id).runs.length, 1, "the later messages wait instead of opening more turns");

    const done = await settled(services, group.id);
    assert.equal(done.runs.length, 2, "one more turn covers both waiting messages");
    assert.equal(most, 1, "never two turns of the same agent at once");
    assert.deepEqual(seen, ["first", "third"], "the next turn answers the newest message");
    const second = done.runs.find((run) => run.input.endsWith("third"));
    assert.match(second?.input ?? "", /\[User\]: second/, "and still sees the one in between");
  } finally {
    server.close();
  }
});

test("a group's approval setting replaces its members' own while they work there", async () => {
  // Asks to run a destructive command once, then answers.
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const messages = (JSON.parse(raw || "{}") as { messages?: { role?: string; content?: string }[] }).messages ?? [];
      const sawResult = toolSteps(messages).length > 0;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        choices: [{
          message: sawResult
            ? { content: "cleaned" }
            : { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "code", arguments: JSON.stringify({ command: "rm -rf scratch" }) } }] },
        }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-groups-"));
    const store = new FileStore(directory);
    await store.load();
    const { services } = createApp(store);
    const connection = await services.createModel({ name: "Local", provider: "openai", baseUrl: `http://127.0.0.1:${address.port}` });
    const cleaner = await services.createAgent({ name: "Cleaner", modelConnectionId: connection.id, autonomy: "default" });
    const group = await services.createGroup({ name: "Ops", agentIds: [cleaner.id] });

    await assert.rejects(() => services.updateGroup(group.id, { autonomy: "yolo" }), /autonomy must be/);
    assert.equal((await services.updateGroup(group.id, { autonomy: "bypass" })).autonomy, "bypass");
    await services.postGroupMessage(group.id, "@Cleaner clean up");
    const done = await settled(services, group.id);
    assert.equal(done.runs[0]?.status, "completed", "no approval card in a full-autonomy group");
    assert.equal(done.runs[0]?.actions.find((item) => item.toolId === "code")?.status, "completed");

    assert.equal((await services.updateGroup(group.id, { autonomy: null })).autonomy, undefined, "null goes back to each agent's own");
    await services.postGroupMessage(group.id, "@Cleaner again");
    for (let attempt = 0; attempt < 200 && services.groupTranscript(group.id).runs.at(-1)?.status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(services.groupTranscript(group.id).runs.at(-1)?.status, "waiting_approval", "the agent's own setting asks again");
  } finally {
    server.close();
  }
});

test("a member that leaves the group takes its session with it", async () => {
  const { model, store, services, make } = await setup(() => "PASS");
  try {
    const a = await make("Alpha", "first");
    const b = await make("Beta", "second");
    const group = await services.createGroup({ name: "Pair", agentIds: [a.id, b.id] });
    await store.update((state) => {
      const current = state.groups!.find((item) => item.id === group.id)!;
      current.sessions = { [a.id]: { claudeSessionId: "s-a", seenAt: "2026-10-20T00:00:00Z" }, [b.id]: { codexThreadId: "t-b" } };
    });
    const updated = await services.updateGroup(group.id, { agentIds: [b.id] });
    assert.deepEqual(Object.keys(updated.sessions ?? {}), [b.id]);
  } finally {
    model.server.close();
  }
});
