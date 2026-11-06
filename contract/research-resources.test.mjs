// What a run costs while it lives, and the Python a project's experiments run in. docs/research-contract.md is the
// contract.
import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench, posixOnly, until } from "./files-support.mjs";

let saturn;
before(async () => { saturn = await bench(); });
after(async () => { await saturn?.stop(); });

const evaluation = { dataset: "ioi", split: "all", sampleSet: "all", scorer: "s", promptFormat: "continuation", chatTemplate: null, generation: {} };
const settled = (item) => !["starting", "running", "stopping"].includes(item.status);

/** A project the runtime may write to. */
async function project() {
  const folder = await saturn.folder();
  const made = await saturn.api("POST", "/projects", { path: folder });
  await saturn.api("POST", `/projects/${made.id}/access`, {});
  return { folder, route: `/projects/${made.id}/research` };
}

test("a run's processor share, memory and sample count are sampled while it lives and kept with it", posixOnly, async () => {
  const { folder, route } = await project();
  await writeFile(path.join(folder, "probe.mjs"), `
import { appendFileSync } from "node:fs";
for (let index = 0; index < 3; index += 1) {
  appendFileSync(process.env.SATURN_RUN_SAMPLES, JSON.stringify({ schemaVersion: 1, sampleId: "s" + index, input: "i", output: "o", usage: { inputTokens: 10, outputTokens: 5 + index, deviceMemoryBytes: 1000 * (index + 1) } }) + "\\n");
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
`);
  const experiment = await saturn.api("POST", `${route}/experiments`, { title: "E", command: "node probe.mjs", evaluation });
  const version = await saturn.api("POST", `${route}/experiments/${experiment.id}/versions`, {});
  const started = await saturn.api("POST", `${route}/versions/${version.id}/runs`, { clientId: "c1" });
  const live = await until("a first point", () => saturn.api("GET", `${route}/runs/${started.id}/resources`), (read) => read.points.length > 0);
  assert.equal(live.runId, started.id);
  assert.ok(live.system.cpus > 0);
  const run = await until("the run to end", () => saturn.api("GET", `${route}/runs/${started.id}`), settled);
  assert.equal(run.status, "completed");
  const read = await saturn.api("GET", `${route}/runs/${started.id}/resources`);
  assert.ok(read.points.length >= 2, `${read.points.length} points`);
  const last = read.points.at(-1);
  assert.equal(typeof last.cpuPercent, "number");
  assert.ok(last.memoryBytes > 0);
  assert.ok(last.processes >= 1);
  assert.ok(last.elapsedMs >= 1000);
  assert.ok(last.samplesLines >= 1 && last.samplesLines <= 3);
  assert.equal(last.samplesRewrites, 0);
  assert.equal(last.inputTokens, 10 * last.samplesLines);
  assert.equal(last.outputTokens, [5, 11, 18][last.samplesLines - 1]);
  assert.equal(last.deviceMemoryBytes, 1000 * last.samplesLines);
  const summary = await saturn.api("GET", `${route}/runs/${started.id}/summary`);
  assert.deepEqual(summary.models[0].tokens, { input: 30, output: 18, samplesReporting: 3 });
  assert.equal(summary.models[0].deviceMemoryPeakBytes, 3000);
  assert.ok(read.points.every((point, index) => index === 0 || point.elapsedMs >= read.points[index - 1].elapsedMs));
  const file = await readFile(path.join(folder, ".saturn/research/runs", started.id, "resources.jsonl"), "utf8");
  assert.equal(file.trim().split("\n").length, read.points.length);
  assert.equal((await saturn.call("GET", `${route}/runs/run_0000000000000000/resources`)).status, 404);
});

test("a samples rewrite restarts the persisted counts instead of adding to an obsolete prefix", posixOnly, async () => {
  const { folder, route } = await project();
  await writeFile(path.join(folder, "probe.mjs"), `
    import { writeFileSync } from "node:fs";
    const line = (sampleId, inputTokens) => JSON.stringify({schemaVersion:1,sampleId,usage:{inputTokens}})+"\\n";
    writeFileSync(process.env.SATURN_RUN_SAMPLES, [0,1,2].map(n => line("old"+n,10)).join(""));
    await new Promise(resolve => setTimeout(resolve,2500));
    writeFileSync(process.env.SATURN_RUN_SAMPLES,line("new",90));
    await new Promise(resolve => setTimeout(resolve,2500));
  `);
  const experiment = await saturn.api("POST", `${route}/experiments`, {title:"Rewrite",command:"node probe.mjs",evaluation});
  const version = await saturn.api("POST", `${route}/experiments/${experiment.id}/versions`, {});
  const run = await saturn.api("POST", `${route}/versions/${version.id}/runs`, {clientId:"rewrite"});
  const readings = await until("the rewrite to be sampled", () => saturn.api("GET", `${route}/runs/${run.id}/resources`), read => read.points.some(point => point.samplesRewrites > 0));
  const last = readings.points.at(-1);
  assert.equal(last.samplesRewrites, 1);
  assert.equal(last.samplesLines, 1);
  assert.equal(last.inputTokens, 90);
  await until("the rewritten run to finish", () => saturn.api("GET", `${route}/runs/${run.id}`), settled);
});

test("the environment names a python, lists the lock files with their hashes, and keeps what the python reports", posixOnly, async () => {
  const { folder, route } = await project();
  await writeFile(path.join(folder, "uv.lock"), "version = 1\n");
  await writeFile(path.join(folder, "python"), `#!/bin/sh
cat > /dev/null
printf '%s' '{"executable":"/env/bin/python","version":"3.12.1","platform":"stand-in","cpus":4,"packages":{"torch":"2.5.0","transformers":null},"devices":{"torch":"2.5.0","cuda":false,"cudaDevices":[],"mps":true}}'
`);
  await chmod(path.join(folder, "python"), 0o755);

  const empty = await saturn.api("GET", `${route}/environment`);
  assert.equal(empty.python, null);
  assert.equal(empty.report, null);
  assert.deepEqual(empty.lockFiles.map((item) => item.path), ["uv.lock"]);
  assert.match(empty.lockFiles[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(empty.lockFiles[0].size, 12);
  assert.equal(empty.suggestedPython, null);

  const nothing = await saturn.call("POST", `${route}/environment/check`);
  assert.equal(nothing.status, 422);
  assert.match(nothing.body.error, /No Python is set/);

  await saturn.api("POST", `${route}/experiments`, { title: "E", command: "./python probe.py", evaluation });
  const suggested = await saturn.api("GET", `${route}/environment`);
  assert.equal(suggested.suggestedPython, "./python");

  const set = await saturn.api("PUT", `${route}/environment`, { python: "./python" });
  assert.equal(set.python, "./python");
  assert.equal(set.revision, 1);
  const checked = await saturn.api("POST", `${route}/environment/check`);
  assert.equal(checked.report.version, "3.12.1");
  assert.equal(checked.report.packages.torch, "2.5.0");
  assert.equal(checked.report.devices.mps, true);
  assert.equal(checked.checkedWith, "./python");
  assert.ok(checked.checkedAt);
  const again = await saturn.api("GET", `${route}/environment`);
  assert.deepEqual(again.report, checked.report);
  const file = JSON.parse(await readFile(path.join(folder, ".saturn/research/environment.json"), "utf8"));
  assert.equal(file.python, "./python");
  assert.equal(file.lockFiles, undefined);

  await saturn.api("PUT", `${route}/environment`, { python: "./no-such-python" });
  const missing = await saturn.call("POST", `${route}/environment/check`);
  assert.equal(missing.status, 422);
  assert.match(missing.body.error, /could not start/);
});
