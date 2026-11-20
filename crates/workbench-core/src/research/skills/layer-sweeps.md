---
name: layer-sweeps
description: Patch every layer on a set of samples to see where behavior returns. Read when asking where in the model a difference lives.
---
# Layer sweeps

```
research_inspect { action: "sweep", runId, sampleIds: [...], sourceModelId, targetModelId, layers: [...] }
```
Up to 32 samples in one call, with both models loaded once. `layers` is optional. It answers with `samples`, each with `expected`, `alternative`, `top`, `expectedLogProb`, `margin` and `byLayer`: what the target ends on with each layer patched.

## Prepare the samples
Write `expected` and `alternative` on the sample lines, so `margin` is the logit margin of `expected` over `alternative`, which is what a two-way scorer judges. Each word's first token only is compared, so check they differ in that token. Without `alternative`, margin is null and only `top` can be read.

## Choose samples
- Those the scorer marked wrong in the target and right in the source: the sweep then asks what brings them back.
- Also some the target already gets right, as a control: patching should not break them.
- Pick by a fixed rule, not by looking at results. More than 32: split into several calls.

## Read
- For each layer, count samples where the margin is above zero, and the mean margin.
- Several layers can tie for best. Report all of them, not the first.
- A sample no layer restores is a finding too: the difference may not be in the residual stream as patched.
- The number at the last layer should match the source's own result. If it does not, stop and find out why.

Whether a layer "restores" a sample is your reading, and the runtime gives only numbers. Say which rule you used.

## Saved results
Results are saved under the run, named by the request and the helper's hash. The same request is answered from there. `what: "inside_list"` lists them, with `current` false for any made by an earlier helper: do not count those as findings.

## Limits
See `activation-patching`: a sweep says how much of the source is needed, and does not locate a defect in one block. Long sweeps on large models take a while, so try 2 samples first to measure time.
