// How the Data screen words what the runtime says: never claiming more than a name or an exact match can show.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cellOf, cellText, dataFileState, distinctText, isReadable, overlapLeftOut, overlapText, parseColumns, rowColumns, sideName, spanText, testReadSummary, testReadText, usesHelper } from "../src/domain/data.ts";

const file = (fields = {}) => ({ path: "a.jsonl", kind: "file", format: "jsonl", exists: true, problem: null, size: 1, modifiedAt: null, frozen: null, frozenBy: [], changed: null, looksLikeTest: false, declaredSplits: [], testReads: 0, experiments: [], runs: [], ...fields });
const frozen = { versionId: "v", number: 1, experimentId: "e", sha256: "x", size: 1, frozenAt: "t" };
const run = (testRead, split = null) => ({ id: "r", versionId: "v", experimentId: "e", status: "completed", at: "t", split, testRead });

test("a file's state says what needs looking at, and only that is colored", () => {
  assert.deepEqual(dataFileState(file()), { label: "Not frozen", tone: "neutral" });
  assert.deepEqual(dataFileState(file({ frozen, changed: false })), { label: "As frozen", tone: "neutral" });
  assert.deepEqual(dataFileState(file({ frozen, changed: true })), { label: "Changed since frozen", tone: "wait" });
  assert.deepEqual(dataFileState(file({ exists: false, frozen, changed: true })), { label: "Missing", tone: "bad" });
  assert.deepEqual(dataFileState(file({ exists: false, problem: "A link" })), { label: "Refused", tone: "bad" });
});

test("a run read as test data says how that is known, and a name is never called proof", () => {
  assert.match(testReadText(run("declared", "test")), /declares the split "test"/);
  assert.match(testReadText(run("name")), /not proof/);
  assert.match(testReadText(run("conflict", "validation")), /One of them is wrong/);
  assert.match(testReadText(run(null, "train")), /declares the split "train"/);
  assert.match(testReadText(run(null)), /No split declared/);
  assert.equal(testReadSummary(file()), "");
  assert.equal(testReadSummary(file({ looksLikeTest: true })), "Name looks like test, no runs");
  assert.equal(testReadSummary(file({ testReads: 2, runs: [run("declared", "test"), run("declared", "test")] })), "2 runs, declared test");
  assert.equal(testReadSummary(file({ testReads: 1, runs: [run("name")] })), "1 run, by name only");
  assert.equal(testReadSummary(file({ testReads: 2, runs: [run("declared", "test"), run("name")] })), "2 runs, partly by name");
});

test("a page's columns are its header's, then whatever its rows have, and a row that is not an object is one value", () => {
  assert.deepEqual(rowColumns({ columns: ["a"], items: [{ offset: 0, row: { b: 1, a: 2 } }, { offset: 1, problem: "x" }, { offset: 2, row: { c: 3 } }] }), ["a", "b", "c"]);
  assert.deepEqual(rowColumns({ columns: [], items: [{ offset: 0, row: 7 }, { offset: 1, row: [1] }] }), ["value"]);
  assert.equal(cellOf({ a: 1 }, "a"), 1);
  assert.equal(cellOf(7, "value"), 7);
  assert.equal(cellOf(7, "a"), undefined);
});

test("a cell is plain text of a length a table can hold", () => {
  assert.equal(cellText(null), "");
  assert.equal(cellText(undefined), "");
  assert.equal(cellText("<b>as written</b>"), "<b>as written</b>");
  assert.equal(cellText({ a: [1] }), '{"a":[1]}');
  assert.equal(cellText(false), "false");
  assert.equal(cellText("x".repeat(10), 4), "xxxx…");
});

test("a column's numbers say when they are only the least there are", () => {
  assert.equal(distinctText({ distinct: 3, distinctCapped: false }), "3");
  assert.equal(distinctText({ distinct: 1000, distinctCapped: true }), "at least 1,000");
  assert.equal(spanText({ range: { min: 0.123456, max: 2000 }, lengths: null }), "0.12346 to 2,000");
  assert.equal(spanText({ range: null, lengths: { min: 1, max: 9 } }), "1 to 9 characters");
  assert.equal(spanText({ range: null, lengths: { min: 18, max: 18 } }), "18 characters");
  assert.equal(spanText({ range: null, lengths: null }), "");
});

const side = (path, rows, inBoth, fields = {}) => ({ path, split: null, rows, malformed: 0, tooLong: 0, withoutColumns: 0, inBoth, ...fields });
const view = (fields = {}) => ({ left: side("train", 10, 2), right: side("test", 4, 1), sharedDistinct: 1, comparedBy: "row", columns: [], capped: false, note: "", ...fields });

test("an overlap says what it found on each side, and when its counts are only the least there are", () => {
  assert.equal(overlapText(view()), "2 rows of 10 in train and 1 of 4 in test are identical, 1 different row in all.");
  assert.equal(overlapText(view({ comparedBy: "columns", columns: ["q", "a"] })), "2 rows of 10 in train and 1 of 4 in test are identical by q, a, 1 different row in all.");
  assert.match(overlapText(view({ capped: true })), /^at least 2 rows .* at least 1 of 4 .* at least 1 different row/);
  const none = { left: side("train", 10, 0), right: side("test", 4, 0), sharedDistinct: 0 };
  assert.equal(overlapText(view(none)), "No identical rows: 10 rows and 4 rows compared.");
  assert.match(overlapText(view({ ...none, capped: true })), /^None found so far/, "out of room, none is not none");
  assert.equal(sideName({ path: "set", split: "test" }), "set (test)");
});

test("what an overlap could not compare is said, and nothing is said when everything was", () => {
  assert.equal(overlapLeftOut(view()), "");
  const text = overlapLeftOut(view({ left: side("train", 1, 0, { malformed: 2 }), right: side("test", 1, 0, { tooLong: 1, withoutColumns: 3 }), capped: true }));
  assert.match(text, /train: 2 malformed rows/);
  assert.match(text, /test: 1 row too long, 3 rows without those columns/);
  assert.match(text, /least there are/);
});

test("typed columns lose their spaces and empty ones, and only files that can be read are offered", () => {
  assert.deepEqual(parseColumns(" a, b ,,"), ["a", "b"]);
  assert.deepEqual(parseColumns(""), []);
  assert.ok(usesHelper("parquet") && usesHelper("arrow") && usesHelper("dataset"));
  assert.ok(!usesHelper("csv"));
  assert.ok(isReadable(file()));
  assert.ok(!isReadable(file({ exists: false })));
  assert.ok(!isReadable(file({ problem: "A link" })));
  assert.ok(!isReadable(file({ format: "other" })));
});
