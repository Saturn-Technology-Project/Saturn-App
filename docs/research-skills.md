# Research skills

The skills that ship with Saturn, in `crates/saturn-core/src/research/skills`. They teach a research assistant to carry out a study through the [research tools](research-contract.md#what-an-agent-does-with-the-records). The assistant reads them with `research_skill`, on any backend, and starts with `research-autopilot`.

To change one for a project, put a skill of the same name in `.saturn/skills/<name>/SKILL.md`: it is used first.

## Running a study

| Skill | What it is for |
|---|---|
| `research-autopilot` | Carry out a whole study on your own, from a question to a report. Read this first when asked to do research independently. |
| `saturn-research-tools` | The research_* tools, the records they work on, and how they fit together. Read when unsure which call does what. |
| `modes-and-boundaries` | What Manual, Pair and Delegate allow, what is always the person's, and what a refusal means. Read when a tool is refused or before changing anything. |
| `task-worktrees` | How a task's git worktree relates to the project's records, runs and merging. Read when working as a task. |
| `starting-tasks` | Hand part of the work to another agent in its own worktree, and follow it. Read before starting a task. |

## The question

| Skill | What it is for |
|---|---|
| `scoping-a-question` | Turn a broad interest into one answerable research question. Read at the start of a study. |
| `literature-review` | Find and use prior work without inventing citations. Read before designing a study on an unfamiliar topic. |
| `writing-hypotheses` | Write falsifiable hypotheses with numeric predictions before any result. Read after scoping and before running. |
| `study-design` | Plan variables, sample size, seeds and a stop rule before spending compute. Read before the first real run. |
| `baselines-and-controls` | Choose baselines and sanity checks that give a result meaning. Read while designing a study. |

## Environment and budget

| Skill | What it is for |
|---|---|
| `environment-setup` | Create, check and pin the project's Python environment with the right kits. Read before writing any experiment. |
| `reproducibility` | Make a run repeatable with seeds, pinned weights and declared inputs. Read before writing a program. |
| `compute-budget` | Estimate and keep to a budget of time, memory and money. Read before any long run or API-backed evaluation. |

## Data

| Skill | What it is for |
|---|---|
| `dataset-preparation` | Build fixed, hashed train, validation and test splits. Read before training or evaluating on a new dataset. |
| `data-leakage-audit` | Find ways the test data reaches the model or the choice of model. Read after splitting, and whenever a score looks too good. |
| `tokenizer-and-format` | Avoid tokenizer, padding, chat template and label-masking mistakes. Read before training or evaluating a language model. |

The audit and the tools skill use `research_read` with `data_list`, `data_profile` and `data_overlap`, the same reads the Data screen shows. Rows themselves are for the person, on that screen.

## Experiments

| Skill | What it is for |
|---|---|
| `experiment-program` | Write a program that runs as an experiment and writes valid samples. Read before writing any experiment or training script. |
| `evaluation-spec` | Fill in the evaluation spec, so that runs compare fairly or say why they do not. Read when creating an experiment. |
| `scorer-design` | Build and validate a scorer, and connect it to a person's labels. Read before trusting any score. |
| `freeze-and-run` | Freeze an experiment, start a run and follow it to the end. Read before starting any run. |
| `run-failures` | Diagnose failed, interrupted and protocol-error runs without repeating the same attempt. Read when a run did not complete. |

## Training

| Skill | What it is for |
|---|---|
| `training-smoke-test` | Prove a training pipeline works in minutes before the real run. Read before any training run. |
| `pretraining` | Train a base model from scratch as a Saturn experiment, with checkpoints in the lineage. Read when training a model from raw text. |
| `fine-tuning` | Supervised fine-tuning of a checkpoint on instruction data, with a fair before-and-after. Read when doing SFT. |
| `preference-training` | Train with preference data using DPO against a frozen reference model. Read when doing post-training beyond SFT. |
| `training-debugging` | Diagnose loss that is NaN, flat, exploding or too good. Read when training misbehaves. |
| `hyperparameter-search` | Search settings within a budget, without contaminating the test set. Read before trying many configurations. |
| `checkpoints-and-lineage` | Save checkpoints where they do not disturb versions, and record each as a model in the lineage. Read when training produces weights. |
| `gpu-and-memory` | Fit training and inference on the available device, and measure what it uses. Read on out-of-memory errors or slow runs. |

## Reading results

| Skill | What it is for |
|---|---|
| `statistics-for-comparisons` | Compare models with paired intervals, effect sizes and honest multiple comparisons. Read before saying one model beats another. |
| `reading-samples` | Read samples systematically to find what scores hide, without labeling on the person's behalf. Read after every evaluation. |
| `counterexample-mining` | Search a run for cases that break the pattern and keep them. Read when a result looks clean or when testing a claim. |
| `comparing-across-lineage` | Measure a family of checkpoints under one evaluation, to see what each training stage changed. Read when comparing pretraining, SFT and preference stages. |
| `plots-and-analysis` | Analyse run outputs with scripts and make plots that do not mislead. Read when producing figures or tables. |

## Inside a model

| Skill | What it is for |
|---|---|
| `activation-reading` | Read what each layer says on a sample with research_inspect, and interpret it within its limits. Read before claiming where something happens in a model. |
| `activation-patching` | Test causally by moving a layer's state between models, within what a residual transplant can show. Read before making a mechanism claim. |
| `layer-sweeps` | Patch every layer on a set of samples to see where behavior returns. Read when asking where in the model a difference lives. |
| `transformer-lens-probes` | Write custom interpretability experiments with hooks when the built-in inspection is not enough. Read for attention, neuron or input-pair patching. |
| `sparse-autoencoders` | Train or use sparse autoencoders on activations, read a prompt's features with research_inspect, and judge them honestly. Read when decomposing a layer into features. |

## Reporting

| Skill | What it is for |
|---|---|
| `recording-findings` | Write findings tied to runs, with evidence and uncertainty. Read whenever you have something worth keeping. |
| `study-report` | Write the final report as a file a reader can check against the records. Read when a study is done, or at the point of stopping. |
| `handing-back` | End a stage or study with what the person must decide, stated plainly. Read before finishing any autonomous work. |
