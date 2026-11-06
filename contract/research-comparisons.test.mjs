// Compare the same inputs, keep missing/error counts, and save the whole regression set rather than one visible page.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench, until } from "./files-support.mjs";

let saturn;
before(async () => { saturn = await bench(); });
after(async () => { await saturn?.stop(); });
const evaluation = { dataset: "d", split: "test", sampleSet: "held-out", scorer: "accuracy-v1", promptFormat: "plain", chatTemplate: null, generation: {} };

/** Two old result files with stable identities, including repeats of a prompt. */
async function pair(left, right, spec = evaluation) {
  const folder = await saturn.folder();
  const project = await saturn.api("POST", "/projects", { path: folder, grant: true });
  const route = `/projects/${project.id}/research`;
  const runs = [];
  for (const [index, rows] of [left, right].entries()) {
    await writeFile(path.join(folder, `${index}.jsonl`), rows.map((row) => JSON.stringify({ input: row.sampleId, scores: { s: 0 }, ...row })).join("\n") + "\n");
    runs.push((await saturn.api("POST", `${route}/imports`, { path: `${index}.jsonl`, ...(spec ? { evaluation: spec } : {}) })).run);
  }
  return { route, request: { left: { runId: runs[0].id }, right: { runId: runs[1].id }, scorer: "s" } };
}

test("paired deltas report improvements, regressions, missing/error/input mismatches and slices", async () => {
  const { route, request } = await pair(
    [{ sampleId: "a", scores: { s: 0 }, category: "names" }, { sampleId: "b", scores: { s: 1 }, category: "math" }, { sampleId: "c" }, { sampleId: "d" }, { sampleId: "e", input: "one" }],
    [{ sampleId: "a", scores: { s: 1 } }, { sampleId: "b", scores: { s: 0 } }, { sampleId: "d", error: { kind: "scorer", message: "failed" } }, { sampleId: "e", input: "different" }, { sampleId: "f" }],
  );
  const compared = await saturn.api("POST", `${route}/comparisons`, request);
  assert.equal(compared.summary.paired, 2);
  assert.equal(compared.summary.improved, 1);
  assert.equal(compared.summary.regressed, 1);
  assert.equal(compared.summary.meanDelta, 0);
  assert.equal(compared.summary.missingLeft, 1);
  assert.equal(compared.summary.missingRight, 1);
  assert.equal(compared.summary.excluded, 2);
  assert.equal(compared.slices.find((slice) => slice.name === "names").meanDelta, 1);
  assert.equal(compared.items.find((row) => row.sampleId === "e").reason, "input_mismatch");
  const lower = await saturn.api("POST", `${route}/comparisons`, { ...request, higherIsBetter: false });
  assert.equal(lower.items.find((row) => row.sampleId === "a").change, "regressed");
});

test("slices read preserved metadata, explicit nested fields, and prefer a declared top-level category", async () => {
  const { route, request } = await pair([
    { sampleId: "a", metadata: { category: "names", group: { language: "zh" } } },
    { sampleId: "b", category: "declared", metadata: { category: "other", group: { language: "en" } } },
  ], [{ sampleId: "a" }, { sampleId: "b" }]);
  const implicit = await saturn.api("POST", `${route}/comparisons`, request);
  assert.deepEqual(implicit.items.map((item) => item.slice), ["names", "declared"]);
  const explicit = await saturn.api("POST", `${route}/comparisons`, { ...request, sliceField: "metadata.group.language" });
  assert.deepEqual(explicit.items.map((item) => item.slice), ["zh", "en"]);
});

/** The same rows as two runs Saturn itself made, from one frozen evaluation, so that they are comparable. */
async function ranPair(left, right, spec = evaluation) {
  const folder = await saturn.folder();
  const project = await saturn.api("POST", "/projects", { path: folder, grant: true });
  const route = `/projects/${project.id}/research`;
  const runs = [];
  for (const [index, rows] of [left, right].entries()) {
    const lines = rows.map((row) => JSON.stringify({ schemaVersion: 1, input: row.sampleId, output: "o", scores: { s: 0 }, ...row }) + "\n");
    await writeFile(path.join(folder, `run${index}.mjs`), `import { appendFileSync } from "node:fs";\nfor (const line of ${JSON.stringify(lines)}) appendFileSync(process.env.SATURN_RUN_SAMPLES, line);\n`);
    const experiment = await saturn.api("POST", `${route}/experiments`, { title: `E${index}`, command: `node run${index}.mjs`, evaluation: spec });
    const version = await saturn.api("POST", `${route}/experiments/${experiment.id}/versions`, {});
    const started = await saturn.api("POST", `${route}/versions/${version.id}/runs`, { clientId: `c${index}` });
    runs.push(await until("the run to end", () => saturn.api("GET", `${route}/runs/${started.id}`), (item) => !["starting", "running", "stopping"].includes(item.status)));
  }
  return { route, request: { left: { runId: runs[0].id }, right: { runId: runs[1].id }, scorer: "s" } };
}

