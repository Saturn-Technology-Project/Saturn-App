// Analysis outputs are immutable snapshots or explicit external references, never executable previews.
import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench, sha } from "./files-support.mjs";

let saturn;
before(async () => { saturn = await bench(); });
after(async () => { await saturn?.stop(); });
async function setup() {
  const folder = await saturn.folder();
  const project = await saturn.api("POST", "/projects", { path: folder, grant: true });
  return { folder, route: `/projects/${project.id}/research` };
}

test("JSON and notebook artifacts retain a content hash and a snapshot when their source changes", async () => {
  const { folder, route } = await setup();
  const body = JSON.stringify({ framework: "TransformerLens", values: [1, 2] });
  await writeFile(path.join(folder, "analysis.json"), body);
  const artifact = await saturn.api("POST", `${route}/artifacts/register`, { path: "analysis.json", kind: "json", metadata: { framework: "TransformerLens", hook: "resid_post" } });
  assert.equal(artifact.sha256, sha(body)); assert.equal(artifact.packaged, true);
  await writeFile(path.join(folder, "analysis.json"), "changed");
  const content = await saturn.api("GET", `${route}/artifacts/${artifact.id}/content`);
  assert.equal(Buffer.from(content.data, "base64").toString(), body);
  assert.equal(content.sourceChanged, true);
  const notebook = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] });
  await writeFile(path.join(folder, "analysis.ipynb"), notebook);
  const note = await saturn.api("POST", `${route}/artifacts/register`, { path: "analysis.ipynb", kind: "notebook" });
  assert.equal(note.sourcePath, "analysis.ipynb");
  assert.equal((await saturn.api("GET", `${route}/artifacts`)).items.length, 2);
  assert.equal(await readFile(path.join(folder, "analysis.ipynb"), "utf8"), notebook);
});

test("external activation stores stay references and do not trigger a network request or copy", async () => {
  const { route } = await setup();
  const artifact = await saturn.api("POST", `${route}/artifacts/register`, { kind: "reference", uri: "s3://research/activations.safetensors", metadata: { framework: "SAELens" } });
  assert.equal(artifact.packaged, false); assert.equal(artifact.hashVerified, false);
  assert.equal((await saturn.call("GET", `${route}/artifacts/${artifact.id}/content`)).status, 404);
  assert.equal((await saturn.call("POST", `${route}/artifacts/register`, { kind: "reference", uri: "https://host/file?token=not-a-real-secret" })).status, 400);
});

test("a run's plain JSONL artifact manifest is imported atomically and idempotently", async () => {
  const { folder, route } = await setup();
  await writeFile(path.join(folder, "old.jsonl"), '{"sampleId":"a"}\n');
  const { run } = await saturn.api("POST", `${route}/imports`, { path: "old.jsonl" });
  const outputs = path.join(folder, ".saturn/research/runs", run.id);
  await writeFile(path.join(outputs, "analysis.json"), '{"values":[1]}');
  // A training program lists its checkpoints in the same manifest, for resuming; they are not analysis outputs.
  await writeFile(path.join(outputs, "artifacts.jsonl"), '{"kind":"checkpoint","path":"checkpoints/step-100","step":100}\n{"path":"analysis.json","kind":"json"}\n');
  const first = await saturn.api("POST", `${route}/artifacts/from-run`, { runId: run.id });
  const second = await saturn.api("POST", `${route}/artifacts/from-run`, { runId: run.id });
  assert.equal(first.items.length, 1); assert.equal(first.items[0].id, second.items[0].id);
  await writeFile(path.join(outputs, "artifacts.jsonl"), '{"path":"analysis.json","kind":"json"}\n{"path":"../../../../outside","kind":"json"}\n');
  assert.equal((await saturn.call("POST", `${route}/artifacts/from-run`, { runId: run.id })).status, 403);
  assert.equal((await saturn.api("GET", `${route}/artifacts`)).items.length, 1);
});

test("artifact readers refuse path escapes, links, HTML and incorrectly named images", async () => {
  const { folder, route } = await setup();
  await writeFile(path.join(folder, "wrong.png"), "<script>bad()</script>");
  assert.equal((await saturn.call("POST", `${route}/artifacts/register`, { path: "wrong.png", kind: "figure" })).status, 415);
  await writeFile(path.join(folder, "page.html"), "<h1>not rendered</h1>");
  assert.equal((await saturn.call("POST", `${route}/artifacts/register`, { path: "page.html", kind: "html" })).status, 400);
  assert.equal((await saturn.call("POST", `${route}/artifacts/register`, { path: "../outside.json", kind: "json" })).status, 403);
  if (process.platform !== "win32") {
    const outside = await saturn.folder(); await writeFile(path.join(outside, "data.json"), "{}");
    await symlink(path.join(outside, "data.json"), path.join(folder, "link.json"));
    assert.equal((await saturn.call("POST", `${route}/artifacts/register`, { path: "link.json", kind: "json" })).status, 403);
  }
});

test("a document artifact keeps a PDF or a text file such as a model card, and refuses HTML", async () => {
  const { folder, route } = await setup();
  await writeFile(path.join(folder, "card.md"), "# Model card\n\nTrained on …");
  const card = await saturn.api("POST", `${route}/artifacts/register`, { path: "card.md", kind: "document" });
  assert.equal(card.mime, "text/markdown"); assert.equal(card.packaged, true);
  await writeFile(path.join(folder, "paper.pdf"), "%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
  const paper = await saturn.api("POST", `${route}/artifacts/register`, { path: "paper.pdf", kind: "document" });
  assert.equal(paper.mime, "application/pdf");
  assert.equal((await saturn.api("GET", `${route}/artifacts/${paper.id}/content`)).mime, "application/pdf");
  await writeFile(path.join(folder, "page.html"), "<!doctype html><p>no</p>");
  assert.equal((await saturn.call("POST", `${route}/artifacts/register`, { path: "page.html", kind: "document" })).status, 415);
  await writeFile(path.join(folder, "main.tex"), "\\documentclass{article}");
  assert.equal((await saturn.api("POST", `${route}/artifacts/register`, { path: "main.tex", kind: "document" })).mime, "text/x-tex");
});
