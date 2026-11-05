---
name: freeze-and-run
description: Freeze an experiment, start a run and follow it to the end. Read before starting any run.
---
# Freeze and run

## The steps
```
research_run { action: "freeze", experiment: "<id>" }     → version, new
research_run { action: "start", version: "<id>" }         → run
research_wait { run: "<id>", seconds: 600 }               → ended, run, summary or resources
```
Repeat `research_wait` until `ended` is true.

## Freezing
A version holds the command, folder, seeds, evaluation, models, git commit, uncommitted files and input hashes. Freezing unchanged content returns the same version with `new: false`. A changed file makes the next version. Older versions and results stay as they are.

The data and scorer of each experiment's newest version become locked for agents.

## Before starting
Smoke test: same program, a few samples. Use an argument or environment variable in the command, so that the real run differs only there, and say which runs were smoke tests in a finding, so they are not confused with results.

## Starting
- `start` checks inputs against the version. If they changed since freezing it answers 409, so freeze again.
- A repeated call with the same `attempt` returns the same run and starts nothing. Use `attempt: 2` to run a version again deliberately.
- Experiment runs do not start on Windows.

## Following
While it runs, `research_wait` gives resources: elapsed time, processor, memory, GPU, lines written, tokens. In the first minutes check:
- `samplesLines` is growing, at about the expected rate.
- The GPU is in use, if there should be one.
- `what: "log", stream: "stderr"` shows no repeating error.

Stop early if it is failing: `research_run { action: "stop", run }`. Complete samples are kept.

## When it ends
Read, in order:
1. `status`. If it is not `completed`, see `run-failures`.
2. `error`, `warnings`, `inputsChanged`, `problems`. `inputsChanged` means a declared input changed during the run: treat the result as suspect.
3. The summary: scores and errors per model. Error counts first.
4. Samples. See `reading-samples`.

`completed` means it executed. It says nothing about the hypothesis.
