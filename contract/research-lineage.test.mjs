// A model's lineage, and whether two versions can be compared: by how they were evaluated, never by how the models were
// trained. docs/research-contract.md is the contract.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench } from "./files-support.mjs";

let saturn;
let route;
let folder;
before(async () => {
  saturn = await bench();
  folder = await saturn.folder();
  await writeFile(path.join(folder, "set.jsonl"), "{}\n");
  await writeFile(path.join(folder, "score.py"), "s\n");
  const made = await saturn.api("POST", "/projects", { path: folder });
  await saturn.api("POST", `/projects/${made.id}/access`, {});
  route = `/projects/${made.id}/research`;
});
after(async () => { await saturn?.stop(); });

const evaluation = { dataset: "ioi-set", split: "test", sampleSet: "all", scorer: "name-logit", promptFormat: "continuation", chatTemplate: null, generation: {} };

/** A version of a new experiment on one model, with this evaluation. */
async function version(model, spec = evaluation, inputs = { data: ["set.jsonl"], scorer: ["score.py"] }) {
  const experiment = await saturn.api("POST", `${route}/experiments`, { title: "E", command: "run", evaluation: spec, inputs, models: [{ modelId: model.id, role: "base" }] });
  return saturn.api("POST", `${route}/experiments/${experiment.id}/versions`, {});
}

const compare = (left, right) => saturn.api("GET", `${route}/compare?left=${left.id}&right=${right.id}`);

test("a lineage is parents: a branch needs a parent that exists and cannot lead back to itself", async () => {
  const base = await saturn.api("POST", `${route}/models`, { source: "EleutherAI/pythia-14m", weightsRevision: "step143000" });
  const tuned = await saturn.api("POST", `${route}/models`, { source: "local/sft", weightsRevision: "abc", parentId: base.id, trainingData: "qa-set v1" });
  assert.equal((await saturn.call("POST", `${route}/models`, { source: "x", parentId: "model_nothere000" })).status, 400);
  const backwards = await saturn.call("PATCH", `${route}/models/${base.id}`, { expectedRevision: 1, parentId: tuned.id });
  assert.equal(backwards.status, 400);
  assert.match(backwards.body.error, /ancestor/);
  assert.equal((await saturn.call("PATCH", `${route}/models/${base.id}`, { expectedRevision: 1, parentId: base.id })).status, 400);
});

test("different training data with the same evaluation can be compared", async () => {
  const base = await saturn.api("POST", `${route}/models`, { source: "base", weightsRevision: "1", trainingData: "the pile" });
  const tuned = await saturn.api("POST", `${route}/models`, { source: "sft", weightsRevision: "1", parentId: base.id, trainingData: "qa-set" });
  assert.deepEqual(await compare(await version(base), await version(tuned)), { result: "comparable", differs: [], missing: [] });
});

test("a different scorer, test set or chat template cannot be compared directly, and says why", async () => {
  const model = await saturn.api("POST", `${route}/models`, { source: "m", weightsRevision: "1" });
  const plain = await version(model);
  const answer = await compare(plain, await version(model, { ...evaluation, chatTemplate: "chatml", scorer: "other" }));
  assert.equal(answer.result, "not_comparable");
  assert.deepEqual(answer.differs.sort(), ["chatTemplate", "scorer"]);
});

test("files that changed under the same name are not the same evaluation", async () => {
  const model = await saturn.api("POST", `${route}/models`, { source: "m2", weightsRevision: "1" });
  const before = await version(model);
  await writeFile(path.join(folder, "set.jsonl"), "{\"changed\":1}\n");
  const answer = await compare(before, await version(model));
  assert.equal(answer.result, "not_comparable");
  assert.deepEqual(answer.differs, ["data files"]);
});

test("what an evaluation did not state makes the answer unknown, not yes", async () => {
  const model = await saturn.api("POST", `${route}/models`, { source: "m3", weightsRevision: "1" });
  const { split: _split, ...partial } = evaluation;
  const answer = await compare(await version(model), await version(model, partial));
  assert.equal(answer.result, "unknown");
  assert.deepEqual(answer.missing, ["split"]);
});

test("comparing a version that does not exist is a 404", async () => {
  assert.equal((await saturn.call("GET", `${route}/compare?left=version_nothere&right=`)).status, 404);
});
