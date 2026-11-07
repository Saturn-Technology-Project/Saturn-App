---
name: pause-and-resume
description: Pause a run and continue it, and resume one that stopped, was interrupted or failed, from where it was. Read before pausing or resuming, and when writing a program that should be resumable.
---
# Pause and resume

## Pause and continue
```
research_run { action: "pause", run: "<id>" }      → the run, status "paused"
research_run { action: "continue", run: "<id>" }   → the run, status "running"
```
- Pausing holds the whole process where it is. It keeps its memory, the GPU's included, so a paused run still blocks the device for others. Pause for minutes, not for a night.
- A paused run is still going. `research_wait` returns as soon as it is paused (`paused: true`), so ask yourself whether to continue it; do not wait on it.
- The run records `pausedSeconds`. Say it when you report the run's speed or cost.
- Stopping a paused run works: it ends as stopped. If Saturn restarts while a run is paused, the run ends as interrupted.
- Remote runs cannot be paused yet.

## Resume
```
research_run { action: "resume", run: "<id>", attempt: 1 }                        → run (a new one)
research_run { action: "resume", run: "<id>", checkpoint: "written/step-2000", step: 2000 }
```
- Only a run that is `stopped`, `interrupted` or `failed` can be resumed. A completed run has nothing left; a paused one is continued.
- The new run runs the same frozen version. If its code, data or models changed since, freeze a new version and start that instead: that is not a resume.
- The new run says `resumes: "<id>"` and what it `carried`, and its evidence records the same with a hash.
- Before resuming a failed run, find out why it failed (see `run-failures`). Resuming a crash that will happen again wastes the time a resume saves.
- A repeated call with the same `attempt` starts nothing. Use a new attempt to resume the same run again.

## What the program has to do
Saturn carries what it can; skipping and restoring are the program's job, and only its report says it did them.

**Evaluation.** The samples the resumed run finished are already in `SATURN_RUN_SAMPLES` when the program starts. Read the file first and skip every sample whose identity (`sampleId`, with `trial` and `modelId` when you use them) is there:
```python
import json, os
path = os.environ["SATURN_RUN_SAMPLES"]
done = set()
if os.path.exists(path):
    with open(path) as lines:
        done = {json.loads(line)["sampleId"] for line in lines if line.strip()}
for sample in samples:
    if sample["id"] in done:
        continue
    ...
```
A program that does not skip writes the same identities twice, and the run ends as `protocol_error`.

**Training.** `SATURN_RESUME_FROM` names the checkpoint to restore: the one given, or by default the last entry of kind `checkpoint` in the resumed run's `SATURN_RUN_ARTIFACTS`. List each checkpoint there as you save it, with its step:
```python
with open(os.environ["SATURN_RUN_ARTIFACTS"], "a") as manifest:
    manifest.write(json.dumps({"path": "written/step-2000", "kind": "checkpoint", "step": 2000}) + "\n")
```
`path` is relative to `SATURN_RUN_DIRECTORY`; `written/` is `SATURN_RUN_OUTPUT`. A checkpoint elsewhere in the project works too. With the step known, the metrics up to it come along, so the curve goes on where the checkpoint was saved.

Restore model, optimizer, scheduler, step and random state, then report what was restored:
```python
report(kind="resume", checkpoint=os.environ["SATURN_RESUME_FROM"], restored=["weights", "optimizer", "scheduler", "rng"])
```
`report` is the helper in `run-provenance`. Without that line, the evidence says the restore is unknown. See also `checkpoints-and-lineage`.

**Also there.** `SATURN_RESUME_RUN` is the resumed run's id and `SATURN_RESUME_DIRECTORY` its folder, which the program may read but not change.

## When not to resume
- The failure was in the method, not the machine: fix it, freeze, and start fresh.
- The samples were wrong, for example a scorer bug: carried samples keep the bug. Start fresh.
- Seeds or nondeterminism matter for the claim: a resumed run is not identical to an uninterrupted one. Say so in the finding.
