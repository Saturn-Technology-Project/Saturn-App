---
name: training-smoke-test
description: Prove a training pipeline works in minutes before the real run. Read before any training run.
---
# Training smoke test

## Start from the template
`research_template` with `name: "train_loop"` is a training program Saturn can follow and resume: metrics, atomic checkpoints listed for resuming, restore of model, optimizer, scheduler and every generator's state (CPU and CUDA) with a report naming what came back, and a `--smoke` flag for this test. Copy it, change the model and data where it says, keep the record-keeping.

## In order
1. **Read a batch.** Decode it and read inputs and labels. See `tokenizer-and-format`.
2. **Loss at the start.** For classification over V tokens with random weights, cross-entropy is near `ln(V)`: about 10.8 for 50,000 tokens. Far off means something is wrong before training begins.
3. **Overfit one small batch.** With 2 to 8 examples and no regularization, loss should go near zero in a few hundred steps. If not, the bug is in the model, labels, optimizer or masking. Nothing else is worth trying until it does.
4. **Check that gradients flow.** After one step, every trainable parameter that should have a gradient has a nonzero one.
5. **Check weights change.** Compare a parameter before and after a step.
6. **Generate something.** Text from the overfit model should show the example. It proves the path through generation works too.
7. **Round-trip a checkpoint.** Save, load into a fresh model, and get the same loss on the same batch.
8. **Time it.** Seconds per step and peak memory, for `compute-budget`.
9. **Try resume.** Stop and continue from a checkpoint, and compare with the run that did not stop: the loss should continue, not jump.

## As a run
Run it as a real experiment version with a small step count, so the record shows it, and the same code path is tested. Put the size in an argument, and keep the code otherwise identical to the full run.

## When to stop
If overfitting fails, go to `training-debugging`. Do not begin the full run hoping it improves.
