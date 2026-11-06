// The research interface's rules that are worth holding on their own: how a lineage is laid
// out, and how a comparison is said. Everything else is checked over HTTP in contract/.
import assert from "node:assert/strict";
import { test } from "node:test";
import { artifactsInContext } from "../src/domain/research.ts";

test("project-wide analysis outputs remain reachable when a run or inspection session is selected", () => {
  const items = [{ id: "project" }, { id: "run", runId: "r" }, { id: "session", inspectionId: "s" }, { id: "other", runId: "other" }];
  assert.deepEqual(artifactsInContext(items, "r").map((item) => item.id), ["run"]);
  assert.deepEqual(artifactsInContext(items, undefined, "s").map((item) => item.id), ["session"]);
  assert.deepEqual(artifactsInContext(items, "r", undefined, true).map((item) => item.id), ["project", "run", "session", "other"]);
  assert.deepEqual(artifactsInContext(items).map((item) => item.id), ["project", "run", "session", "other"]);
});
import { ablationStanding, ablationText, comparisonText, controlCeiling, featurePeaks, featuresText, lineageOrder, lineageRows, promptPatchText, sampleModel, readingDifference, reconstructionIsPoor, runHasResults, sampleIdParts, scoreText, signedText, strongestPatch } from "../src/domain/research.ts";

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

/** A reading through an SAE, with what a test changes. */
function featuresView(change = {}) {
  return {
    modelId: "m", layer: 7, tokens: ["<s>", " Mary", " John"], top: " Mary",
    sae: { release: "r", id: "i", path: null, hookName: "blocks.8.hook_resid_pre", width: 100, trainedOn: "m", startTokenAdded: true, centered: false },
    reconstruction: { varianceExplained: 0.86, relativeError: 0.2, meanActiveFeatures: 50, tokensLeftOut: 1 },
    features: [[], [{ feature: 5, activation: 70 }, { feature: 9, activation: 3 }], [{ feature: 7, activation: 40 }, { feature: 5, activation: 2 }]],
    expected: " Mary", alternative: " John",
    margins: { plain: 3, spliced: 2.5, spliceChange: -0.5 },
    ablation: { feature: 5, activation: 70, margin: -1, change: -3.5, control: { feature: 7, activation: 40, margin: 2.4, change: -0.1 }, controlSeed: 0 },
    ...change,
  };
}

test("an ablation counts only beyond both its control and the error of splicing", () => {
  assert.equal(ablationStanding(featuresView()), "beyond");
  const within = (change, spliceChange = -0.5) => {
    const view = featuresView();
    return featuresView({ margins: { ...view.margins, spliceChange }, ablation: { ...view.ablation, change } });
  };
  assert.equal(ablationStanding(within(-0.1)), "control", "as far as the control went says nothing");
  assert.equal(ablationStanding(within(0.05)), "control", "either direction");
  assert.equal(ablationStanding(within(-0.4)), "splice", "past the control but not past the splice");
  assert.equal(ablationStanding(within(-0.5)), "splice");
  const alone = featuresView();
  alone.ablation = { ...alone.ablation, control: null };
  assert.equal(ablationStanding(alone), "no-control");
  assert.equal(ablationStanding(featuresView({ ablation: null })), null);
  assert.equal(ablationText(featuresView({ ablation: null })), "");
  assert.match(ablationText(within(-0.4)), /splicing/);
});

test("a poor reconstruction is said, by variance explained or, on one token, by error", () => {
  assert.equal(reconstructionIsPoor(featuresView()), false);
  const poor = featuresView({ reconstruction: { varianceExplained: 0.2, relativeError: 0.9, meanActiveFeatures: 900, tokensLeftOut: 0 } });
  assert.equal(reconstructionIsPoor(poor), true);
  assert.equal(reconstructionIsPoor(featuresView({ reconstruction: { varianceExplained: null, relativeError: 0.9, meanActiveFeatures: 1, tokensLeftOut: 0 } })), true);
  assert.equal(reconstructionIsPoor(featuresView({ reconstruction: { varianceExplained: null, relativeError: 0.1, meanActiveFeatures: 1, tokensLeftOut: 0 } })), false);
  assert.match(featuresText(poor, "tuned"), /poor, so the features say little/);
});

test("a feature is known by its id and the tokens it fires on, strongest first", () => {
  assert.deepEqual(featurePeaks(featuresView()), [
    { feature: 5, peak: 70, tokens: [" Mary", " John"] },
    { feature: 7, peak: 40, tokens: [" John"] },
    { feature: 9, peak: 3, tokens: [" Mary"] },
  ]);
});

test("an observation on features gives ids, the control and the splice, and calls itself one case", () => {
  const text = featuresText(featuresView(), "tuned");
  assert.match(text, /SAE r \/ i \(blocks\.8\.hook_resid_pre\) on tuned, layer 7: 86\.0% of variance explained/);
  assert.match(text, /5 \(70 at " Mary", " John"\)/);
  assert.match(text, /a change of -0\.5\. Ablating feature 5 moved it -3\.5 from there\. A random feature of similar activation, 7, moved it -0\.1\./);
  assert.match(text, /further than both/);
  assert.match(text, /one case: not a measurement/);
  assert.equal(signedText(1.5), "+1.5");
  assert.equal(signedText(-1.5), "-1.5");
  assert.equal(signedText(0), "0");
});

test("two readings differ cell by cell, over the layers both have", () => {
  const left = [{ layer: 0, values: [1, 2] }, { layer: 1, values: [3, 3] }];
  assert.deepEqual(readingDifference(left, [{ layer: 0, values: [0.5, 2.5] }]), [{ layer: 0, values: [0.5, -0.5] }]);
});

test("a sample's model is named from its line, or from the version when the line does not say, and never just unnamed", () => {
  const models = [{ id: "m1", name: "Base", source: "gpt2" }, { id: "m2", name: "", source: "local/ckpt" }];
  const bound = (...ids) => ({ models: ids.map((modelId) => ({ modelId, source: `src-${modelId}` })) });
  assert.deepEqual(sampleModel("m1", bound("m1"), models), { name: "Base" });
  assert.deepEqual(sampleModel("m2", bound("m2"), models), { name: "local/ckpt" }, "a model without a name goes by its source");
  assert.equal(sampleModel("gone", bound("m1"), models).name, "gone", "an id with no record is shown as it is");
  assert.match(sampleModel("gone", bound("m1"), models).note, /No model with this id/);
  assert.equal(sampleModel(undefined, bound("m1"), models).name, "Base", "the version's one model");
  assert.equal(sampleModel(null, bound("m9"), models).name, "src-m9", "or its source when it has no record");
  const many = sampleModel(undefined, bound("m1", "m2"), models);
  assert.equal(many.name, "Model not recorded");
  assert.match(many.note, /has 2\. Have the program write modelId/);
  assert.match(sampleModel(undefined, bound(), models).note, /names none/);
  assert.match(sampleModel(undefined, undefined, models).note, /names none/);
});
