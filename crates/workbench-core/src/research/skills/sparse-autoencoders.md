---
name: sparse-autoencoders
description: Train or use sparse autoencoders on activations, read a prompt's features with research_inspect, and judge them honestly. Read when decomposing a layer into features.
---
# Sparse autoencoders

An SAE rewrites one hook point's activations as a sparse sum of learned directions. The `interpretability` kit has `sae_lens`, whose interface changes between versions: read the installed version's docs and source.

## Reading one prompt
```
research_inspect { action: "features", runId, modelId, prompt, layer, saeRelease, saeId }
```
or `saePath` for a folder instead of a release. It needs `sae_lens` in the project's Python; without it the answer says to install the kit. `layer` counts as in a patch, the stream leaving that block: `blocks.8.hook_resid_pre` and `blocks.7.hook_resid_post` are both layer 7. An SAE for another hook point or width is refused.

The answer has `features`, the strongest per token with activations, and `reconstruction` (`varianceExplained`, `relativeError`, `meanActiveFeatures`). Read the reconstruction first: a poor one means the features say little here. Special tokens are left out and left as they were, since an SAE does not rebuild them. A start token is added if the SAE was trained with one, and the mean over dimensions removed if it was trained on centered weights, as `sae.startTokenAdded` and `sae.centered` say.

Add `expected`, `alternative` and `ablate` (a feature's id) to set that feature to zero at every token and splice the reconstruction back. Read three numbers together:
- `margins.spliceChange`: what splicing the unmodified reconstruction alone did. It can exceed any feature's effect.
- `ablation.change`: what the feature did, measured from the spliced margin.
- `ablation.control.change`: the same for a random feature of similar activation, chosen with a fixed seed.

A change at or below the control says nothing, and one at or below the splice could be the reconstruction's error. One random feature is a thin control and one prompt is one case: to claim anything, repeat it on prompts chosen in advance, in an experiment.

## Choosing
- A pretrained SAE matches only the model and hook point it was trained on, and usually not your fine-tuned checkpoints. Check by reconstruction quality before use.
- Training your own needs many activations: tens of millions of tokens for a small model. Estimate first. See `compute-budget`.

## What to measure
- **L0**: average active features per token. Tens to low hundreds is typical.
- **Explained variance**.
- **Reconstruction loss in the model**: replace the activation by the reconstruction, and compare the model's cross-entropy to the original and to ablating. This is the measure that matters most.
- **Dead features**: the fraction that never fire.

Report these together. Each traded against the others, so that any one alone means little.

## Reading features
- Read the top activating examples, and also random ones at lower activation.
- A label is a hypothesis. Test it: write inputs that should and should not fire it.
- Test causally: clamp the feature and see whether the behavior changes as predicted.
- Features split and absorb, so that one concept may not be one feature.

The answer gives ids and what activates them on this prompt, with no names. Do not supply one as if it were found.

## Across a lineage
SAEs trained separately have unrelated features, so matching them across checkpoints is not automatic. Use the same SAE on nearby checkpoints only if reconstruction holds, or train a crosscoder, and say which.

## As experiments
Training is one experiment, with the SAE as an output in a git-ignored folder. Evaluation is another. Keep each hash in a finding, since an SAE is not a model record unless you make it one.

## Claims
"Feature 1234 fires on names" is an observation from examples. "The model tracks names with feature 1234" needs an intervention. Keep these apart.
