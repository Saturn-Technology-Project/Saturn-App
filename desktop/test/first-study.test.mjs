// The first study on Home: its steps follow the records, in the order a study needs them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { comparePrompt, firstStudySteps, importPrompt, nextStep, offersComparison } from "../src/domain/first-study.ts";

const empty = { environmentChecked: false, questions: 0, hypotheses: 0, experiments: 0, imported: 0, runsWithResults: 0, labeled: 0, findings: 0 };

test("a new project starts at its Python, and each record moves the study on", () => {
  assert.equal(nextStep(firstStudySteps(empty)).id, "environment");
  const progress = { ...empty, environmentChecked: true, questions: 1 };
  assert.equal(nextStep(firstStudySteps(progress)).id, "hypothesis");
  assert.equal(nextStep(firstStudySteps({ ...progress, hypotheses: 1 })).id, "results");
});

test("results brought in count as much as an experiment written here", () => {
  const steps = firstStudySteps({ ...empty, imported: 1 });
  assert.equal(steps.find((step) => step.id === "results").done, true);
  assert.equal(steps.find((step) => step.id === "run").done, false, "an import is not a run Saturn made");
});

test("bringing results in can be handed to the assistant, which is told to ask before importing", () => {
  const results = firstStudySteps(empty).find((step) => step.id === "results");
  const asked = results.actions.find((action) => action.action.kind === "assistant");
  assert.equal(asked.action.prompt, importPrompt());
  assert.match(importPrompt(), /importing-results skill/);
  assert.match(importPrompt(), /only after I agree/);
});

test("a complete study has no next step", () => {
  const all = { environmentChecked: true, questions: 1, hypotheses: 1, experiments: 1, imported: 0, runsWithResults: 1, labeled: 3, findings: 1 };
  assert.equal(nextStep(firstStudySteps(all)), null);
});

test("a project without results offers to start from two evaluations, which the assistant brings in only on agreement", () => {
  assert.equal(offersComparison(empty), true);
  assert.equal(offersComparison({ ...empty, imported: 1 }), false, "once results are in, the checklist leads");
  assert.equal(offersComparison({ ...empty, experiments: 1 }), false);
  const results = firstStudySteps(empty).find((step) => step.id === "results");
  assert.ok(results.actions.some((action) => action.action.kind === "assistant" && action.action.prompt === comparePrompt()));
  assert.match(comparePrompt(), /importing-results and paired-comparisons skills/);
  assert.match(comparePrompt(), /only after I agree/);
  assert.match(comparePrompt(), /regressed/);
});
