// The research interface's rules that are worth holding on their own: how a lineage is laid
// out, and how a comparison is said. Everything else is checked over HTTP in contract/.
import assert from "node:assert/strict";
import { test } from "node:test";
import { comparisonText, controlCeiling, lineageOrder, lineageRows, promptPatchText, readingDifference, runHasResults, sampleIdParts, scoreText, strongestPatch } from "../src/domain/research.ts";

const model = (id, parentId) => ({ id, parentId, source: id, floating: false, revision: 1, createdAt: "", updatedAt: "" });

test("a line of checkpoints stays at one depth, and only a real branch goes in a level", () => {
  const models = [model("a"), model("b", "a"), model("c", "b"), model("sft", "c"), model("sft2", "c"), model("dpo", "sft"), model("other")];
  assert.deepEqual(
    lineageRows(models).map((row) => [row.model.id, row.depth, row.branch]),
    [["a", 0, false], ["b", 0, false], ["c", 0, false], ["sft", 1, true], ["dpo", 1, false], ["sft2", 1, true], ["other", 0, false]],
  );
  const long = Array.from({ length: 200 }, (_, index) => model(`step${index}`, index ? `step${index - 1}` : undefined));
  assert.ok(lineageRows(long).every((row) => row.depth === 0));
});

test("a model whose parent is gone starts a line rather than disappearing", () => {
  assert.deepEqual(lineageRows([model("orphan", "gone")]).map((row) => [row.model.id, row.depth]), [["orphan", 0]]);
  assert.deepEqual(lineageOrder([model("orphan", "gone"), model("child", "orphan")]).map((item) => item.depth), [0, 1]);
});

test("a comparison says why not", () => {
  assert.equal(comparisonText({ result: "comparable", differs: [], missing: [] }), "Measured the same way");
  assert.match(comparisonText({ result: "not_comparable", differs: ["scorer", "chatTemplate"], missing: [] }), /scorer, chatTemplate/);
  assert.match(comparisonText({ result: "unknown", differs: [], missing: ["split"] }), /split not stated/);
});

test("a run that wrote samples has results, even if it did not finish cleanly", () => {
  assert.deepEqual(["completed", "stopped", "interrupted", "protocol_error"].map(runHasResults), [true, true, true, true]);
  assert.deepEqual(["running", "starting", "failed"].map(runHasResults), [false, false, false]);
});

test("a score keeps enough digits and says when there is none", () => {
  assert.equal(scoreText(0.123456), "0.123");
  assert.equal(scoreText(0), "0");
  assert.equal(scoreText(null), "No score");
});

test("a long sample id keeps its end when the middle has to go", () => {
  assert.deepEqual(sampleIdParts("shuffled-lr0.0001-s0-step00020"), { start: "shuffled-lr0.0001-s0", end: "-step00020" });
  assert.deepEqual(sampleIdParts("sample_0412"), { start: "sample", end: "_0412" });
  assert.deepEqual(sampleIdParts("abcdefghijkl"), { start: "abcdef", end: "ghijkl" });
  assert.deepEqual(sampleIdParts("a"), { start: "", end: "a" });
  const whole = "x-" + "y".repeat(40);
  assert.equal(Object.values(sampleIdParts(whole)).join(""), whole);
});

test("a patch across prompts counts only beyond what the control did, in either direction", () => {
  const view = { modelId: "m", tokens: ["a", " b"], corruptedTokens: ["a", " c"], expected: " x", alternative: " y", cleanMargin: 2, corruptedMargin: -1, cleanTop: " x", corruptedTop: " y", layers: [0, 3], recovery: [[0, 0.2], [0, 0.9]], control: [[0, -0.3], [0, 0.1]] };
  assert.equal(controlCeiling(view), 0.3);
  assert.deepEqual(strongestPatch(view), { layer: 3, token: " b", position: 1, recovery: 0.9 });
  assert.match(promptPatchText(view, "tuned"), /layer 3 at position 1 \(" b"\) brought back 90\.0%.*at most 30\.0%.*not a measurement/);
  const nothing = { ...view, recovery: [[0, 0.3], [0, -0.9]] };
  assert.equal(strongestPatch(nothing), null, "at the control, or pushing away, is not bringing back");
  assert.match(promptPatchText(nothing, "tuned"), /No layer and position/);
});

test("two readings differ cell by cell, over the layers both have", () => {
  const left = [{ layer: 0, values: [1, 2] }, { layer: 1, values: [3, 3] }];
  assert.deepEqual(readingDifference(left, [{ layer: 0, values: [0.5, 2.5] }]), [{ layer: 0, values: [0.5, -0.5] }]);
});
