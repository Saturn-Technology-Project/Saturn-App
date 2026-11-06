// The tools an agent has for automations, customizations, workflows and plugins, whichever language runs them. Answers are
// compared with contract/cases/agent-tools.json, recorded from the TypeScript runtime before it was removed; a change here is a deliberate one.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startRuntime } from "./runtime.mjs";

const casesFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "cases/agent-tools.json");

let scratch;
let runtime;
let server;
let agent;
const queue = [];

async function call(method, route, body) {
  const token = (await readFile(path.join(runtime.dataDir, "runtime-token"), "utf8")).trim();
  const response = await fetch(`${runtime.origin}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.ok(response.status < 300, `${method} ${route}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

before(async () => {
  scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "saturn-contract-tools-")));
  // A fixed zone, so an automation in "this computer's" zone records the same everywhere.
  runtime = await startRuntime({ env: { TZ: "UTC" } });
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      // Background work (a chat's title, memory) asks without tools and must not take a step meant for the run.
      const next = JSON.parse(raw || "{}").tools?.length ? queue.shift() : undefined;
      const message = next ? { role: "assistant", content: "", tool_calls: [{ id: "c0", type: "function", function: { name: next[0], arguments: JSON.stringify(next[1]) } }] } : { role: "assistant", content: "done" };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "r", object: "chat.completion", model: "s", choices: [{ index: 0, finish_reason: next ? "tool_calls" : "stop", message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const connection = await call("POST", "/connections/models", { name: "Scripted", provider: "openai", model: "s", baseUrl: `http://127.0.0.1:${server.address().port}` });
  agent = await call("POST", "/agents", { name: "Tools", modelConnectionId: connection.id, autonomy: "bypass", mcpConnectionIds: ["automations"] });
});
after(async () => {
  await runtime?.stop();
  await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  await rm(scratch, { recursive: true, force: true });
});

/** Runs each [tool, arguments] in a chat, on `folder` when given, and gives what each answered. */
async function run(steps, folder) {
  queue.push(...steps);
  let threadId;
  if (folder) {
    const project = await call("POST", "/projects", { path: folder, grant: true });
    threadId = (await call("POST", `/agents/${agent.id}/threads`, { title: "Tools", projectId: project.id })).id;
  }
  const started = await call("POST", `/agents/${agent.id}/runs`, { input: "go", ...(threadId ? { threadId } : {}) });
  let current;
  for (let attempt = 0; attempt < 1500; attempt += 1) {
    current = await call("GET", `/runs/${started.id}`);
    if (!["queued", "running", "waiting_approval"].includes(current.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(current.status, "completed", current.error);
  assert.equal(current.actions.length, steps.length);
  return current.actions.map((action, index) => ({ tool: steps[index][0], arguments: steps[index][1], status: action.status, ...(action.result === undefined ? {} : { result: action.result }), ...(action.reason === undefined ? {} : { reason: action.reason }) }));
}

async function matchesRecording(name, value) {
  const normalized = JSON.parse(JSON.stringify(value)
    .replaceAll(runtime.dataDir, "<data>")
    .replaceAll(scratch, "<scratch>")
    .replaceAll(agent.id, "<agent>")
    .replace(/(auto|run)_[0-9a-f]{8,}/g, "<$1>")
    .replace(/"(nextRun|lastRunAt)":"[^"]*"/g, '"$1":"<time>"')
    .replace(/next run [0-9:\-TZ. ]+\(/g, "next run <time> ("));
  const all = await readFile(casesFile, "utf8").then(JSON.parse).catch(() => ({}));
  assert.ok(all[name], `${name} is not recorded`);
  assert.deepEqual(normalized, all[name]);
}

test("automations made by an agent are the ones on the Automations page", async () => {
  const [created] = await run([["automation_create", { name: "Nightly", prompt: "Sum it up", cron: "CRON_TZ=Asia/Taipei 0 9 * * 1-5" }]]);
  const id = created.result.automation.id;
  assert.equal(created.result.automation.agentId, agent.id, "the calling agent runs it");
  const [local] = await run([["automation_create", { name: "Here", prompt: "x", cron: "30 * * * *", enabled: false }]]);
  assert.equal(local.result.automation.timeZone, "UTC", "this computer's zone, here set to UTC");
  assert.equal(local.result.automation.enabled, false);
  assert.match(local.result.message, /next run when enabled/);
  const localId = local.result.automation.id;

  const answers = await run([
    ["automation_create", { name: "Each week", prompt: "x", cron: "CRON_TZ=UTC 5 7 * * 7" }],
    ["automation_create", { name: "Each day", prompt: "x", cron: "CRON_TZ=UTC 5 7 * * *" }],
    ["automation_create", { name: "Often", prompt: "x", cron: "*/5 * * * *" }],
    ["automation_create", { name: "Elsewhere", prompt: "x", cron: "CRON_TZ=No/Such 0 9 * * *" }],
    ["automation_create", { name: "Too few", prompt: "x", cron: "0 9 *" }],
    ["automation_create", { name: "", prompt: "", cron: "0 9 * * *" }],
    ["automation_create", { name: "Nobody", prompt: "x", cron: "0 9 * * *", agentId: "agt_none" }],
    ["automation_list", { filter: "disabled" }],
    ["automation_list", { filter: "enabled" }],
    ["automation_toggle", { automationId: id, enabled: false }],
    ["automation_toggle", { automationId: "aut_none", enabled: true }],
    ["automation_delete", { automationId: "aut_none" }],
    ["automation_trigger", { automationId: "aut_none" }],
  ]);
  await matchesRecording("automations", answers);
  assert.equal((await call("GET", "/automations")).find((item) => item.id === id).enabled, false);

  const [triggered] = await run([["automation_trigger", { automationId: localId }]]);
  assert.equal(triggered.result.success, true);
  assert.equal(triggered.result.status, "started");
  assert.ok(triggered.result.runId);
  const [removed] = await run([["automation_delete", { automationId: localId }]]);
  assert.equal(removed.result.message, `Automation ${localId} deleted.`);
  assert.ok(!(await call("GET", "/automations")).some((item) => item.id === localId));
});

test("the widget templates are the ones the tool promises", async () => {
  await matchesRecording("templates", await run([
    ["generative_ui_template", { type: "metrics_dashboard" }],
    ["generative_ui_template", { type: "interactive_filter" }],
    ["generative_ui_template", { type: "flow_diagram" }],
    ["generative_ui_template", { type: "form_wizard" }],
    ["generative_ui_template", {}],
  ]));
});

test("customizations are written in the chat's project, and stay in it", async () => {
  const folder = path.join(scratch, "customizing");
  const outside = path.join(scratch, "outside");
  await mkdir(folder);
  await mkdir(outside);
  const answers = await run([
    ["customizations_list", {}],
    ["customizations_create_skill", { name: "My Skill!", description: "One\nname: injected\nline", instructions: "Do it." }],
    ["customizations_create_skill", {}],
    ["customizations_create_rule", { name: "style", content: "# Style" }],
    ["customizations_create_rule", { name: "kept.md", content: "kept" }],
    ["customizations_create_rule", { content: "named by default" }],
    ["customizations_list", { scope: "workspace" }],
  ], folder);
  const sorted = (list) => [...list].sort((a, b) => a.name.localeCompare(b.name));
  for (const answer of answers.filter((item) => item.tool === "customizations_list")) {
    answer.result.discovered.skills = sorted(answer.result.discovered.skills);
    answer.result.discovered.rules = sorted(answer.result.discovered.rules);
  }
  await matchesRecording("customizations", answers);
  assert.equal(await readFile(path.join(folder, ".agents/skills/my-skill-/SKILL.md"), "utf8"), "---\nname: my-skill-\ndescription: >-\n  One name: injected line\n---\n\n# my-skill-\n\nDo it.\n");
  assert.equal(await readFile(path.join(folder, ".agents/rules/style.md"), "utf8"), "# Style");

  // A name is one file, whatever it says.
  const refused = await run([
    ["customizations_create_rule", { name: "../../../escaped", content: "x" }],
    ["customizations_create_rule", { name: "/tmp/absolute", content: "x" }],
    ["customizations_create_rule", { name: "a\\b", content: "x" }],
    ["customizations_create_rule", { name: ".hidden", content: "x" }],
    ["customizations_create_skill", { name: "../../escaped", instructions: "x" }],
  ], folder);
  for (const answer of refused.slice(0, 4)) assert.match(answer.reason ?? "", /plain file name/, JSON.stringify(answer));
  assert.equal(refused[4].result.name, "------escaped", "the skill's name is made plain");
  assert.ok(!existsSync(path.join(scratch, "escaped.md")));
  assert.ok(!existsSync(path.join(folder, "..", "escaped")));

  // A link a cloned repository brought along leads nowhere new.
  const cloned = path.join(scratch, "cloned");
  await mkdir(path.join(cloned, ".agents"), { recursive: true });
  await symlink(outside, path.join(cloned, ".agents/rules"));
  await symlink(outside, path.join(cloned, ".agents/skills"));
  await symlink(outside, path.join(cloned, "plugins"));
  const led = await run([
    ["customizations_create_rule", { name: "led", content: "x" }],
    ["customizations_create_skill", { name: "led", instructions: "x" }],
    ["plugins_bundle", { name: "led" }],
  ], cloned);
  for (const answer of led) assert.match(answer.reason ?? "", /outside the workspace/, JSON.stringify(answer));
  assert.ok(!existsSync(path.join(outside, "led.md")));
  assert.ok(!existsSync(path.join(outside, "led")));
});

test("legacy workflows become skills, and a link does not bring anything in", async () => {
  const folder = path.join(scratch, "workflows");
  const flows = path.join(folder, ".agents/workflows");
  await mkdir(flows, { recursive: true });
  await mkdir(path.join(folder, "_agents/workflows"), { recursive: true });
  await writeFile(path.join(flows, "deploy.md"), "Deploy it.\n");
  await writeFile(path.join(flows, "headed.md"), "---\nname: headed\n---\nBody\n");
  await writeFile(path.join(flows, "notes.txt"), "not a workflow");
  await writeFile(path.join(flows, "kept.md"), "Keep me.\n");
  await writeFile(path.join(folder, "_agents/workflows/other.md"), "Other.\n");
  const secret = path.join(scratch, "private.md");
  await writeFile(secret, "PRIVATE");
  await symlink(secret, path.join(flows, "linked.md"));

  const scanned = await run([["workflows_scan", {}]], folder);
  scanned[0].result.workflows.sort((a, b) => a.name.localeCompare(b.name));
  await matchesRecording("workflow scan", scanned);

  const migrated = await run([
    ["workflows_migrate", { workflowName: "kept", archiveOld: false }],
    ["workflows_migrate", { workflowName: "nothing" }],
    ["workflows_migrate", {}],
  ], folder);
  migrated[2].result.migrated.sort();
  await matchesRecording("workflow migration", migrated);
  assert.equal(await readFile(path.join(folder, ".agents/skills/deploy/SKILL.md"), "utf8"), "---\nname: deploy\ndescription: Migrated from legacy workflow deploy\n---\n\nDeploy it.\n\n");
  assert.equal(await readFile(path.join(folder, ".agents/skills/headed/SKILL.md"), "utf8"), "---\nname: headed\n---\nBody\n");
  assert.ok(existsSync(path.join(flows, "archive/deploy.md")));
  assert.ok(!existsSync(path.join(folder, ".agents/skills/linked")), "a link is not a workflow");

  // Going wrong is said, not reported as success.
  const stuck = path.join(scratch, "stuck");
  await mkdir(path.join(stuck, ".agents/workflows"), { recursive: true });
  await mkdir(path.join(stuck, ".agents/skills"), { recursive: true });
  await writeFile(path.join(stuck, ".agents/workflows/blocked.md"), "x");
  await writeFile(path.join(stuck, ".agents/skills/blocked"), "a file where the skill's folder goes");
  const [failed] = await run([["workflows_migrate", {}]], stuck);
  assert.equal(failed.status, "failed", JSON.stringify(failed));
});

test("plugins are packaged in the project, without links, and turned on and off", async () => {
  const folder = path.join(scratch, "bundling");
  const skill = path.join(folder, ".agents/skills/helper");
  await mkdir(path.join(skill, "extra"), { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "---\nname: helper\ndescription: Helps\n---\nHelp.\n");
  await writeFile(path.join(skill, "extra/notes.md"), "Notes");
  const secret = path.join(scratch, "private-key");
  await writeFile(secret, "PRIVATE");
  await symlink(secret, path.join(skill, "linked.md"));
  await symlink(path.dirname(secret), path.join(folder, ".agents/skills/linked-skill"));

  const answers = await run([
    ["plugins_bundle", { name: "My Pack", displayName: "Shown", skills: ["helper", "missing", "../..", "linked-skill"] }],
    ["plugins_bundle", { description: "Described" }],
    ["plugins_list", {}],
    ["plugins_toggle", { pluginName: "not-installed", enabled: true }],
  ], folder);
  await matchesRecording("plugins", answers);
  const packaged = path.join(folder, "plugins/my-pack");
  assert.deepEqual(JSON.parse(await readFile(path.join(packaged, "plugin.json"), "utf8")), { name: "my-pack", description: "Shown", version: "0.1.0" });
  assert.equal(await readFile(path.join(packaged, "skills/helper/extra/notes.md"), "utf8"), "Notes");
  assert.ok(!existsSync(path.join(packaged, "skills/helper/linked.md")), "a link stays behind");
  assert.ok(!existsSync(path.join(packaged, "skills/linked-skill")));

  // Installed from where it was packaged, the agent can see it and turn it off.
  await call("POST", "/plugins", { source: packaged });
  const toggled = await run([
    ["plugins_list", {}],
    ["plugins_toggle", { pluginName: "my-pack", enabled: false }],
    ["plugins_list", { includeDisabled: false }],
    ["plugins_list", {}],
  ], folder);
  assert.equal(toggled[0].result.total, 1);
  assert.equal(toggled[0].result.plugins[0].enabled, true);
  assert.equal(toggled[1].result.message, 'Plugin "my-pack" is now off.');
  assert.equal(toggled[2].result.total, 0);
  assert.equal(toggled[3].result.plugins[0].enabled, false);
});

test("the workspace is the chat's project, or Saturn's own without one", async () => {
  const folder = path.join(scratch, "nothing");
  await mkdir(folder);
  const [answer] = await run([["customizations_list", {}]], folder);
  assert.equal(answer.result.workspace, folder);
  const [elsewhere] = await run([["customizations_list", {}]]);
  assert.equal(elsewhere.result.workspace, path.join(runtime.dataDir, "workspace"));
});
