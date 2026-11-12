// A run's steps as one line each: the verb, and what it was done to.
import assert from "node:assert/strict";
import { test } from "node:test";
import { actionLine } from "../src/domain/conversation.ts";

const line = (toolId, args, result) => actionLine({ id: "a", toolId, arguments: args, status: "completed", result });

test("a step names a file by the end of its path, whichever way the path is written", () => {
  // On Windows Claude Code names files `C:\…`. Read as a path inside the project it was shown whole, so the row ran past
  // its box and the name, at the far end, was out of sight.
  const windows = "C:\\Users\\someone\\research\\2026-11-08-impossible-specificity\\tools\\saturn_run.py";
  assert.deepEqual(line("Read", { file_path: windows }), { verb: "Analyzed", target: "tools\\saturn_run.py", badge: "PY" });
  assert.deepEqual(line("Write", { file_path: "\\\\server\\share\\study\\notes.md" }), { verb: "Wrote", target: "study\\notes.md", badge: "MD" });
  assert.deepEqual(line("Edit", { file_path: "/Users/someone/research/study/tools/saturn_run.py" }), { verb: "Edited", target: "tools/saturn_run.py", badge: "PY" });

  // Saturn's own file tool takes paths inside the project: a deep one is cut to its end and says so, a short one is whole.
  const deep = line("files", { action: "read", path: "experiments\\2026-11-08-impossible-specificity\\tools\\saturn_run.py" }, { totalLines: 3 });
  assert.equal(deep.target, "…\\tools\\saturn_run.py");
  assert.equal(deep.badge, "PY");
  assert.equal(line("files", { action: "write", path: "experiments/2026-11-08-impossible-specificity/tools/saturn_run.py" }).target, "…/tools/saturn_run.py");
  assert.equal(line("files", { action: "write", path: "src/domain/model.ts" }).target, "src/domain/model.ts");
  assert.equal(line("files", { action: "patch" }, { applied: [{ path: "a/b/c/d/e.rs" }, { path: "x.rs" }] }).target, "…/d/e.rs +1");
  assert.equal(line("files", { action: "read", path: "" }).target, "file");
});
