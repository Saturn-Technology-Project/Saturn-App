// The programs Saturn hands out as starting points: the SDK writes the records a run is read by, with the real Python,
// and every template compiles. docs/research-contract.md is the contract.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { bench, until } from "./files-support.mjs";

const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../crates/saturn-core/src/research/templates");
// Asked for its version, not only looked for: on Windows `python3` can be a pointer to the Store that runs nothing.
const python = spawnSync("python3", ["--version"]).status === 0 ? "python3" : null;
const needsPython = { skip: python ? false : "needs python3" };
const hasShell = !spawnSync("sh", ["-c", "exit 0"]).error;
// The training template runs for real only where torch and numpy are installed; elsewhere it is parsed like the rest.
const hasTorch = python !== null && spawnSync(python, ["-c", "import torch, numpy"], { timeout: 60_000 }).status === 0;
const needsTorch = { ...needsPython, skip: needsPython.skip || (hasTorch ? false : "needs torch and numpy") };

let saturn;
before(async () => { saturn = await bench(); });
after(async () => { await saturn?.stop(); });

test("every Python template parses and the shell template parses", needsPython, () => {
  for (const name of readdirSync(TEMPLATES).filter((name) => /\.py$/.test(name) || (hasShell && name.endsWith(".sh")))) {
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

test("the training template saves every generator's state and reports only what a resume put back", needsTorch, async () => {
  // Outside Saturn the SDK writes under ./saturn-run, so two folders stand for the first run and its resume.
  const first = await saturn.folder();
  const resumed = await saturn.folder();
  for (const folder of [first, resumed]) {
    for (const name of ["saturn_run.py", "train_loop.py"]) await writeFile(path.join(folder, name), await readFile(path.join(TEMPLATES, name)));
  }
  const smoke = (cwd, env) => spawnSync(python, ["train_loop.py", "--smoke"], { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: 300_000 });
  const trained = smoke(first, {});
  assert.equal(trained.status, 0, trained.stderr);
  const checkpoint = path.join(first, "saturn-run/written/step-30");
  const manifest = await readFile(path.join(first, "saturn-run/artifacts.jsonl"), "utf8");
  assert.match(manifest, /"kind": "checkpoint", "path": "written\/step-30", "step": 30/);
  // The checkpoint holds each generator by name, the CUDA devices' as None where there are none.
  const kept = spawnSync(python, ["-I", "-c", "import json, sys, torch; rng = torch.load(sys.argv[1], weights_only=False)['rng']; print(json.dumps({'keys': sorted(rng), 'cuda': rng.get('cuda') is not None, 'available': torch.cuda.is_available()}))", path.join(checkpoint, "state.pt")], { encoding: "utf8", timeout: 120_000 });
  assert.equal(kept.status, 0, kept.stderr);
  const saved = JSON.parse(kept.stdout);
  assert.deepEqual(saved.keys, ["cuda", "numpy", "python", "torch"]);
  assert.equal(saved.cuda, saved.available);
  const resumeReport = async (folder) => {
    const reports = (await readFile(path.join(folder, "saturn-run/report.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    return reports.find((item) => item.kind === "resume");
  };
  const again = smoke(resumed, { SATURN_RESUME_FROM: checkpoint });
  assert.equal(again.status, 0, again.stderr);
  const resume = await resumeReport(resumed);
  assert.equal(resume.checkpoint, checkpoint);
  assert.equal(resume.step, 30);
  // Each generator is named; the plain "rng" that once stood for the CPU generator alone is gone, and CUDA's state is
  // claimed only where it was put back.
  const expected = ["weights", "optimizer", "scheduler", "step", "rng:cpu", ...(saved.available ? ["rng:cuda"] : [])];
  assert.deepEqual(resume.restored, expected);
  assert.equal(resume.notRestored, undefined);
  // A checkpoint from a machine with more CUDA devices than this one: its CUDA state is not put back, and the report
  // says so instead of claiming it.
  const elsewhere = await saturn.folder();
  for (const name of ["saturn_run.py", "train_loop.py"]) await writeFile(path.join(elsewhere, name), await readFile(path.join(TEMPLATES, name)));
  const foreign = path.join(first, "saturn-run/written/step-30-elsewhere");
  const altered = spawnSync(python, ["-I", "-c", "import shutil, sys, torch; shutil.copytree(sys.argv[1], sys.argv[2]); state = torch.load(sys.argv[2] + '/state.pt', weights_only=False); state['rng']['cuda'] = [torch.get_rng_state()] * (torch.cuda.device_count() + 1); torch.save(state, sys.argv[2] + '/state.pt')", checkpoint, foreign], { encoding: "utf8", timeout: 120_000 });
  assert.equal(altered.status, 0, altered.stderr);
  const moved = smoke(elsewhere, { SATURN_RESUME_FROM: foreign });
  assert.equal(moved.status, 0, moved.stderr);
  const honest = await resumeReport(elsewhere);
  assert.deepEqual(honest.restored, ["weights", "optimizer", "scheduler", "step", "rng:cpu"]);
  assert.deepEqual(honest.notRestored, ["rng:cuda"]);
  // The template loads the checkpoint onto the training device, which moves the generator states there too, and a
  // generator takes its state as a CPU tensor only: the restore brings them back. Tried on the accelerator this machine
  // has (CUDA or Apple's MPS), and on the CPU where it has none.
  const mapped = spawnSync(python, ["-c", "import json, sys, torch, train_loop; device = 'cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu'; saved = torch.load(sys.argv[1], map_location=device, weights_only=False); print(json.dumps({'device': device, 'restored': train_loop.restore_generators(saved['rng'])[0]}))", path.join(checkpoint, "state.pt")], { cwd: first, encoding: "utf8", timeout: 120_000 });
  assert.equal(mapped.status, 0, mapped.stderr);
  assert.deepEqual(JSON.parse(mapped.stdout).restored, ["rng:cpu", ...(saved.available ? ["rng:cuda"] : [])]);
});
