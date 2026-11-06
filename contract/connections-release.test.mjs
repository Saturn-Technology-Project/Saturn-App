// A connection still in use is refused unless the agents using it are told what becomes of them, since an agent may have
// no screen left to change it on.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { bench } from "./files-support.mjs";

let saturn;
before(async () => { saturn = await bench(); });
after(async () => { await saturn?.stop(); });

const model = (name) => saturn.api("POST", "/connections/models", { name, provider: "openai", model: "m", baseUrl: "http://127.0.0.1:9" });
const agentOf = async (id) => (await saturn.api("GET", "/agents")).find((item) => item.id === id);

test("a model in use is refused until its agents are moved, and they can run out of models", async () => {
  const [first, second] = [await model("First"), await model("Second")];
  const agent = await saturn.api("POST", "/agents", { name: "Worker", modelConnectionId: first.id });
  const other = await saturn.api("POST", "/agents", { name: "Elsewhere", modelConnectionId: second.id });

  const refused = await saturn.call("DELETE", `/connections/models/${first.id}`);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /still used by an agent/);
  assert.equal((await agentOf(agent.id)).modelConnectionId, first.id);

  assert.equal((await saturn.call("DELETE", `/connections/models/${first.id}?moveAgentsTo=${first.id}`)).status, 400);
  assert.equal((await saturn.call("DELETE", `/connections/models/${first.id}?moveAgentsTo=mdl_missing`)).status, 404);
  assert.equal((await agentOf(agent.id)).modelConnectionId, first.id, "a refused move changes nothing");

  assert.equal((await saturn.call("DELETE", `/connections/models/${first.id}?moveAgentsTo=${second.id}`)).status, 204);
  assert.equal((await agentOf(agent.id)).modelConnectionId, second.id);
  assert.ok(!(await saturn.api("GET", "/connections/models")).some((item) => item.id === first.id));

  assert.equal((await saturn.call("DELETE", `/connections/models/${second.id}?moveAgentsTo=none`)).status, 204);
  assert.equal((await agentOf(agent.id)).modelConnectionId, null);
  assert.equal((await agentOf(other.id)).modelConnectionId, null);
  await saturn.api("DELETE", `/agents/${agent.id}`);
  await saturn.api("DELETE", `/agents/${other.id}`);
});

test("a server in use comes off its agents' lists only when asked, and other servers stay", async () => {
  const server = await saturn.api("POST", "/connections/mcp", { name: "Tools", url: "https://example.invalid/mcp" });
  const kept = await saturn.api("POST", "/connections/mcp", { name: "Kept", url: "https://example.invalid/kept" });
  const agent = await saturn.api("POST", "/agents", { name: "Worker", mcpConnectionIds: [server.id, kept.id] });
  assert.equal((await saturn.call("DELETE", `/connections/mcp/${server.id}`)).status, 409);
  assert.equal((await saturn.call("DELETE", `/connections/mcp/${server.id}?releaseAgents=true`)).status, 204);
  const after = (await agentOf(agent.id)).mcpConnectionIds;
  assert.ok(!after.includes(server.id));
  assert.ok(after.includes(kept.id));
  await saturn.api("DELETE", `/agents/${agent.id}`);
});

test("a model's removal needs to know where its agents go, and an unused one needs nothing", async () => {
  const unused = await model("Unused");
  assert.equal((await saturn.call("DELETE", `/connections/models/${unused.id}`)).status, 204);
  const held = await model("Held");
  const agent = await saturn.api("POST", "/agents", { name: "Worker", modelConnectionId: held.id });
  const silent = await saturn.call("DELETE", `/connections/models/${held.id}?releaseAgents=true`);
  assert.equal(silent.status, 400);
  assert.match(silent.body.error, /Say which model/);
  assert.equal((await agentOf(agent.id)).modelConnectionId, held.id);
});