test("uncertainty uses independent sample IDs, not repeated trials, and unknown methods get no interval", async () => {
  const left = [{ sampleId: "a", trial: 0 }, { sampleId: "a", trial: 1 }, { sampleId: "b" }];
  const right = left.map((row) => ({ ...row, scores: { s: 1 } }));
  const known = await ranPair(left, right);
  const result = await saturn.api("POST", `${known.route}/comparisons`, known.request);
  assert.equal(result.comparison.result, "comparable");
  assert.equal(result.summary.independentSamples, 2);
  assert.deepEqual(result.summary.interval95, [1, 1]);
  assert.match(result.note, /training seeds/);
  const unknown = await pair(left, right, null);
  const unknownResult = await saturn.api("POST", `${unknown.route}/comparisons`, unknown.request);
  assert.equal(unknownResult.comparison.result, "unknown");
  assert.equal(unknownResult.summary.interval95, null);
});

test("imported results describing the same evaluation are not enough for an interval", async () => {
  const left = [{ sampleId: "a" }, { sampleId: "b" }];
  const imported = await pair(left, left.map((row) => ({ ...row, scores: { s: 1 } })));
  const result = await saturn.api("POST", `${imported.route}/comparisons`, imported.request);
  assert.equal(result.comparison.result, "unknown");
  assert.ok(result.comparison.missing.some((reason) => /imported result only describes/.test(reason)));
  assert.equal(result.summary.interval95, null);
  assert.equal(result.summary.meanDelta, 1, "the difference is still shown, as a description");
});

test("saved counterexample sets include every regression and retain their source request", async () => {
  const left = Array.from({ length: 205 }, (_, index) => ({ sampleId: `s-${index}`, scores: { s: 1 } }));
  const right = left.map((row) => ({ ...row, scores: { s: 0 } }));
  const { route, request } = await pair(left, right);
  const result = await saturn.api("POST", `${route}/comparisons`, { ...request, only: "regressed", save: true, title: "Regressions" });
  assert.equal(result.items.length, 200);
  assert.equal(result.next, 200);
  assert.equal(result.saved.members.length, 205);
  const stored = await saturn.api("GET", `${route}/counterexample_sets/${result.saved.id}`);
  assert.deepEqual(stored.request.left, request.left);
  assert.equal(stored.members.at(-1).change, "regressed");
});

test("generated row IDs are not treated as matched inputs, and multiple models require a selection", async () => {
  const { route, request } = await pair([{ sampleId: "a", identityGenerated: true }], [{ sampleId: "a" }]);
  assert.equal((await saturn.api("POST", `${route}/comparisons`, request)).summary.paired, 0);
  const multi = await pair([{ sampleId: "a", modelId: "m1" }, { sampleId: "a", modelId: "m2" }], [{ sampleId: "a" }]);
  assert.equal((await saturn.call("POST", `${multi.route}/comparisons`, multi.request)).status, 400);
});

test("a run whose inputs changed while it ran is not compared as if it measured its version", async () => {
  const folder = await saturn.folder();
  const project = await saturn.api("POST", "/projects", { path: folder, grant: true });
  const route = `/projects/${project.id}/research`;
  await mkdir(path.join(folder, "data"));
  await writeFile(path.join(folder, "data", "set.jsonl"), "{}\n");
  const rows = [{ sampleId: "a" }, { sampleId: "b" }];
  const runs = [];
  for (const [index, replaces] of [false, true].entries()) {
    const lines = rows.map((row) => JSON.stringify({ schemaVersion: 1, input: row.sampleId, output: "o", scores: { s: index }, ...row }) + "\n");
    // Without the sandbox only permissions protect the snapshot: the program can replace a file it was given.
    const swap = replaces ? 'rmSync("data/set.jsonl"); writeFileSync("data/set.jsonl", "{\\"changed\\":true}\\n");' : "";
    await writeFile(path.join(folder, `run${index}.mjs`), `import { appendFileSync, rmSync, writeFileSync } from "node:fs";\n${swap}\nfor (const line of ${JSON.stringify(lines)}) appendFileSync(process.env.SATURN_RUN_SAMPLES, line);\n`);
    const experiment = await saturn.api("POST", `${route}/experiments`, { title: `E${index}`, command: `node run${index}.mjs`, evaluation, inputs: { code: [`run${index}.mjs`], data: ["data/set.jsonl"] }, sandbox: { isolated: false } });
    const version = await saturn.api("POST", `${route}/experiments/${experiment.id}/versions`, {});
    const started = await saturn.api("POST", `${route}/versions/${version.id}/runs`, { clientId: `changed-${index}` });
    runs.push(await until("the run to end", () => saturn.api("GET", `${route}/runs/${started.id}`), (item) => !["starting", "running", "stopping"].includes(item.status)));
  }
  assert.deepEqual(runs[1].inputsChanged, ["data/set.jsonl"], JSON.stringify(runs[1]));
  const result = await saturn.api("POST", `${route}/comparisons`, { left: { runId: runs[0].id }, right: { runId: runs[1].id }, scorer: "s" });
  assert.equal(result.comparison.result, "not_comparable");
  assert.ok(result.comparison.differs.some((reason) => /changed during the run \(data\/set\.jsonl\)/.test(reason)), JSON.stringify(result.comparison));
  assert.equal(result.summary.interval95, null, "no interval rests on a run that read other inputs");
  const across = await saturn.api("GET", `${route}/samples/a?runs=${runs[0].id},${runs[1].id}`);
  assert.equal(across.rows[1].comparison.result, "not_comparable", "nor beside it when one sample is read across runs");
});
