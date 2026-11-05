// How a notebook is read, edited and written back, and how its outputs are shown. Running one is in contract/notebooks.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { addCell, applyKernelEvent, clearAllOutputs, deleteCell, editCell, isNotebookPath, kernelStateLabel, moveCell, nextKernelStatus, notebookLanguage, outputView, parseNotebook, plainText, runnableCells, serializeNotebook } from "../src/domain/notebook.ts";

const STORED = {
  cells: [
    { cell_type: "markdown", id: "intro", metadata: { tags: ["a"] }, source: ["# Title\n", "text"] },
    { cell_type: "code", execution_count: 2, id: "run", metadata: { scrolled: true }, outputs: [{ name: "stdout", output_type: "stream", text: ["one\n", "two\n"] }], source: "print('hi')\nprint('there')" },
    { cell_type: "raw", id: "plain", metadata: {}, source: [] },
    { cell_type: "future", id: "later", metadata: {}, whatever: { nested: [1, 2] } },
  ],
  metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" }, custom: { keep: true } },
  nbformat: 4,
  nbformat_minor: 5,
  extra: "kept",
};
/** A file as nbformat writes one: indent 1, a line end at the end. */
const FILE = `${JSON.stringify(STORED, null, 1)}\n`;
const read = (text = FILE) => {
  const reading = parseNotebook(text);
  assert.ok("notebook" in reading, reading.problem);
  return reading.notebook;
};

test("a notebook is read as its cells, and what is not understood stays", () => {
  const notebook = read();
  assert.deepEqual(notebook.cells.map((cell) => [cell.key, cell.kind]), [["intro", "markdown"], ["run", "code"], ["plain", "raw"], ["later", "other"]]);
  assert.equal(notebook.cells[0].source, "# Title\ntext");
  assert.equal(notebook.cells[1].source, "print('hi')\nprint('there')");
  assert.equal(notebook.cells[1].executionCount, 2);
  assert.equal(notebook.cells[1].outputs.length, 1);
  assert.equal(notebook.cells[2].source, "");
});

test("a notebook with nothing changed saves as the same bytes, whatever its layout", () => {
  const odd = '{"nbformat":4, "nbformat_minor":4,\n\n\t"metadata": {"pi": 3.10, "big": 12345678901234567890, "é": "\\u00e9"} ,"cells": [ {"cell_type":"code","source":"x","outputs":[],"metadata":{},"execution_count":1.0}\n,\n  {"cell_type":"markdown", "source":[],"metadata":{}} ]}  ';
  for (const text of [FILE, JSON.stringify(STORED), odd, '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}']) {
    assert.equal(serializeNotebook(read(text)), text);
  }
});

test("editing a cell changes only that cell's bytes", () => {
  const before = read();
  const edited = editCell(before, "run", "x = 1\ny = 2\n");
  const text = serializeNotebook(edited);
  const expected = structuredClone(STORED);
  expected.cells[1].source = "x = 1\ny = 2\n";
  // The cell's source was one string in the file, and stays one.
  assert.equal(text, `${JSON.stringify(expected, null, 1)}\n`);
  const reread = read(text);
  assert.equal(reread.cells[1].source, "x = 1\ny = 2\n");
});

test("a source stored as lines stays lines, each with its line end", () => {
  const edited = editCell(read(), "intro", "first\nsecond\n\nlast");
  assert.deepEqual(JSON.parse(serializeNotebook(edited)).cells[0].source, ["first\n", "second\n", "\n", "last"]);
  assert.deepEqual(JSON.parse(serializeNotebook(editCell(read(), "intro", ""))).cells[0].source, []);
});

