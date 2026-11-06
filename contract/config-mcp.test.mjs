// What may be an MCP server, how a local one is held and started, and the integrations list, whichever language runs them.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { open } from "./config-harness.mjs";

let saturn;

before(async () => {
  // Stands for a key in the runtime's own environment: it must never reach a server it starts.
  saturn = await open({ env: { ANTHROPIC_API_KEY: "contract-parent-key" } });
});
after(async () => {
  await saturn?.close();
});

const refusedUrl = /Saturn does not start local programs/;

test("a server added by URL is an HTTP(S) endpoint: no address ever makes Saturn start a program", async () => {
  for (const url of ["npx -y @evil/mcp-server", "node server.js", "stdio:node server.js", "file:///usr/bin/python3", "javascript:alert(1)", "/usr/local/bin/mcp", ""]) {
    await saturn.refused("POST", "/connections/mcp", { name: "Bad", url }, 400, refusedUrl);
  }
  assert.ok(!(await saturn.api("GET", "/connections/mcp")).some((item) => item.name === "Bad"), "nothing refused was saved");

  const added = await saturn.api("POST", "/connections/mcp", { name: "Remote", url: " https://mcp.example.com/mcp " });
  assert.equal(added.url, "https://mcp.example.com/mcp");
  const local = await saturn.api("POST", "/connections/mcp", { name: "On this computer", url: "http://127.0.0.1:3845/mcp" });
  assert.equal(local.url, "http://127.0.0.1:3845/mcp");

  await saturn.refused("PATCH", `/connections/mcp/${added.id}`, { url: "stdio:./run.sh" }, 400, /not stdio/);
  await saturn.refused("PATCH", `/connections/mcp/${added.id}`, { url: "./run.sh" }, 400, refusedUrl);
  const kept = (await saturn.api("GET", "/connections/mcp")).find((item) => item.id === added.id);
  assert.equal(kept.url, "https://mcp.example.com/mcp", "a refused change leaves the server as it was");
  assert.equal((await saturn.api("PATCH", `/connections/mcp/${added.id}`, { url: " https://mcp.example.com/other " })).url, "https://mcp.example.com/other");
  await saturn.api("DELETE", `/mcp/${added.id}`);
  await saturn.api("DELETE", `/mcp/${local.id}`);
});

test("a local server's command is checked: a program is required, and arguments and variables must be what they say", async () => {
  await saturn.refused("POST", "/connections/mcp", { name: "x", command: { program: "  ", args: [] } }, 400, /needs the program/);
  await saturn.refused("POST", "/connections/mcp", { name: "x", command: { program: "npx\nrm", args: [] } }, 400, /line break/);
  await saturn.refused("POST", "/connections/mcp", { name: "x", command: { program: "npx", args: [1] } }, 400, /Arguments must be text/);
  await saturn.refused("POST", "/connections/mcp", { name: "x", command: { program: "npx", args: ["a\0b"] } }, 400, /NUL/);
  await saturn.refused("POST", "/connections/mcp", { name: "x", command: { program: "npx", args: [], env: { "BAD NAME": "1" } } }, 400, /not a valid environment variable/);
  await saturn.refused("POST", "/connections/mcp", { name: "x", command: { program: "npx", args: [], env: { GOOD: 1 } } }, 400, /must be text/);
  await saturn.refused("POST", "/connections/mcp", { name: "x", url: "npx -y something" }, 400, refusedUrl);
  assert.ok(!(await saturn.api("GET", "/connections/mcp")).some((item) => item.name === "x"));
});

/** A local MCP server: one tool reporting what it was started with. It notes its process id when it starts. */
const PROBE = (pidFile) => `
require("node:fs").appendFileSync(${JSON.stringify(pidFile)}, process.pid + "\\n");
const lines = require("node:readline").createInterface({ input: process.stdin });
lines.on("close", () => process.exit(0));
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === "initialize"
    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } }
    : message.method === "tools/list"
      ? { tools: [{ name: "probe", description: "Reports its environment", inputSchema: { type: "object", properties: { word: { type: "string" } } } }] }
      : { content: [{ type: "text", text: JSON.stringify({ word: message.params.arguments.word, greeting: process.env.GREETING ?? null, leaked: process.env.ANTHROPIC_API_KEY ?? null, cwd: process.cwd() }) }] };
  console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
});`;

