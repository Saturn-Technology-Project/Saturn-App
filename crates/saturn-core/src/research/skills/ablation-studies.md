---
name: ablation-studies
description: Design an ablation as a family of matched experiments, one factor removed at a time, read with intervals. Read before removing parts of a method to see what matters.
---
# Ablation studies

An ablation asks what a part of the method contributes, by taking it away and measuring the same thing. It is a family of experiments, not one run with a flag flipped.

## Design
- **One factor per arm.** Remove or replace one component, setting or data source. Everything else stays as in the full system: data, steps, evaluation, generation settings.
- **Match compute and data.** Removing a component often frees steps or parameters. Decide in advance whether arms match in steps, in tokens seen or in wall time, and say which; a cheaper arm given the same steps is not the same comparison as one given the same time. See `compute-budget`.
- **Two anchors.** The full system, and a baseline with none of the factors under study (or the parent model untouched). Each arm sits between them.
- **Seeds per arm.** A training arm on one seed is an anecdote. Give every arm the same seeds, at least 3 where the budget allows, as the experiment's `seeds`. See `study-design`.
- **The plan first.** Write the arms, the matching rule, the primary score and the seeds as a finding before training. An arm added after the results is exploratory, and says so.

## As Saturn records
- One experiment per arm, with its own version: the arm's setting in a config file named in `inputs.code` or in the command, so the version shows what differs. A shared evaluation experiment then measures every arm's checkpoints under one `evaluation` (see `evaluation-spec`); the checkpoints are model records with `parentId` and `producedBy`, as in `checkpoints-and-lineage`.
- Keep the evaluation program and data identical across arms, so `research_read { what: "compare", left, right }` answers `comparable`. Anything else is not one table.
- Name the arm in each model record's `name` and `note`, and the factor in the experiment's title, so the Lineage screen reads as the table does.

## Reading the table
- Report each arm as a mean with an interval and n, over seeds where seeds vary, over samples where only the evaluation does. One run per arm gives no interval, and the table must say so.
- Pair where you can: the same `sampleId` across arms lets `research_read { what: "paired" }` show per-sample deltas and slices, which a column of means hides. See `paired-comparisons` and `statistics-for-comparisons`.
- A difference smaller than the spread across seeds of the full system is not a contribution. Print that spread in the table's first row.
- Many arms mean many comparisons. Name the primary one in advance; the rest are leads.

## Interactions
Removing A and removing B are two ablations; removing both is a third, not their sum. Components overlap or compensate: two each worth nothing alone may be worth much together, and the reverse. If the question is whether A and B interact, run all four cells (neither, A only, B only, both) and read the interaction as the difference of differences, with its interval. Do not infer it from the two single ablations.

## Common mistakes
- Tuning the full system and running the arms at its settings. A removed component may need a different learning rate; say whether arms were retuned, and the cost.
- Letting the arm change the data: dropping a loss term that also filtered examples changes what the model saw. Check with `research_read { what: "data_list" }` that arms read the same files.
- Reading improvement where a part was removed and noise rose. Check the error counts per arm in `what: "summary"`.
- Stopping an arm early because it looked bad. All arms run to the matching rule.

## Record
A finding per arm with its runs, then one finding for the table, naming the matching rule, the seeds, the arms that failed and why, and which differences the intervals support. Regressions kept as counterexamples (`counterexample-mining`) show what the removed part did.
