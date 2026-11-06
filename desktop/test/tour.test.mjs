// The tour covers every screen, in the rail's order, and ends by starting a piece of research.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SCREENS, TOUR_STEPS } from "../src/domain/workbench.ts";

test("every screen has a step that shows it, in the rail's order, and the last step starts the research", () => {
  const shown = TOUR_STEPS.filter((step) => step.screen && step.target === `rail-${step.screen}`).map((step) => step.screen);
  assert.deepEqual(shown, [...SCREENS]);
  assert.equal(TOUR_STEPS[0].target, null);
  assert.equal(TOUR_STEPS.at(-1).id, "start");
  assert.equal(new Set(TOUR_STEPS.map((step) => step.id)).size, TOUR_STEPS.length);
  for (const step of TOUR_STEPS) assert.ok(step.title && step.text.length > 40, step.id);
});
