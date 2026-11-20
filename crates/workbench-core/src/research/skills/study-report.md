---
name: study-report
description: Write the final report as a file a reader can check against the records. Read when a study is done, or at the point of stopping.
---
# The study report

A file in the project, for example `reports/<short-name>.md`. It should let someone who did not watch you judge the result.

## Outline
1. **Result first**: the answer in three sentences, with the main number and its uncertainty. If there was no clear answer, say so.
2. **Question and hypotheses**: as recorded, with ids, and made before or after results.
3. **Method**: models with revisions and lineage, data with hashes, evaluation, seeds, environment, hardware.
4. **Results**: a table per comparison, with run ids. Each number traceable to a run.
5. **What the samples show**: failure groups with counts, and how you chose what you read.
6. **Mechanism**, if studied: with the limits of the method stated.
7. **Counterexamples and threats**: what could make this wrong. Leakage checks, single seeds, scorer agreement, floating models.
8. **Deviations**: what differed from the plan, and each failed or invalid run, with why.
9. **Reproducing**: version ids, and how to start them. Where weights are, since they are not in git.
10. **Decisions for the person**: see `handing-back`.

## Writing it
- Every number has a run id next to it, or nearby. Read each from the record when writing, and do not rely on memory.
- Keep measured results apart from your reading of them.
- Say plainly what you did not do or could not check.
- Keep it short, and link rather than paste. A long report hides weak points.

## Check before finishing
Re-read the numbers against `what: "summary"`. Confirm that runs you cite are `completed`, with no `inputsChanged` and with warnings explained. Confirm that compared versions are `comparable`.

If the result is null or negative, write it the same way. That is a result.
