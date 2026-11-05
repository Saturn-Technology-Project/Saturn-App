---
name: recording-findings
description: Write findings tied to runs, with evidence and uncertainty. Read whenever you have something worth keeping.
---
# Recording findings

```
research_write { collection: "findings", fields: { text: "...", runIds: ["..."] } }
```
Yours are always recorded as AI suggestions, and show that way to the person. Only a person records a conclusion.

## A good finding
- **Says one thing**, and names the runs it rests on.
- **Has numbers with conditions**: effect, interval, n, evaluation, seeds.
- **Separates what was measured from what it might mean**.
- **Names how you could be wrong**.

```
Measured: on run run_ab12 (ioi-test, n=500), the SFT checkpoint's mean logit difference was +0.42 above its parent (95% CI 0.31 to 0.53).
Suggests: hypothesis H1 is supported. The verdict is yours.
Limits: one seed. 12% of samples use templates that also appear in training. I read 40 samples; 6 were right for an unclear reason.
```

## When to write
- At each stage boundary: the plan, the environment, the data, each comparison.
- When a run fails or is invalid, and why.
- When you change the plan, and why, in a new finding. Do not rewrite the old one.
- Before stopping for any reason, with where things stand and what comes next.

Findings are your memory across turns. A later turn starts from `what: "status"`, and only what you wrote survives.

## Mark the kind of evidence
Say whether a result is **confirmatory** (predicted beforehand) or **exploratory** (noticed afterward). Exploratory findings are leads that need their own test.

## Never
Round a number in your favor, leave out failed runs, or state a mechanism when you measured a correlation. If you were wrong earlier, say so in a new finding, naming the old one.
