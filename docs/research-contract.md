# The research workbench's contract

What Saturn's research records and experiment runs promise, and what they do not. Tests in
`contract/research-*.test.mjs` hold the runtime to it.

## Where records live

A project's records are plain files in `<project>/.saturn/research/`, readable without Saturn:

```
.gitignore         one line, *
questions/<id>.json
hypotheses/<id>.json
experiments/<id>.json      a draft, which keeps changing
versions/<id>.json         a frozen experiment, which never changes
models/<id>.json
findings/<id>.json
labels/<run id>.json       the user's labels, kept apart from scores
objects/<sha256>           saved copies of source files
runs/<id>/run.json
runs/<id>/samples.jsonl    the only output that counts as samples
runs/<id>/stdout.log, stderr.log
```

There are two roots. The record root is always the project's main folder, so chats in different worktrees share one
set of records. The source root is where a run's code is: the main folder, or the worktree of the chat a request names.
A client names a project and a chat, never a path to either root. A symbolic link at `.saturn` or
`.saturn/research` is refused rather than followed.

Records hold environment variable names and lock file fingerprints, never credential values.

### Git

Saturn writes the `.gitignore` above, so records do not make the project dirty, do not block merging a chat, and do not
change when a branch does. To share records, export them. Removing that `.gitignore` is allowed; tracked records that
keep changing then make Saturn's merge refuse with "uncommitted changes".

## Saving

Every record has `schemaVersion`, `revision`, `id`, `createdAt` and `updatedAt`, all set by the runtime.

- A change must carry the `expectedRevision` it was based on. A stale one gets 409 and changes nothing.
- A file is written to a temporary file in its own folder and renamed over the old one, so a crash leaves the old or the
  new record, never half of one.
- A file that cannot be parsed, or that has a newer `schemaVersion`, is reported and never overwritten.
- Writes go through one lock per project in one runtime. Two runtimes writing to one project are not protected.

## Objects

```
Question ← Hypothesis ← Experiment (draft) ← ExperimentVersion ← Run → samples, labels
                                                  ↑                 ↑
                                                Model            Finding
```

- A hypothesis has a `verdict`: `undecided`, `supported`, `refuted` or `inconclusive`. A run's `status` says whether it
  executed. Neither one changes the other.
- A finding's `kind` is `observation`, `ai_suggestion` or `conclusion`. It may name the runs it came from.
- A model has a `source` (a name or a local path) and a `weightsRevision`. One with no `weightsRevision` is `floating`, and a run on it
  says so. Roles (`base`, `reference`, `policy`) belong to an experiment's use of a model, since one set of weights can
  play different roles in different experiments.

## Freezing

A version is everything that decides what a run computes:

- the command, working directory, seeds and names of environment variables;
- the `EvaluationSpec`: dataset and split, sample set, scorer, prompt format, chat template, generation settings;
- the models and their roles, sources and revisions;
- the git commit, or none outside git;
- every uncommitted and untracked file, as a saved copy up to 5 MiB each and 200 MiB in all, and by hash beyond that;
- outside git, the declared code inputs the same way;
- the size and SHA-256 of every declared input (`code`, `data`, `scorer`, `environment`). Data and scorers are not copied.

Freezing the same content again returns the same version. Different content makes the next version. Working files stay
free to change: nothing is locked by having been frozen, and the next run freezes what is there then. Older versions and
their results do not change.

A version whose input is missing cannot be created, and says which input.

## Comparing

Two runs compare only through their `EvaluationSpec`. The answer is `comparable`, `not_comparable` with the fields that
differ, or `unknown` with the fields that are missing. Training data is not part of it: pretraining, SFT and DPO are
meant to differ.

## A run's life

```
starting → running → stopping → stopped
              ├────────────────→ completed | failed | protocol_error
              └────────────────→ interrupted
```

- The run is saved as `starting` before its process exists. A start carries a `clientId`; repeating it returns the same
  run and starts nothing.
- Inputs are checked against the version just before the process starts, and a mismatch starts nothing. They are checked
  again at the end, and a change during the run is recorded on it as `inputsChanged`.
- The process is identified by its process id, its start time and a token in its environment. After the runtime restarts,
  a run left `starting` or `running` becomes `interrupted`. Its process group is ended only if the process is confirmed to
  be the same one; otherwise the run says it could not be confirmed.
- An interrupted run keeps its complete samples. A new run can be started; resuming the same one is not offered.
- Ending a run seals it: the hash of `samples.jsonl` is recorded, and later writes to the file do not count.
- A running run holds its worktree: discarding it, or the chat that owns it, gets 409.
- Process identity is implemented for macOS and Linux. On Windows, starting a run says it is not supported yet.

## Samples: JSONL version 1

One JSON object per line, in UTF-8, written to the path in `SATURN_RUN_SAMPLES`. The process also gets `SATURN_RUN_ID`,
`SATURN_RUN_TOKEN`, `SATURN_RUN_VERSION` and `SATURN_RUN_DIRECTORY`.

```json
{"schemaVersion":1,"sampleId":"sample-0412","trial":0,"modelId":"model-1","input":"...","output":"...","scores":{"name-logit":0.42},"error":null}
```

- `sampleId` is required and stable across runs. It identifies the same input wherever it is compared.
- `trial` defaults to 0. `sampleId`, `trial` and `modelId` together must be unique within a run.
- `scores` is an object of numbers, strings or booleans, by scorer name.
- `error` is null, or `{"kind":"infrastructure"|"model"|"scorer","message":"..."}`. Infrastructure errors are counted
  apart and are not model failures.
- Standard output and standard error are only logs.

While the process runs, a final line without a newline is treated as not written yet. Once it has ended:

| What is in the file | Status |
|---|---|
| Valid lines, exit code 0 | `completed` |
| Valid lines, exit code not 0 | `failed`, samples kept |
| A bad line, a repeated identity, or a final partial line | `protocol_error`, with the line number; the raw file is kept and the valid lines stay readable |
| No valid line, exit code 0 | `protocol_error` |

Model output is data. It is shown as plain text and is never put in a system prompt.

## What is enforced, and what is not

**Participation modes and locks are a workflow constraint, not a security boundary.** The HTTP API has one bearer token and
cannot tell the user from an agent that obtained it, and an agent with a shell can write any file the shell can.

| Backend | File tools | Anything else |
|---|---|---|
| API and local models | Refused before writing | A command is compared by hash afterwards |
| Claude Code | Refused through `can_use_tool` for the tools it asks about | Compared afterwards |
| Codex | Not possible per file: its sandbox is read-only or writable | Compared afterwards; a Delegate task runs in a worktree |
| MCP tools | Saturn cannot tell what they write | Compared afterwards |

- No agent tool sets a verdict, a mode, an approval or a frozen version, and file tools refuse `.saturn/research/`.
- A refused tool call is recorded as a confirmed violation. A hash that changed is recorded as `integrity_changed` with
  no claim about who changed it, since the user may have edited the file. A file changed and restored between checks
  is not detected.
