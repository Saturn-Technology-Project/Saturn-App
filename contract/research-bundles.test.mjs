// A portable study includes its evidence, not credentials or execution authority. Imports validate before writing.
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench, sha } from "./files-support.mjs";

let workbench;
before(async () => { workbench = await bench(); });
after(async () => { await workbench?.stop(); });
async function project() {
  const folder = await workbench.folder();
  const made = await workbench.api("POST", "/projects", { path: folder, grant: true });
  return { folder, route: `/projects/${made.id}/research` };
}

/** A small completed study, a human review and an analysis snapshot. */
async function study() {
  const setup = await project();
  await writeFile(path.join(setup.folder, "old.jsonl"), '{"sampleId":"a","input":"a","output":"<script>bad()</script>","scorerLabel":"Wrong","scores":{"s":0}}\n');
  const imported = await workbench.api("POST", `${setup.route}/imports`, { path: "old.jsonl", title: "<script>title()</script>" });
  await workbench.api("POST", `${setup.route}/runs/${imported.run.id}/labels`, { sampleId: "a", label: "Wrong", note: "Reviewed" });
  await workbench.api("POST", `${setup.route}/findings`, { kind: "observation", text: "<script>finding()</script>", runIds: [imported.run.id] });
  await writeFile(path.join(setup.folder, "analysis.json"), '{"values":[1,2]}');
  const artifact = await workbench.api("POST", `${setup.route}/artifacts/register`, { path: "analysis.json", kind: "json", runId: imported.run.id });
  const directory = path.join(setup.folder, ".workbench/research/runs", imported.run.id);
  await mkdir(path.join(directory, "inside"));
  await writeFile(path.join(directory, "stdout.log"), "measured\n");
  await writeFile(path.join(directory, "inside", "inspect-abcd.json"), '{"schemaVersion":1,"action":"compare","helperSha256":"old-helper","tokens":["a"],"layers":[]}');
  return { ...setup, ...imported, artifact };
}

test("a bundle round-trips raw samples, labels, logs, inside results and snapshots to a new project", async () => {
  const source = await study();
  const exported = await workbench.api("POST", `${source.route}/bundles/export`, { path: "exports/study.workbench.json" });
  const bytes = await readFile(path.join(source.folder, exported.path));
  const bundle = JSON.parse(bytes);
  assert.equal(bundle.format, "workbench.research.bundle");
  assert.ok(bundle.files.some((file) => file.path === `runs/${source.run.id}/samples.jsonl`));
  assert.ok(bundle.files.some((file) => file.path === `labels/${source.run.id}.json`));
  assert.ok(bundle.files.some((file) => file.path.includes("/inside/")));
  assert.ok(bundle.files.some((file) => file.path === `artifact_data/${source.artifact.sha256}`));
  assert.equal(bundle.files.some((file) => /policy|remote.json|process.identity|secrets|runtime-token/.test(file.path)), false);
  const target = await project(); await writeFile(path.join(target.folder, "study.workbench.json"), bytes);
  const preview = await workbench.api("POST", `${target.route}/bundles/preview`, { path: "study.workbench.json" });
  assert.equal(preview.sha256, sha(bytes));
  const result = await workbench.api("POST", `${target.route}/bundles/import`, { path: "study.workbench.json", expectedSha256: preview.sha256 });
  assert.ok(result.imported > 0);
  const samples = await workbench.api("GET", `${target.route}/runs/${source.run.id}/samples`);
  assert.equal(samples.items[0].sample.output, "<script>bad()</script>");
  assert.equal((await workbench.api("GET", `${target.route}/runs/${source.run.id}/labels`)).labels[JSON.stringify(["a", 0, ""])].label, "Wrong");
  const content = await workbench.api("GET", `${target.route}/artifacts/${source.artifact.id}/content`);
  assert.equal(Buffer.from(content.data, "base64").toString(), '{"values":[1,2]}');
  assert.equal(await readFile(path.join(target.folder, ".workbench/research/runs", source.run.id, "stdout.log"), "utf8"), "measured\n");
  assert.equal((await workbench.api("POST", `${target.route}/bundles/import`, { path: "study.workbench.json" })).imported, 0);
  const report = await readFile(path.join(source.folder, exported.htmlPath), "utf8");
  assert.equal(report.includes("<script>finding()"), false);
  assert.match(report, /&lt;script&gt;finding/);
  assert.match(report, /not a guarantee of reproducibility/);
  assert.match(report, /Runs and recorded counts/);
  assert.ok(report.includes(source.run.id));
  assert.match(report, /completed/);
});

