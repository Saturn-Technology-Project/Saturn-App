---
name: pretraining
description: Train a base model from scratch as a Saturn experiment, with checkpoints in the lineage. Read when training a model from raw text.
---
# Pretraining

## Size it to the budget
Parameters and steps decide everything. On one consumer device, think small: tens of millions of parameters at most, and tokens in the hundreds of millions at most. Pick the question first: a small model that answers it beats a large one that never finishes. Publish the arithmetic: tokens per second measured × budget.

## The program
- Read a tokenized dataset as memory-mapped arrays, sampling random windows. Tokenize once, separately.
- Use AdamW with weight decay on weights, and none on norms and biases.
- Warm up the learning rate linearly, then decay it by cosine. Start near 3e-4 for small transformers, and find it with a short sweep.
- Clip gradients at 1.0. Use mixed precision where available.
- Evaluate on held-out text on a fixed schedule, with a fixed number of fixed batches, so values compare.
- Save checkpoints on a schedule, to `SATURN_RUN_DIRECTORY` or a git-ignored folder.

## Write samples as you train
A run needs valid sample lines. Write one per evaluation:
```python
write_sample(out, sampleId=f"step-{step:08d}", input="validation loss", output="",
             scores={"val_loss": val_loss, "train_loss": train_loss, "lr": lr, "tokens_per_second": rate},
             usage={"deviceMemoryBytes": torch.cuda.max_memory_allocated()})
```
So the Samples and Resources screens show progress as it happens. Print to stdout too.

## Time limits and resuming
A run that stops cannot continue as the same run, so make the program resume from the newest checkpoint when given one, restoring model, optimizer, schedule step and random state. Add a wall-clock limit that saves and exits 0.

`sampleId` must be unique within a run, not across runs, so a resumed run may repeat steps. Name its resumption point in a finding.

## Watch for
- Validation loss rising while training loss falls: overfitting. Save the best by validation.
- Loss stuck at `ln(V)`: see `training-debugging`.
- Repeated text from samples: normal early, and it should fall.

## Afterwards
Each kept checkpoint becomes a model record: see `checkpoints-and-lineage`. Then evaluate under one evaluation version, so that the whole line compares.
