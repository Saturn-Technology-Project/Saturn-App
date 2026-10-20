// Unit test for the hunk diff behind in-editor agent review (no VS Code needed).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

// agent-review.js requires 'vscode' at load; a stub is enough to reach diffLines.
const require = createRequire(import.meta.url);
const Module = require("node:module");
const original = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) { return request === "vscode" ? request : original.call(this, request, ...rest); };
require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: new Proxy({}, { get: () => new Proxy(function () {}, { get: () => () => ({}), construct: () => ({}) }) }) };
const { diffLines } = require(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "extensions", "saturn", "agent-review.js"));

test("diffLines yields one hunk per changed region, positioned in the new text", () => {
  const before = ["a", "b", "c", "d", "e"];
  const after = ["a", "B", "c", "d", "x", "y", "e"];
  assert.deepEqual(diffLines(before, after), [
    { start: 1, oldLines: ["b"], newLines: ["B"] },
    { start: 4, oldLines: [], newLines: ["x", "y"] },
  ]);
  assert.deepEqual(diffLines(["a", "b"], ["a", "b"]), []);
  assert.deepEqual(diffLines(["a", "b", "c"], ["a"]), [{ start: 1, oldLines: ["b", "c"], newLines: [] }]);
  assert.deepEqual(diffLines([], ["n"]), [{ start: 0, oldLines: [], newLines: ["n"] }]);
});
