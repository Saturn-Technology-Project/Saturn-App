// A tour follows layout frames, and a frame left over from the preceding step cannot publish its position.
import assert from "node:assert/strict";
import { test } from "node:test";
import { followTourTarget } from "../src/presentation/shell/tour-focus.ts";

/** A browser frame queue whose canceled callbacks can still be invoked to reproduce a late callback. */
function frames() {
  const callbacks = new Map();
  let next = 0;
  return {
    callbacks,
    schedule(callback) { callbacks.set(++next, callback); return next; },
    cancel(id) { callbacks.delete(id); },
    draw() { const [id, callback] = callbacks.entries().next().value; callbacks.delete(id); callback(); },
  };
}

test("the focus follows a target that appears or moves, without publishing unchanged rectangles", () => {
  const clock = frames();
  let rectangle = null;
  const seen = [];
  const stop = followTourTarget(() => rectangle, (box) => seen.push(box), clock.schedule, clock.cancel);
  clock.draw();
  rectangle = { top: 5, left: 20, width: 30, height: 40 };
  clock.draw();
  clock.draw();
  rectangle = { ...rectangle, left: 200 };
  clock.draw();
  assert.deepEqual(seen, [null, { top: 5, left: 20, width: 30, height: 40 }, rectangle]);
  stop();
  assert.equal(clock.callbacks.size, 0);
});

test("switching steps cancels the old focus, including a callback already in flight", () => {
  const clock = frames();
  const seen = [];
  const stop = followTourTarget(() => ({ top: 0, left: 10, width: 20, height: 30 }), (box) => seen.push(["old", box]), clock.schedule, clock.cancel);
  const stale = [...clock.callbacks.values()][0];
  stop();
  const next = followTourTarget(() => ({ top: 0, left: 300, width: 20, height: 30 }), (box) => seen.push(["new", box]), clock.schedule, clock.cancel);
  stale();
  clock.draw();
  assert.deepEqual(seen.map(([step, box]) => [step, box.left]), [["new", 300]]);
  next();
});
