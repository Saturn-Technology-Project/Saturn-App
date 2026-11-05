---
name: hyperparameter-search
description: Search settings within a budget, without contaminating the test set. Read before trying many configurations.
---
# Hyperparameter search

## Order of importance
1. Learning rate. Usually matters most: search it on a log scale.
2. Batch size, as far as memory allows; then training length.
3. Weight decay, warmup and regularization.
4. Architecture, only when it is the question.

## Method
- A short learning-rate sweep over a factor of 100 or more, at the same few hundred steps.
- Random search beats a grid once there are more than two settings.
- Early-stop poor configurations on validation: spend the remaining budget on the good ones.
- Keep a budget: a fixed number of trials, written before starting.

## With Saturn
- Put settings in a config file named in `inputs.code`, or as arguments in the command. Either way, each setting is a new version, and the record shows it.
- Keep the evaluation identical across trials: `research_read { what: "compare" }`.
- Use validation scores. Note the split in `evaluation`.
- Record the table of trials in a finding, including those that failed.

## Honesty
- The best of many trials is biased upward. Report how many you tried.
- Re-train the winner with new seeds before claiming it beats a baseline. See `statistics-for-comparisons`.
- Run the test split once, at the end.
