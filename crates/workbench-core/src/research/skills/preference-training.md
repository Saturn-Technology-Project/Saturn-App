---
name: preference-training
description: Train with preference data using DPO against a frozen reference model. Read when doing post-training beyond SFT.
---
# Preference training (DPO)

Direct Preference Optimization learns from pairs of a chosen and a rejected response, against a frozen reference model. It needs no separate reward model.

## The loss
For prompt x, chosen y_w, rejected y_l:
```
L = -log σ( β · [ (log π(y_w|x) - log π_ref(y_w|x)) - (log π(y_l|x) - log π_ref(y_l|x)) ] )
```
Where log-probabilities are summed over response tokens only, π trains, and π_ref is frozen, in eval mode with no gradients. β around 0.1 is the usual default; larger leans more on the preference, and may drift further.

## Setup
- Reference: usually the fine-tuned model. Make `referenceId` on the new model record point to it, as well as `parentId`, and give it role `reference` where an experiment uses it.
- Precompute reference log-probabilities if memory is short: that saves a model in memory.
- `trl` on the `training` kit has a `DPOTrainer`, but its interface changes between versions. Read the installed version's source, and print a batch. Writing the loss yourself takes a dozen lines, and is easier to check.

## Learning rate and checks
Start low: 1e-6 to 5e-6. Watch:
- **Accuracy**: the fraction of pairs where the model prefers the chosen one more than the reference does. It should climb.
- **Reward margin**: the bracket above. Runaway growth means the model is drifting.
- **KL to the reference**, on held-out prompts. A model can win the loss by saying something degenerate: read generated text often, since repetition and length explosion are common.

## Measure
Preference accuracy on held-out pairs is not the goal itself. Evaluate with an independent measure of the behavior and of general ability. Compare to both parent and reference, with one evaluation version.

## Other methods
RLHF with PPO needs a reward model and is far less stable on small compute, so prefer DPO unless PPO is the subject. Whichever you use, the reward or the preference data decides what is learned: read samples of it first.
