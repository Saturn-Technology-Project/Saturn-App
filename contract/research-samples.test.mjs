// Reading samples: one sample across runs, a person's labels kept apart from scores, and pages while a run still writes.
// docs/research-contract.md is the contract.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench, posixOnly, until } from "./files-support.mjs";

let saturn;
before(async () => { saturn = await bench(); });
after(async () => { await saturn?.stop(); });

const evaluation = { dataset: "ioi", split: "test", sampleSet: "all", scorer: "name-logit", promptFormat: "continuation", chatTemplate: null, generation: {} };
const line = (id, fields = {}) => `${JSON.stringify({ schemaVersion: 1, sampleId: id, input: "i", output: "o", scores: { s: 1 }, ...fields })}\n`;
const script = (lines) => `
import { appendFileSync } from "node:fs";
for (const text of ${JSON.stringify(lines)}) appendFileSync(process.env.SATURN_RUN_SAMPLES, text);
`;

/** A project; `run` freezes and runs these lines with this evaluation. */
async function project() {
  const folder = await saturn.folder();
  const made = await saturn.api("POST", "/projects", { path: folder });
  await saturn.api("POST", `/projects/${made.id}/access`, {});
  const route = `/projects/${made.id}/research`;
  let count = 0;
  const run = async (lines, spec = evaluation) => {
    count += 1;
    const file = `probe${count}.mjs`;
    await writeFile(path.join(folder, file), script(lines));
    const experiment = await saturn.api("POST", `${route}/experiments`, { title: "E", command: `node ${file}`, evaluation: spec });
    const version = await saturn.api("POST", `${route}/experiments/${experiment.id}/versions`, {});
    const started = await saturn.api("POST", `${route}/versions/${version.id}/runs`, { clientId: `c${count}` });
    return until("the run to end", () => saturn.api("GET", `${route}/runs/${started.id}`), (item) => !["starting", "running", "stopping"].includes(item.status));
  };
  return { folder, route, run };
}

test("one sample across runs, with a reason where they cannot be compared", posixOnly, async () => {
  const { route, run } = await project();
  const base = await run([line("a", { output: "Mary" }), line("b")]);
  const tuned = await run([line("a", { output: "John" })]);
  const templated = await run([line("a", { output: "Hello" })], { ...evaluation, chatTemplate: "chatml" });
  const missing = await run([line("z")]);
  const { rows } = await saturn.api("GET", `${route}/samples/a?runs=${[base.id, tuned.id, templated.id, missing.id].join(",")}`);
  assert.deepEqual(rows.map((row) => row.samples.map((item) => item.output)), [["Mary"], ["John"], ["Hello"], []]);
  assert.deepEqual(rows.map((row) => row.comparison.result), ["comparable", "comparable", "not_comparable", "comparable"]);
  assert.deepEqual(rows[2].comparison.differs, ["chatTemplate"]);
});

test("a label never changes the samples, and is kept in its own file", posixOnly, async () => {
  const { route, folder, run } = await project();
  const done = await run([line("a"), line("b")]);
  const samplesFile = path.join(folder, ".saturn/research/runs", done.id, "samples.jsonl");
  const before = await readFile(samplesFile, "utf8");
  const saved = await saturn.api("POST", `${route}/runs/${done.id}/labels`, { sampleId: "a", label: "Wrong name", note: "the scorer missed it" });
  assert.equal(saved.label, "Wrong name");
  assert.equal(await readFile(samplesFile, "utf8"), before);
  assert.deepEqual(await saturn.api("GET", `${route}/runs/${done.id}`), done);
  const file = JSON.parse(await readFile(path.join(folder, ".saturn/research/labels", `${done.id}.json`), "utf8"));
  assert.equal(Object.values(file.labels)[0].note, "the scorer missed it");
  assert.equal((await saturn.call("POST", `${route}/runs/${done.id}/labels`, { sampleId: "a" })).status, 400);
  assert.equal((await saturn.call("POST", `${route}/runs/${done.id}/labels`, { label: "x" })).status, 400);
  assert.equal((await saturn.call("POST", `${route}/runs/run_nothere/labels`, { sampleId: "a", label: "x" })).status, 404);
});

