// Notebook kernels: the runtime holds one helper per open notebook, passes on what it says, limits what it keeps, and
// leaves no process behind. A stand-in "python" plays the helper; docs/research-contract.md is the contract.
import assert from "node:assert/strict";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench, posixOnly, until } from "./files-support.mjs";

let saturn;
before(async () => { saturn = await bench(); });
after(async () => { await saturn?.stop(); });

const python = `#!/bin/sh
printf '%s' "$3" | head -n 1 > helper-first-line
exec node "$(dirname "$0")/helper.mjs" "$4"
`;

/** Plays the helper's side of the protocol. What a cell does is what its code says; `mode` changes how it starts. */
const helper = `
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const mode = (() => { try { return readFileSync("mode", "utf8").trim(); } catch { return ""; } })();
writeFileSync("helper.pid", String(process.pid));
writeFileSync("helper.env", JSON.stringify(Object.keys(process.env)));
writeFileSync("helper.folder", process.argv[2]);
const say = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
if (mode === "missing") { say({ event: "missing", packages: ["jupyter_client", "ipykernel"] }); process.exit(0); }
if (mode === "failing") { process.stderr.write("a traceback\\n"); say({ event: "failed", message: "The kernel could not start: no." }); process.exit(1); }
if (mode === "crashing") { process.stderr.write("something broke\\n"); process.exit(3); }
if (mode === "stubborn") process.on("SIGTERM", () => {});
say({ event: "ready", python: "/env/bin/python", version: "3.12" });
let count = 0;
let hanging = null;
const pending = [];
const finish = (cell, status) => { hanging = null; say({ event: "finished", cell, status, count: status === "ok" ? (count += 1) : null }); };
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.op === "stop") { if (mode !== "stubborn") process.exit(0); continue; }
  if (command.op === "interrupt" && hanging) {
    say({ event: "output", cell: hanging, output: { output_type: "error", ename: "KeyboardInterrupt", evalue: "", traceback: ["KeyboardInterrupt"] } });
    finish(hanging, "error");
    for (const waiting of pending.splice(0)) finish(waiting, "skipped");
    continue;
  }
  if (command.op === "restart") { if (hanging) finish(hanging, "aborted"); for (const waiting of pending.splice(0)) finish(waiting, "skipped"); count = 0; say({ event: "restarted" }); continue; }
  if (command.op !== "run") continue;
  const { cell, code } = command;
  if (hanging) { pending.push(cell); continue; }
  say({ event: "started", cell });
  if (code === "hang") { hanging = cell; continue; }
  if (code === "flood") {
    for (let index = 0; index < 4; index += 1) say({ event: "output", cell, output: { output_type: "stream", name: "stdout", text: "é".repeat(400 * 1024) } });
    say({ event: "output", cell, output: { output_type: "stream", name: "stdout", text: "after the limit" } });
  } else if (code === "image") {
    say({ event: "output", cell, output: { output_type: "display_data", data: { "image/png": "A".repeat(3 * 1024 * 1024) }, metadata: {} } });
  } else if (code === "huge") {
    say({ event: "output", cell, output: { output_type: "stream", name: "stdout", text: "x".repeat(9 * 1024 * 1024) } });
  } else if (code === "noise") {
    process.stdout.write("not a line of the protocol\\n");
  } else if (code === "die") {
    process.exit(7);
  } else {
    say({ event: "output", cell, output: { output_type: "stream", name: "stdout", text: code } });
  }
  finish(cell, "ok");
}
`;