test("a number the JSON reader cannot keep survives in the cells and fields that did not change", () => {
  const text = '{\n "cells": [\n  {"cell_type": "code", "metadata": {"ratio": 1.0}, "source": "a", "outputs": [], "execution_count": null},\n  {"cell_type": "code", "metadata": {}, "source": "b", "outputs": [], "execution_count": null}\n ],\n "metadata": {"ratio": 2.50},\n "nbformat": 4,\n "nbformat_minor": 4\n}\n';
  const notebook = read(text);
  const saved = serializeNotebook(editCell(notebook, notebook.cells[1].key, "changed"));
  assert.ok(saved.includes('"ratio": 1.0'));
  assert.ok(saved.includes('"ratio": 2.50'));
  assert.ok(saved.includes('"changed"'));
  assert.equal(saved.split("\n")[2], text.split("\n")[2]);
});

test("the same source written back is not a change", () => {
  const notebook = read();
  assert.equal(serializeNotebook(editCell(notebook, "run", notebook.cells[1].source)), FILE);
});

test("cells are added, moved and deleted, and the file stays a valid notebook", () => {
  let notebook = read();
  const made = addCell(notebook, "code", "intro", () => "new-id");
  notebook = made.notebook;
  assert.equal(made.key, "new-id");
  assert.deepEqual(notebook.cells.map((cell) => cell.key), ["intro", "new-id", "run", "plain", "later"]);
  notebook = editCell(notebook, "new-id", "a = 1\n");
  let parsed = JSON.parse(serializeNotebook(notebook));
  assert.deepEqual(parsed.cells[1], { cell_type: "code", execution_count: null, id: "new-id", metadata: {}, outputs: [], source: ["a = 1\n"] });
  assert.deepEqual(parsed.cells[3].whatever, undefined);
  assert.deepEqual(parsed.cells[4].whatever, { nested: [1, 2] });
  assert.equal(parsed.extra, "kept");
  assert.deepEqual(parsed.metadata.custom, { keep: true });

  notebook = moveCell(notebook, "new-id", 1);
  notebook = moveCell(notebook, "intro", -1);
  notebook = moveCell(notebook, "later", 5);
  assert.deepEqual(notebook.cells.map((cell) => cell.key), ["intro", "run", "new-id", "plain", "later"]);
  notebook = deleteCell(notebook, "plain");
  parsed = JSON.parse(serializeNotebook(notebook));
  assert.deepEqual(parsed.cells.map((cell) => cell.id), ["intro", "run", "new-id", "later"]);

  const first = addCell(read(), "markdown", null, () => "top").notebook;
  assert.equal(first.cells[0].key, "top");
  assert.deepEqual(JSON.parse(serializeNotebook(first)).cells[0], { cell_type: "markdown", id: "top", metadata: {}, source: [] });
});

test("moving a cell away and back saves the same bytes", () => {
  const notebook = read();
  assert.equal(serializeNotebook(moveCell(moveCell(notebook, "run", 1), "run", -1)), FILE);
});

test("a new cell matches the file's indentation and depth", () => {
  const made = addCell(read(), "code", "later", () => "new-id").notebook;
  const text = serializeNotebook(made);
  assert.ok(text.includes('\n  {\n   "cell_type": "code",\n   "execution_count": null,\n   "id": "new-id",'));
  const two = `${JSON.stringify(STORED, null, 2)}\n`;
  assert.equal(serializeNotebook(editCell(read(two), "run", "changed")).startsWith("{\n  \"cells\": [\n    {"), true);
  assert.ok(serializeNotebook(addCell(read(two), "code", "later", () => "x").notebook).includes('\n    {\n      "cell_type": "code",'));
});

