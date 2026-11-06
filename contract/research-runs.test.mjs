// Experiment runs: a process per run, saved before it exists, found again after a crash, and sealed when it ends.
// docs/research-contract.md is the contract. The stand-in experiments are small Node scripts.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench, commitAll, posixOnly, sha, until } from "./files-support.mjs";

let saturn;
before(async () => { saturn = await bench(); });
after(async () => { await saturn?.stop(); });

const line = (id, fields = {}) => JSON.stringify({ schemaVersion: 1, sampleId: id, input: "in", output: "out", scores: { s: 1 }, error: null, ...fields });

/** A script that writes these sample lines and exits with this code. */
const writes = (lines, code = 0) => `
import { appendFileSync } from "node:fs";
for (const text of ${JSON.stringify(lines)}) appendFileSync(process.env.SATURN_RUN_SAMPLES, text);
process.exit(${code});
`;

/** A script that writes one sample every 50 ms, for a long time. */
const LONG = `
import { appendFileSync } from "node:fs";
let index = 0;
process.on("SIGTERM", () => process.exit(0));
setInterval(() => appendFileSync(process.env.SATURN_RUN_SAMPLES, ${JSON.stringify(line("X")).replace('"X"', '"s"')}.replace('"s"', () => '"s' + index++ + '"') + "\\n"), 50);
`;

/** A new allowed project, in the given bench, with an experiment that runs this script. */
async function setup(script, { on = saturn, folder: given, inputs = {}, fields = {} } = {}) {
  const folder = given ?? await on.folder();
  if (script !== null) await writeFile(path.join(folder, "probe.mjs"), script);
  const made = await on.api("POST", "/projects", { path: folder });
  await on.api("POST", `/projects/${made.id}/access`, {});
  const route = `/projects/${made.id}/research`;
  const experiment = await on.api("POST", `${route}/experiments`, { title: "E", command: "node probe.mjs", inputs: { code: ["probe.mjs"], ...inputs }, ...fields });
  const version = await on.api("POST", `${route}/experiments/${experiment.id}/versions`, {});
  return { folder, route, version, experiment, project: made.id };
}

let clients = 0;
const start = (bed, { client = `client-${clients += 1}`, on = saturn, ...fields } = {}) => on.api("POST", `${bed.route}/versions/${bed.version.id}/runs`, { clientId: client, ...fields });

const ended = (bed, id, on = saturn) => until(`run ${id} to end`, () => on.api("GET", `${bed.route}/runs/${id}`), (run) => !["starting", "running", "stopping"].includes(run.status));

const runFolder = (bed, id) => path.join(bed.folder, ".saturn/research/runs", id);

