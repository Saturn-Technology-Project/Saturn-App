// The rules behind the screens that add things up: where a score comes from, what two versions hold fixed, and what
// changed since a visit. Node runs the domain file as it is, so only a module without imports can be tested here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { browserHost, removalQuestion } from "../src/domain/model.ts";
import { bytesText, changedSince, changeRereadsList, comparisonFactors, devicesText, durationText, earlierSweeps, heldFixed, kitState, labelsOf, lastActive, mechanismOf, readSamplePages, restoredByLayer, reviewProgress, runnableVersion, runOfExperiment, scoreSources, tabAfterClosing, scorerSaysWrong, sweepMeasure, throughput } from "../src/domain/research.ts";

test("removing a connection says who uses it and what becomes of them", () => {
  assert.equal(removalQuestion("A", [], "model", "B"), "Remove A?");
  assert.equal(removalQuestion("A", ["Research assistant"], "model", "B"), "Remove A? Research assistant uses it and will move to B.");
  assert.equal(removalQuestion("A", ["Research assistant", "Old"], "model", null), "Remove A? Research assistant and Old use it and will have no model until you connect another.");
  assert.equal(removalQuestion("A", ["One", "Two", "Three"], "model", "B"), "Remove A? One and 2 other agents use it and will move to B.");
  assert.equal(removalQuestion("S", ["One"], "server", null), "Remove S? One uses it and will no longer have its tools.");
});

const point = (elapsedMs, samplesLines, outputTokens = 0) => ({ at: "", elapsedMs, cpuPercent: 1, memoryBytes: 1, processes: 1, samplesBytes: 0, samplesLines, inputTokens: 0, outputTokens, deviceMemoryBytes: null, gpus: null });

test("throughput is a count per second over the newest readings, and nothing until time has passed", () => {
  assert.equal(throughput([]), null);
  assert.equal(throughput([point(0, 0)]), null);
  assert.equal(throughput([point(0, 0), point(2000, 4)]), 2);
  assert.equal(throughput([point(0, 0), point(2000, 100), point(4000, 104)], 2), 2);
  assert.equal(throughput([point(0, 0, 0), point(4000, 1, 200)], 10, (item) => item.outputTokens), 50);
  assert.equal(bytesText(512), "512 B");
  assert.equal(bytesText(1536), "1.5 KB");
  assert.equal(bytesText(200 * 1024 * 1024), "200 MB");
  assert.equal(bytesText(null), "—");
  assert.equal(durationText(42_000), "42s");
  assert.equal(durationText(3_725_000), "1h 2m");
});

test("a kit is installed, partly installed or missing by what the last check saw", () => {
  const kit = (installed) => ({ id: "k", title: "", what: "", bundled: false, packages: installed.map((version, index) => ({ name: `p${index}`, installed: version })) });
  assert.equal(kitState(kit(["1", "2"])), "installed");
  assert.equal(kitState(kit(["1", null])), "partly");
  assert.equal(kitState(kit([null, null])), "missing");
});

test("throughput never crosses a samples file rewrite", () => {
  const readings = [point(0, 100), { ...point(2000, 2), samplesRewrites: 1 }];
  assert.equal(throughput(readings), null);
  assert.equal(throughput([...readings, { ...point(4000, 8), samplesRewrites: 1 }]), 3);
});

test("what an environment can compute on is said from what torch reported", () => {
  const report = (devices) => ({ executable: "", version: "", platform: "", cpus: 1, packages: {}, devices });
  assert.equal(devicesText(null), "Not checked yet");
  assert.equal(devicesText(report({ torch: null, reason: "torch could not be imported: no module" })), "torch could not be imported: no module");
  assert.equal(devicesText(report({ torch: "2.5", cuda: true, cudaDevices: ["A100"], mps: false })), "CUDA: A100");
  assert.equal(devicesText(report({ torch: "2.5", cuda: false, mps: true })), "Apple MPS");
  assert.equal(devicesText(report({ torch: "2.5", cuda: false, mps: false })), "CPU only");
});

const summary = {
  runId: "run_1",
  versionId: "version_1",
  status: "completed",
  models: [
    { modelId: "a", samples: 10, errors: { infrastructure: 1 }, scores: { correct: { mean: 0.8, count: 9, notNumbers: 0 } } },
    { modelId: "b", samples: 10, errors: { scorer: 2 }, scores: { correct: { mean: 0.5, count: 8, notNumbers: 0 } } },
  ],
};
const labels = { labels: {}, agreement: { labeled: 5, compared: 4, agreed: 3 } };

