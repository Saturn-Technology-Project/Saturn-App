---
name: tuned-lens
description: Read intermediate layers through a translator trained per layer instead of the final unembedding, and compare it with the logit lens. Read before trusting an early-layer reading.
---
# Tuned lens

The logit lens reads each layer's residual stream through the final norm and unembedding; it is what `research_inspect` action `activations` gives. It leans toward late layers: the unembedding was trained on the last layer's basis, and earlier layers write in bases it cannot read, so a low value there says little. A tuned lens learns, for each layer, an affine map (a translator) from that layer's stream into the final layer's, trained to predict the model's own next-token distribution, and reads through it.

## When the logit lens is enough
- The question is about late layers, or about where a token becomes readable in the final basis.
- You compare the same layer across models, or across correct and failed samples, so the lens's bias cancels.
- Start there: see `activation-reading`. Train translators when an early-layer reading is the claim.

## Training translators
- One affine map per layer, from the residual stream leaving that block to the final stream, minimizing the KL divergence between the model's final distribution and the one read through the translator.
- Train on text held out from everything you will read: not the evaluation prompts and not their templates. A translator trained on the task's prompts can learn the task.
- It is one experiment: the model, the text's hash, the token count, steps and seed as inputs; the translators saved under `SATURN_RUN_OUTPUT` and registered; the per-layer KL on a second held-out text written to `SATURN_RUN_REPORT`. See `experiment-program`, `analysis-outputs`.
- It pushes many tokens through the model. Measure with a small run first. See `compute-budget`.
- The `interpretability` kit's `transformer_lens` gives the hooks; a translator is a linear layer with a bias that you train. A published tuned lens for the same base model and revision can serve once its held-out KL is checked here. It does not match your fine-tuned checkpoints.

## Compare on the same samples
In one run, for each sample and layer, one line with `scores` for the log probability of `expected` through each lens, and its rank: `logit_lens_layer_6`, `tuned_lens_layer_6`. Plot both against layer, with intervals over samples. See `statistics-for-comparisons`.
- Where they agree, the reading does not depend on the lens.
- Where the tuned lens reads the answer earlier, the information was present in another basis. Where it reads it later, the logit lens was reading something that happened to align.
- At the last layer both must match the model's own output, and the translator there should be near identity. If not, stop.

## Controls
- A translator trained on shuffled text: what any map into the final basis gains. The trained one must beat it.
- A random affine map of the same shape: the floor.
- The translators' KL on a second held-out set. A large gap from the training text means they overfit.

## What an early-layer reading supports
- "At layer 6 the expected token has this probability through the tuned lens (interval, n)": the stream at layer 6 carries information from which an affine map predicts the token.
- Not that the model has decided by layer 6, or that layer 6 computes it. Later layers may overwrite it, and the translator may read what the model never uses.
- Not a causal claim. A reading is correlation, through a lens with its own training. For cause, patch: see `activation-patching`.
- A translator belongs to one model revision. Reading another checkpoint through it gives numbers that mean nothing until the KL is checked there. See `comparing-across-lineage`.

## Record
A finding names the training run and its held-out KL, the reading run, the layers, and both lenses' numbers side by side. See `recording-findings`.
