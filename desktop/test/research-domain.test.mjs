// The research interface's rules that are worth holding on their own: how a lineage is laid
// out, and how a comparison is said. Everything else is checked over HTTP in contract/.
import assert from "node:assert/strict";
import { test } from "node:test";
import { comparisonText, lineageOrder, lineageTracks, runHasResults, sampleIdParts, scoreText } from "../src/domain/research.ts";

const model = (id, parentId) => ({ id, parentId, source: id, floating: false, revision: 1, createdAt: "", updatedAt: "" });

test("a line of checkpoints stays one line, and each other child starts its own", () => {
  const models = [model("a"), model("b", "a"), model("c", "b"), model("sft", "c"), model("sft2", "c"), model("dpo", "sft"), model("other")];
  assert.deepEqual(
    lineageTracks(models).map((track) => [track.from?.id ?? null, track.nodes.map((node) => node.id)]),
    [
      [null, ["a", "b", "c", "sft", "dpo"]],
      ["c", ["sft2"]],
      [null, ["other"]],
    ],
  );
});

test("a model whose parent is gone starts a line rather than disappearing", () => {
  assert.deepEqual(lineageTracks([model("orphan", "gone")]).map((track) => track.nodes.map((node) => node.id)), [["orphan"]]);
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
