// The research assistant's tools for the newer workflow: imported results, paired comparisons and counterexample sets,
// kept outputs, bundles, inspection sessions, the SSH host and notebooks. docs/research-contract.md says what an agent may do.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench } from "./files-support.mjs";

let saturn;
before(async () => { saturn = await bench(); });
after(async () => { await saturn?.stop(); });

/** A project chat whose agent has the research tools. */
async function bed(files = {}) {
  const folder = await saturn.folder();
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(folder, name), content);
  const setup = await saturn.chat(folder, { mcpConnectionIds: ["research"] });
  return { ...setup, folder, route: `/projects/${setup.project.id}/research` };
}

/** One tool call and what came of it. */
async function call(setup, name, args) {
  const run = await setup.turn([[name, args]]);
  const action = run.actions.at(-1);
  assert.equal(action.status, "completed", action.reason);
  return action.result;
}

/** The same, for a call that must be refused. */
async function refused(setup, name, args) {
  const run = await setup.turn([[name, args]]);
  const action = run.actions.at(-1);
  assert.equal(action.status, "failed", JSON.stringify(action.result));
  return action.reason;
}

/** Result rows in a file of the person's own, with stable IDs. */
const rows = (scores) => scores.map((score, index) => JSON.stringify({ id: `s-${index}`, prompt: `p${index}`, answer: "a", correct: score })).join("\n") + "\n";

test("results come in through a preview, are marked imported, and compare sample by sample", async () => {
  const setup = await bed({ "old.jsonl": rows([0, 1, 0, 1]), "new.jsonl": rows([1, 1, 0, 0]) });
  const columns = { sampleId: "id", input: "prompt", output: "answer" };
  const preview = await call(setup, "research_read", { what: "import_preview", path: "old.jsonl", columns, scoreColumns: ["correct"] });
  assert.equal(preview.samples, 4);
  assert.deepEqual(await saturn.api("GET", `${setup.route}/runs`).then((runs) => runs.items), [], "a preview writes nothing");

  const left = await call(setup, "research_evidence", { action: "import", path: "old.jsonl", columns, scoreColumns: ["correct"], title: "Old", expectedSha256: preview.provenance.sha256 });
  const right = await call(setup, "research_evidence", { action: "import", path: "new.jsonl", columns, scoreColumns: ["correct"], title: "New" });
  assert.equal(left.run.status, "completed");
  assert.equal(left.version.imported, true);
  assert.equal(left.experiment.imported, true);

  const request = { left: { runId: left.run.id }, right: { runId: right.run.id }, scorer: "correct" };
  const paired = await call(setup, "research_read", { what: "paired", ...request, save: true });
  assert.equal(paired.summary.improved, 1);
  assert.equal(paired.summary.regressed, 1);
  assert.equal(paired.summary.interval95, null, "imports never get an interval");
  assert.equal(paired.saved, undefined, "reading a comparison keeps nothing");
  assert.deepEqual((await saturn.api("GET", `${setup.route}/counterexample_sets`)).items, []);

  const saved = await call(setup, "research_evidence", { action: "save_counterexamples", ...request, title: "Lost" });
  assert.deepEqual(saved.saved.members.map((member) => member.sampleId), ["s-3"]);
  assert.equal((await saturn.api("GET", `${setup.route}/counterexample_sets`)).items[0].title, "Lost");
});

test("a kept output is a snapshot with its hash, and a bundle is previewed before it comes in", async () => {
  const setup = await bed({ "result.json": JSON.stringify({ layer: 3, effect: 0.4 }), "old.jsonl": rows([1, 0]) });
  const kept = await call(setup, "research_evidence", { action: "artifact_register", kind: "json", path: "result.json", title: "Patching" });
  assert.match(kept.sha256, /^[0-9a-f]{64}$/);
  const listed = await call(setup, "research_read", { what: "list", collection: "artifacts" });
  assert.deepEqual(listed.items.map((item) => item.title), ["Patching"]);
  const content = await call(setup, "research_read", { what: "artifact", id: kept.id });
  assert.equal(content.sha256, kept.sha256);
  assert.match(Buffer.from(content.data, "base64").toString("utf8"), /effect/);

  await call(setup, "research_evidence", { action: "import", path: "old.jsonl", columns: { sampleId: "id", input: "prompt", output: "answer" }, scoreColumns: ["correct"] });
  const exported = await call(setup, "research_evidence", { action: "bundle_export", path: "exports/study.saturn.json" });
  assert.match(JSON.stringify(exported), /study\.saturn\.json/);
  const preview = await call(setup, "research_read", { what: "bundle_preview", path: "exports/study.saturn.json" });
  assert.equal(preview.conflicts?.length ?? 0, 0, JSON.stringify(preview).slice(0, 400));
});

test("the SSH host is the person's: the assistant reads it and is refused a start without one", async () => {
  const setup = await bed();
  const remote = await call(setup, "research_read", { what: "remote" });
  assert.ok(!remote.target, JSON.stringify(remote));
  const question = await call(setup, "research_write", { collection: "questions", fields: { title: "Q" } });
  const experiment = await call(setup, "research_write", { collection: "experiments", fields: { title: "E", command: "node run.mjs", questionId: question.id } });
  await writeFile(path.join(setup.folder, "run.mjs"), "");
  const { version } = await call(setup, "research_run", { action: "freeze", experiment: experiment.id });
  assert.match(await refused(setup, "research_remote", { action: "start", version: version.id }), /host|SSH|remote/i);
  assert.match(await refused(setup, "research_remote", { action: "configure" }), /no action "configure"/);
});

test("inspection sessions and notebooks are reached through the tools, and say what they need", async () => {
  const setup = await bed({ "explore.ipynb": JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }) });
  assert.match(await refused(setup, "research_inspect", { action: "session", title: "Look" }), /1 to 32 project models/);
  assert.match(await refused(setup, "research_inspect", { action: "features", modelId: "m", prompt: "a", layer: 1 }), /runId/);
  const status = await call(setup, "research_read", { what: "notebook", path: "explore.ipynb" });
  assert.ok(status && typeof status === "object");
  assert.match(await refused(setup, "research_notebook", { action: "run", path: "explore.ipynb" }), /cells/);
});

test("an Ask chat reads the new things and is refused every new tool that writes", async () => {
  const setup = await bed({ "old.jsonl": rows([1]) });
  await saturn.api("PATCH", `/threads/${setup.thread.id}`, { chatMode: "manual" });
  await call(setup, "research_read", { what: "remote" });
  await call(setup, "research_read", { what: "import_preview", path: "old.jsonl", columns: { sampleId: "id", input: "prompt", output: "answer" }, scoreColumns: ["correct"] });
  for (const [name, args] of [
    ["research_evidence", { action: "import", path: "old.jsonl" }],
    ["research_remote", { action: "check" }],
    ["research_notebook", { action: "stop", path: "x.ipynb" }],
  ]) {
    const run = await setup.turn([[name, args]]);
    assert.notEqual(run.actions.at(-1).status, "completed", name);
  }
  assert.deepEqual((await saturn.api("GET", `${setup.route}/runs`)).items, []);
});