/** Whether a process exists. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a run that writes valid samples and exits 0 completes, sealed with what it wrote", posixOnly, async () => {
  const lines = [`${line("a")}\n`, `${line("b")}\n`];
  const bed = await setup(writes(lines));
  const started = await start(bed);
  assert.equal(started.versionId, bed.version.id);
  const run = await ended(bed, started.id);
  assert.equal(run.status, "completed", JSON.stringify(run));
  assert.equal(run.exitCode, 0);
  assert.equal(run.samples, 2);
  assert.equal(run.samplesSha256, sha(lines.join("")));
  assert.equal(run.samplesSize, lines.join("").length);
  assert.deepEqual(run.inputsChanged, []);
  assert.deepEqual((await saturn.api("GET", `${bed.route}/runs`)).items.map((item) => item.id), [run.id]);
});

test("the process is told where to write, and its output goes to log files", posixOnly, async () => {
  const bed = await setup(`
    import { appendFileSync } from "node:fs";
    console.log("out", process.env.SATURN_RUN_ID, process.env.SATURN_RUN_VERSION, process.env.SATURN_DATA_DIR ?? "no-data-dir");
    console.error("err", Boolean(process.env.SATURN_RUN_TOKEN));
    appendFileSync(process.env.SATURN_RUN_SAMPLES, ${JSON.stringify(`${line("a")}\n`)});
  `);
  const run = await ended(bed, (await start(bed)).id);
  assert.equal(run.status, "completed", JSON.stringify(run));
  assert.equal((await readFile(path.join(runFolder(bed, run.id), "stdout.log"), "utf8")).trim(), `out ${run.id} ${bed.version.id} no-data-dir`);
  assert.equal((await readFile(path.join(runFolder(bed, run.id), "stderr.log"), "utf8")).trim(), "err true");
});

test("a non-zero exit fails, and keeps its samples", posixOnly, async () => {
  const bed = await setup(writes([`${line("a")}\n`], 3));
  const run = await ended(bed, (await start(bed)).id);
  assert.equal(run.status, "failed");
  assert.equal(run.exitCode, 3);
  assert.equal(run.samples, 1);
});

test("exit 0 with no valid output is a protocol error, not a success", posixOnly, async () => {
  const bed = await setup(writes([]));
  const run = await ended(bed, (await start(bed)).id);
  assert.equal(run.status, "protocol_error");
  assert.equal(run.samples, 0);
});

test("a bad line, a repeated identity and a broken field each name their line, and valid lines still count", posixOnly, async () => {
  const bed = await setup(writes([`${line("a")}\n`, "not json\n", `${line("a")}\n`, `${JSON.stringify({ schemaVersion: 1 })}\n`, `${line("b", { error: { kind: "weather" } })}\n`, `${line("c")}\n`]));
  const run = await ended(bed, (await start(bed)).id);
  assert.equal(run.status, "protocol_error");
  assert.equal(run.samples, 2);
  assert.deepEqual(run.problems.map((problem) => problem.line), [2, 3, 4, 5]);
  assert.match(run.problems[1].reason, /already appeared/);
  assert.ok(existsSync(path.join(runFolder(bed, run.id), "samples.jsonl")), "the raw file is kept");
});

test("a last line with no newline is a protocol error once the process has ended", posixOnly, async () => {
  const bed = await setup(writes([`${line("a")}\n`, line("b")]));
  const run = await ended(bed, (await start(bed)).id);
  assert.equal(run.status, "protocol_error");
  assert.equal(run.samples, 1);
  assert.equal(run.partialLine, true);
});

test("the same sample in another trial or on another model is a different sample, in any language", posixOnly, async () => {
  const bed = await setup(writes([`${line("a")}\n`, `${line("a", { trial: 1 })}\n`, `${line("a", { modelId: "model_x" })}\n`, `${line("名字", { output: "瑪麗 🌙" })}\n`]));
  const run = await ended(bed, (await start(bed)).id);
  assert.equal(run.status, "completed", JSON.stringify(run.problems));
  assert.equal(run.samples, 4);
});

test("infrastructure errors are counted apart", posixOnly, async () => {
  const bed = await setup(writes([`${line("a")}\n`, `${line("b", { error: { kind: "infrastructure", message: "GPU gone" }, scores: null })}\n`]));
  const run = await ended(bed, (await start(bed)).id);
  assert.equal(run.status, "completed");
  assert.equal(run.infrastructureErrors, 1);
});

test("a very long line is read", posixOnly, async () => {
  const bed = await setup(writes([`${line("a", { output: "x".repeat(2 * 1024 * 1024) })}\n`]));
  const run = await ended(bed, (await start(bed)).id);
  assert.equal(run.status, "completed");
});

test("a command that does not exist fails and says so in its log", posixOnly, async () => {
  const folder = await saturn.folder();
  const made = await saturn.api("POST", "/projects", { path: folder });
  await saturn.api("POST", `/projects/${made.id}/access`, {});
  const route = `/projects/${made.id}/research`;
  const experiment = await saturn.api("POST", `${route}/experiments`, { title: "E", command: "no-such-program-here" });
  const version = await saturn.api("POST", `${route}/experiments/${experiment.id}/versions`, {});
  const bed = { route, version, folder };
  const run = await ended(bed, (await start(bed)).id);
  assert.equal(run.status, "failed");
  assert.match(await readFile(path.join(runFolder(bed, run.id), "stderr.log"), "utf8"), /no-such-program-here/);
});

test("repeating a start returns the same run and starts nothing, even at the same moment", posixOnly, async () => {
  const bed = await setup(writes([`${line("a")}\n`]));
  const body = { clientId: "once" };
  const answers = await Promise.all([1, 2, 3].map(() => saturn.call("POST", `${bed.route}/versions/${bed.version.id}/runs`, body)));
  assert.equal(new Set(answers.map((answer) => answer.body.id)).size, 1, JSON.stringify(answers.map((answer) => answer.status)));
  assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 200, 201]);
  await ended(bed, answers[0].body.id);
  assert.equal((await saturn.api("GET", `${bed.route}/runs`)).items.length, 1);
  assert.equal((await saturn.call("POST", `${bed.route}/versions/${bed.version.id}/runs`, {})).status, 400);
});

test("a start refuses when the frozen content has changed, and starts nothing", posixOnly, async () => {
  const bed = await setup(writes([`${line("a")}\n`]));
  await writeFile(path.join(bed.folder, "probe.mjs"), writes([`${line("b")}\n`]));
  const refused = await saturn.call("POST", `${bed.route}/versions/${bed.version.id}/runs`, { clientId: "changed" });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /Freeze a new version/);
  assert.equal((await saturn.api("GET", `${bed.route}/runs`)).items.length, 0);
});

test("a run reads its own read-only snapshot: a write to an input is refused and the project is untouched", posixOnly, async () => {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "set.jsonl"), "{}\n");
  const bed = await setup(`
    import { appendFileSync, writeFileSync } from "node:fs";
    writeFileSync("set.jsonl", "{\\"changed\\":true}\\n");
    appendFileSync(process.env.SATURN_RUN_SAMPLES, ${JSON.stringify(`${line("a")}\n`)});
  `, { folder, inputs: { data: ["set.jsonl"] } });
  const run = await ended(bed, (await start(bed)).id);
  assert.equal(run.status, "failed");
  // Refused by the file's permissions, or by the sandbox before them.
  assert.match(await readFile(path.join(runFolder(bed, run.id), "stderr.log"), "utf8"), /EACCES|EPERM|EROFS|permission denied|not permitted|read-only file system/i);
  assert.equal(await readFile(path.join(folder, "set.jsonl"), "utf8"), "{}\n");
});

// Without the sandbox only the files' permissions protect the snapshot; research-sandbox.test.mjs has the sandbox.
test("without the sandbox, an input replaced during the run is recorded as changed, and the project keeps its own copy", posixOnly, async () => {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "set.jsonl"), "{}\n");
  const bed = await setup(`
    import { appendFileSync, rmSync, writeFileSync } from "node:fs";
    rmSync("set.jsonl");
    writeFileSync("set.jsonl", "{\\"changed\\":true}\\n");
    writeFileSync("made.txt", "output");
    appendFileSync(process.env.SATURN_RUN_SAMPLES, ${JSON.stringify(`${line("a")}\n`)});
  `, { folder, inputs: { data: ["set.jsonl"] }, fields: { sandbox: { isolated: false } } });
  const run = await ended(bed, (await start(bed)).id);
  assert.equal(run.status, "completed");
  assert.deepEqual(run.inputsChanged, ["set.jsonl"]);
  assert.equal(await readFile(path.join(folder, "set.jsonl"), "utf8"), "{}\n");
  assert.equal(existsSync(path.join(folder, "made.txt")), false);
  assert.equal(await readFile(path.join(runFolder(bed, run.id), "written", "made.txt"), "utf8"), "output");
  const evidence = JSON.parse(await readFile(path.join(runFolder(bed, run.id), "evidence.json"), "utf8"));
  assert.equal(evidence.verdicts.inputs, "changed");
  assert.deepEqual(evidence.observed.afterRun.changed, ["set.jsonl"]);
});

test("a committed link out of the project is uncontrolled, and its target changing during the run is caught", posixOnly, async () => {
  const folder = await saturn.folder();
  const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), "saturn-outside-")));
  await writeFile(path.join(outside, "set.jsonl"), "{\"v\":1}\n");
  await mkdir(path.join(folder, "data"));
  await symlink(path.join(outside, "set.jsonl"), path.join(folder, "data", "set.jsonl"));
  // The program reads through the link, then waits until the test has changed what it points to. It waits in its own
  // run folder, which it can see on every system, and never longer than 20 seconds, so a failure leaves nothing behind.
  await writeFile(path.join(folder, "probe.mjs"), `
    import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
    const read = readFileSync("data/set.jsonl", "utf8");
    writeFileSync(process.env.SATURN_RUN_DIRECTORY + "/read", "");
    const go = process.env.SATURN_RUN_DIRECTORY + "/go";
    for (const until = Date.now() + 20000; !existsSync(go) && Date.now() < until;) await new Promise((resolve) => setTimeout(resolve, 50));
    appendFileSync(process.env.SATURN_RUN_SAMPLES, ${JSON.stringify(`${line("a")}\n`)});
    console.log(read.trim());
  `);
  commitAll(folder);
  const bed = await setup(null, { folder });
  const started = await start(bed);
  const evidence = await until("the run's evidence", () => saturn.api("GET", `${bed.route}/runs/${started.id}/evidence`), (item) => item.recorded && item.observed?.snapshot);
  const link = evidence.observed.snapshot.uncontrolled.find((item) => item.path === "data/set.jsonl");
  assert.ok(link, `the link is listed as uncontrolled: ${JSON.stringify(evidence.observed.snapshot.uncontrolled)}`);
  assert.equal(link.kind, "linked file");
  assert.equal(link.target, path.join(outside, "set.jsonl"));
  assert.equal(link.sha256, sha("{\"v\":1}\n"));
  assert.equal(evidence.verdicts.inputs, "partial", "not verified: the version never fixed what the link reads");
  const reading = await until("the program to read the link, or the run to end", async () => {
    if (existsSync(path.join(runFolder(bed, started.id), "read"))) return "read";
    const now = await saturn.api("GET", `${bed.route}/runs/${started.id}`);
    return ["starting", "running", "stopping"].includes(now.status) ? null : now;
  });
  assert.equal(reading, "read", `the program could not read through the link: ${JSON.stringify(reading)}\n${await readFile(path.join(runFolder(bed, started.id), "stderr.log"), "utf8").catch(() => "")}`);
  await writeFile(path.join(outside, "set.jsonl"), "{\"v\":2}\n");
  await writeFile(path.join(runFolder(bed, started.id), "go"), "");
  const run = await ended(bed, started.id);
  assert.equal(run.status, "completed", `${JSON.stringify(run)}\n${await readFile(path.join(runFolder(bed, started.id), "stderr.log"), "utf8").catch(() => "")}`);
  assert.equal((await readFile(path.join(runFolder(bed, started.id), "stdout.log"), "utf8")).trim(), "{\"v\":1}", "it read the target as it was at the start");
  assert.deepEqual(run.inputsChanged, ["data/set.jsonl"]);
  const after = await saturn.api("GET", `${bed.route}/runs/${started.id}/evidence`);
  assert.equal(after.verdicts.inputs, "changed");
  await rm(outside, { recursive: true, force: true });
});

test("a run started before the project was edited runs the version it was given", posixOnly, async () => {
  const release = path.join(await saturn.folder(), "release");
  const { home, folder, first } = await restartable({ SATURN_RESEARCH_TEST_HOLD: "before-process", SATURN_RESEARCH_TEST_RELEASE: release });
  try {
    const bed = await setup(writes([`${line("a")}\n`]), { on: first, folder });
    void first.call("POST", `${bed.route}/versions/${bed.version.id}/runs`, { clientId: "held" }).catch(() => {});
    const [held] = await until("the run to be saved", async () => (await first.api("GET", `${bed.route}/runs`)).items, (items) => items.length === 1);
    await until("the evidence", () => existsSync(path.join(runFolder(bed, held.id), "evidence.json")));
    // The project changes after the snapshot was checked: the run must not see it.
    await writeFile(path.join(folder, "probe.mjs"), writes([`${line("edited")}\n`]));
    await writeFile(release, "");
    const run = await ended(bed, held.id, first);
    assert.equal(run.status, "completed", JSON.stringify(run));
    assert.match(await readFile(path.join(runFolder(bed, run.id), "samples.jsonl"), "utf8"), /"sampleId":"a"/);
    const evidence = JSON.parse(await readFile(path.join(runFolder(bed, run.id), "evidence.json"), "utf8"));
    assert.equal(evidence.verdicts.inputs, "verified");
    assert.equal(evidence.verdicts.outputs, "sealed");
    assert.ok(evidence.observed.snapshot.files.some((file) => file.path === "probe.mjs"));
    assert.equal(evidence.reported.seed, null, "a seed the program did not report is unknown");
  } finally {
    await first.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test("what the program reports about itself is kept apart from what was expected", posixOnly, async () => {
  const bed = await setup(`
    import { appendFileSync } from "node:fs";
    appendFileSync(process.env.SATURN_RUN_REPORT, JSON.stringify({ kind: "seed", value: Number(process.env.SATURN_RUN_SEED ?? -1), applied: ["python", "numpy"] }) + "\\n");
    appendFileSync(process.env.SATURN_RUN_REPORT, JSON.stringify({ kind: "model", source: "local", revision: "abc" }) + "\\nnot json\\n");
    appendFileSync(process.env.SATURN_RUN_SAMPLES, ${JSON.stringify(`${line("a")}\n`)});
  `);
  const run = await ended(bed, (await start(bed)).id);
  assert.equal(run.status, "completed", JSON.stringify(run));
  const evidence = JSON.parse(await readFile(path.join(runFolder(bed, run.id), "evidence.json"), "utf8"));
  assert.deepEqual(evidence.reported.seed, { value: -1, applied: ["python", "numpy"] });
  assert.deepEqual(evidence.reported.models, [{ source: "local", revision: "abc" }]);
  assert.equal(evidence.reported.problems.length, 1);
  assert.match(evidence.limits, /does not show that the program used/);
});

test("samples changed after the seal are caught wherever the run is read", posixOnly, async () => {
  const bed = await setup(writes([`${line("a")}\n`, `${line("b")}\n`]));
  const run = await ended(bed, (await start(bed)).id);
  assert.equal(run.sealIntact, true);
  await writeFile(path.join(runFolder(bed, run.id), "samples.jsonl"), `${line("a")}\n${line("b", { scores: { s: 0 } })}\n`);
  assert.equal((await saturn.api("GET", `${bed.route}/runs/${run.id}`)).sealIntact, false);
  const samples = await saturn.api("GET", `${bed.route}/runs/${run.id}/samples`);
  assert.equal(samples.sealIntact, false);
});

test("stopping a run stops it, keeps its samples, and is stopped rather than completed", posixOnly, async () => {
  const bed = await setup(LONG);
  const started = await start(bed);
  await until("samples", () => stat(path.join(runFolder(bed, started.id), "samples.jsonl")).then((info) => info.size > 0, () => false));
  const stopping = await saturn.api("POST", `${bed.route}/runs/${started.id}/stop`, {});
  assert.ok(["stopping", "stopped"].includes(stopping.status), stopping.status);
  const run = await ended(bed, started.id);
  assert.equal(run.status, "stopped");
  assert.ok(run.samples > 0);
  assert.equal(alive(started.pid), false);
});

test("stopping a run that has ended leaves it as it ended", posixOnly, async () => {
  const bed = await setup(writes([`${line("a")}\n`]));
  const run = await ended(bed, (await start(bed)).id);
  const again = await saturn.api("POST", `${bed.route}/runs/${run.id}/stop`, {});
  assert.equal(again.status, "completed");
  assert.deepEqual(again, run);
});

test("a process that ignores the request to stop is ended by force, with what it left behind", posixOnly, async () => {
  const bed = await setup(`
    import { spawn } from "node:child_process";
    import { appendFileSync, writeFileSync } from "node:fs";
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
    writeFileSync(process.env.SATURN_RUN_DIRECTORY + "/child.pid", String(child.pid));
    process.on("SIGTERM", () => {});
    appendFileSync(process.env.SATURN_RUN_SAMPLES, ${JSON.stringify(`${line("a")}\n`)});
    setInterval(() => {}, 1000);
  `);
  const started = await start(bed);
  const childFile = path.join(runFolder(bed, started.id), "child.pid");
  const child = Number(await until("child", () => readFile(childFile, "utf8").catch(() => "")));
  await saturn.api("POST", `${bed.route}/runs/${started.id}/stop`, {});
  const run = await ended(bed, started.id);
  assert.equal(run.status, "stopped");
  await until("the child to end", () => !alive(child));
});

test("what a finished process left running does not outlive the seal", posixOnly, async () => {
  const bed = await setup(`
    import { spawn } from "node:child_process";
    import { appendFileSync, writeFileSync } from "node:fs";
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", detached: false });
    child.unref();
    writeFileSync(process.env.SATURN_RUN_DIRECTORY + "/child.pid", String(child.pid));
    appendFileSync(process.env.SATURN_RUN_SAMPLES, ${JSON.stringify(`${line("a")}\n`)});
    process.exit(0);
  `);
  const run = await ended(bed, (await start(bed)).id);
  assert.equal(run.status, "completed");
  const child = Number(readFileSync(path.join(runFolder(bed, run.id), "child.pid"), "utf8"));
  await until("the child to end", () => !alive(child));
});

test("a run in a chat's worktree holds it until the run ends", posixOnly, async () => {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "probe.mjs"), LONG);
  commitAll(folder);
  const { thread } = await saturn.chat(folder);
  await saturn.api("POST", `/threads/${thread.id}/worktree`, {});
  const projectId = (await saturn.api("GET", "/projects")).find((item) => item.path === folder).id;
  const route = `/projects/${projectId}/research`;
  const experiment = await saturn.api("POST", `${route}/experiments`, { title: "E", command: "node probe.mjs", inputs: { code: ["probe.mjs"] } });
  const version = await saturn.api("POST", `${route}/experiments/${experiment.id}/versions`, { threadId: thread.id });
  const bed = { route, version, folder };
  const started = await start(bed, { threadId: thread.id });
  assert.equal((await saturn.call("DELETE", `/threads/${thread.id}`)).status, 409);
  await saturn.api("POST", `${route}/runs/${started.id}/stop`, {});
  await ended(bed, started.id);
  await until("the run to let go", async () => (await saturn.call("DELETE", `/threads/${thread.id}`)).status < 300);
});

test("a change to a record is announced on the live updates, and is not in the app's own state", async () => {
  const bed = await setup(writes([`${line("a")}\n`]));
  const token = (await readFile(path.join(saturn.runtime.dataDir, "runtime-token"), "utf8")).trim();
  const response = await fetch(`${saturn.runtime.origin}/events`, { headers: { authorization: `Bearer ${token}` } });
  const reader = response.body.getReader();
  await saturn.api("POST", `${bed.route}/questions`, { title: "Announced" });
  let seen = "";
  const deadline = Date.now() + 10_000;
  while (!seen.includes("event: research") && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += Buffer.from(value).toString();
  }
  await reader.cancel();
  assert.match(seen, /event: research/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.doesNotMatch(await readFile(path.join(saturn.runtime.dataDir, "state.json"), "utf8"), /Announced/);
});

/** A runtime whose data and project folder outlive it, with a project made through it. */
async function restartable(env = {}) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "saturn-contract-research-")));
  const dataDir = path.join(home, "data");
  const folder = path.join(home, "project");
  await mkdir(dataDir);
  await mkdir(folder);
  const first = await bench({ env, dataDir, keepData: true });
  return { home, dataDir, folder, first };
}

