// Looking inside a model on one sample: the runtime runs its helper with the experiment's own Python, saves the answer
// with the run, and refuses when it cannot. A stand-in "python" plays the environment. docs/research-contract.md is
// the contract.
import assert from "node:assert/strict";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench, posixOnly, sha, until } from "./files-support.mjs";

let saturn;
before(async () => { saturn = await bench(); });
after(async () => { await saturn?.stop(); });

const evaluation = { dataset: "ioi", split: "all", sampleSet: "all", scorer: "name-logit", promptFormat: "continuation", chatTemplate: null, generation: {} };

/**
 * A "python" that, run as an experiment, writes two samples, and run with the helper on its standard input, answers
 * with the request it was given and the helper's first line, and logs the request to a file.
 */
const PYTHON = `#!/bin/sh
if [ "$1" = "-" ]; then
  helper=$(head -n 1)
  printf '%s\\n' "$2" > asked.json
  node -e '
    const request = JSON.parse(process.argv[1]);
    if (request.input === "boom") { console.error("a traceback"); process.exit(3); }
    if (request.sweep) {
      const layers = request.sweep.layers ?? [0, 1];
      process.stdout.write(JSON.stringify({ sourceModelId: request.sweep.modelId, targetModelId: request.modelId, layers, samples: request.sweep.samples.map((item) => ({
        sampleId: item.sampleId, expected: item.expected, top: "x", expectedLogProb: -3,
        byLayer: layers.map((layer) => ({ layer, top: layer === 1 ? item.expected : "x", expectedLogProb: layer === 1 ? -0.5 : -3 })) })) }));
      process.exit(0);
    }
    const layers = [0, 1].map((layer) => ({ layer, values: request.input.split(" ").map((_, index) => layer + index / 10) }));
    const answer = { sampleId: request.sampleId, modelId: request.modelId, measure: "stand-in", tokens: request.input.split(" "), layers, top: "x",
      patched: request.patch ? { layer: request.patch.layer, sourceModelId: request.patch.modelId, layers, top: "y" } : null, helper: process.argv[2] };
    process.stdout.write(JSON.stringify(answer));
  ' "$2" "$helper"
else
  node "$@"
fi
`;
const PROBE = `
import { appendFileSync } from "node:fs";
const line = (sampleId, modelId, input, expected) => JSON.stringify({ schemaVersion: 1, sampleId, modelId, input, expected, output: "o", scores: { s: 1 } }) + "\\n";
appendFileSync(process.env.SATURN_RUN_SAMPLES, line("a", process.argv[2], "When Mary and John went", " Mary"));
appendFileSync(process.env.SATURN_RUN_SAMPLES, line("b", process.argv[3], "boom", null));
`;

/** A project with two models bound to an experiment, run once with the stand-in python. */
async function project() {
  const folder = await saturn.folder();
  const made = await saturn.api("POST", "/projects", { path: folder });
  await saturn.api("POST", `/projects/${made.id}/access`, {});
  const route = `/projects/${made.id}/research`;
  await writeFile(path.join(folder, "python"), PYTHON);
  await chmod(path.join(folder, "python"), 0o755);
  await writeFile(path.join(folder, "probe.mjs"), PROBE);
  const base = await saturn.api("POST", `${route}/models`, { source: "org/base", weightsRevision: "step1" });
  const tuned = await saturn.api("POST", `${route}/models`, { source: "org/tuned", weightsRevision: "v1", parentId: base.id });
  const experiment = await saturn.api("POST", `${route}/experiments`, {
    title: "E",
    command: `./python probe.mjs ${base.id} ${tuned.id}`,
    evaluation,
    models: [{ modelId: base.id, role: "base" }, { modelId: tuned.id, role: "policy" }],
  });
  const version = await saturn.api("POST", `${route}/experiments/${experiment.id}/versions`, {});
  const started = await saturn.api("POST", `${route}/versions/${version.id}/runs`, { clientId: "c1" });
  const run = await until("the run to end", () => saturn.api("GET", `${route}/runs/${started.id}`), (item) => !["starting", "running", "stopping"].includes(item.status));
  assert.equal(run.status, "completed");
  return { folder, route, run, base, tuned };
}

