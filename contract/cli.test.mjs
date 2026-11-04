// The `saturn` command, whichever language it is written in, against a runtime of the same language: what it prints, on which
// stream, and its exit codes. Model servers are fake; the launcher goes in a scratch home folder.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runtimeKind, startRuntime } from "./runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let scratch;
let home;
let runtime;
let server;
let plain;
const runs = {};

/** The command line: the program and the arguments before saturn's own. */
function program() {
  if (runtimeKind === "rust") return [process.env.SATURN_RUST_CLI ?? path.join(root, "target/debug", process.platform === "win32" ? "saturn.exe" : "saturn")];
  return [process.execPath, path.join(root, "runtime/node_modules/tsx/dist/cli.mjs"), path.join(root, "runtime/src/cli.ts")];
}

/** Runs a command; what it printed and how it ended. */
function run(command, args, { input = "", env = {}, cwd = scratch } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, SATURN_RUNTIME_PORT: new URL(runtime.origin).port, SATURN_DATA_DIR: runtime.dataDir, SATURN_RUNTIME_TOKEN: "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, out, err }));
    child.stdin.end(input);
  });
}

function saturn(args, options = {}) {
  const [command, ...before] = program();
  return run(command, [...before, ...args], { ...options, env: { SATURN_RUNTIME_TOKEN: tokenValue, ...options.env } });
}

let tokenValue;

