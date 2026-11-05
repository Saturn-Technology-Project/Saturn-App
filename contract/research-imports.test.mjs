// Old results enter without changing their source or inventing an evaluation. No Python or model is needed.
import assert from "node:assert/strict";
import { readFile, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench, sha } from "./files-support.mjs";

let saturn;
before(async () => { saturn = await bench(); });
after(async () => { await saturn?.stop(); });

/** A project holding old results, with no Saturn experiment yet. */
async function setup(name, content) {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, name), content);
  const project = await saturn.api("POST", "/projects", { path: folder, grant: true });
  return { folder, route: `/projects/${project.id}/research` };
}

test("preview and import preserve old JSONL, its identities and unknown provenance, without a hypothesis", async () => {
  const content = '{"id":"a","prompt":"in","answer":"out","accuracy":0.5,"category":"names"}\n';
  const { folder, route } = await setup("old.jsonl", content);
  const request = { path: "old.jsonl", columns: { sampleId: "id", input: "prompt", output: "answer" }, scoreColumns: ["accuracy"] };
  const preview = await saturn.api("POST", `${route}/imports/preview`, request);
  assert.equal(preview.samples, 1);
  assert.equal(preview.provenance.sha256, sha(content));
  assert.deepEqual((await saturn.api("GET", `${route}/experiments`)).items, []);
  const imported = await saturn.api("POST", `${route}/imports`, { ...request, expectedSha256: preview.provenance.sha256 });
  assert.equal(imported.run.status, "completed");
  assert.equal(imported.version.imported, true);
  assert.equal(imported.version.evaluation, null);
  assert.equal(imported.experiment.hypothesisId, undefined);
  assert.deepEqual((await saturn.api("GET", `${route}/hypotheses`)).items, []);
  const page = await saturn.api("GET", `${route}/runs/${imported.run.id}/samples`);
  assert.equal(page.items[0].sample.sampleId, "a");
  assert.equal(page.items[0].sample.category, "names");
  assert.deepEqual(page.items[0].sample.scores, { accuracy: 0.5 });
  assert.equal(await readFile(path.join(folder, "old.jsonl"), "utf8"), content);
  assert.equal((await saturn.call("POST", `${route}/versions/${imported.version.id}/runs`, { clientId: "do-not-run-imports" })).status, 409);
  assert.equal((await saturn.api("GET", `${route}/compare?left=${imported.version.id}&right=${imported.version.id}`)).result, "unknown");
});

test("CSV quoting and numeric score columns are imported without losing original metadata", async () => {
  const { route } = await setup("old.csv", 'id,prompt,answer,accuracy,category\na,"two\nlines","a, b",1,math\nb,short,no,0,names\n');
  const imported = await saturn.api("POST", `${route}/imports`, { path: "old.csv", columns: { sampleId: "id", input: "prompt", output: "answer" }, scoreColumns: ["accuracy"] });
  const { items } = await saturn.api("GET", `${route}/runs/${imported.run.id}/samples`);
  assert.equal(items.length, 2);
  assert.equal(items[0].sample.input, "two\nlines");
  assert.equal(items[0].sample.output, "a, b");
  assert.equal(items[1].sample.scores.accuracy, 0);
});

test("Trainer log_history becomes metrics, without pretending training steps are evaluation samples", async () => {
  const { route } = await setup("trainer_state.json", JSON.stringify({ global_step: 20, log_history: [{ step: 10, loss: 2.5, epoch: 0.1 }, { step: 20, eval_loss: 2.0, total_flos: 200 }] }));
  const imported = await saturn.api("POST", `${route}/imports`, { path: "trainer_state.json", format: "trainer" });
  assert.equal(imported.run.kind, "training");
  assert.equal(imported.run.samples, 0);
  const metrics = await saturn.api("GET", `${route}/runs/${imported.run.id}/metrics`);
  assert.equal(metrics.items.length, 2);
  assert.deepEqual(metrics.items[0].values, { loss: 2.5, epoch: 0.1 });
  assert.deepEqual((await saturn.api("GET", `${route}/runs/${imported.run.id}/samples`)).items, []);
});

test("invalid, duplicate, changed and escaped inputs fail before writing records", async () => {
  const { folder, route } = await setup("bad.jsonl", '{"sampleId":"a"}\n{"sampleId":"a"}\n');
  assert.equal((await saturn.call("POST", `${route}/imports`, { path: "bad.jsonl" })).status, 422);
  await writeFile(path.join(folder, "bad.csv"), "id,score\na,no-number\n");
  assert.equal((await saturn.call("POST", `${route}/imports`, { path: "bad.csv", scoreColumns: ["score"] })).status, 422);
  await writeFile(path.join(folder, "valid.jsonl"), '{"sampleId":"a"}\n');
  assert.equal((await saturn.call("POST", `${route}/imports`, { path: "valid.jsonl", expectedSha256: "outdated" })).status, 409);
  assert.equal((await saturn.call("POST", `${route}/imports`, { path: "../outside.jsonl" })).status, 403);
  if (process.platform !== "win32") {
    const outside = await saturn.folder();
    await writeFile(path.join(outside, "outside.jsonl"), '{"sampleId":"b"}\n');
    await symlink(path.join(outside, "outside.jsonl"), path.join(folder, "linked.jsonl"));
    assert.equal((await saturn.call("POST", `${route}/imports`, { path: "linked.jsonl" })).status, 403);
  }
  assert.deepEqual((await saturn.api("GET", `${route}/experiments`)).items, []);
});
