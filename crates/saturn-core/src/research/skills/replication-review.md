---
name: replication-review
description: Check a finding with a second-reader pass and a pre-registered replication before its conclusion stands. Read before calling a result a conclusion.
---
# Replication review

A result becomes a conclusion once a reader who did not produce it has checked it, and it has come out again. Until then it is an observation, however clean it looks.

## Second-reader pass
Read as if someone else had done the work, from the records and not from memory:
1. `research_read { what: "record", collection: "findings", id }`, then each run in its `runIds`: `status` is `completed`, `inputsChanged` is false, and every warning is explained.
2. `what: "evidence"` on each run: the three verdicts. `inputs: partial` names something uncontrolled; say what it was and whether it could change the result. A `reported` field that is `null` means the program never said which seed or model revision it used.
3. `what: "compare"` on the versions compared: `comparable`, or the comparison is not one.
4. The scorer: its validation cases, and its agreement with labels (`what: "labels"`). A scorer nobody checked is the first suspect.
5. The statistics: paired differences with an interval and n, seeds as the unit for training claims, and how many comparisons were made. See `statistics-for-comparisons`.
6. The samples: how many were read and how they were chosen.
7. Leakage: the checks in `data-leakage-audit`, done or not.
Write the pass as a finding, `kind: "observation"`, naming what holds and what does not. If something does not hold, stop there: there is nothing to replicate yet.

## Pre-register the replication
Before running, write what the replication must show as a new hypothesis, with direction and size: "On seeds 11, 12 and 13 the mean paired difference stays above +0.3, with its 95% interval above 0." Link the replication experiment with `hypothesisId`. A prediction written after the run is not one.

## Replicate
Change one thing and keep the rest: new `seeds`, or a fresh split drawn by the same rule from data not yet touched, or both as two versions. Freeze and run as a new version (`freeze-and-run`), and compare per sample with `what: "paired"`. Run every model the finding names; a replication that drops the baseline replicates nothing. Expect a smaller effect: a first result that was kept because it was large is large partly by chance.

A different machine or library version is a replication of another kind, and is worth noting. A different scorer is not a replication: see `scorer-design`.

## Reading the result
- **Held**: set the replication hypothesis `supported`, then the original's, each in a finding that names both sets of runs. Now `kind: "conclusion"` is honest.
- **Same direction, smaller**: `inconclusive`, with both effect sizes in the finding. Say which size you now believe and why.
- **Gone or reversed**: `refuted`. Write a new finding; do not edit the original into agreement. Change the original's `kind` to `observation`, or leave it and say in the new finding that it did not replicate.
Every verdict you set is recorded as yours. One the person set stays as it is; disagree in a finding.

## Postmortem
When a result dies, write it down as a finding while it is fresh:
- **Believed**: the claim, with the finding and run ids.
- **Wrong**: what the second reading or the replication showed. One seed; a template on both sides of the split; a scorer that counted refusals as right; a comparison across versions that were not comparable.
- **Next time**: the check that would have caught it, and at which stage. Add it to the study plan.
A postmortem is a result. Keep the dead finding, and let the postmortem name it.

## Limits
A replication by the same person with the same code shares its mistakes. Say so, and name what an outside replication would need: version ids, the data's hashes and datasheet, the scorer, and where the weights are.
