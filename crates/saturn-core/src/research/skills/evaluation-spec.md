---
name: evaluation-spec
description: Fill in the evaluation spec, so that runs compare fairly or say why they do not. Read when creating an experiment.
---
# The evaluation spec

Two runs compare only through `evaluation`. Answers: `comparable`, `not_comparable` with the fields that differ, or `unknown` with those missing.

```json
{ "dataset": "ioi-names", "split": "test", "sampleSet": "all-500", "scorer": "logit-diff",
  "promptFormat": "continuation", "chatTemplate": null,
  "generation": { "max_new_tokens": 1, "do_sample": false } }
```

## Fill in everything
A missing field makes comparisons `unknown`, which helps nobody. Use `null` for "does not apply", as with `chatTemplate` on a base model.

## Keep it true
It is your statement of what the program does, and the runtime cannot verify it. If you change the prompt format in code and not in the spec, the comparison lies. Read the program after writing the spec. Files named in `inputs.data` and `inputs.scorer` are hashed, and changed ones make versions `not_comparable` whatever the spec says.

Saturn adds a warning when a run's samples per model differ from the last comparable completed run. Read `warnings` on a run: a stale evaluation often shows up there.

## What belongs here
Only what changes the measurement. Training data does not belong here: pretraining, supervised fine-tuning and preference training are meant to differ, and that is what you compare across.

## Checking
```
research_read { what: "compare", left: "<version id>", right: "<version id>" }
```
Before comparing numbers, compare versions. If the answer is not `comparable`, do not chart them together. Say what differs. If you must change the evaluation mid-study, re-run the old models under the new one.
