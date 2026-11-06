---
name: run-provenance
description: What a run's evidence shows and does not, and how a program reports its seed, models and resumed state. Read before citing a run.
---
# Run provenance

Every local run starts from its own snapshot of the version, made and checked before the command runs:
- Committed files come from git's own objects for the frozen commit, not from the folder.
- Uncommitted files come from the copies saved when the version was frozen, or are copied and checked.
- Declared data and scorers are copied in (copy-on-write where the disk can) and checked against the version's hashes.
- A file that differs refuses the run before anything runs. Freeze a new version to run the new content.
- Files are read-only while the run reads them. This is permissions, not isolation: a program can still delete and
  replace a file, and Saturn then records it as changed.
- Top-level folders that are neither in the version nor declared (a `.venv`, a cache) are reached by link and listed as
  **uncontrolled**.
- New files the program writes in its working folder are kept in the run's `written/` folder.

## Reading the evidence
`research_read { what: "evidence", run }` answers three things, kept apart:
- `expected`: what the version says (command, commit, inputs, models, seeds).
- `observed`: what Saturn saw (the snapshot's files and hashes, how each input got there, what is uncontrolled, what
  changed during the run, the seeds passed).
- `reported`: what the program said about itself. `null` means it did not say. Never fill it in from `expected`.

And three verdicts:
- `execution`: whether the program ran to completion.
- `inputs`: `verified` (every input controlled and unchanged), `partial` (something uncontrolled or linked), `changed`
  or `unverified`.
- `outputs`: `sealed`, `incomplete`, `changed` (the samples no longer match their seal), or `none`.

A hash shows which content a file had. It does not show that the program used it, or that the scorer or the
conclusion is right. Say so when you cite a run, and name what was uncontrolled.

## Reporting from the program
Write one JSON object per line to `SATURN_RUN_REPORT`. Each kind is optional; whatever is not written stays unknown.
```python
import json, os

def report(**fields):
    path = os.environ.get("SATURN_RUN_REPORT")
    if path:
        with open(path, "a", encoding="utf-8") as out:
            out.write(json.dumps(fields) + "\n")

seed = int(os.environ.get("SATURN_RUN_SEED", "0"))
random.seed(seed); numpy.random.seed(seed); torch.manual_seed(seed)
report(kind="seed", value=seed, applied=["python", "numpy", "torch"])
report(kind="model", source="huggingface", id=name, revision=model.config._commit_hash)
report(kind="config", resolved=config_as_dict)
report(kind="resume", checkpoint=path, restored=["weights", "optimizer", "scheduler", "rng"])
```
- `SATURN_RUN_SEED` is the version's first seed and `SATURN_RUN_SEEDS` all of them. Saturn passes them; only the
  program can say it applied them.
- Report the model revision the library actually loaded, not the one you asked for.
- For a resumed run, report what was restored. A run that restored only the weights is not the same as one that
  restored the optimizer and random state.
