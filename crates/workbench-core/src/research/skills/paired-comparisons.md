---
name: paired-comparisons
description: Compare two runs or models sample by sample, find what improved and what regressed, and keep the regressions. Read before saying one model or version is better, or when looking for what changed.
---
# Paired comparisons

A mean over different samples hides which samples moved. A paired comparison matches the same sample ID (and trial) on both sides and reports the difference per sample.

## Read one
`research_read` with `what: "paired"`:
- `left`, `right`: each `{ "runId": ..., "modelId": ... }`. Name the model when a run holds several. The delta is always right minus left.
- `scorer`: a numeric score name. `higherIsBetter: false` for losses and errors.
- `only`: `all`, `improved`, `regressed`, `unchanged` or `missing`. `sliceField` to slice by a field other than `category`, such as `metadata.group.language`.
- `cursor` to page through items, 200 at a time.

What comes back:
- `comparison.result`: `comparable`, `not_comparable` or `unknown`, with what differs or is missing. Only `comparable` pairs get `interval95`.
- `summary`: paired count, improved, regressed, `meanDelta`, missing on each side, excluded errors, independent sample IDs.
- `slices`: the same per category. A small mean change can hide a large change in one slice.
- `note`: what the interval does and does not cover. It treats sample IDs as independent; it says nothing about variation across training seeds.

## Keep the regressions
`research_evidence` with `action: "save_counterexamples"`, the same fields, `only: "regressed"` (the default) and a `title`. Every matching sample is kept, not just the first page, with the request and evidence hashes. Read samples from the set before you describe it. See `counterexample-mining`.

## Say it honestly
- A descriptive delta under different or unknown conditions does not establish an improvement. Say which condition differs.
- An imported run is always a description. See `importing-results`.
- Several comparisons at once need the care in `statistics-for-comparisons`.
- Write what you found as a finding that names both runs. See `recording-findings`.
