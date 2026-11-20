---
name: counterexample-mining
description: Search a run for cases that break the pattern and keep them. Read when a result looks clean or when testing a claim.
---
# Counterexample mining

A claim gets stronger by surviving attempts to break it. Search for what would refute it.

## Finding them
1. State the claim narrowly: "the fine-tuned model tracks the indirect object".
2. Find failures: samples where it loses to its parent, or where the score is lowest.
3. Find odd successes: right for the wrong reason. Read the output as well as the score.
4. Group them: the same name order, the same template, the same length. A pattern of failure is the finding.
5. Test the pattern: write new inputs of that kind in a new evaluation sample set. If failures follow, you have learned something general. That needs a new version, and is not comparable with the old evaluation, which is fine.

## Keeping them
```
research_write { collection: "counterexamples", fields: { runId, sampleId, note: "Why this one matters" } }
```
They show on the sample and stay after the run ends. Keep few and meaningful: a list of 500 helps nobody.

## Use in the report
Every claim in the report names its strongest counterexamples. If you searched and found none, say how you searched. Do not delete a claim's exceptions from the story.

## Do not train on your test
Adding counterexamples to the training set is legitimate, and then they are not test data any more. Build a new held-out set before measuring again. See `data-leakage-audit`.