/** Waits until the app's own data is on disk, so a killed runtime still knows the project. */
const projectSaved = (dataDir, folder) => until("the project to be saved", () => readFile(path.join(dataDir, "state.json"), "utf8").then((text) => text.includes(folder) && text.includes('"access"'), () => false));

test("a runtime killed mid-run: the process is ended, the run is interrupted, and its samples are kept and sealed", posixOnly, async () => {
  const { home, dataDir, folder, first } = await restartable();
  const bed = await setup(LONG, { on: first, folder });
  await projectSaved(dataDir, folder);
  const started = await start(bed, { on: first });
  const samples = path.join(runFolder(bed, started.id), "samples.jsonl");
  await until("samples", () => stat(samples).then((info) => info.size > 0, () => false));
  first.runtime.child.kill("SIGKILL");
  await first.runtime.stop();
  assert.equal(alive(started.pid), true, "the process outlives the killed runtime");

  const second = await bench({ dataDir, keepData: true });
  try {
    const run = await ended(bed, started.id, second);
    assert.equal(run.status, "interrupted");
    assert.equal(run.process, "ended");
    assert.ok(run.samples > 0);
    await until("the process to end", () => !alive(started.pid));
    const { size } = await stat(samples);
    assert.equal(run.samplesSize <= size, true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await stat(samples)).size, size, "nothing writes after the seal");
    const next = await start(bed, { on: second });
    await second.api("POST", `${bed.route}/runs/${next.id}/stop`, {});
    await ended(bed, next.id, second);
  } finally {
    await second.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test("a runtime killed before the process existed: the run is interrupted and no process is claimed", posixOnly, async () => {
  const { home, dataDir, folder, first } = await restartable({ SATURN_RESEARCH_TEST_HOLD: "before-process" });
  const bed = await setup(writes([`${line("a")}\n`]), { on: first, folder });
  await projectSaved(dataDir, folder);
  void first.call("POST", `${bed.route}/versions/${bed.version.id}/runs`, { clientId: "held" }).catch(() => {});
  const [held] = await until("the run to be saved", async () => (await first.api("GET", `${bed.route}/runs`)).items, (items) => items.length === 1);
  assert.equal(held.status, "starting");
  first.runtime.child.kill("SIGKILL");
  await first.runtime.stop();
  const second = await bench({ dataDir, keepData: true });
  try {
    const run = await ended(bed, held.id, second);
    assert.equal(run.status, "interrupted");
    assert.equal(run.process, "none");
  } finally {
    await second.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test("a runtime killed just after the process started still finds it, by what the process recorded", posixOnly, async () => {
  const { home, dataDir, folder, first } = await restartable({ SATURN_RESEARCH_TEST_HOLD: "after-process" });
  const bed = await setup(LONG, { on: first, folder });
  await projectSaved(dataDir, folder);
  void first.call("POST", `${bed.route}/versions/${bed.version.id}/runs`, { clientId: "held" }).catch(() => {});
  const [held] = await until("the run to be saved", async () => (await first.api("GET", `${bed.route}/runs`)).items, (items) => items.length === 1);
  const identity = path.join(runFolder(bed, held.id), "process.identity");
  const pid = Number((await until("the identity", () => readFile(identity, "utf8").catch(() => ""))).split("\n")[0]);
  assert.equal(alive(pid), true);
  first.runtime.child.kill("SIGKILL");
  await first.runtime.stop();
  const second = await bench({ dataDir, keepData: true });
  try {
    const run = await ended(bed, held.id, second);
    assert.equal(run.status, "interrupted");
    assert.equal(run.process, "ended");
    await until("the process to end", () => !alive(pid));
  } finally {
    await second.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test("a process id now used by something else is not ended", posixOnly, async () => {
  const { home, dataDir, folder, first } = await restartable();
  const bed = await setup(LONG, { on: first, folder });
  await projectSaved(dataDir, folder);
  const started = await start(bed, { on: first });
  const directory = runFolder(bed, started.id);
  await until("the identity", () => existsSync(path.join(directory, "process.identity")));
  first.runtime.child.kill("SIGKILL");
  await first.runtime.stop();
  // Another start time on record means this process id no longer belongs to the run.
  const { pid } = started;
  await writeFile(path.join(directory, "process.identity"), `${pid}\nThu Jan  1 00:00:00 1970\n`);
  const second = await bench({ dataDir, keepData: true });
  try {
    const run = await ended(bed, started.id, second);
    assert.equal(run.status, "interrupted");
    assert.equal(run.process, "gone");
    assert.equal(alive(pid), true, "the other process was left alone");
  } finally {
    process.kill(-pid, "SIGKILL");
    await second.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test("a runtime stopped normally ends its runs and records them as interrupted", posixOnly, async () => {
  const { home, dataDir, folder, first } = await restartable();
  const bed = await setup(LONG, { on: first, folder });
  await projectSaved(dataDir, folder);
  const started = await start(bed, { on: first });
  await first.runtime.stop();
  await until("the process to end", () => !alive(started.pid));
  const saved = JSON.parse(await readFile(path.join(runFolder(bed, started.id), "run.json"), "utf8"));
  assert.equal(saved.status, "interrupted");
  assert.equal(saved.process, "ended");
  await rm(home, { recursive: true, force: true });
});
