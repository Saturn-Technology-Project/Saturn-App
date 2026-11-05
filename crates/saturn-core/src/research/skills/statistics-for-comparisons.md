---
name: statistics-for-comparisons
description: Compare models with paired intervals, effect sizes and honest multiple comparisons. Read before saying one model beats another.
---
# Statistics for comparisons

## Pair by sample
Two models on the same samples: compare the per-sample differences, not two means. It removes variation between samples and gains much power. `sampleId` makes this possible.

## Report an interval
Use a bootstrap interval on the paired differences:
```python
import numpy as np
def bootstrap_ci(differences, draws=10000, seed=0, level=0.95):
    rng = np.random.default_rng(seed)
    values = np.asarray(differences)
    means = rng.choice(values, (draws, len(values))).mean(axis=1)
    return values.mean(), *np.quantile(means, [(1-level)/2, 1-(1-level)/2])
```
Always give the effect size and interval with n. For example: "+0.42 (95% CI 0.31 to 0.53, n=500)". A p-value alone says little.

For binary scores, use McNemar's test on discordant pairs for paired models, and report the discordant counts.

## Seeds
Samples from one trained model are not independent evidence about a training method. The unit for "method A trains better" is the seed. With a few seeds, report each one's score, and treat the interval as rough.

## Multiple comparisons
Comparing many checkpoints or settings, some differences will look real by chance. Name the primary comparison in advance, and report how many you made. Holm's correction is simple and adequate when you need one.

## Common traps
- **Regression to the mean**: selecting the worst samples and "improving" them.
- **Selecting on the outcome**, then testing on the same data. Split it.
- **Excluding errors unevenly**: if one model errors more, a mean over its survivors flatters it. Report error rates next to means. Saturn's summary counts them apart.
- **Stopping when it looks good**: decide the size in advance. See `study-design`.
- **Means hiding structure**: look at distributions, and at subgroups chosen in advance.

## Wording
Say what the data supports: "a difference this size was measured on this set". Do not write "proves". A null result says the effect, if any, is probably smaller than the interval's width: state the width.
