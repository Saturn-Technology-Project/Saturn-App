// The usage summary someone can share: counted from their records, by local day, with nothing of their work in it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { usageSummary, usageText } from "../src/domain/usage-summary.ts";

test("days, projects and records are counted across projects, and imports apart from runs", () => {
  const summary = usageSummary([
    { runs: [{ createdAt: "2026-11-02T12:00:00Z" }, { createdAt: "2026-11-05T12:00:00Z", imported: true }], experiments: [{ createdAt: "2026-11-02T12:00:00Z" }, { createdAt: "2026-11-05T12:00:00Z", imported: true }], questions: [{ createdAt: "2026-11-01T12:00:00Z" }], findings: [] },
    { runs: [], experiments: [], questions: [], findings: [] },
    { runs: [], experiments: [], questions: [], findings: [{ createdAt: "2026-11-05T12:00:00Z" }, { createdAt: "not a time" }] },
  ]);
  // Midday UTC falls on the same calendar day from UTC-11 to UTC+11; a record with no time adds no day.
  assert.deepEqual(summary, { days: ["2026-11-01", "2026-11-02", "2026-11-05"], projects: 2, runs: 1, imported: 1, experiments: 1, questions: 1, findings: 2 });
});

test("the shared text holds counts and dates only", () => {
  const text = usageText({ days: ["2026-11-02", "2026-11-05"], projects: 1, runs: 3, imported: 2, experiments: 1, questions: 1, findings: 4 }, "0.5.2");
  assert.match(text, /Saturn 0\.5\.2/);
  assert.match(text, /Days with work: 2 \(2026-11-02, 2026-11-05\)/);
  assert.match(text, /Results brought in: 2/);
  assert.equal(text.split("\n").length, 8);
});
