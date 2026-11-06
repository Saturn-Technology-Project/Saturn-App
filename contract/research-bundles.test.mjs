// A portable study includes its evidence, not credentials or execution authority. Imports validate before writing.
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench, sha } from "./files-support.mjs";

let saturn;
before(async () => { saturn = await bench(); });
after(async () => { await saturn?.stop(); });
async function project() {
  const folder = await saturn.folder();
  const made = await saturn.api("POST", "/projects", { path: folder, grant: true });
  return { folder, route: `/projects/${made.id}/research` };
}

/** A small completed study, a human review and an analysis snapshot. */
async function study() {
  const setup = await project();
  await writeFile(path.join(setup.folder, "old.jsonl"), '{"sampleId":"a","input":"a","output":"<script>bad()</script>","scorerLabel":"Wrong","scores":{"s":0}}\n');
  const imported = await saturn.api("POST", `${setup.route}/imports`, { path: "old.jsonl", title: "<script>title()</script>" });
  await saturn.api("POST", `${setup.route}/runs/${imported.run.id}/labels`, { sampleId: "a", label: "Wrong", note: "Reviewed" });
  await saturn.api("POST", `${setup.route}/findings`, { kind: "observation", text: "<script>finding()</script>", runIds: [imported.run.id] });
  await writeFile(path.join(setup.folder, "analysis.json"), '{"values":[1,2]}');
  const artifact = await saturn.api("POST", `${setup.route}/artifacts/register`, { path: "analysis.json", kind: "json", runId: imported.run.id });
  const directory = path.join(setup.folder, ".saturn/research/runs", imported.run.id);
  await mkdir(path.join(directory, "inside"));
  await writeFile(path.join(directory, "stdout.log"), "measured\n");
  await writeFile(path.join(directory, "inside", "inspect-abcd.json"), '{"schemaVersion":1,"action":"compare","helperSha256":"old-helper","tokens":["a"],"layers":[]}');
  return { ...setup, ...imported, artifact };
}

test("a bundle round-trips raw samples, labels, logs, inside results and snapshots to a new project", async () => {
  const source = await study();
  const exported = await saturn.api("POST", `${source.route}/bundles/export`, { path: "exports/study.saturn.json" });
  const bytes = await readFile(path.join(source.folder, exported.path));
  const bundle = JSON.parse(bytes);
  assert.equal(bundle.format, "saturn.research.bundle");
  assert.ok(bundle.files.some((file) => file.path === `runs/${source.run.id}/samples.jsonl`));
  assert.ok(bundle.files.some((file) => file.path === `labels/${source.run.id}.json`));
  assert.ok(bundle.files.some((file) => file.path.includes("/inside/")));
  assert.ok(bundle.files.some((file) => file.path === `artifact_data/${source.artifact.sha256}`));
  assert.equal(bundle.files.some((file) => /policy|remote.json|process.identity|secrets|runtime-token/.test(file.path)), false);
  const target = await project(); await writeFile(path.join(target.folder, "study.saturn.json"), bytes);
  const preview = await saturn.api("POST", `${target.route}/bundles/preview`, { path: "study.saturn.json" });
  assert.equal(preview.sha256, sha(bytes));
  const result = await saturn.api("POST", `${target.route}/bundles/import`, { path: "study.saturn.json", expectedSha256: preview.sha256 });
  assert.ok(result.imported > 0);
  const samples = await saturn.api("GET", `${target.route}/runs/${source.run.id}/samples`);
  assert.equal(samples.items[0].sample.output, "<script>bad()</script>");
  assert.equal((await saturn.api("GET", `${target.route}/runs/${source.run.id}/labels`)).labels[JSON.stringify(["a", 0, ""])].label, "Wrong");
  const content = await saturn.api("GET", `${target.route}/artifacts/${source.artifact.id}/content`);
  assert.equal(Buffer.from(content.data, "base64").toString(), '{"values":[1,2]}');
  assert.equal(await readFile(path.join(target.folder, ".saturn/research/runs", source.run.id, "stdout.log"), "utf8"), "measured\n");
  assert.equal((await saturn.api("POST", `${target.route}/bundles/import`, { path: "study.saturn.json" })).imported, 0);
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
  const exported = await saturn.api("POST", `${source.route}/bundles/export`, {});
  const original = JSON.parse(await readFile(path.join(source.folder, exported.path), "utf8"));
  const target = await project();
  async function rejected(bundle, status) {
    await writeFile(path.join(target.folder, "bad.json"), JSON.stringify(bundle));
    assert.equal((await saturn.call("POST", `${target.route}/bundles/import`, { path: "bad.json" })).status, status);
    assert.deepEqual((await saturn.api("GET", `${target.route}/experiments`)).items, []);
  }
  const tampered = structuredClone(original); tampered.files[0].data = Buffer.from("changed").toString("base64"); await rejected(tampered, 422);
  const escape = structuredClone(original); escape.files[0].path = "../outside.json"; await rejected(escape, 403);
  const secret = structuredClone(original); secret.files[0].path = "policy.json"; await rejected(secret, 403);
  await writeFile(path.join(target.folder, "changed.json"), JSON.stringify(original));
  assert.equal((await saturn.call("POST", `${target.route}/bundles/import`, { path: "changed.json", expectedSha256: "stale-preview" })).status, 409);
  const root = path.join(target.folder, ".saturn/research/models"); await mkdir(root, { recursive: true });
  // A conflict in the last file must also leave earlier records untouched.
  const last = original.files.at(-1); const collision = path.join(target.folder, ".saturn/research", last.path); await mkdir(path.dirname(collision), { recursive: true }); await writeFile(collision, "different");
  await rejected(original, 409);
  assert.equal(await readFile(collision, "utf8"), "different");
});

