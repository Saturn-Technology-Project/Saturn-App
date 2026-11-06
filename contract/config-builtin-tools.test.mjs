// The built-in tool servers: which tools they list, a user's disabled tools being saved, honoured and kept when the
// built-ins are installed again, and what is left of the removed Saturn IDE, whichever language runs them.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { open } from "./config-harness.mjs";

let saturn;

before(async () => {
  saturn = await open();
});
after(async () => {
  await saturn?.close();
});

const server = async (id, target = saturn) => (await target.api("GET", "/connections/mcp")).find((item) => item.id === id);
const offered = (body) => (body.tools ?? []).map((tool) => tool.function.name);

test("the built-in servers list their tools, in the categories approval goes by", async () => {
  const listed = await saturn.api("GET", "/connections/mcp");
  assert.deepEqual(listed.slice(0, 5).map((item) => item.id), ["general-skills", "computer-use", "origin", "automations", "browser"]);

  const automations = await server("automations");
  assert.equal(automations.name, "Automations");
  assert.equal(automations.url, "builtin://automations");
  assert.equal(automations.tools.length, 14);
  assert.equal(automations.tools.filter((tool) => tool.category === "read").length, 5);
  assert.equal(automations.tools.filter((tool) => tool.category === "write").length, 9);
  for (const id of ["automation_create", "generative_ui_template", "customizations_create_skill", "workflows_migrate", "plugins_bundle"]) assert.ok(automations.tools.some((tool) => tool.toolId === id), id);
  assert.ok(!automations.tools.some((tool) => /permissioned_github|^github_permission$/.test(tool.toolId)), "Origin has the git tools");
  assert.ok(!automations.tools.some((tool) => /^ui_navigation_|^guide_|^generative_ui_render$/.test(tool.toolId)), "tools that only pretended are gone");

  const computer = await server("computer-use");
  assert.equal(computer.tools.length, 16);
  assert.ok(computer.tools.every((tool) => tool.category === "write"));
  for (const id of ["computer_screenshot", "computer_check_permissions"]) assert.ok(computer.tools.some((tool) => tool.toolId === id), id);

  const origin = await server("origin");
  assert.equal(origin.tools.length, 31);
  const reads = origin.tools.filter((tool) => tool.category === "read");
  const writes = origin.tools.filter((tool) => tool.category === "write");
  assert.equal(reads.length, 13);
  assert.equal(writes.length, 18);
  assert.ok(reads.some((tool) => tool.toolId === "get_repository"));
  assert.ok(writes.some((tool) => tool.toolId === "create_pull_request"));

  for (const item of [automations, computer, origin]) {
    assert.ok(item.tools.every((tool) => tool.serverId === item.id && tool.description && tool.inputSchema?.type === "object"), item.id);
  }
});

test("a built-in server's own name, address and tools are not the user's to change, only which tools are off", async () => {
  await saturn.refused("PATCH", "/connections/mcp/general-skills", { name: "Mine" }, 403);
  await saturn.refused("PATCH", "/connections/mcp/general-skills", { url: "https://example.com/" }, 403);
  await saturn.refused("PATCH", "/connections/mcp/general-skills", { tools: [] }, 403);
  await saturn.refused("POST", "/connections/mcp/general-skills/discover", undefined, 403);
  const off = await saturn.api("PATCH", "/connections/mcp/general-skills", { disabledTools: ["web"] });
  assert.deepEqual(off.disabledTools, ["web"]);
  assert.deepEqual((await saturn.api("PATCH", "/connections/mcp/general-skills", { disabledTools: [] })).disabledTools, []);
});