test("a score comes from the samples the scorer judged, less every error, and a dispute is a label the scorer disagrees with", () => {
  assert.deepEqual(scoreSources(summary, labels), { scored: 17, reviewed: 5, disputed: 1, infrastructure: 1, otherErrors: 2 });
  assert.deepEqual(scoreSources(summary, null), { scored: 17, reviewed: 0, disputed: 0, infrastructure: 1, otherErrors: 2 });
  assert.deepEqual(reviewProgress(summary, labels), { labeled: 5, total: 17 });
  assert.deepEqual(reviewProgress(null, null), { labeled: 0, total: 0 });
});

test("held fixed is what a version states and a comparison did not fault; an empty chat template counts as stated", () => {
  const spec = { dataset: "ioi", split: "all", scorer: "logit", promptFormat: "", chatTemplate: null, generation: {} };
  assert.deepEqual(
    heldFixed(spec, { result: "not_comparable", differs: ["scorer"], missing: ["sampleSet"] }).map((item) => item.field),
    ["dataset", "split"],
  );
  assert.deepEqual(
    comparisonFactors(spec, { result: "not_comparable", differs: ["scorer"], missing: [] }).map((item) => `${item.field}:${item.state}`),
    ["dataset:same", "split:same", "sampleSet:missing", "scorer:differs", "promptFormat:missing", "chatTemplate:missing"],
  );
});

test("what changed since a visit comes newest first, and the last activity is the newest change anywhere", () => {
  const items = [{ updatedAt: "2026-01-01T00:00:00Z" }, { updatedAt: "2026-03-01T00:00:00Z" }, { updatedAt: "2026-02-01T00:00:00Z" }];
  assert.deepEqual(changedSince(items, "2026-01-15T00:00:00Z").map((item) => item.updatedAt), ["2026-03-01T00:00:00Z", "2026-02-01T00:00:00Z"]);
  assert.equal(changedSince(items, null).length, 3);
  assert.equal(lastActive([items, [{ updatedAt: "2026-04-01T00:00:00Z" }]]), "2026-04-01T00:00:00Z");
  assert.equal(lastActive([[]]), null);
});

test("a layer restores a sample when the patched model ends on the expected token, and the scorer's wrong is read from a false score or its word", () => {
  const sample = (expected, tops) => ({ sampleId: "s", expected, top: "x", expectedLogProb: null, byLayer: tops.map((top, layer) => ({ layer, top, expectedLogProb: null })) });
  const view = { sourceModelId: "a", targetModelId: "b", layers: [0, 1, 2], samples: [sample(" Mary", ["x", " Mary", " Mary"]), sample(" John", [" John", "x", " John"]), sample(null, [" Mary", " Mary", " Mary"])] };
  assert.deepEqual(restoredByLayer(view), [1, 1, 2]);
  assert.equal(scorerSaysWrong({ sampleId: "s", scores: { correct: false } }), true);
  assert.equal(scorerSaysWrong({ sampleId: "s", scores: { correct: true } }), false);
  assert.equal(scorerSaysWrong({ sampleId: "s", scores: { score: 0.1 }, scorerLabel: "Wrong name" }), true);
  assert.equal(scorerSaysWrong({ sampleId: "s", scores: { correct: false }, error: { kind: "scorer" } }), false);
});

test("a node's mechanism is each sweep into it with its best layer, and label names fall back to the plain set", () => {
  const sweep = (target, tops) => ({ kind: "sweep", sourceModelId: "a", targetModelId: target, layers: [0, 1], samples: [{ sampleId: "s", expected: " x", top: "y", expectedLogProb: null, byLayer: tops.map((top, layer) => ({ layer, top, expectedLogProb: null })) }], recordedAt: "t" });
  const items = [sweep("b", ["y", " x"]), sweep("c", [" x", " x"]), { kind: "reading", sampleId: "s", modelId: "b", measure: "", tokens: [], layers: [] }];
  assert.deepEqual(mechanismOf(items, "b"), [{ sourceModelId: "a", layers: [1], restored: 1, of: 1, measure: "top", recordedAt: "t" }]);
  assert.deepEqual(mechanismOf(items, "z"), []);
  assert.deepEqual(labelsOf(null), ["Correct", "Wrong", "Invalid", "Unsure"]);
  assert.deepEqual(labelsOf({ labels: [" Correct name ", "", "Wrong name"] }), ["Correct name", "Wrong name"]);
});

test("a mechanism reports every tied best layer, and no best layer when none restores a sample", () => {
  const sweep = { kind: "sweep", sourceModelId: "a", targetModelId: "b", layers: [2, 5, 8], samples: [
    { sampleId: "s", expected: " x", top: "y", expectedLogProb: null, byLayer: [{ layer: 2, top: " x" }, { layer: 5, top: "y" }, { layer: 8, top: " x" }] },
  ] };
  assert.deepEqual(mechanismOf([sweep], "b"), [{ sourceModelId: "a", layers: [2, 8], restored: 1, of: 1, measure: "top", recordedAt: undefined }]);
  assert.deepEqual(mechanismOf([{ ...sweep, samples: [{ ...sweep.samples[0], expected: " z" }] }], "b")[0].layers, []);
});

