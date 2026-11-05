---
name: study-design
description: Plan variables, sample size, seeds and a stop rule before spending compute. Read before the first real run.
---
# Study design

Write the plan as a finding before running. It is what the report is checked against later.

## The plan
1. **Primary question and hypothesis**, by id.
2. **What varies**: one factor where possible. List its levels.
3. **What stays fixed**: data, split, scorer, prompt format, generation settings, and everything else in the evaluation.
4. **Measure**: the primary score. Name secondary ones as secondary.
5. **Units and sample size**: how many samples, and how many seeds. See below.
6. **Baselines**: see `baselines-and-controls`.
7. **Analysis**: how you will compare, chosen before seeing results. See `statistics-for-comparisons`.
8. **Stop rule**: when you stop, including on bad news. Budget used, a target reached, or a clear failure.
9. **Exclusions**: what counts as an infrastructure error, decided now.

## Sample size
- For a mean difference with paired samples, the standard error shrinks with the square root of n. Measure the spread in a small pilot, then pick n so the interval is narrower than the effect you care about.
- Training is noisy across seeds. Comparing two training setups needs several seeds each: at least 3 to see anything, 5 or more to claim anything. One seed each is an anecdote; say so if the budget forces it.
- Do not extend a run until the result looks good. If you must extend, say so.

## Factors
When several factors matter, vary one at a time from a fixed base unless interactions are the point. A full grid multiplies cost. See `hyperparameter-search`.

## Splits and peeking
Tune on validation. Touch the test split once, at the end, for the final comparison. If you looked earlier, it is not a test split any more, and the report says so.
