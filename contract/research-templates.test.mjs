// The programs Saturn hands out as starting points: the SDK writes the records a run is read by, with the real Python,
// and every template compiles. docs/research-contract.md is the contract.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { bench, posixOnly, until } from "./files-support.mjs";

const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../crates/saturn-core/src/research/templates");
const python = spawnSync("python3", ["--version"]).error ? null : "python3";
const needsPython = { ...posixOnly, skip: posixOnly.skip || (python ? false : "needs python3") };

let saturn;
before(async () => { saturn = await bench(); });
after(async () => { await saturn?.stop(); });

test("every Python template parses and the shell template parses", needsPython, () => {
  for (const name of readdirSync(TEMPLATES).filter((name) => /\.(py|sh)$/.test(name))) {
    const file = path.join(TEMPLATES, name);
    // A parse, not py_compile, so nothing is written beside the templates.
    const checked = name.endsWith(".sh") ? spawnSync("sh", ["-n", file]) : spawnSync(python, ["-I", "-c", "import ast, sys; ast.parse(open(sys.argv[1], encoding='utf-8').read(), sys.argv[1])", file]);
    assert.equal(checked.status, 0, `${name}: ${checked.stderr}`);
  }
});

test("a program on the SDK writes samples, metrics, a report and a checkpoint that Saturn reads as its records", needsPython, async () => {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "saturn_run.py"), await readFile(path.join(TEMPLATES, "saturn_run.py")));
  await writeFile(path.join(folder, "probe.py"), `
from saturn_run import Run
run = Run()
seed = run.seed()
run.report("model", source="local", revision="abc")
for index, item in enumerate(["a", "b", "c"]):
    if run.finished(item):
        continue
    run.sample(item, input=item, output=item.upper(), scores={"correct": index != 1}, expected=item.upper(), scorerLabel="Correct" if index != 1 else "Wrong")
run.metric(1, loss=0.5)
run.metric(2, loss=0.25)
(run.output / "step-2").write_text("weights")
run.checkpoint(run.output / "step-2", step=2)
run.artifact(run.output / "step-2", "json", note="not json, only listed")
`);
  const made = await saturn.api("POST", "/projects", { path: folder });
  await saturn.api("POST", `/projects/${made.id}/access`, {});
  const route = `/projects/${made.id}/research`;
  const experiment = await saturn.api("POST", `${route}/experiments`, { title: "SDK", command: `${python} probe.py`, inputs: { code: ["probe.py", "saturn_run.py"] }, seeds: [11], evaluation: { dataset: "d", split: "test", sampleSet: "all", scorer: "correct", promptFormat: "continuation", chatTemplate: null, generation: {} } });
  const version = await saturn.api("POST", `${route}/experiments/${experiment.id}/versions`, {});
  const started = await saturn.api("POST", `${route}/versions/${version.id}/runs`, { clientId: "sdk-1" });
  const run = await until("the run to end", () => saturn.api("GET", `${route}/runs/${started.id}`), (item) => !["starting", "running", "stopping"].includes(item.status));
  assert.equal(run.status, "completed", JSON.stringify(run));
  assert.equal(run.samples, 3);
  const summary = await saturn.api("GET", `${route}/runs/${run.id}/summary`);
  assert.equal(summary.models[0].scores.correct.mean, 2 / 3);
  const evidence = await saturn.api("GET", `${route}/runs/${run.id}/evidence`);
  assert.deepEqual(evidence.reported.seed.value, 11);
  assert.ok(evidence.reported.seed.applied.includes("python"));
  assert.deepEqual(evidence.reported.models, [{ source: "local", revision: "abc" }]);
  const metrics = await saturn.api("GET", `${route}/runs/${run.id}/metrics`);
  assert.deepEqual(metrics.items.map((item) => item.values.loss), [0.5, 0.25]);
  const manifest = await readFile(path.join(folder, ".saturn/research/runs", run.id, "artifacts.jsonl"), "utf8");
  assert.match(manifest, /"kind": "checkpoint", "path": "written\/step-2", "step": 2/);
  const output = await saturn.api("GET", `${route}/runs/${run.id}/output`);
  assert.deepEqual(output.files.map((file) => file.path), ["step-2"]);
});
