// Group chats beyond the first hand-off, whichever language runs them: who takes a turn, how a chain ends, one turn at a
// time per member, and the group's own approval setting.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { open, settled } from "./config-harness.mjs";

let saturn;

before(async () => {
  saturn = await open();
});
after(async () => {
  await saturn?.close();
});

/** What a group prompt says: which agent is asked, the latest message and who sent it. */
function turnOf(body) {
  const input = (body.messages ?? []).filter((item) => item.role === "user").at(-1)?.content;
  const text = typeof input === "string" ? input : JSON.stringify(input ?? "");
  const latest = text.match(/Latest message, from (\w+):\n([\s\S]*)$/);
  return { agent: text.match(/^You are (\w+),/)?.[1] ?? "?", latest: latest?.[2] ?? "", from: latest?.[1] ?? "" };
}

/** A model answering as whichever member the prompt names, by `reply(agent, latest, from)`, and agents on it. */
async function team(reply, names, { autonomy = "bypass" } = {}) {
  const scripted = await saturn.model({ answer: (body) => { const turn = turnOf(body); return reply(turn.agent, turn.latest, turn.from); } });
  const agents = [];
  for (const name of names) agents.push(await saturn.api("POST", "/agents", { name, description: `${name} works here`, modelConnectionId: scripted.connection.id, autonomy, mcpConnectionIds: [] }));
  return { scripted, agents };
}

const transcript = (id) => saturn.api("GET", `/groups/${id}/messages`);
const settledAll = (view) => view.runs.every(settled);

/** Waits until every turn has settled and its reply is posted: `holds`, and nothing new for longer than a check takes. */
async function quiet(id, holds) {
  let last = "";
  let since = Date.now();
  return saturn.until("the group to go quiet", () => transcript(id), (view) => {
    const shape = `${view.messages.length} ${view.runs.length}`;
    if (shape !== last || !settledAll(view) || !holds(view)) {
      last = shape;
      since = Date.now();
    }
    return Date.now() - since > 1_200;
  }, 40_000);
}

test("every member sees a user message and decides; a reply @mentioning an agent hands it the work, with the conversation", async () => {
  const { agents } = await team((agent, latest, from) => {
    if (latest.includes("stand up")) return "PASS";
    if (agent === "Alpha") return from === "User" ? "On it. @Beta please write the code." : "PASS";
    if (agent === "Beta") return /@Beta/.test(latest) ? "Done: the code is written." : "PASS";
    return "PASS";
  }, ["Alpha", "Beta", "Gamma"]);
  const [alpha, beta, gamma] = agents;
  const group = await saturn.api("POST", "/groups", { name: "Team", agentIds: [alpha.id, beta.id, gamma.id] });

  await saturn.api("POST", `/groups/${group.id}/messages`, { text: "Build a landing page" });
  const { messages, runs } = await quiet(group.id, (view) => view.messages.length === 3 && view.runs.length === 4);
  assert.deepEqual(messages.map((item) => [item.agentId ?? "user", item.text, item.depth]), [
    ["user", "Build a landing page", 0],
    [alpha.id, "On it. @Beta please write the code.", 1],
    [beta.id, "Done: the code is written.", 2],
  ]);
  assert.equal(runs.length, 4, "all three considered the user's message; only Beta got the hand-off");
  const handed = runs.find((run) => run.agentId === beta.id && run.output.startsWith("Done"));
  assert.match(handed.input, /\[User\]: Build a landing page/, "the transcript travels with the turn");
  assert.match(handed.input, /You were @mentioned/);
  assert.match(handed.input, /- @Alpha — Alpha works here/, "the roster names who is there");
  assert.match(handed.input, /- @Beta \(you\)/);

  // Group turns stay out of the agents' own chats.
  assert.deepEqual(await saturn.api("GET", `/agents/${beta.id}/messages`), []);
  assert.deepEqual(await saturn.api("GET", `/agents/${beta.id}/threads`), []);

  // A user message that @mentions one agent goes only to it, in any case.
  await saturn.api("POST", `/groups/${group.id}/messages`, { text: "@gamma what colors?" });
  const asked = await quiet(group.id, (view) => view.runs.length === 5);
  assert.equal(asked.runs.filter((run) => run.agentId === gamma.id).length, 2);

  // @everyone reaches every member, whoever else it names.
  await saturn.api("POST", `/groups/${group.id}/messages`, { text: "@everyone and @Alpha: stand up" });
  assert.equal((await quiet(group.id, (view) => view.runs.length === 8)).runs.length, 8);

  // Removing the group takes its turns with it.
  const runIds = (await transcript(group.id)).runs.map((run) => run.id);
  await saturn.api("DELETE", `/groups/${group.id}`);
  assert.ok(!(await saturn.api("GET", "/groups")).some((item) => item.id === group.id));
  await saturn.refused("GET", `/runs/${runIds[0]}`, undefined, 404);
});