test("a sweep counts the margin when every sample has one, and only a current helper's sweep speaks for a model", () => {
  const at = (layer, top, margin) => ({ layer, top, expectedLogProb: null, margin });
  const margins = { kind: "sweep", current: true, sourceModelId: "a", targetModelId: "b", layers: [0, 1], samples: [{ sampleId: "s", expected: " x", alternative: " y", top: "the", expectedLogProb: null, margin: -1, byLayer: [at(0, "the", 0.5), at(1, " x", -0.2)] }] };
  assert.equal(sweepMeasure(margins), "margin");
  assert.deepEqual(restoredByLayer(margins), [1, 0], "ahead of the alternative counts, even when another word is on top");
  assert.deepEqual(restoredByLayer(margins, "top"), [0, 1]);
  const partly = { ...margins, samples: [...margins.samples, { sampleId: "t", expected: " x", top: "the", expectedLogProb: null, byLayer: [at(0, " x", null), at(1, "the", null)] }] };
  assert.equal(sweepMeasure(partly), "top", "a mix is not counted two ways");
  const stale = { ...margins, current: false, sourceModelId: "old" };
  assert.deepEqual(mechanismOf([stale, margins], "b").map((item) => [item.sourceModelId, item.layers, item.measure]), [["a", [0], "margin"]]);
  assert.equal(earlierSweeps([stale, margins], "b"), 1);
  assert.equal(earlierSweeps([stale, margins], "z"), 0);
});

test("the sample list reads every page, stops at its limit or when no longer wanted, and only disputes move with labels", async () => {
  const pages = { 0: { items: [{ offset: 0 }, { offset: 1 }], next: 2 }, 2: { items: [{ offset: 2 }, { offset: 3 }], next: 4 }, 4: { items: [{ offset: 4 }], next: null } };
  const read = async (cursor) => pages[cursor];
  const all = await readSamplePages(read);
  assert.deepEqual([all.items.length, all.next], [5, null]);
  const seen = [];
  await readSamplePages(read, { onPage: (page) => seen.push(page.next) });
  assert.deepEqual(seen, [2, 4, null]);
  const capped = await readSamplePages(read, { most: 2 });
  assert.deepEqual([capped.items.length, capped.next], [2, 2], "More goes on from here");
  const resumed = await readSamplePages(read, { from: capped.next });
  assert.equal(resumed.items.length, 3);
  let wanted = true;
  const stopped = await readSamplePages(async (cursor) => { wanted = false; return pages[cursor]; }, { live: () => wanted });
  assert.equal(stopped.items.length, 0, "a page for a list no longer shown is dropped");
  assert.deepEqual(["all", "errors", "disputed"].map(changeRereadsList), [false, false, true]);
});

test("a run here starts from the newest version frozen here, and an experiment bar speaks only of its own experiment's run", () => {
  const version = (id, fields = {}) => ({ id, ...fields });
  assert.equal(runnableVersion([version("v1"), version("v2"), version("v3", { archived: true })]).id, "v2", "an archived version is not run");
  assert.equal(runnableVersion([version("v1"), version("v2", { imported: true })]).id, "v1", "nor one that came from elsewhere");
  assert.equal(runnableVersion([]), undefined);
  const run = { id: "r", experimentId: "e1" };
  assert.equal(runOfExperiment(run, "e1"), run);
  assert.equal(runOfExperiment(run, "e2"), null, "another experiment's run is not this one's");
  assert.equal(runOfExperiment(run, null), run, "before an experiment is chosen, the run there is");
  assert.equal(runOfExperiment(null, "e1"), null);
});

test("the browser tab names the host of the assistant's page, and nothing for a blank one", () => {
  assert.equal(browserHost("https://arxiv.org/abs/2401.00001?x=1#a"), "arxiv.org");
  assert.equal(browserHost("http://127.0.0.1:8080/page"), "127.0.0.1:8080");
  assert.equal(browserHost("about:blank"), "");
  assert.equal(browserHost(""), "");
  assert.equal(browserHost(undefined), "");
});

test("closing a tab shows the one that took its place, or the one before the last", () => {
  assert.equal(tabAfterClosing(["a", "b", "c"], "b"), "c");
  assert.equal(tabAfterClosing(["a", "b", "c"], "c"), "b");
  assert.equal(tabAfterClosing(["a"], "a"), undefined);
  assert.equal(tabAfterClosing(["a", "b"], "z"), undefined, "a tab that is not there changes nothing");
});
