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
- `what: "runs"`, `"run"`, `"summary"` (scores and errors per model), `"log"` (`stream: stdout|stderr`), `"resources"`.
- `what: "samples"`, `run`, `cursor`, `limit` (at most 50), `only: all|disputed|errors`. Follow `next` as the next cursor.
- `what: "compare"`, `left`, `right`: version ids. Answers `comparable`, `not_comparable` or `unknown`.
- `what: "sample_across"`, `sample`, `runs`: one sample in several runs.
- `what: "labels"`, `"events"`, `"environment"`, `"policy"`, `"inside_list"`, `"inside"`.

## Writing: `research_write`
Leave out `id` to make a record. To change one, pass `id` and `expectedRevision` from your read; a stale revision is refused, so read again.

| Collection | Main fields |
|---|---|
| `questions` | `title` |
| `hypotheses` | `title`, `questionId`. Made once, never changed |
| `experiments` | `title`, `command`, `cwd`, `inputs` (`code`, `data`, `scorer`, `environment`: lists of paths), `evaluation`, `models` (`modelId`, `role`), `seeds`, `envNames`, `questionId`, `hypothesisId`, `labels`, `labelAliases` |
| `models` | `source`, `weightsRevision`, `name`, `parentId`, `referenceId`, `trainingData`, `producedBy`, `note` |
| `findings` | `text`, `runIds`. Always recorded as your suggestion |
| `counterexamples` | `runId`, `sampleId`, `note` |

## Running: `research_run`
- `action: "freeze"`, `experiment`: the version for the experiment as it is now. The same content returns the same version (`new: false`).
- `action: "start"`, `version`, `attempt`: returns at once. A repeated call with the same attempt starts nothing. Use a new `attempt` to run a version again.
- `action: "stop"`, `run`.
- `research_wait`, `run`, `seconds`: up to 600 at a time.

## Environment: `research_environment_action`
`check`, `create`, `install`, `set`, `stop`. Create and install are jobs: follow them with `what: "environment"`.

## Inside a model: `research_inspect`
`activations`, `patch`, `sweep`. See `activation-reading`, `activation-patching`, `layer-sweeps`.

## Skills: `research_skill`
With no name, lists them. A project's own skill of the same name is used first.

## Your program and the run
A run's command gets `SATURN_RUN_SAMPLES`, `SATURN_RUN_DIRECTORY`, `SATURN_RUN_ID`, `SATURN_RUN_VERSION` and `SATURN_RUN_TOKEN`. See `experiment-program`.
