---
name: comparing-across-lineage
description: Measure a family of checkpoints under one evaluation, to see what each training stage changed. Read when comparing pretraining, SFT and preference stages.
---
# Comparing across a lineage

The question: what did each stage change, and when?

## Set up
1. All the models are records, pinned, with `parentId` chains. See `checkpoints-and-lineage`.
2. One evaluation experiment names them all in `models`, with roles, and the program writes one line per sample per model, with `modelId`.
3. One version means one evaluation. Fewer version comparisons to worry about.

If models run in separate versions, confirm before reading them together:
```
research_read { what: "compare", left, right }
```
Anything but `comparable` does not go on one chart.

## Reading
- Score by step or stage: where does it move? Sudden jumps deserve a look at the checkpoints around them.
- Pairwise, on the same samples: parent against child. See `statistics-for-comparisons`.
- Samples that flipped: right in the parent, wrong in the child, and the reverse. `what: "sample_across"`.
- Look at general ability too: gaining a behavior at the cost of everything else is a common finding.

## Base models and chat models
Base models continue text, and fine-tuned ones may expect a template. Two options, each with a limit:
- The same prompt format for all: fair in form, but may under-measure chat models.
- Each with its own format: fair in spirit, but it is not the same measurement, and the spec says so.

Often run both, and report the difference. Say which you chose before seeing results.

## Causes
A change across a stage shows when, not why. Use `activation-patching` and `layer-sweeps` to ask where in the model it lives, and keep that apart from what the scores alone show.