test("relabeling replaces the earlier label, and labels on one sample do not leak to another trial", posixOnly, async () => {
  const { route, run } = await project();
  const done = await run([line("a"), line("a", { trial: 1 })]);
  await saturn.api("POST", `${route}/runs/${done.id}/labels`, { sampleId: "a", label: "First" });
  await saturn.api("POST", `${route}/runs/${done.id}/labels`, { sampleId: "a", label: "Second" });
  await saturn.api("POST", `${route}/runs/${done.id}/labels`, { sampleId: "a", trial: 1, label: "Other" });
  const { labels } = await saturn.api("GET", `${route}/runs/${done.id}/labels`);
  assert.deepEqual(Object.values(labels).map((item) => [item.trial, item.label]).sort(), [[0, "Second"], [1, "Other"]]);
});

test("many labels at once all land", posixOnly, async () => {
  const { route, run } = await project();
  const ids = Array.from({ length: 10 }, (_, index) => `s${index}`);
  const done = await run(ids.map((id) => line(id)));
  await Promise.all(ids.map((sampleId) => saturn.api("POST", `${route}/runs/${done.id}/labels`, { sampleId, label: "ok" })));
  const { labels } = await saturn.api("GET", `${route}/runs/${done.id}/labels`);
  assert.equal(Object.keys(labels).length, 10);
});

test("agreement counts only samples the scorer labeled, in this run", posixOnly, async () => {
  const { route, run } = await project();
  const done = await run([line("a", { scorerLabel: "Refused" }), line("b", { scorerLabel: "Refused" }), line("c"), line("d", { scorerLabel: "Refused" })]);
  const label = (sampleId, value) => saturn.api("POST", `${route}/runs/${done.id}/labels`, { sampleId, label: value });
  await label("a", "Refused");
  await label("b", "Not refused");
  await label("c", "Refused");
  await label("missing", "Refused");
  const { agreement } = await saturn.api("GET", `${route}/runs/${done.id}/labels`);
  assert.deepEqual(agreement, { labeled: 4, compared: 2, agreed: 1 });
});

test("pages read while a run writes never show half a line, and reach every sample once", posixOnly, async () => {
  const folder = await saturn.folder();
  await writeFile(path.join(folder, "probe.mjs"), `
    import { appendFileSync } from "node:fs";
    const text = "瑪麗".repeat(2000);
    let index = 0;
    const timer = setInterval(() => {
      const line = JSON.stringify({ schemaVersion: 1, sampleId: "s" + index++, output: text }) + "\\n";
      const bytes = Buffer.from(line);
      // In two writes, so a reader can catch the line unfinished.
      appendFileSync(process.env.SATURN_RUN_SAMPLES, bytes.subarray(0, 100));
      setTimeout(() => appendFileSync(process.env.SATURN_RUN_SAMPLES, bytes.subarray(100)), 2);
      if (index === 40) { clearInterval(timer); }
    }, 8);
  `);
  const made = await saturn.api("POST", "/projects", { path: folder });
  await saturn.api("POST", `/projects/${made.id}/access`, {});
  const route = `/projects/${made.id}/research`;
  const experiment = await saturn.api("POST", `${route}/experiments`, { title: "E", command: "node probe.mjs", inputs: { code: ["probe.mjs"] } });
  const version = await saturn.api("POST", `${route}/experiments/${experiment.id}/versions`, {});
  const started = await saturn.api("POST", `${route}/versions/${version.id}/runs`, { clientId: "x" });
  const seen = [];
  let cursor = 0;
  for (;;) {
    const current = await saturn.api("GET", `${route}/runs/${started.id}`);
    const page = await saturn.api("GET", `${route}/runs/${started.id}/samples?cursor=${cursor}&limit=7`);
    for (const item of page.items) {
      assert.ok(item.sample, JSON.stringify(item).slice(0, 200));
      seen.push(item.sample.sampleId);
      cursor = item.offset + Buffer.byteLength(`${JSON.stringify(item.sample)}\n`);
    }
    if (page.next !== null) cursor = page.next;
    if (!["starting", "running", "stopping"].includes(current.status) && page.next === null && page.items.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(seen, Array.from({ length: 40 }, (_, index) => `s${index}`));
});

test("a counterexample is a record that names its run and sample", async () => {
  const { route } = await project();
  assert.equal((await saturn.call("POST", `${route}/counterexamples`, { note: "no sample" })).status, 400);
  const kept = await saturn.api("POST", `${route}/counterexamples`, { runId: "run_x", sampleId: "a", note: "indirect" });
  assert.equal((await saturn.api("GET", `${route}/counterexamples`)).items[0].id, kept.id);
});
