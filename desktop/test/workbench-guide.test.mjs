// What the assistant is told about the interface, and what it may do with it: name a known place, and nothing else.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { assistantInstructions, GUIDE_PLACES, guideIn, guidePlace, HELP_REQUESTS, isWorkScreen, SCREENS, statusText, TOUR_STEPS, windowTitle, workbenchState } from "../src/domain/workbench.ts";

const presentation = new URL("../src/presentation", import.meta.url).pathname;
const sources = readdirSync(presentation, { recursive: true }).filter((name) => String(name).endsWith(".tsx")).map((name) => readFileSync(path.join(presentation, String(name)), "utf8")).join("\n");

test("every place the assistant may point at is marked in the interface", () => {
  for (const place of GUIDE_PLACES) {
    if (place.id.startsWith("rail-")) continue;
    assert.ok(sources.includes(`data-tour="${place.id}"`), `${place.id} is not marked`);
  }
  assert.ok(sources.includes("data-tour={`rail-${item}`}"));
  assert.equal(new Set(GUIDE_PLACES.map((place) => place.id)).size, GUIDE_PLACES.length);
  for (const screen of SCREENS) assert.ok(guidePlace(`rail-${screen}`));
});

test("an answer's marks become known places, once each and in order, and never reach the reader", () => {
  const { text, places } = guideIn("First freeze.\n[[saturn:show experiments-freeze]]\nThen sweep. [[saturn:show experiments-sweep]] [[saturn:show experiments-freeze]]");
  assert.deepEqual(places.map((place) => place.id), ["experiments-freeze", "experiments-sweep"]);
  assert.doesNotMatch(text, /saturn:show/);
  assert.match(text, /First freeze/);
});

test("a mark for anything else is dropped: model output cannot name a place, a script or a screen of its own", () => {
  for (const mark of ["not-a-real-place", "../../etc", "x\"]<script>", "Settings"]) {
    assert.deepEqual(guideIn(`Look. [[saturn:show ${mark}]]`).places, [], mark);
  }
  assert.deepEqual(guideIn("[[saturn:click experiments-freeze]]").places, [], "there is no such thing as a click");
  assert.deepEqual(guideIn("nothing here"), { text: "nothing here", places: [] });
});

test("a mark still arriving is not shown while the answer streams", () => {
  for (const partial of ["[", "[[", "[[sat", "[[saturn:", "[[saturn:show exper", "[[saturn:show experiments-freeze]"]) {
    assert.equal(guideIn(`Next. ${partial}`).text, "Next.", partial);
  }
  assert.equal(guideIn("A list [1] stays").text, "A list [1] stays");
});

test("the assistant is told every screen and place, and that the person does the work", () => {
  const told = assistantInstructions();
  for (const screen of SCREENS) assert.ok(told.includes(`${screen}:`), screen);
  for (const place of GUIDE_PLACES) assert.ok(told.includes(`- ${place.id}:`), place.id);
  assert.match(told, /cannot click/);
  assert.match(told, /Verdicts, labels, modes/);
  assert.equal(TOUR_STEPS.filter((step) => told.includes(step.text)).length, TOUR_STEPS.length - 2, "the same words as the tour");
});

test("the state sent with a message and the names read from outside say where things stand", () => {
  assert.equal(workbenchState({ screen: "Home", project: "P" }), "Screen: Home\nProject: P");
  assert.equal(workbenchState({ screen: "Workspace", project: "P", file: "a.py", mode: "manual", run: { id: "r", status: "running" }, sampleId: "s" }), "Screen: Workspace\nProject: P\nOpen file: a.py, in manual mode\nLatest run: r, running\nSample on screen: s");
  assert.equal(windowTitle("Samples", "Pythia"), "Samples – Pythia – Saturn");
  assert.equal(windowTitle("Home", null), "Home – Saturn");
  assert.equal(statusText({ screen: "Home", project: "P", runtime: "ready" }), "Home screen, project P. Runtime ready.");
  assert.deepEqual(SCREENS.filter(isWorkScreen), ["Workspace", "Samples"]);
  assert.ok(HELP_REQUESTS.length >= 1);
});
