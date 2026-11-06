// The computer-use tools, whichever language runs them. Nothing here touches the real screen: SATURN_DESKTOP_BIN puts
// stand-ins for osascript, screencapture, sips and open in place, and what they were asked to do is compared with
// contract/cases/computer.json, recorded from the TypeScript runtime before it was removed; a change here is a deliberate one. macOS only, since that is
// what the stand-ins stand in for; Windows' helper has its own tests in crates/saturn-computer.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startRuntime } from "./runtime.mjs";

const casesFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "cases/computer.json");
const macOnly = { skip: process.platform !== "darwin" && "the stand-ins are for macOS" };

let scratch;
let runtime;
let configFile;
let logFile;
let run;
const servers = [];

/** One stand-in program: logs how it was called, then does what the config says. */
const standIn = (name) => `#!${process.execPath}
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.env.FAKE_CONFIG, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ program: ${JSON.stringify(name)}, args }) + "\\n");
const say = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const failing = config.fail && (${JSON.stringify(name)} === config.fail.program) && args.join(" ").includes(config.fail.match ?? "");
if (failing) { process.stderr.write(config.fail.stderr); process.exit(1); }
if (${JSON.stringify(name)} === "open") { config.launched = true; fs.writeFileSync(process.env.FAKE_CONFIG, JSON.stringify(config)); process.exit(0); }
if (${JSON.stringify(name)} === "screencapture") { fs.writeFileSync(args.at(-1), "raw"); process.exit(0); }
if (${JSON.stringify(name)} === "sips") { fs.writeFileSync(args.at(-1), Buffer.alloc(config.tinyShot ? 10 : 1200, 7)); process.exit(0); }
const script = args[3];
const params = JSON.parse(args[4]);
if (script.includes("AXIsProcessTrusted")) say({ accessibility: config.accessibility, screenRecording: config.screenRecording });
else if (script.includes("CGSessionCopyCurrentDictionary")) say(config.locked);
else if (script.includes("CGDisplayBounds")) say({ width: 1728, height: 1117 });
else if (script.includes("frontmostApplication")) say([{ name: "Mail", pid: 11, bundle_id: "com.apple.mail", frontmost: false }, { name: "Notes", pid: 22, bundle_id: "com.apple.Notes", frontmost: true }, ...(config.launched ? [{ name: "Calculator", pid: 33, bundle_id: "com.apple.calculator", frontmost: false }] : [])]);
else if (script.includes("windows[0].position")) say({ x: 100, y: 50, width: 640, height: 400 });
else if (script.includes("settableRoles")) say({
  truncated: params.root.length === 0 && config.truncated === true,
  nodes: params.root.length
    ? [{ path: [...params.root, 0], depth: params.root.length + 1, role: "AXButton", name: "Inner", value: "", actions: [], settable: false, omitted: 0 }]
    : config.emptyTree ? [] : [
      { path: [0], depth: 1, role: "AXTextField", name: "Title", value: "hello", actions: ["AXShowMenu"], settable: true, omitted: 0 },
      { path: [1], depth: 1, role: "AXGroup", name: "", value: "", actions: [], settable: false, omitted: 12 },
      { path: [1, 0], depth: 2, role: "AXButton", name: "Save \\"it\\"", value: "", actions: ["AXPress", "AXShowDefaultUI"], settable: false, omitted: 0 },
    ],
});
else process.stdout.write("null\\n");
`;

