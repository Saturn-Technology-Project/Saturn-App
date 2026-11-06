---
name: plots-and-analysis
description: Analyse run outputs with scripts and make plots that do not mislead. Read when producing figures or tables.
---
# Analysis and plots

## Script it
Keep analysis in a script in the project, taking run ids as arguments, so anyone can repeat it. The `analysis` kit has pandas and matplotlib. Read samples from `.saturn/research/runs/<id>/samples.jsonl`, reading only: never write there.

```python
import json, pandas as pd
rows = [json.loads(line) for line in open(f".saturn/research/runs/{run}/samples.jsonl")]
frame = pd.json_normalize(rows)
```
Save figures and tables outside tracked folders, or commit them deliberately. New untracked files make a new version next time. See `checkpoints-and-lineage`. To keep a figure or analysis JSON with its hash beside the run that produced it, see `analysis-outputs`.

## Plots
- **One axis.** Two scales on one plot mislead. Use two plots.
- **Show uncertainty**: intervals, or individual seeds as points.
- **Bars start at zero**, and only for quantities where zero means something. Use points otherwise.
- **Label axes with units**, and write n.
- **Show raw distributions** when comparing means, since a difference may come from a few samples.
- **Do not cherry-pick the range**: if you truncate, say why.
- Only put comparable runs together. See `evaluation-spec`.

## Tables
Round to what the interval justifies: `0.42 ± 0.05`, and not `0.4213`. Include n, the error count, and the run id.

## From analysis to claim
Every figure in a report names the run and the script that made it. If you explored many views, say so, and treat anything found that way as a lead that needs a new test.
