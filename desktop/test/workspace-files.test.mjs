// A rename keeps open tabs and unsaved work attached to the new path; new notebooks must open as notebooks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renamedFileSession, newFileContent } from "../src/domain/workspace-files.ts";

test("renaming a file carries its tab and unsaved draft without rewriting other paths", () => {
  const before = { file: "src/old.py", tabs: ["a.py", "src/old.py", "src/old.py.bak"], draft: { file: "src/old.py", content: "unsaved edits", revision: "base" }, experimentId: "e" };
  const after = renamedFileSession(before, "src/old.py", "src/new.py");
  assert.equal(after.file, "src/new.py");
  assert.deepEqual(after.tabs, ["a.py", "src/new.py", "src/old.py.bak"]);
  assert.deepEqual(after.draft, { file: "src/new.py", content: "unsaved edits", revision: "base" });
  assert.equal(after.experimentId, "e");
  assert.equal(before.draft.file, "src/old.py");
});

test("a new notebook is valid nbformat 4 while ordinary new files are empty", () => {
  const notebook = JSON.parse(newFileContent("analysis.IPYNB"));
  assert.equal(notebook.nbformat, 4);
  assert.deepEqual(notebook.cells, []);
  assert.equal(newFileContent("src/probe.py"), "");
});
