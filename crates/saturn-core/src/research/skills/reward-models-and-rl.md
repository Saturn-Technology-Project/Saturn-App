---
name: reward-models-and-rl
description: Train a reward model from preference pairs, then optimize a policy against it with PPO or GRPO, watching for reward hacking. Read before any RL post-training.
---
# Reward models and RL

Two stages, each its own experiment: a reward model learned from preference pairs, then a policy trained against it. Each has its own way of fooling you. If the question is only whether preference data improves the model, DPO (`preference-training`) needs no reward model and is far more stable on small compute: start there, and use RL when the reward model, the optimization or online sampling is the subject.

## The reward model
- Start from the fine-tuned model, or a smaller one, with a scalar head. Loss on a pair: `-log σ(r(chosen) - r(rejected))`, summed over pairs.
- Hold out pairs before training, grouped by prompt, so one prompt is never on both sides. Record the data and its hash in `trainingData`.
- Log per evaluation: held-out pair accuracy (chance is 0.5; read a few disagreements), and calibration: bin pairs by `σ(margin)` and compare each bin with the fraction actually chosen. An overconfident reward model is exploited sooner.
- Length bias: the correlation of reward with response length on held-out pairs, and accuracy on the pairs where the rejected response is the longer one. If the reward is mostly length, the policy will learn length.
- The reward model becomes a model record with `parentId` and `producedBy` (see `checkpoints-and-lineage`), and the policy experiment names it in `models` with role `reward`.

## Policy optimization
- Reference: the policy's starting weights, frozen. Set `referenceId` on the policy's record.
- PPO: a value model, a clipped ratio and advantage estimation; many parts, each a place to be wrong. GRPO: several samples per prompt, advantages normalized within the group, no value model; simpler and cheaper, and the usual first choice.
- A KL penalty to the reference, in the reward or as a loss term. Log the KL measured on held-out prompts, not only the coefficient.
- Learning rate around 1e-6, few steps, generation at fixed settings. Generation dominates the time: measure it with `training-smoke-test` before estimating a budget (`compute-budget`).

## Metrics to log
Each step, to `SATURN_RUN_METRICS`: mean reward, reward spread, KL to the reference, mean response length, the fraction of responses that hit the length limit, loss, gradient norm, and for PPO the clip fraction and value loss. Each evaluation, a sample line per prompt to `SATURN_RUN_SAMPLES` with the generated text, so it can be read while the run lives. Checkpoints to `SATURN_RUN_OUTPUT`, listed in `SATURN_RUN_ARTIFACTS`.

## Reward hacking
The reward model is a proxy, and the policy searches for its holes. Signs:
- Reward rises while held-out human-labelled quality is flat or falls. Label a fixed set of prompts at several checkpoints (`reading-samples`), or run an independent evaluation; the reward curve alone shows nothing about quality.
- Response length grows step after step.
- Repeated phrases, one fixed opening, refusing everything, or text that pleases the reward model's data and not the prompt.
- KL climbing fast: the policy left the region where the reward model saw data.
Stop and read samples when one appears. A reward model knows only its training distribution.

## Controls
- The reference model's reward on the same prompts: the policy's reward is read against this, not against zero.
- A random or degenerate policy (shuffled responses, a constant string) scored by the reward model: near the trained policy means the reward is broken.
- The same reward model with the policy trained on another seed: the noise floor for the comparison.
- One final evaluation version naming the reference, a DPO baseline where there is one, and the policy checkpoints. Compare with `comparing-across-lineage` and `statistics-for-comparisons`.

## Record
A finding per stage: reward model accuracy and calibration with its run; policy curves and the hacking checks with the sample ids you read. Say which quality numbers a person or an independent evaluation measured, and which are the reward model judging its own policy.
