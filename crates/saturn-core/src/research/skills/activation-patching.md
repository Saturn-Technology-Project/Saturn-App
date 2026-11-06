---
name: activation-patching
description: Test causally by moving a layer's state between models, within what a residual transplant can show. Read before making a mechanism claim.
---
# Activation patching

```
research_inspect { action: "patch", runId, sampleId, sourceModelId, targetModelId, layer }
```
It runs the source on the same input, replaces the residual stream leaving `layer` in the target with the source's, and answers with `patched: { layer, sourceModelId, layers, top }`.

## What it means
**Everything up to that layer is then the source's, and everything after it is the target's.** Intervention layer 0 is the output of the first block; reading layer 0 is the embedding, so they count differently.

## What it cannot show
A residual transplant replaces the whole prefix's state, not one block's contribution. So:
- "Patching layer 8 restores the behavior" means source's first 9 blocks plus target's rest succeed.
- It does **not** locate the defect in block 8. Finding the first layer that restores it shows how much of the source is needed, given the target's remaining blocks.
- To narrow further, compare adjacent layers, go the other way (target into source), or use finer methods. See `transformer-lens-probes`.

## Design
- **Self-patch control**: a model into itself must change nothing. Do this first.
- **Both directions**: source into target, and target into source. Agreement is much stronger evidence.
- **Same input**: this method patches between models on one input. For differences between inputs on one model, see below.
- **Several samples, chosen in advance**: failures and successes. See `layer-sweeps`.

The architecture and hidden size must match for a transplant to mean anything. Say so if a model pair differs in tokenizer or size.

## Between two prompts on one model
```
research_inspect { action: "prompts", runId, modelId, clean, corrupted, expected, alternative }
```
It restores each layer and position of the corrupted prompt from the clean one. `recovery` is the share of the margin brought back, and `control` the same for a random vector of the size of that difference at that place. Read a cell only against the control: at or below it, it says nothing. The prompts need the same number of tokens. One pair is one case; to claim anything, repeat it on pairs chosen in advance, in an experiment. `action: "compare"` (modelId, otherModelId, input, expected) reads two models on one prompt instead.

## Words to use
"Replacing the state leaving layer L with the later checkpoint's restored the correct answer on 7 of 10 samples." Not "layer L is where name tracking is learned." The runtime gives numbers and no verdict, and the claim is yours to make carefully.