test("an empty notebook takes its first cell, and a last deleted cell leaves an empty list", () => {
  const empty = `${JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }, null, 1)}\n`;
  const one = addCell(read(empty), "code", null, () => "first").notebook;
  const text = serializeNotebook(one);
  assert.equal(JSON.parse(text).cells[0].id, "first");
  assert.equal(text, `${JSON.stringify({ cells: [JSON.parse(text).cells[0]], metadata: {}, nbformat: 4, nbformat_minor: 5 }, null, 1)}\n`);
  assert.deepEqual(JSON.parse(serializeNotebook(deleteCell(one, "first"))).cells, []);
  const single = `${JSON.stringify({ cells: [{ cell_type: "raw", metadata: {}, source: [] }], metadata: {}, nbformat: 4, nbformat_minor: 5 }, null, 1)}\n`;
  const notebook = read(single);
  assert.deepEqual(JSON.parse(serializeNotebook(deleteCell(notebook, notebook.cells[0].key))).cells, []);
});

test("before cell ids, a new cell gets none, and every cell still has a key of its own", () => {
  const old = { cells: [{ cell_type: "code", metadata: {}, source: "a", outputs: [], execution_count: null }, { cell_type: "code", metadata: {}, source: "b", outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 4 };
  const notebook = read(JSON.stringify(old));
  assert.equal(new Set(notebook.cells.map((cell) => cell.key)).size, 2);
  const made = addCell(notebook, "code", null);
  assert.equal(new Set(made.notebook.cells.map((cell) => cell.key)).size, 3);
  assert.equal(JSON.parse(serializeNotebook(made.notebook)).cells[0].id, undefined);
});

test("cells sharing an id keep keys of their own", () => {
  const same = { cells: [{ cell_type: "raw", id: "same", metadata: {}, source: [] }, { cell_type: "raw", id: "same", metadata: {}, source: [] }], metadata: {}, nbformat: 4, nbformat_minor: 5 };
  assert.equal(new Set(read(JSON.stringify(same)).cells.map((cell) => cell.key)).size, 2);
});

test("a cell with a source it cannot read is kept as it is, and not edited", () => {
  const text = JSON.stringify({ cells: [{ cell_type: "code", metadata: {}, source: 7, outputs: [], execution_count: null }, 5], metadata: {}, nbformat: 4, nbformat_minor: 4 });
  const notebook = read(text);
  assert.deepEqual(notebook.cells.map((cell) => cell.kind), ["other", "other"]);
  assert.deepEqual(runnableCells(notebook), []);
  const added = addCell(notebook, "code", null, () => "x");
  const parsed = JSON.parse(serializeNotebook(added.notebook));
  assert.equal(parsed.cells[1].source, 7);
  assert.equal(parsed.cells[2], 5);
});

test("what is not nbformat 4 says why, so it opens as text instead", () => {
  assert.match(parseNotebook("not json").problem, /not JSON/);
  assert.match(parseNotebook("").problem, /not JSON/);
  assert.match(parseNotebook("[]").problem, /not a JSON object/);
  assert.match(parseNotebook(JSON.stringify({ nbformat: 3, worksheets: [] })).problem, /nbformat 3/);
  assert.match(parseNotebook(JSON.stringify({ nbformat: 4 })).problem, /no list of cells/);
});

test("the cells a repeated key means are the ones found, and strings in the way do not confuse it", () => {
  const text = '{"cells": [{"cell_type": "raw", "source": "old", "metadata": {}}], "cells": [{"cell_type": "raw", "source": "new ] } \\" {", "metadata": {}}], "metadata": {"cells": []}, "nbformat": 4, "nbformat_minor": 4}';
  const notebook = read(text);
  assert.equal(notebook.cells[0].source, 'new ] } " {');
  const edited = serializeNotebook(editCell(notebook, notebook.cells[0].key, "changed"));
  assert.equal(JSON.parse(edited).cells[0].source, "changed");
});

test("a run replaces a cell's outputs, joins its streams and stores its count", () => {
  let state = { notebook: read(), clears: new Set() };
  const apply = (event) => { state = applyKernelEvent(state.notebook, state.clears, event); };
  apply({ type: "started", seq: 1, cell: "run" });
  assert.deepEqual(state.notebook.cells[1].outputs, []);
  assert.equal(state.notebook.cells[1].executionCount, null);
  apply({ type: "output", seq: 2, cell: "run", output: { output_type: "stream", name: "stdout", text: "a" } });
  apply({ type: "output", seq: 3, cell: "run", output: { output_type: "stream", name: "stdout", text: "b" } });
  apply({ type: "output", seq: 4, cell: "run", output: { output_type: "stream", name: "stderr", text: "c" } });
  apply({ type: "output", seq: 5, cell: "run", output: { output_type: "display_data", data: { "text/plain": "d" }, metadata: {} } });
  apply({ type: "finished", seq: 6, cell: "run", status: "ok", count: 7 });
  const parsed = JSON.parse(serializeNotebook(state.notebook));
  assert.equal(parsed.cells[1].execution_count, 7);
  assert.deepEqual(parsed.cells[1].outputs.map((output) => output.text ?? output.data["text/plain"]), ["ab", "c", "d"]);
  assert.deepEqual(parsed.cells[1].metadata, { scrolled: true });
  assert.equal(parsed.cells[1].id, "run");
  // Another cell's bytes are untouched.
  assert.ok(serializeNotebook(state.notebook).includes(JSON.stringify(STORED.cells[0], null, 1).replaceAll("\n", "\n  ")));
});

test("a cleared output goes at once, or with the next output when it asks to wait", () => {
  let state = { notebook: read(), clears: new Set() };
  const apply = (event) => { state = applyKernelEvent(state.notebook, state.clears, event); };
  const output = (text) => ({ type: "output", seq: 1, cell: "run", output: { output_type: "stream", name: "stdout", text } });
  apply({ type: "started", seq: 1, cell: "run" });
  apply(output("a"));
  apply({ type: "clear", seq: 2, cell: "run", wait: true });
  assert.equal(state.notebook.cells[1].outputs.length, 1);
  apply(output("b"));
  assert.equal(state.notebook.cells[1].outputs[0].text, "b");
  apply({ type: "clear", seq: 3, cell: "run", wait: false });
  assert.deepEqual(state.notebook.cells[1].outputs, []);
});

test("an event for a cell no longer there changes nothing", () => {
  const notebook = read();
  const next = applyKernelEvent(notebook, new Set(), { type: "output", seq: 1, cell: "gone", output: {} });
  assert.equal(next.notebook, notebook);
  assert.equal(serializeNotebook(next.notebook), FILE);
});

test("a run that ended without a count leaves the outputs it made", () => {
  let state = { notebook: read(), clears: new Set() };
  const apply = (event) => { state = applyKernelEvent(state.notebook, state.clears, event); };
  apply({ type: "started", seq: 1, cell: "run" });
  apply({ type: "output", seq: 2, cell: "run", output: { output_type: "stream", name: "stdout", text: "a" } });
  apply({ type: "finished", seq: 3, cell: "run", status: "aborted", count: null });
  assert.equal(state.notebook.cells[1].outputs.length, 1);
});

test("a cell skipped keeps the outputs it had", () => {
  const notebook = read();
  const next = applyKernelEvent(notebook, new Set(), { type: "finished", seq: 1, cell: "run", status: "skipped", count: null });
  assert.equal(serializeNotebook(next.notebook), FILE);
});

test("clearing outputs leaves cells that have none as they were", () => {
  const notebook = clearAllOutputs(read());
  const parsed = JSON.parse(serializeNotebook(notebook));
  assert.deepEqual(parsed.cells[1].outputs, []);
  assert.equal(parsed.cells[1].execution_count, null);
  assert.equal(notebook.cells[0].text !== null, true);
  const clean = read(serializeNotebook(notebook));
  assert.equal(serializeNotebook(clearAllOutputs(clean)), serializeNotebook(clean));
});

test("HTML and SVG are never shown as what they are: a PNG, then text", () => {
  const data = (fields) => ({ output_type: "display_data", data: fields, metadata: {} });
  assert.deepEqual(outputView(data({ "text/html": "<b onclick='x()'>hi</b>", "text/plain": "a frame" })), { kind: "text", text: "a frame", failure: false });
  assert.deepEqual(outputView(data({ "text/html": ["<script>", "x()</script>"] })), { kind: "text", text: "<script>x()</script>", failure: false });
  assert.deepEqual(outputView(data({ "image/svg+xml": "<svg onload='x()'/>" })), { kind: "text", text: "<svg onload='x()'/>", failure: false });
  const image = outputView(data({ "image/png": "iVBORw0KGgo=\n", "text/plain": "<Figure>" }));
  assert.deepEqual(image, { kind: "image", source: "data:image/png;base64,iVBORw0KGgo=", description: "<Figure>" });
  assert.equal(outputView(data({ "image/png": '"><script>' })).kind, "note");
  assert.equal(outputView(data({})).kind, "note");
  assert.deepEqual(outputView(data({ "application/json": { a: 1 } })), { kind: "text", text: '{\n  "a": 1\n}', failure: false });
  assert.deepEqual(outputView({ output_type: "execute_result", data: { "text/plain": "42" }, metadata: {}, execution_count: 1 }), { kind: "text", text: "42", failure: false });
});

test("streams, errors and notes are shown plainly, and what is not understood says so", () => {
  assert.deepEqual(outputView({ output_type: "stream", name: "stdout", text: ["a\n", "b"] }), { kind: "text", text: "a\nb", failure: false });
  assert.equal(outputView({ output_type: "stream", name: "stderr", text: "x" }).failure, true);
  assert.deepEqual(outputView({ output_type: "error", ename: "ValueError", evalue: "boom", traceback: ["\u001b[0;31mValueError\u001b[0m", "line"] }), { kind: "error", title: "ValueError: boom", traceback: "ValueError\nline" });
  assert.deepEqual(outputView({ output_type: "display_data", data: { "text/plain": "left out" }, metadata: { saturn: { truncated: true } } }), { kind: "note", text: "left out" });
  assert.equal(outputView({ output_type: "future" }).kind, "note");
  assert.equal(outputView(5).kind, "note");
});

test("text reads as a terminal would leave it", () => {
  assert.equal(plainText("\u001b[1;32mok\u001b[0m"), "ok");
  assert.equal(plainText("10%\r50%\r100%\nnext\r\n"), "100%\nnext\n");
});

test("only code cells with something in them run", () => {
  let notebook = read();
  notebook = editCell(addCell(notebook, "code", "run", () => "blank").notebook, "blank", "   \n");
  assert.deepEqual(runnableCells(notebook), [{ cell: "run", code: "print('hi')\nprint('there')" }]);
});

test("a notebook's language is what it says, else Python", () => {
  assert.equal(notebookLanguage(read()), "python");
  const language = (metadata) => notebookLanguage(read(JSON.stringify({ cells: [], metadata, nbformat: 4, nbformat_minor: 5 })));
  assert.equal(language({}), "python");
  assert.equal(language({ kernelspec: { language: "R" } }), "r");
  assert.equal(language({ language_info: { name: "julia" } }), "julia");
});

test("the kernel's state comes from the runtime's newest word about it", () => {
  const status = { kernel: "k", state: "idle", missing: [], queued: [], seq: 1 };
  assert.equal(nextKernelStatus(status, { type: "started", seq: 2, cell: "a" }), status);
  assert.equal(nextKernelStatus(status, { type: "state", seq: 3, kernel: "k", state: "busy", missing: [], queued: [] }).state, "busy");
  assert.equal(kernelStateLabel("missing"), "Cannot run");
});

test("a notebook is known by its name", () => {
  assert.equal(isNotebookPath("a/b.ipynb"), true);
  assert.equal(isNotebookPath("B.IPYNB"), true);
  assert.equal(isNotebookPath("b.ipynb.txt"), false);
});
