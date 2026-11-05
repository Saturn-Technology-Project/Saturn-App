---
name: sparse-autoencoders
description: Train or use sparse autoencoders on activations and judge them honestly. Read when decomposing a layer into features.
---
# Sparse autoencoders

An SAE rewrites one hook point's activations as a sparse sum of learned directions. The `interpretability` kit has `sae_lens`, whose interface changes between versions: read the installed version's docs and source.

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

## Across a lineage
SAEs trained separately have unrelated features, so matching them across checkpoints is not automatic. Use the same SAE on nearby checkpoints only if reconstruction holds, or train a crosscoder, and say which.

## As experiments
Training is one experiment, with the SAE as an output in a git-ignored folder. Evaluation is another. Keep each hash in a finding, since an SAE is not a model record unless you make it one.

## Claims
"Feature 1234 fires on names" is an observation from examples. "The model tracks names with feature 1234" needs an intervention. Keep these apart.