test("a bundle cannot attach evidence to a run the project already has", async () => {
  const source = await study();
  const exported = await saturn.api("POST", `${source.route}/bundles/export`, { path: "exports/study.saturn.json" });
  const bundle = JSON.parse(await readFile(path.join(source.folder, exported.path)));
  // Only an inspection for that run, under a name the project does not have yet: no run comes with it.
  bundle.files = bundle.files.filter((file) => file.path.startsWith(`runs/${source.run.id}/inside/`)).map((file) => ({ ...file, path: file.path.replace("inspect-abcd", "inspect-ffff") }));
  assert.equal(bundle.files.length, 1);
  await writeFile(path.join(source.folder, "attach.saturn.json"), JSON.stringify(bundle));
  const refused = await saturn.call("POST", `${source.route}/bundles/import`, { path: "attach.saturn.json" });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error, /already has, and the bundle does not carry that run/);
  const inside = await readdir(path.join(source.folder, ".saturn/research/runs", source.run.id, "inside"));
  assert.deepEqual(inside, ["inspect-abcd.json"], "nothing was added");
});

test("active jobs import as archived interrupted evidence, never as launch instructions", async () => {
  const source = await study();
  const model = await saturn.api("POST", `${source.route}/models`, { source: "org/model", weightsRevision: "fixed" });
  await saturn.api("PUT", `${source.route}/environment`, { python: process.execPath });
  const session = await saturn.api("POST", `${source.route}/inspection-sessions`, { modelIds: [model.id] });
  const experiment = await saturn.api("POST", `${source.route}/experiments`, { title: "Executable locally", command: "node -e 'process.exit(0)'", inputs: {} });
  const version = await saturn.api("POST", `${source.route}/experiments/${experiment.id}/versions`, {});
  const runPath = path.join(source.folder, ".saturn/research/runs", source.run.id, "run.json");
  const run = JSON.parse(await readFile(runPath, "utf8"));
  run.status = "running"; run.remote = { host: "never-connect", workdir: "/never", program: "not-a-program" }; await writeFile(runPath, JSON.stringify(run));
  const exported = await saturn.api("POST", `${source.route}/bundles/export`, {});
  const target = await project(); await writeFile(path.join(target.folder, "study.json"), await readFile(path.join(source.folder, exported.path)));
  const preview = await saturn.api("POST", `${target.route}/bundles/preview`, { path: "study.json" }); assert.equal(preview.activeRuns, 1);
  await saturn.api("POST", `${target.route}/bundles/import`, { path: "study.json" });
  const archived = await saturn.api("GET", `${target.route}/runs/${source.run.id}`);
  assert.equal(archived.status, "interrupted"); assert.equal(archived.archived, true);
  assert.equal((await saturn.api("GET", `${target.route}/remote`)).target, null);
  assert.equal((await saturn.call("POST", `${target.route}/versions/${version.id}/runs`, { clientId: "must-not-execute" })).status, 409);
  assert.equal((await saturn.call("POST", `${target.route}/inspection-sessions/${session.id}/actions`, { action: "prompts", modelId: model.id, clean: "a", corrupted: "b", expected: " x", alternative: " y" })).status, 409);
  const local = await saturn.api("POST", `${target.route}/experiments/${experiment.id}/versions`, {});
  assert.notEqual(local.id, version.id);
  assert.equal(local.archived, undefined);
  assert.equal(local.number, version.number + 1);
  assert.equal((await saturn.api("POST", `${target.route}/experiments/${experiment.id}/versions`, {})).id, local.id);
});

test("exports and imports refuse links and leave missing external data explicit", async () => {
  const source = await study();
  await saturn.api("POST", `${source.route}/models`, { source: "org/model", weightsRevision: "fixed" });
  await saturn.api("POST", `${source.route}/artifacts/register`, { kind: "reference", uri: "s3://bucket/activations" });
  const exported = await saturn.api("POST", `${source.route}/bundles/export`, {});
  const bundle = JSON.parse(await readFile(path.join(source.folder, exported.path), "utf8"));
  assert.ok(bundle.external.some((item) => item.kind === "model_weights"));
  assert.ok(bundle.external.some((item) => item.kind === "artifact_reference"));
  if (process.platform !== "win32") {
    const target = await project(); await writeFile(path.join(target.folder, "study.json"), JSON.stringify(bundle));
    const outside = await saturn.folder(); await mkdir(path.join(target.folder, ".saturn/research"), { recursive: true });
    await symlink(outside, path.join(target.folder, ".saturn/research/runs"));
    assert.equal((await saturn.call("POST", `${target.route}/bundles/import`, { path: "study.json" })).status, 403);
    assert.deepEqual(await readdir(outside), []);
  }
});