const running = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a local server starts only after its exact command is allowed, with a trimmed environment, and any change asks again", async () => {
  const folder = await saturn.folder("probe");
  const script = path.join(folder, "server.cjs");
  const pidFile = path.join(folder, "pids");
  const started = async () => (await readFile(pidFile, "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number);
  await writeFile(script, PROBE(pidFile));
  const created = await saturn.api("POST", "/connections/mcp", { name: "Probe", command: { program: process.execPath, args: [script], env: { GREETING: "hello-from-settings" } } });
  assert.equal(created.approval, "needed", "nothing runs before the user allows it");
  assert.ok(created.commandLine.includes("server.cjs"));
  assert.deepEqual(created.command.env, ["GREETING"], "names only");
  assert.ok(!JSON.stringify(created).includes("hello-from-settings"));
  assert.ok(!(await readFile(path.join(saturn.dataDir, "state.json"), "utf8")).includes("hello-from-settings"), "values stay out of the state file");

  await saturn.refused("POST", `/connections/mcp/${created.id}/discover`, undefined, 409, /runs a program on this computer/);
  await saturn.refused("POST", `/connections/mcp/${created.id}/approve`, { fingerprint: "0".repeat(64) }, 409, /command changed/);
  assert.deepEqual(await started(), [], "refused: it never started");

  assert.equal((await saturn.api("POST", `/connections/mcp/${created.id}/approve`, { fingerprint: created.commandFingerprint })).approval, "approved");
  const found = await saturn.api("POST", `/connections/mcp/${created.id}/discover`);
  assert.deepEqual(found.tools.map((tool) => tool.toolId), ["probe"]);
  assert.equal((await started()).length, 1);

  const setup = await saturn.chat({ autonomy: "bypass", mcpConnectionIds: ["general-skills", created.id], steps: [["probe", { word: "ping" }]] });
  const run = await saturn.finished((await saturn.start(setup)).id);
  assert.equal(run.status, "completed", run.error);
  const seen = JSON.parse(run.actions[0].result.content[0].text);
  assert.equal(seen.word, "ping");
  assert.equal(seen.greeting, "hello-from-settings", "it gets the variables the user set");
  assert.equal(seen.leaked, null, "the runtime's own environment, API keys included, does not reach it");
  assert.equal(seen.cwd, path.join(saturn.dataDir, "workspace"));

  // A new command needs a new approval, and stops the one running.
  const [pid] = await started();
  const changed = await saturn.api("PATCH", `/connections/mcp/${created.id}`, { command: { program: process.execPath, args: [script, "--other"], env: { GREETING: "hello-from-settings" } } });
  assert.equal(changed.approval, "needed");
  assert.notEqual(changed.commandFingerprint, created.commandFingerprint);
  await saturn.until("the old server to stop", () => running(pid), (alive) => !alive);
  await saturn.refused("POST", `/connections/mcp/${created.id}/approve`, { fingerprint: created.commandFingerprint }, 409, /command changed/);
  await saturn.refused("POST", `/connections/mcp/${created.id}/discover`, undefined, 409, /Allow it in Saturn Settings/);

  // An agent that already knows its tool cannot start it either.
  setup.model.queue.push(["probe", { word: "again" }]);
  await saturn.finished((await saturn.start(setup)).id);
  assert.equal((await started()).length, 1, "it did not start");

  // The same program with one variable's value changed is a different command too.
  const allowed = await saturn.api("POST", `/connections/mcp/${created.id}/approve`, { fingerprint: changed.commandFingerprint });
  const other = await saturn.api("PATCH", `/connections/mcp/${created.id}`, { command: { program: process.execPath, args: [script, "--other"], env: { GREETING: "another" } } });
  assert.equal(allowed.approval, "approved");
  assert.equal(other.approval, "needed");
  assert.notEqual(other.commandFingerprint, allowed.commandFingerprint);
  await saturn.api("DELETE", `/mcp/${created.id}`);
  assert.ok(!(await saturn.api("GET", "/connections/mcp")).some((item) => item.id === created.id));
});

test("a call to a local server whose command changed is a failed step that says to allow it, and the program does not start", async () => {
  const folder = await saturn.folder("probe-changed");
  const script = path.join(folder, "server.cjs");
  const pidFile = path.join(folder, "pids");
  await writeFile(script, PROBE(pidFile));
  const created = await saturn.api("POST", "/connections/mcp", { name: "Changed", command: { program: process.execPath, args: [script] } });
  await saturn.api("POST", `/connections/mcp/${created.id}/approve`, { fingerprint: created.commandFingerprint });
  await saturn.api("POST", `/connections/mcp/${created.id}/discover`);
  const setup = await saturn.chat({ autonomy: "bypass", mcpConnectionIds: ["general-skills", created.id] });
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  await saturn.api("PATCH", `/connections/mcp/${created.id}`, { command: { program: process.execPath, args: [script, "--other"] } });
  await saturn.until("the old server to stop", () => running(pid), (alive) => !alive);

  setup.model.queue.push(["probe", { word: "again" }]);
  const run = await saturn.finished((await saturn.start(setup)).id);
  const starts = (await readFile(pidFile, "utf8")).split("\n").filter(Boolean).length;
  await saturn.api("DELETE", `/mcp/${created.id}`);
  assert.equal(starts, 1, "it did not start");
  assert.equal(run.actions[0].status, "failed", JSON.stringify(run));
  assert.match(run.actions[0].reason, /Allow it in Saturn Settings/);
});

test("integrations are listed with what the app shows, and one that cannot be installed says why, changing nothing", async () => {
  const servers = (await saturn.api("GET", "/connections/mcp")).length;
  await saturn.refused("POST", "/marketplace/seeking-alpha/install", {}, 409, /no official MCP server/);
  await saturn.refused("POST", "/marketplace/github/install", {}, 400, /Paste a token/);
  await saturn.refused("POST", "/marketplace/slack/install", {}, 400, /OAuth client ID/);
  await saturn.refused("POST", "/marketplace/nobody/install", {}, 404, /Unknown integration/);
  assert.equal((await saturn.api("GET", "/connections/mcp")).length, servers);

  const list = await saturn.api("GET", "/marketplace");
  assert.ok(list.every((item) => typeof item.id === "string" && typeof item.available === "boolean" && item.installed === null), "nothing is installed yet");
  const booking = list.find((item) => item.id === "booking");
  assert.equal(booking.available, false);
  assert.ok(booking.reason);
  const notion = list.find((item) => item.id === "notion");
  assert.equal(notion.available, true);
  assert.equal(notion.auth, "oauth");
  const github = list.find((item) => item.id === "github");
  assert.equal(github.auth, "token");
  assert.equal(github.tokenAlternative, true);
  assert.equal(list.find((item) => item.id === "slack").auth, "oauth-client");
  await saturn.api("DELETE", "/marketplace/notion");
});
