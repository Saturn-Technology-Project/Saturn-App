---
name: research-autopilot
description: Carry out a whole study on your own, from a question to a report. Read this first when asked to do research independently.
---
# Research autopilot

The loop for an independent study. Each stage names the skill to read before doing it; read it, do not work from memory.

## Before you start
1. `research_read` with `what: "status"`. Continue what exists rather than duplicating it.
2. Check you can act: in a Manual chat you only read, in a Pair chat every change waits for the person. A long study belongs in a task (Delegate). See `modes-and-boundaries` and `task-worktrees`.
3. Agree the limits in one message if the person gave none: the question, the compute budget, and how long you may run. If you cannot ask, take the smallest reasonable budget and write it down in your first finding. See `compute-budget`.

## The stages
| Stage | What comes out of it | Skills |
|---|---|---|
| 1. Scope | One question record | `scoping-a-question`, `literature-review` |
| 2. Commit to predictions | Hypothesis records, written before any result | `writing-hypotheses` |
| 3. Design | A plan as a finding: variables, baselines, sample size, stop rule | `study-design`, `baselines-and-controls`, `statistics-for-comparisons` |
| 4. Environment | A checked interpreter and a lock file | `environment-setup`, `reproducibility` |
| 5. Data | Fixed splits, hashed, audited | `dataset-preparation`, `data-leakage-audit`, `tokenizer-and-format` |
| 6. Measure the start | An evaluation run on the untrained or base model | `experiment-program`, `evaluation-spec`, `scorer-design`, `freeze-and-run` |
| 7. Train | Checkpoints, each a model record in the lineage | `training-smoke-test`, then `pretraining`, `fine-tuning` or `preference-training`; `checkpoints-and-lineage`, `gpu-and-memory` |
| 8. Evaluate | Runs that compare as the same evaluation | `freeze-and-run`, `comparing-across-lineage` |
| 9. Understand | Sample review, statistics, mechanism | `reading-samples`, `counterexample-mining`, `statistics-for-comparisons`, `activation-patching`, `layer-sweeps` |
| 10. Report | Findings tied to runs, a report file, a list of what the person decides | `recording-findings`, `study-report`, `handing-back` |

## Rules that hold throughout
- **Write the prediction before the result.** A hypothesis made after seeing the number is a description, and you say so.
- **Smoke test everything first.** Run on a tiny sample before spending the budget. A failed long run is the most expensive mistake available.
- **One change per version.** If two things changed, the comparison says nothing about either.
- **A run that completed only executed.** It says nothing about whether the hypothesis holds.
- **Read the samples.** Never conclude from a mean alone: read some wins and some failures.
- **Record as you go.** Write a finding at each stage boundary, so a stopped turn loses nothing. On resuming, status and findings tell you where you are.
- **When stuck, stop honestly.** After two failed fixes of the same problem, record what you tried and what you need, and hand back. See `run-failures`.
- **Do not fake progress.** Never edit samples, drop failures quietly, or change a scorer to reach a result. If a result is disappointing, it is the result.

## What you never do
Set a verdict, set a label, change a chat's mode, lift a lock, or merge a task. The tools do not offer these. Finish by telling the person exactly which of them are waiting: see `handing-back`.

## Long runs
`research_wait` holds a turn for up to 600 seconds, so call it again until the run ends. A turn has a limit on tool steps; if yours stops, the person says continue and you resume from status and your findings.