test("a disabled tool is saved, not offered to the model, not handed out by load_tools, and refused if called", async () => {
  const updated = await saturn.api("PATCH", "/connections/mcp/automations", { disabledTools: ["automation_delete"] });
  assert.deepEqual(updated.disabledTools, ["automation_delete"]);
  assert.equal(updated.tools.length, 14, "off is not gone: the list still shows it");
  assert.deepEqual((await server("automations")).disabledTools, ["automation_delete"]);

  const setup = await saturn.chat({
    autonomy: "bypass",
    mcpConnectionIds: ["general-skills", "automations"],
    steps: [
      ["load_tools", { toolkits: ["automations"] }],
      ["automation_delete", { automationId: "nobody" }],
      ["automation_list", {}],
    ],
  });
  const run = await saturn.finished((await saturn.start(setup)).id);
  assert.equal(run.status, "completed", run.error);
  const [loaded, deleted, list] = run.actions;
  const names = loaded.result.loaded.flatMap((item) => item.tools);
  assert.ok(names.includes("automation_list"));
  assert.ok(!names.includes("automation_delete"));
  assert.equal(deleted.status, "failed");
  assert.equal(deleted.reason, "Unknown tool: automation_delete");
  assert.equal(list.status, "completed", "the others still work");
  const last = setup.model.requests.filter((body) => body.tools?.length).at(-1);
  assert.ok(offered(last).includes("automation_list"), "loaded by now");
  assert.ok(!offered(last).includes("automation_delete"));
  await saturn.api("PATCH", "/connections/mcp/automations", { disabledTools: [] });
});

