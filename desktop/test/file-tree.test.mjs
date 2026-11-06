// The Workspace's file tree: order, opening and revealing folders, reading them again, and moving with the keyboard.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_TREE, ancestors, foldersToRead, keyMove, parentOf, refreshed, revealed, sortEntries, toggled, treeRows, withFolder } from "../src/domain/file-tree.ts";

const file = (path) => ({ name: path.split("/").at(-1), path, kind: "file" });
const folder = (path) => ({ name: path.split("/").at(-1), path, kind: "directory" });
const names = (rows) => rows.map((row) => `${"  ".repeat(row.depth - 1)}${row.entry.name}${row.entry.kind === "directory" ? (row.expanded ? "/-" : "/+") : ""}`);

test("folders come first, then names as a person reads them, with dot files last", () => {
  const sorted = sortEntries([file("run10.py"), file(".env"), file("Readme.md"), folder("data"), file("run2.py"), folder(".github"), file("analysis.ipynb")]);
  assert.deepEqual(sorted.map((entry) => entry.name), ["data", ".github", "analysis.ipynb", "Readme.md", "run2.py", "run10.py", ".env"]);
});

test("a path's folders and parent", () => {
  assert.deepEqual(ancestors("a/b/c.py"), ["a", "a/b"]);
  assert.deepEqual(ancestors("c.py"), []);
  assert.equal(parentOf("a/b/c.py"), "a/b");
  assert.equal(parentOf("c.py"), ".");
});

test("open folders show their entries under them, and the project's records are never listed", () => {
  let tree = withFolder(EMPTY_TREE, ".", [file("probe.py"), folder("src"), folder(".saturn"), folder("node_modules")]);
  assert.deepEqual(names(treeRows(tree)), ["node_modules/+", "src/+", "probe.py"]);
  assert.equal(treeRows(tree)[0].generated, true);

  tree = toggled(tree, "src");
  assert.equal(treeRows(tree)[1].loading, true, "an open folder not read yet says so");
  assert.deepEqual(foldersToRead(tree), ["src"]);
  tree = withFolder(tree, "src", [file("src/model.py"), folder("src/utils")]);
  assert.deepEqual(names(treeRows(tree)), ["node_modules/+", "src/-", "  utils/+", "  model.py", "probe.py"]);
  assert.deepEqual(foldersToRead(tree), []);

  tree = toggled(tree, "src");
  assert.deepEqual(names(treeRows(tree)), ["node_modules/+", "src/+", "probe.py"]);
  assert.deepEqual(treeRows(toggled(tree, "src")).length, 5, "a folder read once opens again without reading");
});

test("revealing a file opens every folder above it, and only those", () => {
  const tree = revealed(EMPTY_TREE, "experiments/ioi/run.py");
  assert.deepEqual(tree.open, ["experiments", "experiments/ioi"]);
  assert.deepEqual(foldersToRead(tree), [".", "experiments", "experiments/ioi"]);
  assert.equal(revealed(tree, "experiments/ioi/other.py"), tree, "nothing to open changes nothing");
});

test("reading again keeps what is open, adds new files, and forgets folders that are gone", () => {
  let tree = withFolder(EMPTY_TREE, ".", [folder("a"), folder("b")]);
  tree = withFolder(toggled(tree, "a"), "a", [folder("a/deep")]);
  tree = withFolder(toggled(tree, "a/deep"), "a/deep", [file("a/deep/x.py")]);
  tree = refreshed(tree, { ".": [folder("b"), file("new.py")], a: null, "a/deep": null });
  assert.deepEqual(tree.open, []);
  assert.deepEqual(Object.keys(tree.folders), ["."]);
  assert.deepEqual(names(treeRows(tree)), ["b/+", "new.py"]);
});

test("the keyboard moves through the tree as the tree pattern says", () => {
  let tree = withFolder(EMPTY_TREE, ".", [folder("src"), file("probe.py")]);
  tree = withFolder(toggled(tree, "src"), "src", [file("src/model.py")]);
  const rows = treeRows(tree);
  assert.deepEqual(keyMove(rows, 0, "ArrowDown"), { kind: "focus", index: 1 });
  assert.deepEqual(keyMove(rows, 0, "ArrowRight"), { kind: "focus", index: 1 }, "right on an open folder goes to its first entry");
  assert.deepEqual(keyMove(rows, 0, "ArrowLeft"), { kind: "toggle", path: "src", open: false });
  assert.deepEqual(keyMove(rows, 1, "ArrowLeft"), { kind: "focus", index: 0 }, "left on a file goes to its folder");
  assert.deepEqual(keyMove(rows, 1, "Enter"), { kind: "open-file", path: "src/model.py" });
  assert.deepEqual(keyMove(rows, 2, "ArrowDown"), { kind: "none" });
  assert.deepEqual(keyMove(rows, 2, "Home"), { kind: "focus", index: 0 });
  const closed = treeRows(toggled(tree, "src"));
  assert.deepEqual(keyMove(closed, 0, "ArrowRight"), { kind: "toggle", path: "src", open: true });
  assert.deepEqual(keyMove(closed, 0, " "), { kind: "toggle", path: "src", open: true });
});