/** A project with a notebook in a folder, the stand-in as its Python, and `mode` for how the helper starts. */
async function project(mode = "") {
  const folder = await saturn.folder();
  const made = await saturn.api("POST", "/projects", { path: folder });
  await saturn.api("POST", `/projects/${made.id}/access`, {});
  await mkdir(path.join(folder, "notes"));
  await writeFile(path.join(folder, "notes/a.ipynb"), JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
  await writeFile(path.join(folder, "python"), python);
  await chmod(path.join(folder, "python"), 0o755);
  await writeFile(path.join(folder, "helper.mjs"), helper);
  if (mode) await writeFile(path.join(folder, "mode"), mode);
  const route = `/projects/${made.id}/research`;
  await saturn.api("PUT", `${route}/environment`, { python: "./python" });
  return { folder, id: made.id, route, notebook: `${route}/notebook` };
}

const NOTEBOOK = "notes/a.ipynb";
const run = (place, ...cells) => saturn.api("POST", `${place.notebook}/run`, { path: NOTEBOOK, cells: cells.map(([cell, code]) => ({ cell, code })) });
const status = (place) => saturn.api("GET", `${place.notebook}?path=${encodeURIComponent(NOTEBOOK)}`);

/** Whether a process is there. One that ended and has not been reaped does not count: nothing is left of it but its record. */
function alive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

const helperPid = async (place) => until("the helper to start", async () => {
  try {
    return await readFile(path.join(place.folder, "helper.pid"), "utf8");
  } catch {
    return "";
  }
});
const gone = (pid, seconds = 15) => until(`process ${pid} to end`, async () => !alive(pid), Boolean, seconds);

/** Follows a kernel's events as they come: `.seen` so far, and `.until` to wait for one. Ends with the stream. */
async function follow(place, kernel, from = 0) {
  const token = (await readFile(path.join(saturn.runtime.dataDir, "runtime-token"), "utf8")).trim();
  const controller = new AbortController();
  const response = await fetch(`${saturn.runtime.origin}${place.notebook}/events?path=${encodeURIComponent(NOTEBOOK)}&kernel=${kernel}&after=${from}`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
  assert.equal(response.status, 200);
  const seen = [];
  const done = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const data = /^data: (.*)$/m.exec(buffer.slice(0, index))?.[1];
          buffer = buffer.slice(index + 2);
          if (data) seen.push(JSON.parse(data));
        }
      }
    } catch {
      // Aborted by the test.
    }
  })();
  return {
    seen,
    done,
    stop: () => controller.abort(),
    until: (what, check) => until(what, async () => seen.find(check)),
  };
}