before(async () => {
  if (process.platform !== "darwin") return;
  scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "saturn-contract-computer-")));
  const programs = path.join(scratch, "programs");
  await mkdir(programs);
  for (const name of ["osascript", "screencapture", "sips", "open"]) {
    await writeFile(path.join(programs, name), standIn(name));
    await chmod(path.join(programs, name), 0o755);
  }
  configFile = path.join(scratch, "config.json");
  logFile = path.join(scratch, "log.jsonl");
  await writeFile(logFile, "");
  await configure({});
  runtime = await startRuntime({ env: { SATURN_DESKTOP_BIN: programs, FAKE_CONFIG: configFile, FAKE_LOG: logFile } });
  run = await toolRunner();
});
after(async () => {
  await runtime?.stop();
  await Promise.all(servers.map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

/** How the stand-ins behave from now on. */
async function configure(change) {
  await writeFile(configFile, JSON.stringify({ accessibility: true, screenRecording: true, locked: false, ...change }));
}

async function call(method, route, body) {
  const token = (await readFile(path.join(runtime.dataDir, "runtime-token"), "utf8")).trim();
  const response = await fetch(`${runtime.origin}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function api(method, route, body) {
  const answer = await call(method, route, body);
  assert.ok(answer.status < 300, `${method} ${route}: ${answer.status} ${JSON.stringify(answer.body)}`);
  return answer.body;
}

/** An agent that calls the tools it is given; gives back a function running a list of them. */
async function toolRunner() {
  const queue = [];
  const server = createServer((request, response) => {
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
  servers.push(server);
  const connection = await api("POST", "/connections/models", { name: "Scripted", provider: "openai", model: "s", baseUrl: `http://127.0.0.1:${server.address().port}` });
  const agent = await api("POST", "/agents", { name: "Tools", modelConnectionId: connection.id, autonomy: "bypass", mcpConnectionIds: ["computer-use"] });
  return async (steps) => {
    queue.push(...steps);
    const started = await api("POST", `/agents/${agent.id}/runs`, { input: "go" });
    let current;
    for (let attempt = 0; attempt < 1500; attempt += 1) {
      current = await api("GET", `/runs/${started.id}`);
      if (!["queued", "running", "waiting_approval"].includes(current.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(current.status, "completed", current.error);
    assert.equal(current.actions.length, steps.length);
    return current.actions.map((action, index) => ({ tool: steps[index][0], arguments: steps[index][1], status: action.status, ...(action.result === undefined ? {} : { result: action.result }), ...(action.reason === undefined ? {} : { reason: action.reason }) }));
  };
}

/** What the stand-ins were asked since the last look. A permission check depends on the clock, so it is left out. */
async function asked() {
  const lines = (await readFile(logFile, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  await writeFile(logFile, "");
  return lines.filter((line) => !line.args[3]?.includes("AXIsProcessTrusted"));
}

/** What changes from one run to the next, made plain. */
function plain(value) {
  const tmp = os.tmpdir().replace(/\/$/, "");
  return JSON.parse(JSON.stringify(value)
    .replaceAll(tmp, "<tmp>")
    .replace(/saturn-shot-\d+-\d+/g, "saturn-shot")
    .replace(/snap_[a-z0-9]+/g, "snap")
    .replace(/"timestamp":"[^"]*"/g, '"timestamp":"<now>"')
    .replace(/"elapsed_ms":\d+/g, '"elapsed_ms":0'));
}

async function matchesRecording(name, value) {
  const normalized = plain(value);
  const all = await readFile(casesFile, "utf8").then(JSON.parse).catch(() => ({}));
  assert.ok(all[name], `${name} is not recorded`);
  assert.deepEqual(normalized, all[name]);
}

const app = { scope: "app", pid: 22 };

test("finding apps: the running ones first, one selector at a time, and only apps get started", macOnly, async () => {
  await configure({});
  await asked();
  const answers = await run([
    ["computer_apps", {}],
    ["computer_resolve_app", { pid: 11 }],
    ["computer_resolve_app", { app_name: "notes" }],
    ["computer_resolve_app", { bundle_id: "COM.APPLE.MAIL" }],
    ["computer_resolve_app", { app_path: "/Applications/Mail.app" }],
    ["computer_resolve_app", {}],
    ["computer_resolve_app", { pid: 11, app_name: "Mail" }],
    ["computer_resolve_app", { pid: 999 }],
  ]);
  await matchesRecording("finding apps", answers);
  await matchesRecording("finding apps asked", await asked());

  // A script, a document, a web address or an option handed over as an "app" is refused before anything starts.
  const refused = await run([
    ["computer_resolve_app", { app_path: "/tmp/run-me.command" }],
    ["computer_resolve_app", { app_path: "/tmp/notes.txt" }],
    ["computer_resolve_app", { app_path: "https://example.com/" }],
    ["computer_resolve_app", { app_name: "/tmp/run-me.command" }],
    ["computer_resolve_app", { app_name: "-h" }],
    ["computer_resolve_app", { bundle_id: "--args" }],
    ["computer_resolve_app", { bundle_id: "file:///tmp/x" }],
  ]);
  for (const answer of refused) {
    assert.equal(answer.status, "failed", JSON.stringify(answer));
    assert.match(answer.reason, /is not an app/);
  }
  assert.deepEqual((await asked()).filter((line) => line.program === "open"), []);

  const opened = await run([["computer_resolve_app", { app_name: "Calculator" }]]);
  await matchesRecording("starting an app", opened);
  await matchesRecording("starting an app asked", await asked());
  await configure({ fail: { program: "open", stderr: "Unable to find application named 'Nothing'" } });
  const failed = await run([["computer_resolve_app", { app_name: "Nothing" }]]);
  assert.equal(failed[0].reason, "Could not open Nothing: Unable to find application named 'Nothing'");
});

test("screenshots: the screen or an app's window, with a token that ties coordinates to it", macOnly, async () => {
  await configure({});
  await asked();
  const answers = await run([
    ["computer_screenshot", {}],
    ["computer_screenshot", { target: { scope: "screen" } }],
    ["computer_screenshot", { target: app }],
    ["computer_screenshot", { target: { target_id: "app_22" } }],
    ["computer_screenshot", { target: { scope: "app" } }],
  ]);
  assert.match(answers[0].result.image, /^data:image\/jpeg;base64,/);
  await matchesRecording("screenshots", answers);
  await matchesRecording("screenshots asked", await asked());

  await configure({ tinyShot: true });
  assert.match((await run([["computer_screenshot", {}]]))[0].reason, /Could not take a screenshot: macOS returned an empty screenshot/);
  await configure({ fail: { program: "screencapture", stderr: "could not create image from display" } });
  assert.equal((await run([["computer_screenshot", {}]]))[0].reason, "Could not take a screenshot: could not create image from display");
  await configure({});
});

test("input: canvas pixels become screen points, and what cannot be right is refused", macOnly, async () => {
  await configure({});
  const shot = (await run([["computer_screenshot", { target: app }]]))[0].result;
  const token = shot.coordinate_token;
  await asked();
  const answers = await run([
    ["computer_click", { x: 640, y: 400 }],
    ["computer_click", { x: 5000, y: -3, button: "right", count: 9, target: { scope: "screen" } }],
    ["computer_click", { x: 640, y: 400, target: app, coordinate_token: token, click_count: 2, button: "bad" }],
    ["computer_click", { x: 1, y: 1, target: app }],
    ["computer_click", { x: 1, y: 1, target: app, coordinate_token: "not-a-token" }],
    ["computer_click", { x: 1, y: 1, target: { scope: "app", pid: 11 }, coordinate_token: token }],
    ["computer_move", { x: 10.6, y: "20", target: app, coordinate_token: token }],
    ["computer_drag", { from: { x: 0, y: 0 }, to: { x: 1280, y: 800 }, target: app, coordinate_token: token, button: "middle" }],
    ["computer_drag", { start_x: 10, start_y: 20, end_x: 30, end_y: 40 }],
    ["computer_scroll", { x: 1, y: 2, direction: "up", amount: 99, target: app, coordinate_token: token }],
    ["computer_scroll", { x: 1, y: 2, direction: "left", target: app, coordinate_token: token }],
    ["computer_scroll", { x: 1, y: 2, direction: "sideways", amount: 0, target: app, coordinate_token: token }],
    ["computer_key", { key: "cmd+shift+s", target: app }],
    ["computer_key", { key: "Return" }],
    ["computer_key", { key: "F5", target: app }],
    ["computer_key", { key: "" }],
    ["computer_key", { key: "hyper+x" }],
    ["computer_key", { key: "ctrl+banana" }],
    ["computer_type", { text: "hello\nworld", target: app }],
    ["computer_type", { text: "你好", target: app }],
    ["computer_type", { text: "no target" }],
    ["computer_type", { text: "", target: app }],
    ["computer_start_control", {}],
    ["computer_release_control", {}],
    ["computer_wait", { ms: 5, reason: "page load" }],
    ["computer_wait", { duration_ms: "nope" }],
  ]);
  await matchesRecording("input", answers);
  await matchesRecording("input asked", await asked());
});

test("an app's element tree: ids from one call work on the next, and stale ones say so", macOnly, async () => {
  await configure({});
  await asked();
  const read = (await run([["computer_app_state", { target: app }]]))[0].result;
  assert.match(read.text, /\[1\] TextField name="Title" value="hello" settable actions=show-menu/);
  const snapshot = read.snapshot_id;
  const answers = await run([
    ["computer_set_value", { target: app, snapshot_id: snapshot, element_id: 1, value: "new" }],
    ["computer_app_action", { target: app, snapshot_id: snapshot, element_id: 3, action: "show-menu" }],
    ["computer_app_action", { target: app, snapshot_id: snapshot, element_id: 3 }],
    ["computer_app_action", { target: app, snapshot_id: snapshot, element_id: 3, action: "AXRaise" }],
    ["computer_type", { target: app, snapshot_id: snapshot, element_id: 1, text: "typed" }],
    ["computer_app_state", { target: app, snapshot_id: snapshot, element_id: 2 }],
    ["computer_app_action", { target: app, snapshot_id: snapshot, element_id: 4 }],
    ["computer_set_value", { target: app, snapshot_id: snapshot, element_id: 99, value: "x" }],
    ["computer_set_value", { target: { scope: "app", pid: 11 }, snapshot_id: snapshot, element_id: 1, value: "x" }],
    ["computer_set_value", { target: app, snapshot_id: "snap_gone", element_id: 1, value: "x" }],
    ["computer_set_value", { snapshot_id: snapshot, element_id: 1, value: "x" }],
    ["computer_app_action", { snapshot_id: snapshot, element_id: 1 }],
    ["computer_app_state", {}],
  ]);
  await matchesRecording("element tree first", read);
  await matchesRecording("element tree", answers);
  await matchesRecording("element tree asked", await asked());

  await configure({ truncated: true });
  const partial = (await run([["computer_app_state", { target: app }]]))[0].result;
  assert.equal(partial.truncated, true);
  assert.match(partial.text, /This tree is partial/);
  await configure({ emptyTree: true });
  const empty = (await run([["computer_app_state", { target: app }]]))[0].result;
  assert.equal(empty.text, `(no elements)\nsnapshot_id=${empty.snapshot_id}`);
});

test("what macOS says becomes what the user can do", macOnly, async () => {
  await configure({ fail: { program: "osascript", match: "activateWithOptions", stderr: "execution error: Error: Error: Something odd (-2700)" } });
  const shot = (await run([["computer_screenshot", {}]]))[0];
  assert.equal(shot.status, "completed");
  const odd = await run([["computer_key", { key: "a", target: app }]]);
  assert.equal(odd[0].reason, "Something odd");
  for (const [stderr, expected] of [
    ["execution error: Not allowed assistive access. (-25211)", /needs the Accessibility permission/],
    ["execution error: Not authorized to send Apple events to System Events. (-1743)", /not allowed to control System Events/],
  ]) {
    await configure({ fail: { program: "osascript", match: "activateWithOptions", stderr } });
    assert.match((await run([["computer_key", { key: "a", target: app }]]))[0].reason, expected);
  }
  await configure({});
});

test("a locked screen and missing permissions are said plainly, and the settings page sees them", macOnly, async () => {
  await configure({ locked: true });
  await asked();
  const locked = await run([
    ["computer_screenshot", {}],
    ["computer_click", { x: 1, y: 1 }],
    ["computer_apps", {}],
    ["computer_check_permissions", {}],
    ["computer_wait", { ms: 1 }],
  ]);
  assert.match(locked[0].reason, /screen is locked/);
  assert.match(locked[1].reason, /screen is locked/);
  assert.equal(locked[2].status, "completed", "what does not look at the screen still works");
  assert.equal(locked[3].result.status, "screen_locked");
  assert.equal(locked[3].result.screenLocked, true);
  assert.equal(locked[4].status, "completed");
  await asked();

  await configure({ accessibility: false, screenRecording: true });
  const noAccessibility = await run([["computer_check_permissions", {}], ["computer_click", { x: 1, y: 1 }], ["computer_key", { key: "a" }]]);
  assert.equal(noAccessibility[0].result.status, "requires_accessibility_permission");
  assert.match(noAccessibility[0].result.help, /needs the Accessibility permission/);
  assert.match(noAccessibility[1].reason, /needs the Accessibility permission/);
  assert.match(noAccessibility[2].reason, /needs the Accessibility permission/);
  assert.deepEqual(await api("GET", "/computer/permissions"), { platform: "darwin", required: true, accessibility: false, screenRecording: true });

  await configure({ accessibility: true, screenRecording: false });
  const noRecording = await run([["computer_check_permissions", {}], ["computer_screenshot", {}]]);
  assert.equal(noRecording[0].result.status, "requires_screen_recording_permission");
  assert.deepEqual(noRecording[0].result.canvas, { width: 1280, height: 800 });
  assert.match(noRecording[1].reason, /needs the Screen Recording permission/);

  await configure({ fail: { program: "osascript", match: "AXIsProcessTrusted", stderr: "execution error: Error: broken (-1)" } });
  assert.deepEqual(await api("GET", "/computer/permissions"), { platform: "darwin", required: true, accessibility: false, screenRecording: false, error: "broken" });
  await configure({});
  assert.deepEqual(await api("GET", "/computer/permissions"), { platform: "darwin", required: true, accessibility: true, screenRecording: true });
});
