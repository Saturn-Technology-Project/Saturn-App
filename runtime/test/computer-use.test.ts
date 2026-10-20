import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_TOOL_ROUNDS, stepLimitNote } from "../src/application/runs.js";
import { actionName, axAction, CANVAS, decodeToken, encodeToken, formatTree, toScreen } from "../src/infrastructure/skills/computer-use-skill.js";
import { ACCESSIBILITY_HELP, PermissionError, explain, parseChord } from "../src/infrastructure/skills/macos.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

test("canvas pixels map onto the screen region the screenshot showed, per axis", () => {
  // A 1512×982-point Retina display stretched to the 1280×800 canvas.
  const display = { x: 0, y: 0, width: 1512, height: 982 };
  assert.deepEqual(toScreen(display, 0, 0), { x: 0, y: 0 });
  assert.deepEqual(toScreen(display, 640, 400), { x: 756, y: 491 });
  assert.deepEqual(toScreen(display, 73, 116), { x: 86, y: 142 }, "the click the agent kept retrying lands where it saw the target");
  assert.deepEqual(toScreen(display, 5000, -20), { x: 1511, y: 0 }, "points off the canvas are clamped to it");
  // An app window: canvas pixels map into the window's frame.
  assert.deepEqual(toScreen({ x: 200, y: 100, width: 640, height: 400 }, 640, 400), { x: 520, y: 300 });
  assert.deepEqual(CANVAS, { width: 1280, height: 800 });
});

test("an app's coordinate token round-trips and refuses another app or a forged value", () => {
  const region = { x: 10, y: 20, width: 800, height: 600 };
  const token = encodeToken(42, region);
  assert.deepEqual(decodeToken(token, 42), region);
  assert.throws(() => decodeToken(token, 43), /another app/);
  assert.throws(() => decodeToken("not-a-token", 42), /not valid/);
});

test("the accessibility tree reads as one line per element, with the snapshot id last", () => {
  const nodes = [
    { id: 1, path: [0], depth: 1, role: "AXGroup", name: "Sidebar", value: "", actions: [], settable: false, omitted: 0 },
    { id: 2, path: [0, 0], depth: 2, role: "AXButton", name: "Automations", value: "", actions: ["AXShowMenu"], settable: false, omitted: 0 },
    { id: 3, path: [0, 1], depth: 2, role: "AXTextField", name: "Search", value: "hello", actions: [], settable: true, omitted: 12 },
  ];
  assert.equal(
    formatTree(nodes, "snap_x"),
    [
      '[1] Group name="Sidebar"',
      '  [2] Button name="Automations" actions=show-menu',
      '  [3] TextField name="Search" value="hello" settable (+12 descendants omitted)',
      "snapshot_id=snap_x",
    ].join("\n"),
  );
  assert.equal(actionName("AXScrollToVisible"), "scroll-to-visible");
  assert.deepEqual(["press", "show-menu", "ShowMenu", "AXRaise", ""].map(axAction), ["AXPress", "AXShowMenu", "AXShowMenu", "AXRaise", "AXPress"]);
});

test("key chords parse into a key and System Events modifiers; unknown names are refused", () => {
  assert.deepEqual(parseChord("cmd+shift+s"), { key: "s", modifiers: ["command down", "shift down"] });
  assert.deepEqual(parseChord("Return"), { key: "Return", code: 36, modifiers: [] });
  assert.deepEqual(parseChord("ctrl+Left"), { key: "Left", code: 123, modifiers: ["control down"] });
  assert.throws(() => parseChord("hyper+a"), /Unknown modifier/);
  assert.throws(() => parseChord("Banana"), /Unknown key/);
});

test("a macOS refusal is explained as the permission the user has to grant", () => {
  const denied = explain({ stderr: "execution error: System Events got an error: osascript is not allowed assistive access. (-25211)" });
  assert.ok(denied instanceof PermissionError);
  assert.equal(denied.message, ACCESSIBILITY_HELP);
  assert.match(explain({ stderr: "Not authorized to send Apple events to System Events. (-1743)" }).message, /Automation/);
  assert.equal(explain({ stderr: "execution error: Error: The app has no open window (-2700)" }).message, "The app has no open window");
});

test("a turn that runs out of tool steps says so instead of ending silently", async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls += 1;
      res.setHeader("content-type", "application/json");
      // Never finishes: always asks for one more (harmless) command.
      res.end(JSON.stringify({ choices: [{ message: { content: "Checking again.", tool_calls: [{ id: `c${calls}`, type: "function", function: { name: "code", arguments: JSON.stringify({ command: "true" }) } }] } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-steps-")));
    await store.load();
    const { services } = createApp(store);
    const model = await services.createModel({ name: "Local", provider: "openai", model: "local", baseUrl: `http://127.0.0.1:${address.port}` });
    const agent = await services.createAgent({ name: "Looper", modelConnectionId: model.id, autonomy: "fully_autonomous" });
    const run = await services.startRun(agent.id, "go");
    for (let attempt = 0; attempt < 600 && !["completed", "failed"].includes(services.kernel.getRun(run.id).status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const done = services.kernel.getRun(run.id);
    assert.equal(done.status, "completed");
    assert.ok(done.actions.length >= MAX_TOOL_ROUNDS && done.actions.length <= MAX_TOOL_ROUNDS + 1, `ran ${done.actions.length} steps`);
    assert.equal(done.output, `Checking again.\n\n${stepLimitNote()}`);
  } finally {
    server.close();
  }
});
