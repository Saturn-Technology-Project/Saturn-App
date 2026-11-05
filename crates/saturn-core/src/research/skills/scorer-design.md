---
name: scorer-design
description: Build and validate a scorer, and connect it to a person's labels. Read before trusting any score.
---
# Scorer design

A scorer is code, and has bugs. Most wrong conclusions in evaluation start here.

## Choose
- Prefer the **most direct measure**: exact match or a logit difference before a model-graded judgment.
- Report the **continuous** value when there is one: thresholds hide size.
- A **model as judge** needs its own validation, costs money, and drifts when it changes. Pin it, and check it against labelled examples.

## Validate
1. Hand-write 20 or more cases with the right answer: clear passes, clear failures, near misses.
2. Assert the scorer on them, in a test in the project.
3. Run it on trivial outputs: empty string, repeating the prompt, the right answer with extra words.
4. Read 20 real outputs next to their scores before any large run.

## Output
Write the numeric score in `scores`, and the verdict in words in `scorerLabel` when a person may label the same samples: labels and `scorerLabel` are compared directly.

Use `labels` on the experiment for the words a person labels with, and `labelAliases` for explicit matches such as `{"Wrong name":"Wrong"}`. Saturn does not guess that two words mean the same.

Write `expected`, and `alternative` for a two-way comparison, so that sweeps can compute margins. Tell scorer errors from model failures with `error.kind: "scorer"`.

## Freeze it
Name the scorer's file in `inputs.scorer`. Once frozen it is locked for agents, so that it cannot be tuned to reach a result. If it has a real bug, say so and ask the person to release it. A fixed scorer makes a new, not comparable version, so re-run earlier models.

## Disagreement
When the person has labelled samples, read `what: "labels"`: `agreesWithScorer` shows where they differ. Read the disputed ones with `only: "disputed"`. Low agreement means the score does not measure what the person means, and that comes before any comparison.