test("a disabled tool of the user's own MCP server is not offered either", async () => {
  const url = await saturn.serve((_request, raw, response) => {
    const message = JSON.parse(raw);
    const result = message.method === "tools/list"
      ? { tools: [{ name: "keep", description: "Kept", inputSchema: { type: "object" } }, { name: "drop", description: "Dropped", inputSchema: { type: "object" } }] }
      : { ok: true };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  const remote = await saturn.api("POST", "/connections/mcp", { name: "Remote", url });
  await saturn.api("POST", `/connections/mcp/${remote.id}/discover`);
  await saturn.api("PATCH", `/connections/mcp/${remote.id}`, { disabledTools: ["drop"] });
  const setup = await saturn.chat({ autonomy: "bypass", mcpConnectionIds: ["general-skills", remote.id], steps: [["drop", {}]] });
  const run = await saturn.finished((await saturn.start(setup)).id);
  assert.equal(run.actions[0].reason, "Unknown tool: drop");
  const asked = setup.model.requests.find((body) => body.tools?.length);
  assert.ok(offered(asked).includes("keep"));
  assert.ok(!offered(asked).includes("drop"));
  await saturn.api("DELETE", `/mcp/${remote.id}`);
});

test("disabled tools outlast a restart and the built-ins being installed again, under their old names too", async () => {
  const fresh = await open();
  try {
    const agent = await fresh.api("POST", "/agents", { name: "Builder" });
    await fresh.api("PATCH", "/connections/mcp/automations", { disabledTools: ["automation_delete"] });
    await fresh.api("PATCH", "/connections/mcp/computer-use", { disabledTools: ["computer_drag"] });
    await fresh.api("PATCH", "/connections/mcp/origin", { disabledTools: ["merge_pull_request"] });
    await fresh.api("PATCH", "/connections/mcp/browser", { disabledTools: ["browser_evaluate"] });
    await fresh.restart();
    assert.deepEqual((await server("computer-use", fresh)).disabledTools, ["computer_drag"]);

    // An earlier version's state: tool lists out of date, so the built-ins are installed afresh.
    await fresh.restart((state) => {
      for (const item of state.mcp) if (item.id !== "general-skills") item.tools = item.tools.slice(0, 2);
    });
    for (const [id, tool, count] of [["automations", "automation_delete", 14], ["computer-use", "computer_drag", 16], ["origin", "merge_pull_request", 31], ["browser", "browser_evaluate", 11]]) {
      const item = await server(id, fresh);
      assert.equal(item.tools.length, count, id);
      assert.deepEqual(item.disabledTools, [tool], id);
    }

    // Finding a built-in's tools again keeps them off too.
    assert.deepEqual((await fresh.api("POST", "/connections/mcp/automations/discover")).disabledTools, ["automation_delete"]);

    // The ids of earlier versions become today's, on the servers and on the agents.
    await fresh.restart((state) => {
      for (const [from, to] of [["computer-use", "cursor-computer-use"], ["origin", "cursor-origin"], ["automations", "antigravity-skills"]]) {
        state.mcp.find((item) => item.id === from).id = to;
        const owner = state.agents.find((item) => item.id === agent.id);
        owner.mcpConnectionIds = owner.mcpConnectionIds.map((id) => (id === from ? to : id));
      }
    });
    const listed = await fresh.api("GET", "/connections/mcp");
    assert.ok(!listed.some((item) => ["cursor-computer-use", "cursor-origin", "antigravity-skills"].includes(item.id)));
    assert.deepEqual((await server("automations", fresh)).disabledTools, ["automation_delete"]);
    assert.deepEqual((await server("computer-use", fresh)).disabledTools, ["computer_drag"]);
    assert.deepEqual((await server("origin", fresh)).disabledTools, ["merge_pull_request"]);
    const ids = (await fresh.api("GET", `/agents/${agent.id}`)).mcpConnectionIds;
    assert.ok(["computer-use", "origin", "automations"].every((id) => ids.includes(id)), JSON.stringify(ids));
    assert.ok(!ids.some((id) => ["cursor-computer-use", "cursor-origin", "antigravity-skills"].includes(id)), JSON.stringify(ids));
  } finally {
    await fresh.close();
  }
});

test("state saved by a version with Saturn IDE loads without its server, its tools or its settings", async () => {
  const fresh = await open();
  try {
    const connection = await fresh.api("POST", "/connections/models", { name: "Local", provider: "openai", baseUrl: "http://127.0.0.1:9" });
    const agent = await fresh.api("POST", "/agents", { name: "Builder", modelConnectionId: connection.id, autonomy: "review" });
    await fresh.restart((state) => {
      state.mcp.push({ id: "ide", name: "Saturn IDE", url: "builtin://ide", tools: [] });
      state.agents.find((item) => item.id === agent.id).mcpConnectionIds.push("ide");
      state.settings.launchApp = "ide";
      state.settings.claudeCodeAuth = "api-key";
    });
    assert.ok(!(await fresh.api("GET", "/connections/mcp")).some((item) => item.id === "ide"));
    const ids = (await fresh.api("GET", `/agents/${agent.id}`)).mcpConnectionIds;
    assert.ok(!ids.includes("ide"));
    assert.ok(ids.length > 0, "the agent keeps its other tools");
    const settings = await fresh.api("GET", "/settings");
    assert.ok(!("launchApp" in settings) && !("claudeCodeAuth" in settings));

    // Nor do they come back into the file with the next save.
    await fresh.api("PATCH", "/settings", { name: "Saved" });
    const saved = JSON.parse(await readFile(path.join(fresh.dataDir, "state.json"), "utf8"));
    assert.ok(!saved.mcp.some((item) => item.id === "ide"));
    assert.ok(!("launchApp" in saved.settings) && !("claudeCodeAuth" in saved.settings));
  } finally {
    await fresh.close();
  }
});

test("a call to a tool of Saturn IDE fails and says why, and any other unknown tool says that", async () => {
  const setup = await saturn.chat({ autonomy: "bypass", steps: [["ide_rename", { path: "a.ts" }], ["no_such_tool", {}]] });
  const run = await saturn.finished((await saturn.start(setup)).id);
  assert.equal(run.status, "completed", run.error);
  const [removed, unknown] = run.actions;
  assert.equal(removed.status, "failed");
  assert.match(removed.reason, /ide_rename was part of Saturn IDE/);
  assert.equal(unknown.status, "failed");
  assert.equal(unknown.reason, "Unknown tool: no_such_tool");
});

test("the routes only Saturn IDE used are gone", async () => {
  for (const route of ["/v1/traces", "/v1/logs", "/runtime/wakeup"]) await saturn.refused("POST", route, {}, 404);
});
