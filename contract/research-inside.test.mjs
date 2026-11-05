// Looking inside a model on one sample: the runtime runs its helper with the experiment's own Python, saves the answer
// with the run, and refuses when it cannot. A stand-in "python" plays the environment. docs/research-contract.md is
// the contract.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
    if (request.action === "compare") {
      const layers = [{ layer: 0, values: [1, 2] }];
      process.stdout.write(JSON.stringify({ modelId: request.modelId, otherModelId: request.otherModelId, measure: "stand-in", tokens: ["a", "b"], layers, otherLayers: layers, top: "x", otherTop: "y", first: process.argv[2] }));
      process.exit(0);
    }
    if (request.action === "prompts") {
      if (request.clean === "boom") { console.error("different lengths"); process.exit(1); }
      process.stdout.write(JSON.stringify({ modelId: request.modelId, tokens: ["a", "b"], corruptedTokens: ["a", "c"], expected: request.expected, alternative: request.alternative, cleanMargin: 2, corruptedMargin: -1, cleanTop: "x", corruptedTop: "y", layers: [0], recovery: [[0, 0.8]], control: [[0, 0.1]], first: process.argv[2] }));
      process.exit(0);
    }
    if (request.action === "features") {
      if (request.prompt === "no-kit") { process.stdout.write(JSON.stringify({ refused: "sae_lens is not installed in the project Python." })); process.exit(0); }
      if (request.prompt === "boom") { console.error("a traceback"); process.exit(3); }
      process.stdout.write(JSON.stringify({ modelId: request.modelId, layer: request.layer, tokens: ["a", "b"], top: "x",
        sae: { release: request.sae.release ?? null, id: request.sae.id ?? null, path: request.sae.path ?? null, hookName: "blocks.1.hook_resid_post", width: 8, trainedOn: "org", startTokenAdded: false, centered: false },
        reconstruction: { varianceExplained: 0.9, relativeError: 0.1, meanActiveFeatures: 2, tokensLeftOut: 0 },
        features: [[{ feature: 3, activation: 5 }], [{ feature: 4, activation: 2 }]],
        expected: request.expected ?? null, alternative: request.alternative ?? null,
        margins: request.expected ? { plain: 2, spliced: 1.5, spliceChange: -0.5 } : null,
        ablation: request.ablate === null || request.ablate === undefined ? null : { feature: request.ablate, activation: 5, margin: 0.5, change: -1, control: { feature: 4, activation: 4, margin: 1.4, change: -0.1 }, controlSeed: 0 },
        first: process.argv[2] }));
      process.exit(0);
    }
    if (request.sweep) {
      const layers = request.sweep.layers ?? [0, 1];
      process.stdout.write(JSON.stringify({ sourceModelId: request.sweep.modelId, targetModelId: request.modelId, layers, samples: request.sweep.samples.map((item) => ({
        sampleId: item.sampleId, expected: item.expected, alternative: item.alternative, top: "x", expectedLogProb: -3, margin: -1,
        byLayer: layers.map((layer) => ({ layer, top: layer === 1 ? item.expected : "x", expectedLogProb: layer === 1 ? -0.5 : -3, margin: layer === 2 ? 0.5 : -1 })) })) }));
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
const line = (sampleId, modelId, input, expected) => JSON.stringify({ schemaVersion: 1, sampleId, modelId, input, expected, alternative: expected ? " John" : undefined, output: "o", scores: { s: 1 } }) + "\\n";
appendFileSync(process.env.SATURN_RUN_SAMPLES, line("a", process.argv[2], "When Mary and John went", " Mary"));
appendFileSync(process.env.SATURN_RUN_SAMPLES, line("b", process.argv[3], "boom", null));
`;

test("Inspect can start from model and Python snapshots without any experiment or completed run", posixOnly, async () => {
  const folder = await saturn.folder();
  const made = await saturn.api("POST", "/projects", { path: folder, grant: true });
  const route = `/projects/${made.id}/research`;
  await writeFile(path.join(folder, "python"), PYTHON); await chmod(path.join(folder, "python"), 0o755);
  await saturn.api("PUT", `${route}/environment`, { python: path.join(folder, "python") });
  const base = await saturn.api("POST", `${route}/models`, { source: "org/base", weightsRevision: "step1" });
  const other = await saturn.api("POST", `${route}/models`, { source: "org/other", weightsRevision: "step2" });
  const session = await saturn.api("POST", `${route}/inspection-sessions`, { title: "Explore", modelIds: [base.id, other.id] });
  assert.deepEqual((await saturn.api("GET", `${route}/runs`)).items, []);
  assert.deepEqual((await saturn.api("GET", `${route}/experiments`)).items, []);
  await saturn.api("PATCH", `${route}/models/${base.id}`, { expectedRevision: base.revision, weightsRevision: "changed" });
  await saturn.api("PUT", `${route}/environment`, { python: "does-not-exist" });
  const answer = await saturn.api("POST", `${route}/inspection-sessions/${session.id}/actions`, { action: "compare", modelId: base.id, otherModelId: other.id, input: "a b" });
  assert.equal(answer.modelId, base.id);
  const asked = JSON.parse(await readFile(path.join(folder, "asked.json"), "utf8"));
  assert.deepEqual(asked.target, { source: "org/base", revision: "step1" });
  const recorded = await saturn.api("GET", `${route}/inspection-sessions/${session.id}/inside`);
  assert.equal(recorded.items.length, 1);
  assert.equal((await saturn.call("PATCH", `${route}/inspection_sessions/${session.id}`, { expectedRevision: session.revision, python: "changed" })).status, 405);
  const stranger = await saturn.api("POST", `${route}/models`, { source: "org/stranger", weightsRevision: "x" });
  assert.equal((await saturn.call("POST", `${route}/inspection-sessions/${session.id}/actions`, { action: "compare", modelId: stranger.id, otherModelId: base.id, input: "a b" })).status, 422);
});

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
  const listed = await saturn.api("GET", `${route}/runs/${run.id}/inside`);
  assert.deepEqual(listed.items.map((item) => [Boolean(item.legacy), item.current]).sort(), [[false, true], [true, false]], "the earlier result is listed, and said not to be current");
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

test("prompts of the person's own are looked at with a run's python and weights, and saved with it", posixOnly, async () => {
  const { folder, route, run, base, tuned } = await project();
  const place = `${route}/runs/${run.id}/inspections`;
  const asked = { action: "prompts", modelId: tuned.id, clean: "John gave to", corrupted: "Mary gave to", expected: " Mary", alternative: " John" };
  const first = await saturn.api("POST", place, asked);
  assert.deepEqual(first.recovery, [[0, 0.8]]);
  assert.equal(first.action, "prompts");
  const heard = JSON.parse(await readFile(path.join(folder, "asked.json"), "utf8"));
  assert.deepEqual(heard.target, { source: "org/tuned", revision: "v1" });
  assert.equal(heard.clean, "John gave to");
  await writeFile(path.join(folder, "asked.json"), "untouched");
  const again = await saturn.api("POST", place, asked);
  assert.equal(again.recordedAt, first.recordedAt, "answered from what was saved");
  assert.equal(await readFile(path.join(folder, "asked.json"), "utf8"), "untouched");

  const compared = await saturn.api("POST", place, { action: "compare", modelId: tuned.id, otherModelId: base.id, input: "When Mary" });
  assert.equal(compared.otherTop, "y");
  assert.deepEqual(JSON.parse(await readFile(path.join(folder, "asked.json"), "utf8")).other, { source: "org/base", revision: "step1" });

  const listed = await saturn.api("GET", `${route}/runs/${run.id}/inside`);
  assert.deepEqual(listed.items.map((item) => item.kind).sort(), ["compare", "prompts"]);
  assert.ok(listed.items.every((item) => item.current === true));
  // The helper that reads samples did not change, so what it already made stays current.
  await saturn.api("POST", `${route}/runs/${run.id}/activations`, { sampleId: "a" });
  assert.ok((await saturn.api("GET", `${route}/runs/${run.id}/inside`)).items.every((item) => item.current === true));
});

test("a look at prompts that cannot mean anything is refused, and a helper's refusal is passed on", posixOnly, async () => {
  const { route, run, base, tuned } = await project();
  const place = `${route}/runs/${run.id}/inspections`;
  const good = { action: "prompts", modelId: tuned.id, clean: "a", corrupted: "b", expected: " x", alternative: " y" };
  for (const [change, why] of [
    [{ corrupted: "a" }, /same/],
    [{ alternative: " x" }, /same/],
    [{ expected: "" }, /expected/],
    [{ clean: "z".repeat(4001) }, /longer/],
    [{ action: "other" }, /nothing to do/],
  ]) {
    const refused = await saturn.call("POST", place, { ...good, ...change });
    assert.equal(refused.status, 400, JSON.stringify(change).slice(0, 60));
    assert.match(JSON.stringify(refused.body), why);
  }
  assert.equal((await saturn.call("POST", place, { action: "compare", modelId: base.id, otherModelId: base.id, input: "a" })).status, 400);
  assert.equal((await saturn.call("POST", `${route}/runs/run_0000000000000000/inspections`, good)).status, 404);
  const failed = await saturn.call("POST", place, { ...good, clean: "boom" });
  assert.equal(failed.status, 422);
  assert.match(JSON.stringify(failed.body), /different lengths/);
});

/** The helper's whole program for features, as the runtime composes it. */
async function featuresHelper() {
  const folder = new URL("../crates/saturn-core/src/research/", import.meta.url);
  const functions = (await readFile(new URL("inside.py", folder), "utf8")).split("\nif __name__")[0];
  return `${functions}\n${await readFile(new URL("inside_features.py", folder), "utf8")}`;
}

test("features are read through an SAE with a run's python and weights, saved with it, and listed", posixOnly, async () => {
  const { folder, route, run, tuned } = await project();
  const place = `${route}/runs/${run.id}/inspections`;
  const asked = { action: "features", modelId: tuned.id, prompt: "When Mary", layer: 1, saeRelease: "some-release", saeId: "blocks.1.hook_resid_post", expected: " Mary", alternative: " John", ablate: 3 };
  const first = await saturn.api("POST", place, asked);
  assert.equal(first.action, "features");
  assert.deepEqual(first.features[0], [{ feature: 3, activation: 5 }]);
  assert.equal(first.ablation.control.feature, 4);
  assert.equal(first.margins.spliceChange, -0.5, "what splicing alone did is in the answer");
  assert.equal(first.helperSha256, sha(await featuresHelper()));
  const heard = JSON.parse(await readFile(path.join(folder, "asked.json"), "utf8"));
  assert.deepEqual(heard.target, { source: "org/tuned", revision: "v1" });
  assert.deepEqual(heard.sae, { release: "some-release", id: "blocks.1.hook_resid_post" });
  assert.equal(heard.layer, 1);
  assert.equal(heard.ablate, 3);
  await writeFile(path.join(folder, "asked.json"), "untouched");
  const again = await saturn.api("POST", place, asked);
  assert.equal(again.recordedAt, first.recordedAt, "answered from what was saved");
  assert.equal(await readFile(path.join(folder, "asked.json"), "utf8"), "untouched");
  const saved = await readdir(path.join(folder, ".saturn/research/runs", run.id, "inside"));
  assert.equal(saved.filter((name) => name.startsWith("inspect-")).length, 1);

  // Without two words there is no margin, and asking without an ablation is another question.
  const plain = await saturn.api("POST", place, { action: "features", modelId: tuned.id, prompt: "When Mary", layer: 1, saeRelease: "some-release", saeId: "blocks.1.hook_resid_post" });
  assert.equal(plain.margins, null);
  assert.equal(plain.ablation, null);
  assert.notEqual(plain.key, first.key);

  await saturn.api("POST", place, { action: "prompts", modelId: tuned.id, clean: "a", corrupted: "b", expected: " x", alternative: " y" });
  const listed = await saturn.api("GET", `${route}/runs/${run.id}/inside`);
  assert.deepEqual(listed.items.map((item) => item.kind).sort(), ["features", "features", "prompts"]);
  assert.ok(listed.items.every((item) => item.current === true), "each is judged by the helper that makes its own kind");
});

test("a request for features that cannot mean anything is refused, and a helper's reason is passed on and not saved", posixOnly, async () => {
  const { folder, route, run, tuned } = await project();
  const place = `${route}/runs/${run.id}/inspections`;
  const good = { action: "features", modelId: tuned.id, prompt: "a", layer: 1, saeRelease: "r", saeId: "i" };
  for (const [change, why] of [
    [{ prompt: "" }, /prompt/],
    [{ prompt: "z".repeat(4001) }, /longer/],
    [{ layer: undefined }, /layer/],
    [{ layer: -1 }, /layer/],
    [{ layer: "one" }, /layer/],
    [{ saeRelease: "" }, /names an SAE/],
    [{ saeId: "" }, /names an SAE/],
    [{ saePath: "folder" }, /twice/],
    [{ expected: " x" }, /both/],
    [{ alternative: " y" }, /both/],
    [{ expected: " x", alternative: " x" }, /same/],
    [{ ablate: 3 }, /margin/],
    [{ ablate: "three", expected: " x", alternative: " y" }, /whole number/],
  ]) {
    const refused = await saturn.call("POST", place, { ...good, ...change });
    assert.equal(refused.status, 400, JSON.stringify(change).slice(0, 60));
    assert.match(JSON.stringify(refused.body), why);
  }
  assert.equal((await saturn.call("POST", `${route}/runs/run_0000000000000000/inspections`, good)).status, 404);

  const missing = await saturn.call("POST", place, { ...good, prompt: "no-kit" });
  assert.equal(missing.status, 422);
  assert.match(missing.body.error, /^sae_lens is not installed/, "the reason itself, not a failure around it");
  const failed = await saturn.call("POST", place, { ...good, prompt: "boom" });
  assert.equal(failed.status, 422);
  assert.match(failed.body.error, /a traceback/);
  const saved = await readdir(path.join(folder, ".saturn/research/runs", run.id)).then((names) => names.includes("inside"));
  assert.equal(saved, false, "neither is kept, so asking again after installing runs");
});

test("an SAE in a local folder is asked about afresh when its files change", posixOnly, async () => {
  const { folder, route, run, tuned } = await project();
  const place = `${route}/runs/${run.id}/inspections`;
  const asked = { action: "features", modelId: tuned.id, prompt: "a", layer: 1, saePath: "saes/one" };
  const absent = await saturn.call("POST", place, asked);
  assert.equal(absent.status, 422);
  assert.match(absent.body.error, /no SAE folder at saes\/one/);
  await mkdir(path.join(folder, "saes/one"), { recursive: true });
  await writeFile(path.join(folder, "saes/one/cfg.json"), "{}");
  const first = await saturn.api("POST", place, asked);
  assert.equal(first.sae.path, "saes/one");
  assert.equal(JSON.parse(await readFile(path.join(folder, "asked.json"), "utf8")).sae.path, "saes/one");
  assert.equal((await saturn.api("POST", place, asked)).recordedAt, first.recordedAt);
  await writeFile(path.join(folder, "saes/one/weights.safetensors"), "trained again");
  const fresh = await saturn.api("POST", place, asked);
  assert.notEqual(fresh.key, first.key);
});

test("the real helper says when sae_lens is missing or an SAE reads another layer", { ...posixOnly, skip: posixOnly.skip || spawnSync("python3", ["--version"]).error ? "needs python3" : false }, async () => {
  const { folder, route, run, tuned } = await project();
  const place = `${route}/runs/${run.id}/inspections`;
  // A real interpreter runs the helper, with just enough of torch and transformers to reach what is being tested.
  await writeFile(path.join(folder, "python"), `#!/bin/sh\nexec python3 "$@"\n`);
  await writeFile(path.join(folder, "torch.py"), `float32 = "float32"\ndef no_grad():\n    return lambda function: function\n`);
  await writeFile(path.join(folder, "transformers.py"), `class Config:\n    num_hidden_layers = 4\nclass Model:\n    config = Config()\n    def eval(self):\n        return self\nclass AutoModelForCausalLM:\n    @staticmethod\n    def from_pretrained(*args, **kwargs):\n        return Model()\nclass AutoTokenizer:\n    @staticmethod\n    def from_pretrained(*args, **kwargs):\n        return object()\n`);
  await writeFile(path.join(folder, "sae_lens.py"), `raise ModuleNotFoundError("No module named 'sae_lens'", name="sae_lens")\n`);
  const good = { action: "features", modelId: tuned.id, prompt: "a", layer: 1, saeRelease: "r", saeId: "blocks.1.hook_resid_post" };
  const missing = await saturn.call("POST", place, good);
  assert.equal(missing.status, 422, JSON.stringify(missing.body));
  assert.match(missing.body.error, /^sae_lens is not installed in this project's Python\. Install the Interpretability kit on the Environment screen\.$/);

  await writeFile(path.join(folder, "sae_lens.py"), `class Config:\n    def __init__(self, hook_name):\n        self.hook_name = hook_name\nclass SAE:\n    def __init__(self, hook_name):\n        self.cfg = Config(hook_name)\n    @staticmethod\n    def from_pretrained(release, sae_id, device):\n        if release == "bad":\n            raise ValueError("no such release")\n        return SAE(sae_id)\n`);
  for (const [change, why] of [
    [{ layer: 2 }, /reads blocks\.1\.hook_resid_post, the residual stream leaving layer 1, but layer 2 was asked for/],
    [{ layer: 9 }, /has layers 0 to 3/],
    [{ layer: 7, saeId: "blocks.8.hook_resid_pre" }, /has layers 0 to 3/],
    [{ layer: 2, saeId: "blocks.2.hook_resid_pre" }, /leaving layer 1, but layer 2/],
    [{ saeId: "blocks.1.attn.hook_z" }, /not a residual stream between blocks/],
    [{ layer: 0, saeId: "blocks.0.hook_resid_pre" }, /embeddings before the first block/],
    [{ saeRelease: "bad" }, /could not be loaded: no such release/],
  ]) {
    const refused = await saturn.call("POST", place, { ...good, ...change });
    assert.equal(refused.status, 422, JSON.stringify(change));
    assert.match(refused.body.error, why);
  }
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
  assert.deepEqual(asked.sweep.samples.map((item) => item.alternative), [" John"], "the line's alternative goes to the helper");
  assert.deepEqual(swept.samples[0].byLayer.map((item) => item.margin), [-1, -1, 0.5]);
  const again = await saturn.api("POST", `${route}/interventions/sweep`, { runId: run.id, sampleIds: ["a"], sourceModelId: tuned.id, targetModelId: base.id, layers: [0, 1, 2] });
  assert.equal(again.recordedAt, swept.recordedAt);
  const saved = await readdir(path.join(folder, ".saturn/research/runs", run.id, "inside"));
  assert.equal(saved.filter((name) => name.startsWith("sweep-")).length, 1);
  await saturn.api("POST", `${route}/runs/${run.id}/activations`, { sampleId: "a" });
  const listed = await saturn.api("GET", `${route}/runs/${run.id}/inside`);
  assert.deepEqual(listed.items.map((item) => item.kind).sort(), ["reading", "sweep"]);
  assert.ok(listed.items.every((item) => item.current === true), "made by this runtime's helper");
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
