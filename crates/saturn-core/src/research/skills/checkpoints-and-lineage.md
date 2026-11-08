---
name: checkpoints-and-lineage
description: Save checkpoints where they do not disturb versions, and record each as a model in the lineage. Read when training produces weights.
---
# Checkpoints and lineage

## Where to save
- In `SATURN_RUN_OUTPUT`: the run's `written/` folder, kept with its record. This is where the sandbox lets the
  program write, and where a resume looks first. Use it unless the weights are too large to keep with the run.
- In a git-ignored folder in the project such as `checkpoints/`: only when the person has turned the sandbox off for
  the version (`sandbox.isolated: false`), since a sandboxed program cannot write the project. Ask, and say how large
  the weights are. Add the folder to `.gitignore` before training starts.

New untracked files in the project change the next version, and large ones are saved or hashed with it. Never write checkpoints to a tracked or unignored folder.

## What to keep
Newest, best by validation, and a few at planned steps. Weights take room, so delete the rest deliberately, and only those no record names.

A resumable checkpoint holds model, optimizer, schedule step and the state of every random generator in use: Python's, NumPy's, torch's CPU generator and, on a GPU, each CUDA device's (`torch.cuda.get_rng_state_all()`), which `torch.get_rng_state()` does not include. A model record only needs the weights.

List each resumable checkpoint in `SATURN_RUN_ARTIFACTS` as you save it, with `kind: "checkpoint"` and its `step`: a resume of the run restores the last one listed. See `pause-and-resume`.

## Saving
```python
model.save_pretrained(folder, safe_serialization=True)
tokenizer.save_pretrained(folder)
```
Save to a temporary name and rename, so a crash leaves no half checkpoint. Then hash it:
```python
import hashlib, pathlib
digest = hashlib.sha256()
for file in sorted(pathlib.Path(folder).glob("*.safetensors")):
    digest.update(file.read_bytes())
```

## Record it
```
research_write { collection: "models", fields: {
  name: "pretrain-step-20000", source: "/absolute/path/to/checkpoint",
  weightsRevision: "<sha256>", parentId: "<parent model>", trainingData: "<dataset and its hash>",
  producedBy: "run <id>" } }
```
- Without a full commit or hash as `weightsRevision` the model is `floating`, and every run on it says so. `main`, `latest` and short commits are floating.
- `parentId`: the checkpoint or model it came from. Cycles are refused.
- `referenceId`: the frozen model preference training was against.
- For a published model: its name as `source`, and its commit hash as `weightsRevision`.

## Why it matters
Lineage is how a score is tied to how the weights came about. The Lineage screen and `comparing-across-lineage` depend on it, and a model with no parent is a claim that nothing preceded it.

A local path breaks if the file moves. Say in the report where the weights are, and that they are not in git.
