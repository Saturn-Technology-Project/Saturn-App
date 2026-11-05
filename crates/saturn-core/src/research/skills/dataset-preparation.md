---
name: dataset-preparation
description: Build fixed, hashed train, validation and test splits. Read before training or evaluating on a new dataset.
---
# Dataset preparation

## Steps
1. **Check the license and contents.** Note the source and license in a finding. Do not use data you may not, or personal data without a reason.
2. **Look at it.** Read 20 examples, and count lengths, duplicates and labels. Most surprises show here. `research_read` with `what: "data_profile"` gives the counts for a declared file.
3. **Clean with a script.** A script in the project, never by hand, so the steps can be repeated.
4. **Deduplicate before splitting**, on normalized text. See `data-leakage-audit`.
5. **Split once, by a stable rule**, usually a hash of a stable id, so that adding data does not move examples between splits:
```python
import hashlib
def split_of(key: str) -> str:
    bucket = int(hashlib.sha256(key.encode()).hexdigest(), 16) % 100
    return "test" if bucket < 10 else "val" if bucket < 20 else "train"
```
   Split by group (author, document, source) when examples within a group are related.
6. **Write the splits to files** and keep them. JSONL with a stable `id` on each line.
7. **Hash them**, and name evaluation files in `inputs.data`. Saturn then records their size and hash.

## Training data vs evaluation data
A version's `data` and `scorer` inputs are the evaluation's files, and a change to them makes versions `not_comparable`. They are also locked for agents once frozen.

Training data is meant to differ between models. Do not declare it as `data` on an evaluation. Record it on the model that came from it: `trainingData` on the model record. In a training experiment, declare it there, since that experiment is what it feeds.

## Size
Large files are recorded by hash, and are not copied into saved versions above the size limit. Keep large data out of git: use a data folder named in `.gitignore`, with a script that fetches it and checks the hash.

## Evaluation sets
Keep them small enough to read and large enough to measure: often 200 to 1000. Give each sample a stable `sampleId`, which is how it is compared across every run.
