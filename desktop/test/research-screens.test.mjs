// The rules behind the screens that add things up: where a score comes from, what two versions hold fixed, and what
// changed since a visit. Node runs the domain file as it is, so only a module without imports can be tested here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesText, changedSince, comparisonFactors, devicesText, durationText, heldFixed, lastActive, reviewProgress, scoreSources, throughput } from "../src/domain/research.ts";

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
