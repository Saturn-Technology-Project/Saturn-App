---
name: reproducibility
description: Make a run repeatable with seeds, pinned weights and declared inputs. Read before writing a program.
---
# Reproducibility

Saturn records what a run computed. You make sure that is enough to repeat it.

## In the experiment
- `seeds`: list them. Read the seed in the program from an argument or an environment variable named in `envNames`.
- `models`: pin each with `weightsRevision`. A model without one is `floating`, and the run says so. Hugging Face: the commit hash. A local path: the checkpoint's hash.
- `inputs`: every data file, scorer and lock file. A version holds their hashes, so a change is a new version.
- Never read an undeclared file that affects results.

## In the program
```python
import os, random, numpy as np, torch
seed = int(os.environ.get("SEED", "0"))
random.seed(seed); np.random.seed(seed); torch.manual_seed(seed)
torch.cuda.manual_seed_all(seed)
```
For stricter determinism on CUDA, set `torch.use_deterministic_algorithms(True)` and `CUBLAS_WORKSPACE_CONFIG=:4096:8`; it is slower and some operations will raise. Give each DataLoader a seeded `generator`, and seed workers.

## What is still not exact
Different hardware, driver and library versions give different floats. MPS has no full determinism guarantee. Do not claim bit-exact repeats unless you checked: run a version twice with `attempt: 2` and compare with `what: "sample_across"`.

## Ordering
Keep sample order and ids stable: sort before iterating, and derive a `sampleId` from the content or a fixed id, never the position after shuffling. Comparisons across runs depend on it.