test("tampered data, traversal, credentials and conflicts reject before any new evidence lands", async () => {
  const source = await study();
  const exported = await workbench.api("POST", `${source.route}/bundles/export`, {});
  const original = JSON.parse(await readFile(path.join(source.folder, exported.path), "utf8"));
  const target = await project();
  async function rejected(bundle, status) {
    await writeFile(path.join(target.folder, "bad.json"), JSON.stringify(bundle));
    assert.equal((await workbench.call("POST", `${target.route}/bundles/import`, { path: "bad.json" })).status, status);
    assert.deepEqual((await workbench.api("GET", `${target.route}/experiments`)).items, []);
  }
  const tampered = structuredClone(original); tampered.files[0].data = Buffer.from("changed").toString("base64"); await rejected(tampered, 422);
  const escape = structuredClone(original); escape.files[0].path = "../outside.json"; await rejected(escape, 403);
  const secret = structuredClone(original); secret.files[0].path = "policy.json"; await rejected(secret, 403);
  await writeFile(path.join(target.folder, "changed.json"), JSON.stringify(original));
  assert.equal((await workbench.call("POST", `${target.route}/bundles/import`, { path: "changed.json", expectedSha256: "stale-preview" })).status, 409);
  const root = path.join(target.folder, ".workbench/research/models"); await mkdir(root, { recursive: true });
  // A conflict in the last file must also leave earlier records untouched.
  const last = original.files.at(-1); const collision = path.join(target.folder, ".workbench/research", last.path); await mkdir(path.dirname(collision), { recursive: true }); await writeFile(collision, "different");
  await rejected(original, 409);
  assert.equal(await readFile(collision, "utf8"), "different");
});

test("a bundle cannot attach evidence to a run the project already has", async () => {
  const source = await study();
  const exported = await workbench.api("POST", `${source.route}/bundles/export`, { path: "exports/study.workbench.json" });
  const bundle = JSON.parse(await readFile(path.join(source.folder, exported.path)));
  // Only an inspection for that run, under a name the project does not have yet: no run comes with it.
  bundle.files = bundle.files.filter((file) => file.path.startsWith(`runs/${source.run.id}/inside/`)).map((file) => ({ ...file, path: file.path.replace("inspect-abcd", "inspect-ffff") }));
  assert.equal(bundle.files.length, 1);
  await writeFile(path.join(source.folder, "attach.workbench.json"), JSON.stringify(bundle));
  const refused = await workbench.call("POST", `${source.route}/bundles/import`, { path: "attach.workbench.json" });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error, /already has, and the bundle does not carry that run/);
  const inside = await readdir(path.join(source.folder, ".workbench/research/runs", source.run.id, "inside"));
  assert.deepEqual(inside, ["inspect-abcd.json"], "nothing was added");
});

test("active jobs import as archived interrupted evidence, never as launch instructions", async () => {
  const source = await study();
  const model = await workbench.api("POST", `${source.route}/models`, { source: "org/model", weightsRevision: "fixed" });
  await workbench.api("PUT", `${source.route}/environment`, { python: process.execPath });
  const session = await workbench.api("POST", `${source.route}/inspection-sessions`, { modelIds: [model.id] });
  const experiment = await workbench.api("POST", `${source.route}/experiments`, { title: "Executable locally", command: "node -e 'process.exit(0)'", inputs: {} });
  const version = await workbench.api("POST", `${source.route}/experiments/${experiment.id}/versions`, {});
  const runPath = path.join(source.folder, ".workbench/research/runs", source.run.id, "run.json");
  const run = JSON.parse(await readFile(runPath, "utf8"));
  run.status = "running"; run.remote = { host: "never-connect", workdir: "/never", program: "not-a-program" }; await writeFile(runPath, JSON.stringify(run));
  const exported = await workbench.api("POST", `${source.route}/bundles/export`, {});
  const target = await project(); await writeFile(path.join(target.folder, "study.json"), await readFile(path.join(source.folder, exported.path)));
  const preview = await workbench.api("POST", `${target.route}/bundles/preview`, { path: "study.json" }); assert.equal(preview.activeRuns, 1);
  await workbench.api("POST", `${target.route}/bundles/import`, { path: "study.json" });
  const archived = await workbench.api("GET", `${target.route}/runs/${source.run.id}`);
  assert.equal(archived.status, "interrupted"); assert.equal(archived.archived, true);
  assert.equal((await workbench.api("GET", `${target.route}/remote`)).target, null);
  assert.equal((await workbench.call("POST", `${target.route}/versions/${version.id}/runs`, { clientId: "must-not-execute" })).status, 409);
  assert.equal((await workbench.call("POST", `${target.route}/inspection-sessions/${session.id}/actions`, { action: "prompts", modelId: model.id, clean: "a", corrupted: "b", expected: " x", alternative: " y" })).status, 409);
  const local = await workbench.api("POST", `${target.route}/experiments/${experiment.id}/versions`, {});
  assert.notEqual(local.id, version.id);
  assert.equal(local.archived, undefined);
  assert.equal(local.number, version.number + 1);
  assert.equal((await workbench.api("POST", `${target.route}/experiments/${experiment.id}/versions`, {})).id, local.id);
});