test("activations are read by the experiment's own python, saved with the run, and given again without running", posixOnly, async () => {
  const { folder, route, run, base } = await project();
  const first = await saturn.api("POST", `${route}/runs/${run.id}/activations`, { sampleId: "a" });
  assert.equal(first.modelId, base.id);
  assert.deepEqual(first.tokens, ["When", "Mary", "and", "John", "went"]);
  assert.equal(first.layers.length, 2);
  assert.equal(first.patched, null);
  assert.match(first.helper, /^"""Looks inside a model/);
  const asked = JSON.parse(await readFile(path.join(folder, "asked.json"), "utf8"));
  assert.deepEqual(asked.target, { source: "org/base", revision: "step1" });
  assert.equal(asked.expected, " Mary");
  const saved = await readdir(path.join(folder, ".saturn/research/runs", run.id, "inside"));
  assert.equal(saved.length, 1);
  const again = await saturn.api("GET", `${route}/runs/${run.id}/activations?sample=a`);
  assert.equal(again.recordedAt, first.recordedAt);
  const repeated = await saturn.api("POST", `${route}/runs/${run.id}/activations`, { sampleId: "a" });
  assert.equal(repeated.recordedAt, first.recordedAt);
  assert.equal((await saturn.call("GET", `${route}/runs/${run.id}/activations?sample=zzz`)).status, 404);
});

test("a changed helper computes a new reading and leaves an earlier helper's result intact", posixOnly, async () => {
  const { folder, route, run, base } = await project();
  const directory = path.join(folder, ".saturn/research/runs", run.id, "inside");
  await mkdir(directory, { recursive: true });
  // The old cache key did not include the helper. Keep that result in the history, but do not reuse it.
  const key = sha(JSON.stringify({ layer: null, modelId: null, sampleId: "a", sourceModelId: null }));
  const legacy = path.join(directory, `${key.slice(0, 16)}.json`);
  const original = JSON.stringify({ schemaVersion: 1, sampleId: "a", modelId: base.id, legacy: true });
  await writeFile(legacy, original);
  const current = await saturn.api("POST", `${route}/runs/${run.id}/activations`, { sampleId: "a" });
  const helper = await readFile(new URL("../crates/saturn-core/src/research/inside.py", import.meta.url));
  assert.equal(current.helperSha256, sha(helper));
  assert.equal(current.legacy, undefined);
  assert.equal(await readFile(legacy, "utf8"), original);
  assert.equal((await readdir(directory)).length, 2);
});

test("an intervention patches a layer from one bound model into another, and the helper's failure is reported", posixOnly, async () => {
  const { route, run, base, tuned } = await project();
  const patched = await saturn.api("POST", `${route}/interventions`, { runId: run.id, sampleId: "a", sourceModelId: tuned.id, targetModelId: base.id, layer: 1 });
  assert.equal(patched.patched.layer, 1);
  assert.equal(patched.patched.sourceModelId, tuned.id);
  assert.equal(patched.patched.top, "y");
  const unbound = await saturn.call("POST", `${route}/interventions`, { runId: run.id, sampleId: "a", sourceModelId: "model_0000000000000000", layer: 1 });
  assert.equal(unbound.status, 422);
  const failed = await saturn.call("POST", `${route}/runs/${run.id}/activations`, { sampleId: "b" });
  assert.equal(failed.status, 422);
  assert.match(failed.body.error, /a traceback/);
  const missing = await saturn.call("POST", `${route}/interventions`, { runId: run.id, sampleId: "a", sourceModelId: tuned.id });
  assert.equal(missing.status, 400);
});

test("a sweep patches every layer on several samples in one helper process, and is saved with the run", posixOnly, async () => {
  const { folder, route, run, base, tuned } = await project();
  const swept = await saturn.api("POST", `${route}/interventions/sweep`, { runId: run.id, sampleIds: ["a"], sourceModelId: tuned.id, targetModelId: base.id, layers: [0, 1, 2] });
  assert.deepEqual(swept.layers, [0, 1, 2]);
  assert.equal(swept.samples.length, 1);
  assert.deepEqual(swept.samples[0].byLayer.map((item) => item.top), ["x", " Mary", "x"]);
  const asked = JSON.parse(await readFile(path.join(folder, "asked.json"), "utf8"));
  assert.deepEqual(asked.sweep.source, { source: "org/tuned", revision: "v1" });
  assert.deepEqual(asked.sweep.samples.map((item) => item.expected), [" Mary"]);
  const again = await saturn.api("POST", `${route}/interventions/sweep`, { runId: run.id, sampleIds: ["a"], sourceModelId: tuned.id, targetModelId: base.id, layers: [0, 1, 2] });
  assert.equal(again.recordedAt, swept.recordedAt);
  const saved = await readdir(path.join(folder, ".saturn/research/runs", run.id, "inside"));
  assert.equal(saved.filter((name) => name.startsWith("sweep-")).length, 1);
  await saturn.api("POST", `${route}/runs/${run.id}/activations`, { sampleId: "a" });
  const listed = await saturn.api("GET", `${route}/runs/${run.id}/inside`);
  assert.deepEqual(listed.items.map((item) => item.kind).sort(), ["reading", "sweep"]);
  assert.equal(listed.items.find((item) => item.kind === "sweep").samples[0].sampleId, "a");
  assert.deepEqual((await saturn.api("GET", `${route}/runs/run_0000000000000000/inside`)).items, []);
  assert.equal((await saturn.call("POST", `${route}/interventions/sweep`, { runId: run.id, sampleIds: [], sourceModelId: tuned.id, targetModelId: base.id })).status, 400);
  assert.equal((await saturn.call("POST", `${route}/interventions/sweep`, { runId: run.id, sampleIds: ["zzz"], sourceModelId: tuned.id, targetModelId: base.id })).status, 404);
});

test("a command that does not start with a python is refused with what to do", posixOnly, async () => {
  const folder = await saturn.folder();
  const made = await saturn.api("POST", "/projects", { path: folder });
  await saturn.api("POST", `/projects/${made.id}/access`, {});
  const route = `/projects/${made.id}/research`;
  await writeFile(path.join(folder, "probe.mjs"), `import { appendFileSync } from "node:fs"; appendFileSync(process.env.SATURN_RUN_SAMPLES, '{"schemaVersion":1,"sampleId":"a","input":"i","output":"o"}\\n');`);
  const experiment = await saturn.api("POST", `${route}/experiments`, { title: "E", command: "node probe.mjs", evaluation });
  const version = await saturn.api("POST", `${route}/experiments/${experiment.id}/versions`, {});
  const started = await saturn.api("POST", `${route}/versions/${version.id}/runs`, { clientId: "c1" });
  await until("the run to end", () => saturn.api("GET", `${route}/runs/${started.id}`), (item) => !["starting", "running", "stopping"].includes(item.status));
  const refused = await saturn.call("POST", `${route}/runs/${started.id}/activations`, { sampleId: "a" });
  assert.equal(refused.status, 422);
  assert.match(refused.body.error, /Python/);
});
