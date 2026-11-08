---
name: scaling-and-efficiency
description: Scaling curves on a small grid, distillation and quantization as Saturn experiments with fair evaluation. Read before claiming a trend, a smaller model or a cheaper one.
---
# Scaling and efficiency

Three studies that share one trap: comparing models that were not measured the same way.

## Scaling curves
- A grid of a few sizes, or a few compute budgets, trained with the same program, data pipeline and schedule, as in `pretraining`. Each size is an experiment version; each checkpoint a model record with `parentId`, `producedBy` and `trainingData`.
- Log validation loss against tokens seen and against parameters to `SATURN_RUN_METRICS`, with the same fixed held-out batches at every size, so points on the curve share one measurement. Write `tokens_per_second` and device memory on the lines too: speed is part of the curve.
- Fit on loss against parameters or compute. A power law plus a constant is the common form, but with four or five points the fit is a description of those points, not a law. Report the fit, its residuals and the range it covers.
- Where a fit means anything: inside the range of sizes you trained, with a schedule tuned at each size. A grid where only the smallest size was tuned bends the curve. Undertrained points lie above it.
- Extrapolation is a hypothesis. Write it as one (`writing-hypotheses`) with the predicted value at the next size, and treat the next training run as its test. Never report a predicted number next to measured ones without saying which is which.
- Compute-optimal claims (the best size for a fixed budget) need both axes varied; do not read them from a one-axis sweep.

## Distillation
- Teacher and student are both model records. The student's `parentId` is its initialization (a smaller checkpoint or a fresh model), and its `note` names the teacher's id and the loss (soft targets, hidden states, sampled outputs). Teacher outputs used as data are a data file with a hash, in `trainingData`, even when they were generated in the project.
- The student experiment reads the teacher through its pinned record: a teacher with a floating revision makes the student's data unreproducible.
- Evaluate teacher, student and the student's untrained parent under one evaluation version (`comparing-across-lineage`). Report what is lost per category with `research_read { what: "paired" }` and its `slices`: distillation usually keeps the common cases and loses the rare ones, and a mean hides that.
- Log the student's agreement with the teacher separately from its score on the task. High agreement with a wrong teacher is not success.

## Quantization
- A quantized model is a new model record: `parentId` the full-precision one, `weightsRevision` the hash of the quantized weights, `note` the method and bit width. Several methods are several records.
- Fair comparison means the same evaluation version, the same prompts, the same generation settings and the same device for all. A quantized model evaluated with a different runtime (another kernel, another sampler) is a different measurement, and the spec says so.
- Report degradation per task and per slice, paired on `sampleId`, with intervals: a point of mean accuracy can be ten points on one category. Keep the regressions as counterexamples.
- Measure speed and memory inside the run, not from a datasheet: `tokens_per_second` and `usage.deviceMemoryBytes` on sample lines, under the same batch size and length for every model. Speed on one device says nothing about another; name the device from `research_read { what: "environment" }`.
- A perplexity gap on text is not a capability gap, and the reverse. Measure the behavior the person cares about.

## What to claim
- "Loss fell as a power law over this range" is measured; "it will continue" is a hypothesis.
- "The student keeps 95% of the teacher's mean score" says nothing until the categories it lost are named.
- "4-bit costs one point" is true on this evaluation, this device and this runtime; the finding names all three.
Write the findings with run ids and intervals, as in `recording-findings`, and the grid's failed sizes with them.