test("exports and imports refuse links and leave missing external data explicit", async () => {
  const source = await study();
  await workbench.api("POST", `${source.route}/models`, { source: "org/model", weightsRevision: "fixed" });
  await workbench.api("POST", `${source.route}/artifacts/register`, { kind: "reference", uri: "s3://bucket/activations" });
  const exported = await workbench.api("POST", `${source.route}/bundles/export`, {});
  const bundle = JSON.parse(await readFile(path.join(source.folder, exported.path), "utf8"));
  assert.ok(bundle.external.some((item) => item.kind === "model_weights"));
  assert.ok(bundle.external.some((item) => item.kind === "artifact_reference"));
  if (process.platform !== "win32") {
    const target = await project(); await writeFile(path.join(target.folder, "study.json"), JSON.stringify(bundle));
    const outside = await workbench.folder(); await mkdir(path.join(target.folder, ".workbench/research"), { recursive: true });
    await symlink(outside, path.join(target.folder, ".workbench/research/runs"));
    assert.equal((await workbench.call("POST", `${target.route}/bundles/import`, { path: "study.json" })).status, 403);
    assert.deepEqual(await readdir(outside), []);
  }
});

test("a run's evidence travels with the bundle: the imported run still has it", async () => {
  const source = await project();
  await writeFile(path.join(source.folder, "probe.mjs"), `import { appendFileSync } from "node:fs"; appendFileSync(process.env.WORKBENCH_RUN_REPORT, JSON.stringify({ kind: "seed", value: 7 }) + "\\n"); appendFileSync(process.env.WORKBENCH_RUN_SAMPLES, JSON.stringify({ schemaVersion: 1, sampleId: "a", input: "i", output: "o", scores: { s: 1 }, error: null }) + "\\n");`);
  const experiment = await workbench.api("POST", `${source.route}/experiments`, { title: "E", command: "node probe.mjs", inputs: { code: ["probe.mjs"] } });
  const version = await workbench.api("POST", `${source.route}/experiments/${experiment.id}/versions`, {});
  const started = await workbench.api("POST", `${source.route}/versions/${version.id}/runs`, { clientId: "bundled-evidence" });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (!["starting", "running", "stopping"].includes((await workbench.api("GET", `${source.route}/runs/${started.id}`)).status)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const before = await workbench.api("GET", `${source.route}/runs/${started.id}/evidence`);
  assert.equal(before.recorded, true);
  const exported = await workbench.api("POST", `${source.route}/bundles/export`, { path: "exports/evidence.workbench.json" });
  const bytes = await readFile(path.join(source.folder, exported.path));
  const names = JSON.parse(bytes).files.map((file) => file.path);
  for (const name of ["evidence.json", "report.jsonl"]) assert.ok(names.includes(`runs/${started.id}/${name}`), `${name} in ${names}`);
  const target = await project();
  await writeFile(path.join(target.folder, "evidence.workbench.json"), bytes);
  await workbench.api("POST", `${target.route}/bundles/import`, { path: "evidence.workbench.json" });
  const after = await workbench.api("GET", `${target.route}/runs/${started.id}/evidence`);
  assert.equal(after.recorded, true);
  assert.deepEqual(after.verdicts, before.verdicts);
  assert.deepEqual(after.reported.seed, { value: 7 });
});