test("a cell runs in the notebook's kernel, its output streams, and the notebook's folder is where it runs", posixOnly, async () => {
  const place = await project();
  const before = await status(place);
  assert.equal(before.state, "none");
  assert.equal(before.kernel, null);
  const started = await saturn.api("POST", `${place.notebook}/start`, { path: NOTEBOOK });
  assert.ok(started.kernel);
  const again = await saturn.api("POST", `${place.notebook}/start`, { path: NOTEBOOK });
  assert.equal(again.kernel, started.kernel);
  const events = await follow(place, started.kernel);
  await events.until("the kernel to be ready", (event) => event.type === "state" && event.state === "idle");
  await run(place, ["one", "print('hi')"]);
  const output = await events.until("its output", (event) => event.type === "output" && event.cell === "one");
  assert.deepEqual(output.output, { output_type: "stream", name: "stdout", text: "print('hi')" });
  const finished = await events.until("it to finish", (event) => event.type === "finished" && event.cell === "one");
  assert.equal(finished.status, "ok");
  assert.equal(finished.count, 1);
  assert.equal(events.seen.findIndex((event) => event.type === "started") < events.seen.indexOf(output), true);
  assert.equal(await readFile(path.join(place.folder, "helper.folder"), "utf8"), path.join(place.folder, "notes"));
  assert.match(await readFile(path.join(place.folder, "helper-first-line"), "utf8"), /^"""Holds one Jupyter kernel/);
  const now = await until("it to rest", () => status(place), (view) => view.state === "idle");
  assert.equal(now.python, "/env/bin/python");
  events.stop();
  await saturn.api("POST", `${place.notebook}/stop`, { path: NOTEBOOK });
});

test("the helper gets no SATURN_ variable from the runtime", posixOnly, async () => {
  const place = await project();
  await saturn.api("POST", `${place.notebook}/start`, { path: NOTEBOOK });
  const pid = await helperPid(place);
  const names = await until("the helper's environment", async () => {
    try {
      return JSON.parse(await readFile(path.join(place.folder, "helper.env"), "utf8"));
    } catch {
      return null;
    }
  });
  assert.deepEqual(names.filter((name) => name.startsWith("SATURN_")), []);
  await saturn.api("POST", `${place.notebook}/stop`, { path: NOTEBOOK });
  await gone(pid);
});

test("cells run in order, and an interrupt stops the running one with the error it raises", posixOnly, async () => {
  const place = await project();
  const view = await run(place, ["first", "hang"], ["second", "later"]);
  assert.deepEqual(view.queued.toSorted(), ["first", "second"]);
  const events = await follow(place, view.kernel);
  await events.until("the first to start", (event) => event.type === "started" && event.cell === "first");
  const running = await status(place);
  assert.equal(running.running, "first");
  assert.equal(running.state, "busy");
  await saturn.api("POST", `${place.notebook}/interrupt`, { path: NOTEBOOK });
  const finished = await events.until("it to stop", (event) => event.type === "finished" && event.cell === "first");
  assert.equal(finished.status, "error");
  assert.ok(events.seen.some((event) => event.type === "output" && event.output.ename === "KeyboardInterrupt"));
  const second = await events.until("the second to be skipped", (event) => event.type === "finished" && event.cell === "second");
  assert.equal(second.status, "skipped");
  assert.equal(events.seen.some((event) => event.type === "started" && event.cell === "second"), false);
  assert.equal((await until("it to rest", () => status(place), (item) => item.state === "idle")).running, null);
  events.stop();
  await saturn.api("POST", `${place.notebook}/stop`, { path: NOTEBOOK });
});

test("a restart keeps the helper, lets the running cell go, and a kernel it does not have cannot be restarted", posixOnly, async () => {
  const place = await project();
  assert.equal((await saturn.call("POST", `${place.notebook}/restart`, { path: NOTEBOOK })).status, 409);
  assert.equal((await saturn.call("POST", `${place.notebook}/interrupt`, { path: NOTEBOOK })).status, 409);
  const view = await run(place, ["first", "hang"]);
  const events = await follow(place, view.kernel);
  await events.until("it to start", (event) => event.type === "started");
  await saturn.api("POST", `${place.notebook}/restart`, { path: NOTEBOOK });
  const finished = await events.until("it to be let go", (event) => event.type === "finished");
  assert.equal(finished.status, "aborted");
  const after = await until("it to rest", () => status(place), (item) => item.state === "idle");
  assert.equal(after.kernel, view.kernel);
  events.stop();
  await saturn.api("POST", `${place.notebook}/stop`, { path: NOTEBOOK });
});

test("without the packages the runtime says which, points at the kit, and running again checks again", posixOnly, async () => {
  const place = await project("missing");
  const view = await run(place, ["one", "x"]);
  const missing = await until("the helper to answer", () => status(place), (item) => item.state === "missing");
  assert.deepEqual(missing.missing, ["jupyter_client", "ipykernel"]);
  assert.match(missing.message, /jupyter_client or ipykernel/);
  assert.match(missing.message, /Notebooks kit under Environment/);
  assert.deepEqual(missing.queued, []);
  const events = await follow(place, view.kernel);
  await events.done;
  assert.ok(events.seen.some((event) => event.type === "finished" && event.cell === "one" && event.status !== "ok"));
  assert.equal(events.seen.at(-1).type, "ended");

  await writeFile(path.join(place.folder, "mode"), "");
  const next = await run(place, ["two", "y"]);
  assert.notEqual(next.kernel, view.kernel);
  const running = await follow(place, next.kernel);
  await running.until("it to run now", (event) => event.type === "finished" && event.cell === "two" && event.status === "ok");
  running.stop();
  await saturn.api("POST", `${place.notebook}/stop`, { path: NOTEBOOK });
  // The notebook itself never needed a kernel.
  const opened = await saturn.api("GET", `${place.route}/source?path=${encodeURIComponent(NOTEBOOK)}`);
  assert.equal(opened.kind, "file");
});

test("a Python that is not there, or none at all, is refused with what to do", posixOnly, async () => {
  const place = await project();
  await saturn.api("PUT", `${place.route}/environment`, { python: "./no-such-python" });
  const absent = await saturn.call("POST", `${place.notebook}/start`, { path: NOTEBOOK });
  assert.equal(absent.status, 422);
  assert.match(absent.body.error, /could not start.*Environment/s);
  await saturn.api("PUT", `${place.route}/environment`, { python: "" });
  const none = await saturn.call("POST", `${place.notebook}/run`, { path: NOTEBOOK, cells: [{ cell: "a", code: "b" }] });
  assert.equal(none.status, 422);
  assert.match(none.body.error, /No Python is set/);
});

test("a helper that fails or crashes says why, and nothing stays waiting", posixOnly, async () => {
  const failing = await project("failing");
  const first = await run(failing, ["one", "x"]);
  const failed = await until("it to fail", () => status(failing), (item) => item.state === "failed" && item.message.includes("a traceback"));
  assert.match(failed.message, /could not start: no\./);
  assert.equal(failed.kernel, first.kernel);

  const crashing = await project("crashing");
  await run(crashing, ["one", "x"]);
  const stopped = await until("it to end", () => status(crashing), (item) => item.state === "stopped");
  assert.match(stopped.message, /something broke/);
  assert.deepEqual(stopped.queued, []);
  assert.equal(stopped.running, null);
});

test("a helper that dies with a cell running lets the cell go", posixOnly, async () => {
  const place = await project();
  const view = await run(place, ["one", "die"]);
  const events = await follow(place, view.kernel);
  await events.done;
  const finished = events.seen.find((event) => event.type === "finished" && event.cell === "one");
  assert.equal(finished.status, "aborted");
  assert.equal(events.seen.at(-1).type, "ended");
});

test("output has a limit, its text keeps its start, and a note says what happened", posixOnly, async () => {
  const place = await project();
  const view = await run(place, ["flood", "flood"], ["image", "image"], ["huge", "huge"], ["after", "noise"], ["small", "still here"]);
  const events = await follow(place, view.kernel);
  await events.until("the last to finish", (event) => event.type === "finished" && event.cell === "small");

  const of = (cell) => events.seen.filter((event) => event.type === "output" && event.cell === cell).map((event) => event.output);
  const flood = of("flood");
  const kept = flood.filter((output) => output.output_type === "stream").map((output) => output.text).join("");
  assert.ok(kept.length > 0);
  assert.ok(Buffer.byteLength(kept) <= 2 * 1024 * 1024);
  assert.ok(!kept.includes("�"));
  assert.ok(!kept.includes("after the limit"));
  const note = flood.at(-1);
  assert.equal(note.metadata.saturn.truncated, true);
  assert.match(note.data["text/plain"], /kept the first 2 MB/);
  assert.equal(flood.filter((output) => output.metadata?.saturn?.truncated).length, 1);

  const image = of("image");
  assert.equal(image.length, 1);
  assert.equal(image[0].metadata.saturn.truncated, true);
  assert.equal(image[0].data["image/png"], undefined);

  assert.match(of("huge")[0].data["text/plain"], /kept the first 2 MB/);
  // A line that is not the protocol's changes nothing, and each cell has a limit of its own.
  assert.deepEqual(of("after"), []);
  assert.equal(of("small")[0].text, "still here");
  events.stop();
  await saturn.api("POST", `${place.notebook}/stop`, { path: NOTEBOOK });
});

test("a client that comes back hears what it missed, once", posixOnly, async () => {
  const place = await project();
  const view = await run(place, ["one", "text"]);
  const first = await follow(place, view.kernel);
  const finished = await first.until("it to finish", (event) => event.type === "finished");
  first.stop();
  await run(place, ["two", "more"]);
  const back = await follow(place, view.kernel, finished.seq + 1);
  await back.until("the second", (event) => event.type === "finished" && event.cell === "two");
  assert.equal(back.seen.some((event) => event.cell === "one"), false);
  assert.ok(back.seen.every((event, index) => index === 0 || event.seq === back.seen[index - 1].seq + 1));
  back.stop();
  await saturn.api("POST", `${place.notebook}/stop`, { path: NOTEBOOK });
  const reconnect = await saturn.call("GET", `${place.notebook}/events?path=${encodeURIComponent(NOTEBOOK)}&kernel=${view.kernel}`);
  assert.equal(reconnect.status, 404);
});

test("a path out of the project, into its records, or not a notebook is refused", posixOnly, async () => {
  const place = await project();
  await writeFile(path.join(place.folder, "note.txt"), "text");
  const refused = async (requested, code) => {
    for (const call of [
      () => saturn.call("POST", `${place.notebook}/start`, { path: requested }),
      () => saturn.call("POST", `${place.notebook}/run`, { path: requested, cells: [{ cell: "a", code: "b" }] }),
      () => saturn.call("GET", `${place.notebook}?path=${encodeURIComponent(requested)}`),
    ]) {
      assert.equal((await call()).status, code, requested);
    }
  };
  await refused("../outside.ipynb", 403);
  await refused("notes/../../outside.ipynb", 403);
  await refused("/etc/outside.ipynb", 403);
  await refused(".saturn/research/x.ipynb", 403);
  await refused("note.txt", 400);
  await refused("notes/none.ipynb", 404);
  assert.equal((await saturn.call("POST", `${place.notebook}/stop`, { path: "../outside.ipynb" })).status, 403);
  assert.equal(await readdir(place.folder).then((names) => names.includes("helper.pid")), false);
  const empty = await saturn.call("POST", `${place.notebook}/run`, { path: NOTEBOOK, cells: [] });
  assert.equal(empty.status, 400);
});

test("stopping ends the helper, and one that ignores being asked and signalled is ended by force", posixOnly, async () => {
  const place = await project();
  await saturn.api("POST", `${place.notebook}/start`, { path: NOTEBOOK });
  const pid = await helperPid(place);
  assert.equal(alive(pid), true);
  assert.deepEqual(await saturn.api("POST", `${place.notebook}/stop`, { path: NOTEBOOK }), { stopped: true });
  assert.equal(alive(pid), false);
  assert.deepEqual(await saturn.api("POST", `${place.notebook}/stop`, { path: NOTEBOOK }), { stopped: false });
  assert.equal((await status(place)).state, "none");

  const stubborn = await project("stubborn");
  await saturn.api("POST", `${stubborn.notebook}/start`, { path: NOTEBOOK });
  const held = await helperPid(stubborn);
  await saturn.api("POST", `${stubborn.notebook}/stop`, { path: NOTEBOOK });
  assert.equal(alive(held), false);
});

test("a kernel goes when its project is removed, and when Saturn loses access to the project", posixOnly, async () => {
  const place = await project();
  await saturn.api("POST", `${place.notebook}/start`, { path: NOTEBOOK });
  const pid = await helperPid(place);
  await saturn.call("DELETE", `/projects/${place.id}`);
  assert.equal(alive(pid), false);

  const other = await project();
  await saturn.api("POST", `${other.notebook}/start`, { path: NOTEBOOK });
  const held = await helperPid(other);
  await saturn.api("POST", `/projects/${other.id}/access`, { granted: false });
  assert.equal(alive(held), false);
});

test("a kernel goes when the runtime stops, and when it dies without a word", posixOnly, async () => {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    const own = saturn;
    saturn = await bench();
    try {
      const place = await project();
      await saturn.api("POST", `${place.notebook}/start`, { path: NOTEBOOK });
      const pid = await helperPid(place);
      assert.equal(alive(pid), true);
      saturn.runtime.child.kill(signal);
      await gone(pid);
    } finally {
      await saturn.stop();
      saturn = own;
    }
  }
});

test("a notebook opens up to 8 MB, and another file only up to 2 MB", posixOnly, async () => {
  const place = await project();
  const large = JSON.stringify({ cells: [], metadata: { pad: "x".repeat(3 * 1024 * 1024) }, nbformat: 4, nbformat_minor: 5 });
  await writeFile(path.join(place.folder, "large.ipynb"), large);
  await writeFile(path.join(place.folder, "large.txt"), large);
  await writeFile(path.join(place.folder, "larger.ipynb"), "x".repeat(9 * 1024 * 1024));
  assert.equal((await saturn.api("GET", `${place.route}/source?path=large.ipynb`)).content.length, large.length);
  assert.equal((await saturn.call("GET", `${place.route}/source?path=large.txt`)).status, 413);
  assert.equal((await saturn.call("GET", `${place.route}/source?path=larger.ipynb`)).status, 413);
});
