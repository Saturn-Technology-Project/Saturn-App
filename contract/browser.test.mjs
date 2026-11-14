// The agent's browser and the recordings a run makes, whichever language runs them. Safari is a fake WebDriver server, so
// every command it gets is compared with contract/cases/browser.json, recorded from the TypeScript runtime
// (kept from before it was removed; a change here is a deliberate one). Chrome is the real one when installed, with its own scratch profile and a page on this computer.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { placeProgram } from "./programs.mjs";
import { placed, startRuntime } from "./runtime.mjs";

const casesFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "cases/browser.json");
const ELEMENT = "element-6066-11e4-a52f-4a8f-b8c4-f3bc2b7a1b40";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const chromes = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"];
const hasChrome = Boolean(process.env.SATURN_BROWSER) || chromes.some((item) => existsSync(item));

let scratch;
const servers = [];
const stops = [];

before(async () => {
  scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "saturn-contract-browser-")));
});
after(async () => {
  for (const stop of stops) await stop().catch(() => undefined);
  await Promise.all(servers.map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
  await rm(scratch, { recursive: true, force: true });
});

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

async function start(env = {}) {
  const runtime = await startRuntime({ env });
  stops.push(runtime.stop);
  return runtime;
}

async function fetched(runtime, method, route, body) {
  const token = (await readFile(path.join(runtime.dataDir, "runtime-token"), "utf8")).trim();
  return fetch(`${runtime.origin}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function call(runtime, method, route, body) {
  const response = await fetched(runtime, method, route, body);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function api(runtime, method, route, body) {
  const answer = await call(runtime, method, route, body);
  assert.ok(answer.status < 300, `${method} ${route}: ${answer.status} ${JSON.stringify(answer.body)}`);
  return answer.body;
}

async function until(what, read, done = Boolean, seconds = 20) {
  let value;
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`never happened: ${what}; last ${JSON.stringify(value)}`);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An agent that calls the tools it is given, one call to a turn; gives back a function running a list of them. */
async function toolRunner(runtime) {
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
  const url = await listen(server);
  const connection = await api(runtime, "POST", "/connections/models", { name: "Scripted", provider: "openai", model: "s", baseUrl: url });
  const agent = await api(runtime, "POST", "/agents", { name: "Tools", modelConnectionId: connection.id, autonomy: "bypass", mcpConnectionIds: ["browser"] });
  return async (steps) => {
    queue.push(...steps);
    const started = await api(runtime, "POST", `/agents/${agent.id}/runs`, { input: "go" });
    // A step may start the browser, which has thirty seconds to start and fifteen for a page to load.
    const run = await until("the run", () => api(runtime, "GET", `/runs/${started.id}`), (item) => !["queued", "running", "waiting_approval"].includes(item.status), 90);
    assert.equal(run.status, "completed", run.error);
    assert.equal(run.actions.length, steps.length);
    return { id: run.id, answers: run.actions.map((action, index) => ({ tool: steps[index][0], arguments: steps[index][1], status: action.status, ...(action.result === undefined ? {} : { result: action.result }), ...(action.reason === undefined ? {} : { reason: action.reason }) })) };
  };
}

/** What /browser/live has sent so far, as { event, data } in order, until `close()`. */
async function liveView(runtime) {
  const events = [];
  const stop = new AbortController();
  const token = (await readFile(path.join(runtime.dataDir, "runtime-token"), "utf8")).trim();
  const response = await fetch(`${runtime.origin}/browser/live`, { headers: { authorization: `Bearer ${token}` }, signal: stop.signal });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reading = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const name = /^event: ?(.*)$/m.exec(block)?.[1];
        const data = /^data: ?(.*)$/m.exec(block)?.[1];
        if (name && data) events.push({ event: name, data: JSON.parse(data) });
      }
    }
  })().catch(() => undefined);
  return { events, close: async () => { stop.abort(); await reading; } };
}

/** A WebDriver server standing in for safaridriver: records each command, answers like Safari would. */
async function fakeSafaridriver({ refuse } = {}) {
  const commands = [];
  let url = "about:blank";
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const route = (req.url ?? "").replace(/^\/session\/s1/, "");
      const sent = raw ? JSON.parse(raw) : {};
      if (route !== "/screenshot") commands.push({ method: req.method, route, ...(raw ? { body: sent } : {}) });
      res.setHeader("content-type", "application/json");
      const answer = (value, status = 200) => {
        res.statusCode = status;
        res.end(JSON.stringify({ value }));
      };
      if (req.method === "POST" && req.url === "/session") {
        if (refuse) return answer({ error: "session not created", message: refuse }, 500);
        return answer({ sessionId: "s1", capabilities: { browserName: "Safari" } });
      }
      if (route === "/url" && req.method === "POST") {
        url = String(sent.url);
        return answer(null);
      }
      if (route === "/url") return answer(url);
      if (route === "/title") return answer("Demo page");
      if (route === "/element") return sent.value === "#missing" ? answer(null, 404) : answer({ [ELEMENT]: "e1" });
      if (route === "/execute/sync") {
        const script = String(sent.script);
        if (script.includes("data-saturn-ref")) return answer('[1] heading name="Demo"\n[2] button name="Go"');
        if (script.includes("getBoundingClientRect()")) return answer({ x: 300, y: 230 });
        return answer(null);
      }
      if (route === "/execute/async") return answer(sent.args[0] === "boom" ? { error: "Error: boom" } : { ok: 42 });
      if (route === "/screenshot") return answer(PNG.toString("base64"));
      return answer(null);
    });
  });
  return { commands, endpoint: await listen(server) };
}

/** Compares with the recording, or makes it. */
async function matchesRecording(name, value, runtime) {
  const normalized = placed(value, [[runtime.dataDir, "<data>"], [scratch, "<scratch>"]]);
  const all = await readFile(casesFile, "utf8").then(JSON.parse).catch(() => ({}));
  assert.ok(all[name], `${name} is not recorded`);
  assert.deepEqual(normalized, all[name]);
}

/** The processes running on a data folder's browser profile. */
function browsersOn(dataDir) {
  if (process.platform === "win32") {
    // No pgrep: the system is asked for the command line of every Chrome.
    try {
      const all = JSON.parse(execFileSync("powershell", ["-NoProfile", "-Command", "ConvertTo-Json @(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | ForEach-Object { $_.CommandLine })"], { encoding: "utf8" }) || "[]");
      return all.filter((line) => String(line).includes(`user-data-dir=${dataDir}`)).length ? "running" : "";
    } catch {
      return "";
    }
  }
  try {
    return execFileSync("pgrep", ["-f", `user-data-dir=${dataDir}`], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

test("in Safari mode the tools become WebDriver commands, and a run's recordings can be listed, played and exported", async () => {
  const driver = await fakeSafaridriver();
  const programs = path.join(scratch, "with-ffmpeg");
  await mkdir(programs, { recursive: true });
  // A stand-in for ffmpeg: it counts how often it ran and writes the frame list as the film.
  await placeProgram(path.join(programs, "ffmpeg"), process.platform === "win32"
    ? 'const fs = require("node:fs");\nlet count = 0;\ntry { count = Number(fs.readFileSync("count", "utf8")); } catch {}\nfs.writeFileSync("count", String(count + 1) + "\\n");\nfs.writeFileSync("out.mp4", fs.readFileSync("frames.txt"));\n'
    : '#!/bin/sh\ncount=$(/bin/cat count 2>/dev/null || echo 0)\necho $((count + 1)) > count\n/bin/cat frames.txt > out.mp4\n');
  const runtime = await start({ SATURN_SAFARI_ENDPOINT: driver.endpoint, PATH: programs });
  const workspace = path.join(runtime.dataDir, "workspace");
  await mkdir(workspace, { recursive: true });
  await symlink(scratch, path.join(workspace, "linked"));
  await api(runtime, "PATCH", "/settings", { browser: "safari" });
  assert.deepEqual(await api(runtime, "GET", "/browser"), { open: false, mode: "safari", url: "about:blank", title: "" });
  const run = await toolRunner(runtime);
  const live = await liveView(runtime);

  const first = await run([
    ["browser_navigate", { url: "93.184.216.34/page" }],
    ["browser_navigate", { url: "http://127.0.0.1:4700/" }],
    ["browser_navigate", { url: "http://localhost/" }],
    ["browser_snapshot", {}],
    ["browser_click", { id: 2 }],
    ["browser_click", { selector: "#missing" }],
    ["browser_click", {}],
    ["browser_type", { selector: "#q", text: "hello", submit: true }],
    ["browser_type", { id: 2, text: "kept", clear: false }],
    ["browser_type", { text: "ab" }],
    ["browser_press", { key: "cmd+a" }],
    ["browser_press", { key: "Enter" }],
    ["browser_scroll", { direction: "up", pixels: 50 }],
    ["browser_scroll", { direction: "sideways", pixels: 9000 }],
    ["browser_evaluate", { expression: "6 * 7" }],
    ["browser_evaluate", { expression: "boom" }],
    ["browser_evaluate", { expression: "  " }],
    ["browser_screenshot", {}],
    ["browser_screenshot", { file: "shots/home.jpg" }],
    ["browser_record_stop", {}],
  ]);
  await matchesRecording("safari tools", first.answers, runtime);
  assert.deepEqual([...await readFile(path.join(workspace, "shots/home.jpg"))], [...PNG]);
  assert.deepEqual(await api(runtime, "GET", "/browser"), { open: true, mode: "safari", url: "https://93.184.216.34/page", title: "Demo page" });

  // A screenshot stays in the workspace, whatever path it is given.
  const outside = path.join(scratch, "outside.jpg");
  const refused = await run([
    ["browser_screenshot", { file: outside }],
    ["browser_screenshot", { file: "../escaped.jpg" }],
    ["browser_screenshot", { file: "linked/through-a-link.jpg" }],
  ]);
  for (const answer of refused.answers) {
    assert.equal(answer.status, "failed", JSON.stringify(answer));
    assert.match(answer.reason, /workspace/);
  }
  assert.ok(!existsSync(outside));
  assert.ok(!existsSync(path.join(runtime.dataDir, "escaped.jpg")));
  assert.ok(!existsSync(path.join(scratch, "through-a-link.jpg")));

  // The live view gets the page's PNG screenshots.
  const frame = await until("a live frame", () => live.events.find((item) => item.event === "frame"));
  assert.deepEqual(live.events[0], { event: "state", data: { open: false, mode: "safari", url: "about:blank", title: "" } });
  assert.equal(frame.data.format, "png");
  assert.equal(frame.data.data, PNG.toString("base64"));
  assert.equal(frame.data.url, "https://93.184.216.34/page");
  assert.equal(frame.data.title, "Demo page");
  assert.equal(frame.data.width, 1280);
  assert.equal(frame.data.height, 800);

  // A recording: PNG frames in the folder, which the app can list, play and export.
  const started = await run([["browser_record_start", { name: "my demo!" }], ["browser_record_start", {}]]);
  assert.deepEqual(started.answers[0].result.recording, path.join(workspace, "recordings", "my_demo_"));
  assert.match(started.answers[0].result.note, /700 ms/);
  assert.equal(started.answers[1].reason, "Already recording; call browser_record_stop first.");
  await pause(1600);
  const stopped = await run([["browser_record_stop", {}]]);
  const summary = stopped.answers[0].result;
  assert.equal(summary.recording, path.join(workspace, "recordings", "my_demo_"));
  assert.ok(summary.frames >= 1, JSON.stringify(summary));
  assert.equal(typeof summary.seconds, "number");
  const index = await readFile(path.join(summary.recording, "frames.txt"), "utf8");
  assert.equal(index, `${Array.from({ length: summary.frames }, (_, at) => `file 'frame-${String(at + 1).padStart(5, "0")}.png'\nduration 0.7`).join("\n")}\n`);

  assert.deepEqual(await api(runtime, "GET", `/runs/${stopped.id}/recordings`), [{ name: "my_demo_", frames: summary.frames, seconds: summary.seconds, exported: false }]);
  const played = await fetched(runtime, "GET", `/runs/${stopped.id}/recordings/my_demo_/frames/1`);
  assert.equal(played.status, 200);
  assert.match(played.headers.get("content-type"), /image\/png/);
  assert.deepEqual([...new Uint8Array(await played.arrayBuffer())], [...PNG]);
  assert.equal((await call(runtime, "GET", `/runs/${stopped.id}/recordings/my_demo_/frames/${summary.frames + 1}`)).status, 404);
  assert.equal((await call(runtime, "GET", `/runs/${stopped.id}/recordings/my_demo_/frames/0`)).status, 404);
  assert.equal((await call(runtime, "GET", `/runs/${stopped.id}/recordings/my_demo_/frames/nope`)).status, 404);
  assert.deepEqual((await call(runtime, "GET", `/runs/${stopped.id}/recordings/other/frames/1`)), { status: 404, body: { error: "This run has no such recording" } });
  assert.equal((await call(runtime, "GET", "/runs/run_none/recordings")).status, 404);

  const target = path.join(summary.recording, "out.mp4");
  assert.deepEqual(await api(runtime, "POST", `/runs/${stopped.id}/recordings/my_demo_/export`), { path: target });
  assert.equal(await readFile(target, "utf8"), index);
  assert.deepEqual(await api(runtime, "POST", `/runs/${stopped.id}/recordings/my_demo_/export`), { path: target });
  assert.equal((await readFile(path.join(summary.recording, "count"), "utf8")).trim(), "1", "an export already made is kept");
  assert.equal((await api(runtime, "GET", `/runs/${stopped.id}/recordings`))[0].exported, true);
  assert.equal((await call(runtime, "POST", `/runs/${stopped.id}/recordings/other/export`)).status, 404);

  // A name is one folder under recordings, never a way out of it.
  const dotted = await run([["browser_record_start", { name: ".." }], ["browser_record_stop", {}], ["browser_record_start", { name: "..." }], ["browser_record_stop", {}], ["browser_record_start", { name: "../up" }], ["browser_record_stop", {}]]);
  for (const answer of dotted.answers) {
    assert.equal(answer.status, "completed", JSON.stringify(answer));
    assert.equal(path.dirname(answer.result.recording), path.join(workspace, "recordings"));
    assert.ok(![".", ".."].includes(path.basename(answer.result.recording)));
  }
  assert.ok(!existsSync(path.join(workspace, "frames.txt")));

  // Closing ends the session, and the next call opens a new one.
  await matchesRecording("safari closing", (await run([["browser_close", {}]])).answers, runtime);
  assert.deepEqual(await api(runtime, "GET", "/browser"), { open: false, mode: "safari", url: "about:blank", title: "" });
  await until("the closed state on the live view", () => live.events.some((item) => item.event === "state" && item.data.open === false && live.events.indexOf(item) > 0));
  await run([["browser_snapshot", {}]]);
  assert.equal((await api(runtime, "GET", "/browser")).open, true);

  // Another browser in Settings ends the Safari session.
  await api(runtime, "PATCH", "/settings", { browser: "saturn" });
  assert.deepEqual(await api(runtime, "GET", "/browser"), { open: false, mode: "saturn", url: "about:blank", title: "" });
  await live.close();
  const ended = driver.commands.filter((item) => item.method === "DELETE" && item.route === "").length;
  assert.equal(ended, 2);
  await matchesRecording("safari commands", driver.commands, runtime);
});

test("an export without ffmpeg says how to get it", async () => {
  const driver = await fakeSafaridriver();
  const empty = path.join(scratch, "no-programs");
  await mkdir(empty, { recursive: true });
  const runtime = await start({ SATURN_SAFARI_ENDPOINT: driver.endpoint, PATH: empty });
  await api(runtime, "PATCH", "/settings", { browser: "safari" });
  const run = await toolRunner(runtime);
  await api(runtime, "GET", "/browser");
  await run([["browser_record_start", { name: "plain" }]]);
  await pause(900);
  const stopped = await run([["browser_record_stop", {}], ["browser_close", {}]]);
  const answer = await call(runtime, "POST", `/runs/${stopped.id}/recordings/plain/export`);
  assert.equal(answer.status, 409);
  assert.match(answer.body.error, /ffmpeg is not installed/);
  assert.equal(driver.commands.filter((item) => item.method === "DELETE" && item.route === "").length, 1);
});

test("Safari without remote automation says how to turn it on, and another session in the way says so", async () => {
  for (const [refuse, expected] of [
    ["You must enable 'Allow remote automation' in the Develop menu to control Safari via WebDriver.", /safaridriver --enable/],
    ["Could not create a session: already paired with another session.", /already being automated/],
    ["Something else went wrong.", /Safari could not start an automation window: Something else went wrong\./],
  ]) {
    const driver = await fakeSafaridriver({ refuse });
    const runtime = await start({ SATURN_SAFARI_ENDPOINT: driver.endpoint });
    await api(runtime, "PATCH", "/settings", { browser: "safari" });
    const { answers } = await (await toolRunner(runtime))([["browser_snapshot", {}]]);
    assert.equal(answers[0].status, "failed");
    assert.match(answers[0].reason, expected);
    assert.equal((await api(runtime, "GET", "/browser")).open, false);
  }
});

test("a browser that cannot start says so, and the runtime keeps running", async () => {
  const runtime = await start({ SATURN_BROWSER: path.join(scratch, "no-such-browser") });
  const { answers } = await (await toolRunner(runtime))([["browser_snapshot", {}]]);
  assert.equal(answers[0].status, "failed");
  assert.match(answers[0].reason, /The browser could not start/);
  assert.match(answers[0].reason, /SATURN_BROWSER/);
  assert.equal((await api(runtime, "GET", "/browser")).open, false);
});

test("a browser that ends as it starts is tried once more, and then says what it printed", { skip: process.platform === "win32" && "a shell script stands in for the browser" }, async () => {
  const fake = path.join(scratch, "crashing-browser");
  const tries = path.join(scratch, "crashing-browser-tries");
  await writeFile(fake, `#!/bin/sh\necho started >> "${tries}"\necho "Missing X server or \\$DISPLAY" >&2\nexit 1\n`);
  await chmod(fake, 0o755);
  const runtime = await start({ SATURN_BROWSER: fake });
  const began = Date.now();
  const { answers } = await (await toolRunner(runtime))([["browser_snapshot", {}]]);
  assert.equal(answers[0].status, "failed");
  assert.match(answers[0].reason, /The browser did not start \(crashing-browser\): it ended\. It said: Missing X server or \$DISPLAY/);
  assert.equal((await readFile(tries, "utf8")).trim().split("\n").length, 2, "started twice");
  assert.ok(Date.now() - began < 20_000, "a browser that ended is not waited on");
  assert.equal((await api(runtime, "GET", "/browser")).open, false);
});

test("a real Chrome: the tools read and work a page, the live view streams it, a recording shares the stream", { skip: !hasChrome && "no Chrome here" }, async () => {
  const site = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><title>Demo page</title><body style="margin:0;height:3000px"><h1>Welcome</h1><button id="go" style="margin:200px;width:200px;height:60px" onclick="this.textContent='clicked'">Go</button><form onsubmit="document.title='sent '+document.getElementById('q').value;return false"><input id="q" aria-label="Query" value="old"></form><div id="__hidden" aria-hidden="true">Hidden</div></body>`);
  });
  const url = `${await listen(site)}/`;
  const runtime = await start();
  const workspace = path.join(runtime.dataDir, "workspace");
  const run = await toolRunner(runtime);
  assert.deepEqual(await api(runtime, "GET", "/browser"), { open: false, mode: "saturn", url: "about:blank", title: "" });
  const live = await liveView(runtime);
  try {
    // browser_navigate refuses this computer's addresses, before a browser even starts.
    const refused = await run([["browser_navigate", { url }]]);
    assert.match(refused.answers[0].reason, /not allowed/);
    assert.equal((await api(runtime, "GET", "/browser")).open, false);

    const opened = await run([["browser_evaluate", { expression: `location.href = ${JSON.stringify(url)}` }]]);
    assert.notEqual(opened.answers[0].status, "failed", `the browser opens: ${JSON.stringify(opened.answers[0])}`);
    const shown = await until("the page", () => api(runtime, "GET", "/browser"), (state) => state.title === "Demo page");
    assert.deepEqual(shown, { open: true, mode: "saturn", url, title: "Demo page" });

    const { answers: read } = await run([["browser_snapshot", {}]]);
    const snapshot = read[0].result.snapshot;
    assert.match(snapshot, /^\[1\] RootWebArea name="Demo page"/);
    assert.match(snapshot, /heading name="Welcome"/);
    assert.match(snapshot, /textbox name="Query" value="old"/);
    assert.ok(!snapshot.includes("__saturn_cursor"));
    assert.ok(!snapshot.includes("Hidden"));
    const button = Number(/\[(\d+)\] button name="Go"/.exec(snapshot)[1]);

    const { answers: worked } = await run([
      ["browser_click", { id: button }],
      ["browser_evaluate", { expression: "[document.getElementById('go').textContent, getComputedStyle(document.getElementById('__saturn_cursor')).transform]" }],
      ["browser_click", { id: 9999 }],
      ["browser_click", { selector: "#nothing" }],
      ["browser_click", {}],
      ["browser_type", { selector: "#q", text: "fresh", submit: true }],
      ["browser_evaluate", { expression: "[document.title, document.getElementById('q').value]" }],
      ["browser_type", { selector: "#q", text: "+more", clear: false }],
      ["browser_evaluate", { expression: "document.getElementById('q').value" }],
      ["browser_press", { key: "Tab" }],
      ["browser_evaluate", { expression: "document.getElementById('q').focus(); true" }],
      ["browser_press", { key: "ctrl+b" }],
      ["browser_evaluate", { expression: "document.getElementById('q').value" }],
      ["browser_scroll", { direction: "down", pixels: 300 }],
      ["browser_evaluate", { expression: "window.scrollY" }],
      ["browser_scroll", { direction: "up", pixels: 1 }],
      ["browser_evaluate", { expression: "window.scrollY" }],
      ["browser_evaluate", { expression: "Promise.resolve(40 + 2)" }],
      ["browser_evaluate", { expression: "throw_here()" }],
      ["browser_evaluate", { expression: "" }],
    ]);
    assert.equal(worked[0].result.clicked, true);
    assert.match(worked[0].result.snapshot, /button name="clicked"/);
    assert.equal(worked[1].result.value[0], "clicked");
    assert.match(worked[1].result.value[1], /matrix\(1, 0, 0, 1, (2\d\d|3\d\d)/);
    assert.equal(worked[2].reason, "No element [9999] in the last snapshot. Call browser_snapshot and use an id from it.");
    assert.equal(worked[3].reason, "Nothing matches the selector #nothing");
    assert.equal(worked[4].reason, "Give an element id from the snapshot, or a CSS selector.");
    assert.equal(worked[5].result.typed, 5);
    assert.deepEqual(worked[6].result.value, ["sent fresh", "fresh"]);
    assert.equal(worked[8].result.value, "fresh+more");
    assert.equal(worked[9].result.pressed, "Tab");
    assert.equal(worked[12].result.value, "fresh+more", "a chord types nothing");
    assert.equal(worked[13].result.scrolled, "down");
    assert.equal(worked[14].result.value, 300);
    assert.equal(worked[16].result.value, 200, "at least 100 pixels at a time");
    assert.equal(worked[17].result.value, 42);
    assert.match(worked[18].reason, /throw_here is not defined/);
    assert.equal(worked[19].reason, "Give a JavaScript expression");

    const { answers: shots } = await run([
      ["browser_screenshot", {}],
      ["browser_screenshot", { file: "shots/page.jpg", fullPage: true }],
      ["browser_screenshot", { file: "../escaped.jpg" }],
    ]);
    assert.equal(shots[0].result.width, 1280);
    assert.equal(shots[0].result.height, 800);
    assert.ok(Buffer.from(shots[0].result.image.replace("data:image/jpeg;base64,", ""), "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8])));
    assert.equal(shots[1].result.file, path.join(workspace, "shots/page.jpg"));
    const saved = await readFile(shots[1].result.file);
    assert.equal(shots[1].result.bytes, saved.length);
    assert.ok(saved.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])));
    assert.match(shots[2].reason, /workspace/);

    // Live frames are JPEGs with the page's address and size.
    const frame = await until("a live frame", () => live.events.find((item) => item.event === "frame" && item.data.url === url && item.data.title));
    assert.equal(frame.data.format, "jpeg");
    assert.ok(Buffer.from(frame.data.data, "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8])));
    assert.equal(frame.data.width, 1280);

    // A recording, while the live view keeps going after it stops.
    const { answers: started } = await run([["browser_record_start", { name: "chrome-demo" }], ["browser_scroll", { direction: "down", pixels: 500 }]]);
    assert.equal(started[0].result.recording, path.join(workspace, "recordings/chrome-demo"));
    await pause(500);
    const stopped = await run([["browser_scroll", { direction: "up", pixels: 400 }], ["browser_record_stop", {}]]);
    const summary = stopped.answers[1].result;
    assert.ok(summary.frames >= 1, JSON.stringify(summary));
    assert.deepEqual((await api(runtime, "GET", `/runs/${stopped.id}/recordings`))[0], { name: "chrome-demo", frames: summary.frames, seconds: summary.seconds, exported: false });
    const played = await fetched(runtime, "GET", `/runs/${stopped.id}/recordings/chrome-demo/frames/1`);
    assert.match(played.headers.get("content-type"), /image\/jpeg/);
    assert.ok(Buffer.from(await played.arrayBuffer()).subarray(0, 2).equals(Buffer.from([0xff, 0xd8])));
    const index = await readFile(path.join(summary.recording, "frames.txt"), "utf8");
    assert.ok(index.startsWith("file 'frame-00001.jpg'\nduration 0.1\n"));
    const before = live.events.length;
    await run([["browser_scroll", { direction: "down", pixels: 700 }]]);
    await until("frames after the recording", () => live.events.length > before);

    // Closing ends the browser.
    const { answers: closed } = await run([["browser_close", {}]]);
    assert.deepEqual(closed[0].result, { closed: true });
    assert.deepEqual(await api(runtime, "GET", "/browser"), { open: false, mode: "saturn", url: "about:blank", title: "" });
    await until("the browser to end", () => browsersOn(runtime.dataDir) === "");

    // A runtime that stops takes its browser with it.
    await run([["browser_snapshot", {}]]);
    assert.notEqual(browsersOn(runtime.dataDir), "");
  } finally {
    await live.close();
  }
  await runtime.stop();
  stops.splice(stops.indexOf(runtime.stop), 1);
  await until("the browser to end with the runtime", () => browsersOn(runtime.dataDir) === "");
});
