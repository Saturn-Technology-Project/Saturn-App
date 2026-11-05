---
name: writing-hypotheses
description: Write falsifiable hypotheses with numeric predictions before any result. Read after scoping and before running.
---
# Writing hypotheses

## A good hypothesis
- Names the **comparison**: which models or settings.
- Names the **measure** and data.
- Gives a **direction and size** that would count.
- States **what would refute it**, before any result exists.

Weak: "Fine-tuning improves name tracking."
Strong: "On the held-out IOI set (n=500), the SFT checkpoint's mean logit difference exceeds its parent's by at least 0.5, with a 95% bootstrap interval above 0."

## Record before running
```
research_write { collection: "hypotheses", fields: { title: "...", questionId: "..." } }
```
Link the experiment with `hypothesisId`. A hypothesis cannot change once made, because a verdict may rest on it. If you learn it was badly stated, make a new one and say why.

## Keep to a few
One primary hypothesis decides the study. Others are secondary, and you say so. Every extra comparison raises the chance of a false positive: see `statistics-for-comparisons`.

## After the result
You do not set the verdict. You write a finding saying which way the evidence points, how strongly, and what would change your mind. A hypothesis made after seeing a result is exploratory, and must be labelled so in the finding and the report.
