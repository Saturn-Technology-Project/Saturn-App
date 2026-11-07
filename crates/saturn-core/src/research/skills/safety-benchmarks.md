---
name: safety-benchmarks
description: Run published safety and truthfulness suites (HarmBench, StrongREJECT, TruthfulQA, BBQ, toxicity classifiers) through a wrapped harness as runs. Read before running a safety benchmark.
---
# Safety benchmarks

A published suite gives numbers comparable with other people's, as long as you run it the way they did and say exactly
how. Saturn keeps the "exactly how" as a frozen version.

## Which suite measures what
- **HarmBench** and **StrongREJECT**: compliance with harmful requests, each with its own judge. A compliance rate on
  their requests, not a measure of harm done.
- **TruthfulQA**: whether the model repeats common falsehoods. Its multiple-choice and generation parts are scored
  differently and are not one number.
- **BBQ**: bias in question answering, with ambiguous and disambiguated contexts. Its score is a bias direction, read
  beside accuracy.
- **Toxicity classifiers** (an API or a local model) over the model's generations: they measure the classifier as much
  as the model, and their thresholds are choices you must state.
Each answers a narrow question. None of them is "safety", and a suite's own aggregate is one view of its items.

## Wrap the harness
A harness such as lm-eval or inspect_ai writes its own result files. The run's program calls it, then turns each item's
result into a sample line: `sampleId` from the suite's own item id, `category` the suite's category, `scores` the
suite's metrics by name, `scorerLabel` the judge's verdict, `expected` the reference when there is one. Keep the raw
harness output in `SATURN_RUN_OUTPUT` and list it in `SATURN_RUN_ARTIFACTS`; write the harness's own aggregate to
`SATURN_RUN_REPORT` so it can be checked against Saturn's summary. An item the harness skipped or failed is a sample
with `error`, not a missing line. Smoke test on a handful of items first. See `experiment-program`.

## Pin everything
- The suite's version: a release or commit of its data and prompts, declared in `inputs.data` where it is a file, so it
  is hashed. Prompts and judges change between releases, and the numbers with them.
- The harness version and task configuration: few-shot count, prompt template, chat template, generation settings, all
  in `evaluation`.
- The judge model, its revision and the judge prompt for model-graded suites. A judge upgrade is a new evaluation, and
  earlier runs become `not_comparable`. See `evaluation-spec`.
- Seeds for sampled generation, in `seeds`.
The network is allowed by default, so the harness can fetch data and reach a judge API; the judge's key must be in
`envNames`, which only the person can add.

## License and data use
Read each suite's license before running it: some forbid training on the data, some forbid commercial use, some ask that
generated harmful content not be stored or shared. A classifier API has terms about what may be sent to it. Note the
license in a finding, and ask the person before a private model's output goes to a third-party judge.

## Contamination
A public benchmark may be in the model's training data, and a fine-tune may have seen its prompts. Search the training
data you know of for the suite's prompts, and say when you cannot. A high score on a contaminated suite measures memory.
See `data-leakage-audit`.

## Report per category
The finding gives each category's score with interval and n, and the suite's own aggregate beside Saturn's summary. One
number hides a model that refuses one category and complies with another. Put the helpfulness or over-refusal measure
next to the safety one when the suite has it. Compare models on the same suite version with `what: "paired"`: see
`paired-comparisons`. When your numbers differ from a published figure, list what differs in the setup before anything
else is said.

## What a score does not show
- Behaviour under attacks the suite lacks, in other languages, over many turns, or with tools.
- Behaviour with the person's own system prompt and tools, unless you ran it so; then it is not the published number.
- Why. A benchmark is a measurement, not a mechanism. For attacks beyond the suite see `red-teaming`; for dispositions
  the suites do not cover see `behavioral-evals`.
