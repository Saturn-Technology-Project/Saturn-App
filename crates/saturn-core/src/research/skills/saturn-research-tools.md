---
name: saturn-research-tools
description: The research_* tools, the records they work on, and how they fit together. Read when unsure which call does what.
---
# The research tools

## Records
```
Question ← Hypothesis ← Experiment (draft) ← Version (frozen) ← Run → samples, labels
                                                  ↑                ↑
                                                Model            Finding
```
They live in `.saturn/research` in the project. Your file tools refuse to write there, so write through these tools.

## Reading: `research_read`
- `what: "status"`: everything at a glance. Start here.
- `what: "list"`, `collection`; `what: "record"`, `collection`, `id`.
- `what: "runs"`, `"run"`, `"summary"` (scores and errors per model), `"evidence"` (expected, observed and reported, with three verdicts; see `run-provenance`), `"log"` (`stream: stdout|stderr`), `"resources"`.
- `what: "samples"`, `run`, `cursor`, `limit` (at most 50), `only: all|disputed|errors`. Follow `next` as the next cursor.
- `what: "compare"`, `left`, `right`: version ids. Answers `comparable`, `not_comparable` or `unknown`.
- `what: "sample_across"`, `sample`, `runs`: one sample in several runs.
- `what: "labels"`, `"agreement"` (raters' kappa with each other, the adjudicated labels and the scorer), `"events"`, `"environment"`, `"policy"`, `"inside_list"`, `"inside"`.
- `what: "output"`, `run`, optional `path`: the files a run's program wrote to `SATURN_RUN_OUTPUT`, or one file's text (256 KiB at most). Nothing in them is run.
- `what: "data_list"`: every declared data file, its hash, whether it changed, and which runs read it. `what: "data_profile"`, `path`, `split`: its rows and columns. `what: "data_preview"`, `path`: the rows themselves. `what: "data_overlap"`, `left`, `right` (files, here), `columns`, `leftSplit`, `rightSplit`: exact duplicates between two files. See `data-leakage-audit`.
- `what: "metrics"`, `run`: the training metrics a program logged to `SATURN_RUN_METRICS`. See `training-debugging`.
- `what: "paired"`, `left`, `right` (`{runId, modelId}`), `scorer`: sample by sample, improvements, regressions and slices. See `paired-comparisons`.
- `what: "remote"`: the SSH host the person configured and the remote runs. See `remote-runs`.
- `what: "notebook"`, `path`: a notebook kernel's state. See `notebooks`.
- `what: "session_inside"`, `session`: what an inspection session read. `what: "artifact"`, `id`: a kept output.
- `what: "import_preview"` and `what: "bundle_preview"`, `path`: what an import or a bundle would bring in, changing nothing. See `importing-results` and `research-bundles`.

## Writing: `research_write`
Leave out `id` to make a record. To change one, pass `id` and `expectedRevision` from your read; a stale revision is refused, so read again.

| Collection | Main fields |
|---|---|
| `questions` | `title` |
| `hypotheses` | `title`, `questionId`, `verdict` (recorded as yours) |
| `experiments` | `title`, `command`, `cwd`, `inputs` (`code`, `data`, `scorer`, `environment`: lists of paths), `evaluation`, `models` (`modelId`, `role`), `seeds`, `envNames`, `sandbox` (`isolated`, `network`), `questionId`, `hypothesisId`, `labels`, `labelAliases` |
| `models` | `source`, `weightsRevision`, `name`, `parentId`, `referenceId`, `trainingData`, `producedBy`, `note` |
| `findings` | `text`, `runIds`, `kind` (`ai_suggestion` when left out, `observation`, `conclusion`). Marked as yours |
| `labels` | `runId`, `sampleId`, `modelId`, `trial`, `label` (one of the experiment's), `note`; with `rater`, a named rater's own label beside the adjudicated one. Marked as yours |
| `counterexamples` | `runId`, `sampleId`, `note` |

An experiment's runs are sandboxed (see `run-provenance`). You may set `sandbox.network: false`; turning the sandbox
off, allowing the network again or adding a name to `envNames` is refused: ask the person to do it in Experiments.

To delete an imported experiment, pass `collection: "experiments"`, `id`, `expectedRevision` and `delete: true`. It
moves, with its versions and runs, to the records' trash. An experiment frozen or run here is the person's to delete, in
Experiments, and one that a finding or other record refers to is not moved: the answer names those records.

## Running: `research_run`
- `action: "freeze"`, `experiment`: the version for the experiment as it is now. The same content returns the same version (`new: false`).
- `action: "start"`, `version`, `attempt`: returns at once. A repeated call with the same attempt starts nothing. Use a new `attempt` to run a version again.
- `action: "stop"`, `run`.
- `action: "pause"` and `action: "continue"`, `run`: hold a running run where it is, and let it go on.
- `action: "resume"`, `run`, `attempt`, optional `checkpoint` and `step`: a new run of the same version taking over from one that stopped, was interrupted or failed. See `pause-and-resume`.
- `research_wait`, `run`, `seconds`: up to 600 at a time. It returns at once when the run is paused.

## Environment: `research_environment_action`
`check` (the interpreter, packages, devices, and the programs on its PATH such as `lake` or `tectonic`), `create`, `install`, `set`, `stop`. Create and install are jobs: follow them with `what: "environment"`.

## Inside a model: `research_inspect`
`activations` (with `save`, a project path, it also keeps every layer's raw residual stream as an `.npz` there), `patch`, `sweep` on a run's samples, and `compare`, `prompts`, `features` on prompts of your own. `session` opens an inspection session, and `compare`, `prompts`, `features` then take `sessionId` in place of `runId`. See `activation-reading`, `activation-patching`, `layer-sweeps`, `sparse-autoencoders`, `inspection-sessions`.

## Evidence: `research_evidence`
`import` results made elsewhere, `bundle_export` and `bundle_import` a project's evidence, `artifact_register` a figure, JSON, notebook, document (PDF or text) or reference, `artifacts_from_run` for what a run listed, and `save_counterexamples` from a paired comparison. See `importing-results`, `research-bundles`, `analysis-outputs`, `paired-comparisons`.

## Elsewhere: `research_remote` and `research_notebook`
`research_remote`: `check` the configured SSH host, `start` a frozen version there. See `remote-runs`. `research_notebook`: `start`, `run`, `interrupt`, `restart`, `stop` a notebook's kernel. See `notebooks`.

## Skills: `research_skill`
With no name, lists them. A project's own skill of the same name is used first.

## Your program and the run
A run's command gets where to write: `SATURN_RUN_SAMPLES`, `SATURN_RUN_METRICS`, `SATURN_RUN_ARTIFACTS` and `SATURN_RUN_REPORT` (one JSON object per line each), `SATURN_RUN_OUTPUT` (its files) and `SATURN_RUN_DIRECTORY` (the run's folder, which holds them all); what it is: `SATURN_RUN_ID`, `SATURN_RUN_VERSION`, `SATURN_RUN_TOKEN`, `SATURN_RUN_SEED` and `SATURN_RUN_SEEDS`; and, when it resumes a run, `SATURN_RESUME_FROM`, `SATURN_RESUME_RUN` and `SATURN_RESUME_DIRECTORY`. See `experiment-program`, `run-provenance` and `pause-and-resume`.
