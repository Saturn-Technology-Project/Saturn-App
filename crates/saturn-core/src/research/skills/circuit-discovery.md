---
name: circuit-discovery
description: Go from where a behavior lives to which heads and MLPs carry it, with patching, ablations against a named baseline and faithfulness checks. Read before naming the parts of a mechanism.
---
# Circuit discovery

A layer sweep says how much of a model's prefix carries a difference. A circuit names the components, attention heads and MLP blocks, and the edges between them, that carry it on a task. Do `layer-sweeps` first; a search without a layer picture is wide and slow.

## Set the task up
- A clean and a corrupted prompt per pair, same token length, aligned positions, and a metric: the logit difference between `expected` and `alternative`. See `transformer-lens-probes`.
- Many pairs, fixed in advance, split into a set to find the circuit on and a set to check it on.
- Choose the ablation baseline before patching anything (below), and keep it for the whole study.

## From layers to components
With `transformer_lens`, patch per hook point instead of the whole residual stream: each head's output (`hook_z`) and each MLP's output (`hook_mlp_out`), at each position. The effect on the metric, normalized between corrupted (0) and clean (1), gives a heatmap of components by position. Save it under `SATURN_RUN_OUTPUT`. See `analysis-outputs`.

Patching every component at every position is many forward passes. Two cheaper approximations:
- **Attribution patching**: a first-order estimate of every patch's effect from one clean, one corrupted and one backward pass, using the metric's gradient. It is wrong where the metric is far from linear in the activation: early residual streams, layer norms, and components with large effects. Use it to rank candidates, then patch the top candidates for real.
- **Path patching**: patch a component's output only along its path to one receiver, holding other paths at the corrupted value. It tells direct from indirect effects, and depends on the receivers you chose.

## Ablations and the baseline
Removing a component means replacing its output with something, and that choice decides the number:
- **Zero**: pushes the model off its distribution and tends to overstate effects.
- **Mean** over a reference set: keeps the component's typical contribution; the reference set is part of the method.
- **Resample**: the component's output on another prompt of the same distribution; closest to what patching measures.
Name the baseline beside every number. Ablate nodes (whole components) or edges (one component's output as one receiver's input) as the hypothesis needs.

## Check the circuit
- **Faithfulness**: keep only the circuit's components and ablate the rest to the baseline. Report the fraction of the full model's metric recovered.
- **Completeness**: ablate the circuit from the full model. The metric should fall toward the corrupted value; what remains is what the circuit misses.
- **Minimality**: drop each component in turn. One whose removal costs nothing does not belong.
- Do these on the held-out pairs, not the ones that found the circuit, and report both sets.

## Controls
- Self-patching must change nothing. See `baselines-and-controls`.
- The effects of a set of random components, same baseline, are the floor a found component must clear.
- Ablating the same number of random components says how much the circuit beats chance structure.

## Keep it
Write the circuit as JSON: components, edges, positions, baseline, metric, faithfulness and completeness with n on each set, and the pairs file's hash. Save it under `SATURN_RUN_OUTPUT`, list it in `SATURN_RUN_ARTIFACTS`, and register it with `research_evidence` action `artifacts_from_run`. A finding names the artifact and the runs. See `recording-findings`.

## Limits
- A circuit found on one task distribution describes this model on these prompts with this metric and baseline. Another prompt format, baseline or checkpoint can change it. See `comparing-across-lineage`.
- A component that matters in ablation may matter only through later components. Path patching and direct logit attribution together say which.
- Components left out are not shown idle; they are shown not to move this metric on these pairs.
- "Three heads at layers 9 and 10 recover most of the logit difference under mean ablation on held-out pairs (fraction, n given)" is the measured claim. "The model does X with these heads" is a mechanism claim in general, and this does not support it.