test("agents that keep @mentioning each other stop after the hop limit", async () => {
  const { agents } = await team((agent) => (agent === "Alpha" ? "@Beta your turn" : "@Alpha your turn"), ["Alpha", "Beta"]);
  const group = await saturn.api("POST", "/groups", { name: "Loop", agentIds: agents.map((item) => item.id) });
  await saturn.api("POST", `/groups/${group.id}/messages`, { text: "start" });
  const { messages } = await quiet(group.id, (view) => view.messages.filter((item) => item.agentId).length >= 8);
  const replies = messages.filter((item) => item.agentId);
  assert.equal(replies.length, 8, "both answer the user, and each chain ends at the limit of four hops");
  assert.equal(Math.max(...replies.map((item) => item.depth)), 4);
});

test("a member takes one turn at a time: messages that reach it mid-turn wait, and its next turn answers the newest and sees the rest", async () => {
  const seen = [];
  let inFlight = 0;
  let most = 0;
  let release = () => undefined;
  const gate = new Promise((resolve) => { release = resolve; });
  const scripted = await saturn.model({
    hold: async (body) => {
      const { latest, agent } = turnOf(body);
      if (agent !== "Solo") return;
      seen.push(latest);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await gate;
      inFlight -= 1;
    },
    answer: () => "ok",
  });
  const solo = await saturn.api("POST", "/agents", { name: "Solo", modelConnectionId: scripted.connection.id, autonomy: "bypass", mcpConnectionIds: [] });
  const group = await saturn.api("POST", "/groups", { name: "One", agentIds: [solo.id] });
  await saturn.api("POST", `/groups/${group.id}/messages`, { text: "first" });
  await saturn.api("POST", `/groups/${group.id}/messages`, { text: "second" });
  await saturn.api("POST", `/groups/${group.id}/messages`, { text: "third" });
  assert.equal((await transcript(group.id)).runs.length, 1, "the later messages wait instead of opening more turns");
  await saturn.until("the first turn to reach the model", () => seen.length, (count) => count === 1);
  release();
  const done = await quiet(group.id, (view) => view.runs.length === 2 && view.messages.length === 5);
  assert.equal(done.runs.length, 2, "one more turn covers both waiting messages");
  assert.equal(most, 1, "never two turns of the same agent at once");
  assert.deepEqual(seen, ["first", "third"], "the next turn answers the newest message");
  assert.match(done.runs.find((run) => run.input.endsWith("third")).input, /\[User\]: second/, "and still sees the one in between");
});

test("a group's approval setting replaces its members' own while they work there", async () => {
  const scripted = await saturn.model({ steps: [["code", { command: "rm -rf scratch" }]], answer: () => "cleaned" });
  const cleaner = await saturn.api("POST", "/agents", { name: "Cleaner", modelConnectionId: scripted.connection.id, autonomy: "default" });
  const group = await saturn.api("POST", "/groups", { name: "Ops", agentIds: [cleaner.id] });
  await saturn.refused("PATCH", `/groups/${group.id}`, { autonomy: "yolo" }, 400, /autonomy must be/);
  assert.equal((await saturn.api("PATCH", `/groups/${group.id}`, { autonomy: "bypass" })).autonomy, "bypass");

  await saturn.api("POST", `/groups/${group.id}/messages`, { text: "@Cleaner clean up" });
  const allowed = await quiet(group.id, (view) => view.messages.some((item) => item.agentId === cleaner.id));
  assert.equal(allowed.runs[0].status, "completed", "no card in a group that runs without asking");
  assert.equal(allowed.runs[0].actions.find((item) => item.toolId === "code").status, "completed");

  assert.equal((await saturn.api("PATCH", `/groups/${group.id}`, { autonomy: null })).autonomy, undefined, "null goes back to each agent's own");
  scripted.queue.push(["code", { command: "rm -rf scratch" }]);
  await saturn.api("POST", `/groups/${group.id}/messages`, { text: "@Cleaner again" });
  const asked = await saturn.until("the agent's own setting to ask", () => transcript(group.id), (view) => view.runs.some((run) => run.status === "waiting_approval"));
  assert.equal(asked.runs.filter((run) => run.status === "waiting_approval").length, 1);
  await saturn.api("POST", `/runs/${asked.runs.find((run) => run.status === "waiting_approval").id}/stop`);
});

test("a group with no members takes no message, and a paused member sits out", async () => {
  const empty = await saturn.api("POST", "/groups", {});
  assert.equal(empty.name, "New Group");
  await saturn.refused("POST", `/groups/${empty.id}/messages`, { text: "anyone?" }, 409, /Add an agent/);
  const { agents } = await team(() => "here", ["Awake", "Asleep"]);
  await saturn.api("PATCH", `/agents/${agents[1].id}`, { status: "paused" });
  const group = await saturn.api("POST", "/groups", { name: "Partly", agentIds: agents.map((item) => item.id) });
  await saturn.api("POST", `/groups/${group.id}/messages`, { text: "roll call" });
  const { runs } = await quiet(group.id, (view) => view.runs.length >= 1 && view.messages.length >= 2);
  assert.deepEqual(runs.map((run) => run.agentId), [agents[0].id]);
});
