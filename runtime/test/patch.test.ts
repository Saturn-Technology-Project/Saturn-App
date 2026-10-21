import assert from "node:assert/strict";
import test from "node:test";
import { PatchDocument } from "../src/domain/skills/patch.js";

const SOURCE = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n";

test("a patch without its closing line, or with blank context lines missing their space, still applies", () => {
  const unclosed = PatchDocument.parse("*** Begin Patch\n*** Update File: x.js\n@@\n function a() {\n-  return 1;\n+  return 10;\n }\n");
  const change = unclosed.changes[0]!;
  assert.equal(change.kind, "update");
  assert.equal(unclosed.apply(SOURCE, change.kind === "update" ? change.hunks : []), SOURCE.replace("return 1;", "return 10;"));

  const blank = PatchDocument.parse("*** Begin Patch\n*** Update File: x.js\n@@\n }\n\n function b() {\n-  return 2;\n+  return 20;\n*** End Patch\n");
  const update = blank.changes[0]!;
  assert.equal(blank.apply(SOURCE, update.kind === "update" ? update.hunks : []), SOURCE.replace("return 2;", "return 20;"));
});

test("a patch with nothing in it, or a bad line, is still refused", () => {
  assert.throws(() => PatchDocument.parse("*** Begin Patch\n"), /must end with \*\*\* End Patch/);
  assert.throws(() => PatchDocument.parse("*** Begin Patch\n*** Update File: x.js\n@@\n?? what\n*** End Patch"), /must start with a space, \+ or -/);
  assert.throws(() => PatchDocument.parse("--- a/x.js\n+++ b/x.js"), /must start with \*\*\* Begin Patch/);
});