async function api(method, route, body) {
  const response = await fetch(`${runtime.origin}${route}`, {
    method,
    headers: { authorization: `Bearer ${tokenValue}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.ok(response.status < 300, `${method} ${route}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

before(async () => {
  scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "saturn-contract-cli-")));
  home = path.join(scratch, "home");
  plain = path.join(scratch, "plain-project");
  await mkdir(home);
  await mkdir(plain);
  runtime = await startRuntime({ env: { HOME: home, USERPROFILE: home } });
  tokenValue = (await readFile(path.join(runtime.dataDir, "runtime-token"), "utf8")).trim();
  // A model that runs one shell command (asked about in Review mode), then answers. A prompt with "slowly" takes its time.
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const text = JSON.stringify(body.messages ?? []);
      const reply = () => {
        const ran = text.includes("marker-output") || text.includes('"role":"tool"') || text.includes("denied") || text.includes("Denied");
        const message = !body.tools?.length || ran || text.includes("no tools please")
          ? { role: "assistant", content: "all done" }
          : { role: "assistant", content: "", tool_calls: [{ id: "c0", type: "function", function: { name: "code", arguments: JSON.stringify({ command: "echo marker-output" }) } }] };
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "r", object: "chat.completion", model: "s", choices: [{ index: 0, finish_reason: "stop", message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      };
      if (text.includes("slowly")) setTimeout(reply, 1500);
      else reply();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const model = await api("POST", "/connections/models", { name: "Local", provider: "openai", model: "s", baseUrl: `http://127.0.0.1:${server.address().port}` });
  await api("POST", "/agents", { name: "Doer", modelConnectionId: model.id, autonomy: "bypass", mcpConnectionIds: ["general-skills"] });
  await api("POST", "/agents", { name: "Careful", modelConnectionId: model.id, autonomy: "review", mcpConnectionIds: ["general-skills"] });
  await api("POST", "/agents", { name: "A=B", modelConnectionId: model.id, autonomy: "bypass" });
  const claude = await api("POST", "/connections/models", { provider: "claude-code", model: "claude-sonnet-5-5" });
  await api("POST", "/agents", { name: "Planner", modelConnectionId: claude.id });
});
after(async () => {
  await runtime?.stop();
  await new Promise((resolve) => { server?.closeAllConnections(); server?.close(resolve); });
  await rm(scratch, { recursive: true, force: true });
});

test("help and mistakes in how it is called", async () => {
  const none = await saturn([]);
  assert.equal(none.code, 2);
  assert.match(none.out, /^saturn: the Saturn runtime from a terminal\n\nUsage:\n {2}saturn run PROMPT/);
  for (const args of [["help"], ["--help"], ["-h"], ["agents", "--help"]]) {
    const help = await saturn(args);
    assert.equal(help.code, 0, args.join(" "));
    assert.equal(help.out, none.out);
  }
  const unknown = await saturn(["frobnicate"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /^saturn: Unknown command "frobnicate"\.\n\nsaturn: the Saturn runtime/);
  for (const [args, expected] of [
    [["run", ""], /Give the prompt/],
    [["show"], /saturn show RUN/],
    [["changes"], /saturn changes RUN/],
    [["approve", "r"], /saturn approve RUN ACTION/],
    [["stop"], /saturn stop RUN/],
    [["run", "x"], /Name the agent with --agent\. Agents: /],
    [["run", "x", "--agent", "Nobody"], /No agent named "Nobody"\. Agents: /],
    [["run", "x", "--agent", "Doer", "--mode", "wild"], /--mode is agent, ask or plan/],
    [["run", "x", "--agent", "Doer", "--project", "/not/a/project"], /is not a Saturn project/],
  ]) {
    const answer = await saturn(args);
    assert.equal(answer.code, 2, `${args.join(" ")}: ${answer.err}`);
    assert.match(answer.err, expected);
    assert.equal(answer.out, "");
  }
});

test("saturn says when Saturn cannot be reached", async () => {
  const [command, ...before] = program();
  const away = await run(command, [...before, "agents"], { env: { SATURN_RUNTIME_PORT: "9", SATURN_RUNTIME_TOKEN: "made-up" } });
  assert.equal(away.code, 4);
  assert.match(away.err, /^saturn: Saturn is not running \(nothing answers on http:\/\/127\.0\.0\.1:9\)\. Open Saturn and try again\.\n$/);
  const empty = path.join(scratch, "never-ran");
  const unset = { ...process.env };
  delete unset.SATURN_RUNTIME_TOKEN;
  const fresh = await new Promise((resolve) => {
    const child = spawn(command, [...before, "agents"], { env: { ...unset, SATURN_DATA_DIR: empty } });
    let err = "";
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.once("close", (code) => resolve({ code, err }));
  });
  assert.equal(fresh.code, 4);
  assert.match(fresh.err, /Saturn has not run on this computer yet \(no .*runtime-token\)\. Open Saturn first\./);
  const refused = await run(command, [...before, "agents"], { env: { SATURN_RUNTIME_TOKEN: "wrong-token" } });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /^saturn: Unauthorized\n$/);
});

test("the token comes from the data folder unless the environment gives one", async () => {
  const [command, ...before] = program();
  const unset = { ...process.env };
  delete unset.SATURN_RUNTIME_TOKEN;
  const answer = await new Promise((resolve) => {
    const child = spawn(command, [...before, "agents"], { env: { ...unset, SATURN_RUNTIME_PORT: new URL(runtime.origin).port, SATURN_DATA_DIR: runtime.dataDir } });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.once("close", (code) => resolve({ code, out }));
  });
  assert.equal(answer.code, 0);
  assert.match(answer.out, /^Doer\tLocal\t/m);
});

test("saturn agents lists agents and their models", async () => {
  const { code, out } = await saturn(["agents"]);
  assert.equal(code, 0);
  const lines = out.trim().split("\n");
  assert.ok(lines.some((line) => /^Doer\tLocal\tagent_|^Doer\tLocal\t/.test(line)), out);
  assert.ok(lines.some((line) => line.startsWith("Planner\t")), out);
});

test("saturn run follows a run to its answer", async () => {
  const answer = await saturn(["run", "do", "it", "--agent", "Doer"]);
  assert.equal(answer.code, 0, answer.err);
  assert.equal(answer.out, "all done\n");
  assert.match(answer.err, /^Doer · run run_[0-9a-f]+ · chat \S+\n/);
  assert.match(answer.err, /\n {2}· code echo marker-output\n/);
  runs.done = /run (run_[0-9a-f]+)/.exec(answer.err)[1];

  const json = await saturn(["run", "do it", "--agent=Doer", "--json"]);
  assert.equal(json.code, 0);
  assert.equal(json.err, "");
  const done = JSON.parse(json.out);
  assert.equal(done.status, "completed");
  assert.equal(done.output, "all done");
  assert.equal(done.actions[0].status, "completed");

  // The prompt from stdin, an agent named with its id, and a name with = in it.
  const piped = await saturn(["run", "-", "--agent", "Doer", "--json"], { input: "from stdin no tools please" });
  assert.equal(piped.code, 0);
  assert.equal(JSON.parse(piped.out).input, "from stdin no tools please");
  const equals = await saturn(["run", "no tools please", "--agent=A=B", "--json"]);
  assert.equal(equals.code, 0, equals.err);
  const agents = await api("GET", "/agents");
  const byId = await saturn(["run", "no tools please", "--agent", agents.find((agent) => agent.name === "Doer").id, "--json"]);
  assert.equal(byId.code, 0);

  // Later messages join a chat, and a mode is passed on.
  const chat = JSON.parse(json.out).threadId;
  const joined = await saturn(["run", "no tools please", "--agent", "Doer", "--chat", chat, "--mode", "ask", "--json"]);
  assert.equal(JSON.parse(joined.out).threadId, chat);
  assert.equal(JSON.parse(joined.out).mode, "ask");
});

test("saturn run on a project works there, and only with access", async () => {
  const project = await api("POST", "/projects", { path: plain, grant: true });
  const answer = await saturn(["run", "no tools please", "--agent", "Doer", "--project", ".", "--json"], { cwd: plain });
  assert.equal(answer.code, 0, answer.err);
  const thread = JSON.parse(answer.out).threadId;
  assert.equal((await api("GET", `/agents/${(await api("GET", "/agents")).find((agent) => agent.name === "Doer").id}/threads`)).find((item) => item.id === thread).projectId, project.id);
  const dotted = await saturn(["run", "no tools please", "--agent", "Doer", "--project", path.join(plain, "sub", ".."), "--json"]);
  assert.equal(dotted.code, 0, dotted.err);
  const locked = path.join(scratch, "locked-project");
  await mkdir(locked);
  await api("POST", "/projects", { path: locked });
  const refused = await saturn(["run", "x", "--agent", "Doer", "--project", locked]);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /does not have access to .*locked-project yet/);
});

test("an approval it cannot ask about exits 3 and says how to answer", async () => {
  const waiting = await saturn(["run", "do it carefully", "--agent", "Careful"]);
  assert.equal(waiting.code, 3, waiting.err);
  assert.equal(waiting.out, "");
  const hint = /Waiting for approval: code echo marker-output.*\nAnswer with: saturn approve (\S+) (\S+)/s.exec(waiting.err);
  assert.ok(hint, waiting.err);
  const [, runId, actionId] = hint;

  const shown = await saturn(["show", runId]);
  assert.equal(shown.code, 0);
  assert.match(shown.out, new RegExp(`^${runId} · waiting_approval\\n {2}· code echo marker-output \\(waiting_approval: .*\\) {3}\\[${actionId}\\]\\n`));

  const approved = await saturn(["approve", runId, actionId]);
  assert.equal(approved.code, 0);
  assert.equal(approved.out, "Approved.\n");
  let finished;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    finished = await api("GET", `/runs/${runId}`);
    if (finished.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(finished.status, "completed");

  const json = await saturn(["run", "do it carefully again", "--agent", "Careful", "--json"]);
  assert.equal(json.code, 3);
  const asked = JSON.parse(json.out);
  assert.equal(asked.status, "waiting_approval");
  const denied = await saturn(["approve", asked.id, asked.actions.find((item) => item.status === "waiting_approval").id, "--deny"]);
  assert.equal(denied.out, "Denied.\n");

  const missing = await saturn(["approve", "run_none", "a1"]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /^saturn: /);
});

// Runs a command on a real terminal, answers "y" when it asks, and passes on what it printed and how it ended.
const ON_A_TERMINAL = `
import os, pty, select, subprocess, sys
leader, follower = pty.openpty()
child = subprocess.Popen(sys.argv[1:], stdin=follower, stdout=follower, stderr=follower, close_fds=True)
os.close(follower)
seen = b""
answered = False
while True:
    ready, _, _ = select.select([leader], [], [], 30)
    if not ready:
        child.kill()
        break
    try:
        chunk = os.read(leader, 4096)
    except OSError:
        break
    if not chunk:
        break
    seen += chunk
    if not answered and b"[y/N]" in seen:
        os.write(leader, b"y\\n")
        answered = True
sys.stdout.write(seen.decode("utf8", "replace"))
sys.exit(child.wait())
`;

test("on a terminal it asks about an approval itself", { skip: process.platform === "win32" && "needs a Unix terminal" }, async () => {
  const [command, ...before] = program();
  const allowed = await run("python3", ["-c", ON_A_TERMINAL, command, ...before, "run", "do it on a terminal", "--agent", "Careful"], { env: { SATURN_RUNTIME_TOKEN: tokenValue } });
  assert.match(allowed.out, /Allow code echo marker-output .*\? \[y\/N\] /s, allowed.err);
  assert.match(allowed.out, /all done/);
  assert.equal(allowed.code, 0);
});

test("Claude Code is refused unattended, as automations are", async () => {
  const refused = await saturn(["run", "plan it", "--agent", "Planner", "--json"]);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /Planner runs on Claude \(via Claude Code\).*violation of Anthropic's policy/s);
});

test("saturn runs, show, changes and stop", async () => {
  const listed = await saturn(["runs", "--limit", "2"]);
  assert.equal(listed.code, 0);
  assert.match(listed.out, /^run_[0-9a-f]+\t\w+\t\S+\t/);
  assert.equal(listed.out.match(/^run_[0-9a-f]+\t/gm).length, 2);
  const json = JSON.parse((await saturn(["runs", "--limit=1", "--json"])).out);
  assert.equal(json.length, 1);

  const shown = await saturn(["show", runs.done]);
  assert.equal(shown.code, 0);
  assert.match(shown.out, new RegExp(`^${runs.done} · completed\\n {2}· code echo marker-output\\n\\nall done\\n$`));
  assert.equal(JSON.parse((await saturn(["show", runs.done, "--json"])).out).id, runs.done);
  const missing = await saturn(["show", "run_none"]);
  assert.equal(missing.code, 1);
  assert.equal(missing.err, "saturn: Run not found\n");

  const changes = await saturn(["changes", runs.done]);
  assert.equal(changes.code, 0);
  assert.equal(changes.out, "No file changes.\n");
  assert.deepEqual(JSON.parse((await saturn(["changes", runs.done, "--json"])).out).files, []);

  const agents = await api("GET", "/agents");
  const started = await api("POST", `/agents/${agents.find((agent) => agent.name === "Doer").id}/runs`, { input: "slowly no tools please" });
  const stopped = await saturn(["stop", started.id]);
  assert.equal(stopped.code, 0);
  assert.equal(stopped.out, `${started.id} · cancelled\n`);
});

test("a run that fails exits 1 and says why", async () => {
  const broken = await api("POST", "/connections/models", { name: "Gone", provider: "openai", model: "s", baseUrl: "http://127.0.0.1:9" });
  await api("POST", "/agents", { name: "Broken", modelConnectionId: broken.id, autonomy: "bypass" });
  const answer = await saturn(["run", "no tools please", "--agent", "Broken"]);
  assert.equal(answer.code, 1);
  assert.match(answer.err, /\nfailed: /);
  const json = await saturn(["run", "no tools please", "--agent", "Broken", "--json"]);
  assert.equal(json.code, 1);
  assert.equal(JSON.parse(json.out).status, "failed");
});

test("Settings installs the command, and what it installs works", { skip: process.platform === "win32" && "HOME is not the home folder on Windows" }, async () => {
  const launcher = path.join(home, ".local/bin/saturn");
  const before = await api("GET", "/cli");
  assert.deepEqual(before, { path: launcher, installed: false, current: false, onPath: false, folder: path.dirname(launcher) });
  const installed = await api("POST", "/cli/install");
  assert.deepEqual({ ...installed, onPath: false }, { path: launcher, installed: true, current: true, onPath: false, folder: path.dirname(launcher) });
  assert.ok(existsSync(launcher));
  assert.ok(((await stat(launcher)).mode & 0o111) !== 0, "executable");
  const text = await readFile(launcher, "utf8");
  assert.match(text, /^#!\/bin\/sh\n# Saturn command line: /);
  assert.match(text, new RegExp(`export SATURN_RUNTIME_PORT='${new URL(runtime.origin).port}'`), "a second Saturn gets a launcher pointing at it");
  assert.ok(text.includes(`export SATURN_DATA_DIR='${runtime.dataDir}'`));

  const unset = { ...process.env };
  delete unset.SATURN_RUNTIME_TOKEN;
  delete unset.SATURN_RUNTIME_PORT;
  delete unset.SATURN_DATA_DIR;
  const ran = await new Promise((resolve) => {
    const child = spawn(launcher, ["agents"], { env: unset });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.once("close", (code) => resolve({ code, out }));
  });
  assert.equal(ran.code, 0);
  assert.match(ran.out, /^Doer\tLocal\t/m);

  // An outdated launcher is reported, and replaced.
  const { writeFile } = await import("node:fs/promises");
  await writeFile(launcher, "#!/bin/sh\nexit 1\n");
  assert.equal((await api("GET", "/cli")).current, false);
  assert.equal((await api("POST", "/cli/install")).current, true);
});
