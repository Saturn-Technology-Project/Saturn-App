---
name: data-leakage-audit
description: Find ways the test data reaches the model or the choice of model. Read after splitting, and whenever a score looks too good.
---
# Data leakage audit

A result better than expected is the moment to look for a mistake.

## Check
1. **Exact overlap**: hash normalized text in each split, and count the overlap. It should be zero.
2. **Near duplicates**: compare n-gram sets or embeddings between test and train on a sample. Paraphrases and templates inflate scores.
3. **Group leakage**: the same document, author, entity or template on both sides.
4. **Time leakage**: for dated data, train on the past and test on the future.
5. **Preprocessing fit on everything**: anything learned from data (vocabulary, normalization stats) comes from train only.
6. **Selection on test**: choosing a checkpoint or hyperparameter by test score. Choose on validation.
7. **Label in the input**: fields or formatting that give the answer away. Train on shuffled labels: a score above chance means something leaks.
8. **Evaluation prompts in training**: templated tasks are easy to contaminate. Search the training data for the evaluation's exact prompts.
9. **Pretrained contamination**: a public model may have trained on your test set. For public benchmarks, say so.

## Report
Write a finding with the counts: exact overlap, near-duplicate rate, and what you did. If you found leakage after a run, those results are invalid. Say so in a finding rather than removing the run.
