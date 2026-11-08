---
name: steering-vectors
description: Build a direction from contrastive prompts or a probe, add it at a layer over a coefficient sweep, and measure effect and side effects together. Read before claiming a direction controls behavior.
---
# Steering vectors

A steering vector is a direction in the residual stream, added at one layer during the forward pass and scaled by a coefficient. It is a causal test of a direction and a tool. It is not a mechanism claim on its own.

## Building the direction
`research_template` with `name: "steering_sweep"` builds a difference-of-means direction, adds it with a hook, sweeps coefficients with the controls below and writes one sample per prompt and coefficient. Start from it.

- **Difference of means**: two prompt sets that differ in the property and match otherwise, the mean activation of each at a chosen layer and position, and their difference. Dozens of pairs at least; report how many. For a run's samples, `research_inspect` `action: "activations"` with `save` keeps each sample's raw layers as an `.npz` in the project (see `linear-probes`); for prompts of your own, a hook script.
- **A probe's weights**: the direction a probe learned. See `linear-probes`. A direction that separates classes need not be one that moves behavior, so test it the same way.
- Build it on one prompt set and test on another. A direction tested on the prompts that built it is overfit by construction.
- Save the vector under `SATURN_RUN_OUTPUT` with its layer, position rule, norm and the prompt sets' hashes, and register it with `research_evidence`. See `analysis-outputs`.

## Adding it
With `transformer_lens`, a forward hook on the residual stream leaving the layer (`hook_resid_post`), or the matching hook on a plain transformers model, adds `coefficient * direction` at every position or at the positions you name. Say which, since adding at all positions and at the last token behave differently. Keep `torch.inference_mode()` on.

## Sweep the coefficient
Run a range of coefficients in one run, with 0 and negative values among them, on the same prompts at each. Express coefficients in multiples of the typical residual norm at that layer, so the numbers carry across layers and models.

## Measure in the same run
For every prompt and coefficient, one sample line with `scores` for:
- the **target behavior**: the scorer the hypothesis names, on held-out prompts;
- **perplexity** or loss on a fixed unrelated text, to see fluency degrade;
- **unrelated tasks**: a few held-out items the direction should leave alone.
Put the coefficient in the `sampleId` or in a score, so samples can be sliced by it. Large coefficients break the model; where that starts is part of the result. See `experiment-program`.

## Controls
- **A random vector of the same norm** at the same layer over the same sweep. The direction must beat it at every coefficient you report.
- **The direction at a wrong layer**, several layers away: it should do less.
- **A negative coefficient**: subtracting should move the behavior the other way, if the direction is what you say.
- **Coefficient 0** must match the unsteered model exactly. If it does not, the hook is wrong.

## Report dose-response
Plot the target measure and each side effect against the coefficient, with intervals, for the direction and both controls on the same axes. The claim rests on the curve, not on one coefficient chosen after seeing results. Set the side-effect threshold beforehand and name the coefficient where it is crossed. See `plots-and-analysis` and `statistics-for-comparisons`.

## Limits
- Steering shows a direction can move the behavior. It does not show the model uses that direction, or that the behavior lives at that layer: at large norms many directions move many behaviors.
- A judging model's scores move with fluency loss. Read samples at the coefficients you report. See `reading-samples`.
- A direction built on one checkpoint says nothing about another until tested there. See `comparing-across-lineage`.
- "Adding the direction at layer 12 at twice the residual norm raised the scorer from 0.2 to 0.7 (n given) with perplexity up a tenth; a random vector of the same norm raised it to 0.25" is what was measured. "The model has a direction for X" is more. See `recording-findings`.
