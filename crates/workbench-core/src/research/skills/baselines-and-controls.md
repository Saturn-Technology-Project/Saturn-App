---
name: baselines-and-controls
description: Choose baselines and sanity checks that give a result meaning. Read while designing a study.
---
# Baselines and controls

A number means nothing alone. Decide what it is compared with first.

## Baselines
- **Trivial**: majority class, constant output, random choice, or a shuffled-label model. Your method must beat it clearly.
- **Untrained or parent**: the same model before the training under study. Measure with the same evaluation.
- **Known good**: a published model or result on this task, when one exists.

## Controls
- **Positive control**: a case the scorer must pass. If a perfect answer does not score perfectly, the scorer or the pipeline is broken.
- **Negative control**: a case that must fail. Random output should score at chance.
- **Label shuffle**: train on shuffled labels. If it reaches the same score, your pipeline is leaking. See `data-leakage-audit`.
- **Seed noise**: the same config with another seed. A difference smaller than this is not an effect.
- **Repeat**: run the same version twice when it should be deterministic. A different result means a hidden source of randomness. See `reproducibility`.

## Interpretability controls
- Patch a model into itself: the score must not change. If it does, the method is broken.
- Patch from a corrupted input, or a random direction: a large effect there means the effect you saw may be generic disruption.

## Record them
Run controls as experiments or as marked samples in the same run, and name them in the findings. A surprising result with no controls is not yet a result.
