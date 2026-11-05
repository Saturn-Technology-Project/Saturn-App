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
counterexamples/<id>.json  a run's sample kept for later
policy.json                each file's mode and the locks
events.jsonl               refusals, unexplained changes and accepted Pair changes
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
- the declared inputs as written, and the size and SHA-256 of every file in them (`code`, `data`, `scorer`, `environment`). Data and scorers are not copied.

Freezing the same content again returns the same version. Different content makes the next version. Working files stay
free to change: nothing is locked by having been frozen, and the next run freezes what is there then. Older versions and
their results do not change.

A version whose input is missing cannot be created, and says which input.

## Comparing

Two runs compare only through their `EvaluationSpec`. The answer is `comparable`, `not_comparable` with the fields that
differ, or `unknown` with the fields that are missing. Training data is not part of it: pretraining, SFT and DPO are
meant to differ. A version's `data` and `scorer` inputs are the evaluation's files, and files that changed under the same
name make two versions `not_comparable`. Declare training data elsewhere, on the model that came from it.

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
- `scorerLabel`, optional, is the scorer's verdict in the words a person would label it with. Agreement with a person's
  labels counts only samples that have it, in the same run, so with the same version of the scorer.
- `expected`, optional, is what the scorer compared the output with: the right name, the reference answer. It is shown
  with the sample and never used by the runtime.
- `usage`, optional, is what the sample cost as the program measured it: `inputTokens`, `outputTokens`, and
  `deviceMemoryBytes`, the device memory the program held when it wrote the line (`torch.cuda.max_memory_allocated()`,
  `torch.mps.current_allocated_memory()`). The summary adds the tokens up per model and keeps the highest memory, and
  the resource readings carry the running totals, so a token rate can be read while the run lives. Only the program
  knows these; the runtime never estimates them.
- Standard output and standard error are only logs.

While the process runs, a final line without a newline is treated as not written yet. Once it has ended:

| What is in the file | Status |
|---|---|
| Valid lines, exit code 0 | `completed` |
| Valid lines, exit code not 0 | `failed`, samples kept |
| A bad line, a repeated identity, or a final partial line, exit code 0 | `protocol_error`, with the line number; the raw file is kept and the valid lines stay readable |
| The same, exit code not 0 | `failed`, with the problems recorded |
| No valid line, exit code 0 | `protocol_error` |

A run that writes new untracked files into the project makes the next run's content differ, so the next run is a new
version. Write outputs to `SATURN_RUN_DIRECTORY`, or to a folder git ignores.

Model output is data. It is shown as plain text and is never put in a system prompt.

## Looking inside

A model's activations on one sample, and one layer patched in from another model, are computed by a helper the runtime
runs with the Python the experiment's command starts with (`.venv/bin/python probe.py`), so the model loads in the
environment that ran the experiment; a command that starts with anything else is refused with 422. The helper needs
`torch` and `transformers`, loads weights in float32, and is run in the version's working folder. Not on Windows.

- `POST /projects/{id}/research/runs/{run}/activations` with `{"sampleId","modelId"?}` answers with
  `{"sampleId","modelId","measure","tokens":[...],"layers":[{"layer":0,"values":[...]}],"top","patched":null}`: one
  value per token at each layer, read from the residual stream leaving that layer (layer 0 is the embedding). With an
  `expected` on the sample line it is the log-probability of `expected`'s first token read through the final norm and
  the unembedding; without one it is the residual stream's norm. `top` is the token the model ends on. The model is the
  one the sample line names unless `modelId` says otherwise; its weights are as the version pinned them, else as the
  project's model record says.
- `POST /projects/{id}/research/interventions` with `{"runId","sampleId","sourceModelId","targetModelId","layer"}`
  runs the source model on the same input, replaces the residual stream leaving `layer` of the target with the source's,
  and answers in the same shape with `patched: {"layer","sourceModelId","layers","top"}`. Everything up to that layer is
  then the source's, everything after it the target's.
- The answer is saved in the run's folder under `inside/`, named by the request, and the same request is answered from
  there without running again. `GET .../activations?sample=&model=` reads what was saved, or 404.
- A helper that fails answers 422 with the end of its error output. The runtime never interprets the values.

## What a run costs

While a run lives the runtime samples its process group every two seconds into `runs/{id}/resources.jsonl`, one
object per line: `at`, `elapsedMs`, `cpuPercent` and `memoryBytes` (every process in the group, added up, from `ps`),
`processes`, `samplesBytes` and `samplesLines` (the samples file so far), `inputTokens` and `outputTokens` (the
`usage` of the lines so far, added up), `deviceMemoryBytes` (the last `usage.deviceMemoryBytes` a line gave, or null),
and `gpus` (each GPU's name, utilization and memory from `nvidia-smi`, or null where there is none). `GET /projects/{id}/research/runs/{run}/resources` answers
with `{"runId","status","system":{"cpus","platform"},"points":[...]}`, the newest 900 points. The readings are what
the system said; nothing is derived from them.

## The environment

`GET /projects/{id}/research/environment` is the project's Python: `python` (the interpreter the user set, or null),
`suggestedPython` (the one the newest experiment's command starts with, when none is set), `report` (what the
interpreter last said about itself), `checkedAt`, and `lockFiles`, the pinning files found at the project's root
(`uv.lock`, `poetry.lock`, `Pipfile.lock`, `requirements.txt`, `requirements.lock`, `pyproject.toml`,
`environment.yml`) with their `sha256` and `size`, looked up at the time of asking. `PUT` with `{"python"}` sets the
interpreter; empty forgets it. `POST .../environment/check` runs a script with the interpreter that reports its
version, platform, processor count, the versions of the packages research code leans on, and the devices torch can
see (CUDA names, MPS), and keeps the report. No interpreter, one that cannot start, or one whose report cannot be read
answers 422 with what to do. Looking inside uses this interpreter when an experiment's command does not start with
one. The record lives in `.saturn/research/environment.json`, and the lock files are not changed by Saturn.

### The managed environment

Saturn can make a Python environment in the project, at `.venv`, with `uv` when it is on PATH and `python3 -m venv`
otherwise, and fill it with kits of packages. The record carries `tools` (`uv` and `python3` as found on PATH, and
`managed`: the path, its python, and whether it exists), `kits`, and `job`.

- Kits: `core` (torch, transformers, numpy: what Saturn's own helpers load models with, `bundled`, so it goes in
  with the environment unless declined), `interpretability` (transformer_lens, sae_lens, einops), `training` (trl,
  peft, datasets, accelerate), `analysis` (pandas, matplotlib), `notebooks` (jupyter, ipykernel). Each package carries
  the version the last check of the managed interpreter reported, or null.
- `POST .../environment/create` with `{"python"?: "3.12", "withCore"?: true}` makes the environment (a version needs
  uv) and installs the bundled kit, then sets the record's `python` to the managed one. `POST .../environment/install`
  with `{"kit"}`, `{"packages": [...]}` (plain names with an optional pin; nothing starting with `-`) or
  `{"sync": true}` (`uv sync` with a `uv.lock` or `pyproject.toml`, else pip against `requirements.lock` or
  `requirements.txt`) installs into it. Both answer with the record at once and run as a job.
- A job runs the commands one after another in the project's folder, writes their output to
  `.saturn/research/environment-job.log`, and records itself in `environment-job.json`: `kind`, `commands`, `status`
  (`running`, `completed`, `failed`, or `interrupted` when the runtime that started it is gone), `exitCode`,
  `startedAt`, `endedAt`. The record's `job` adds `logTail` and `logLines`. One job at a time per project (409).
  `POST .../environment/job/stop` ends it; `.saturn/research` changes as it starts and ends.
- The installs are made by uv or pip, which reach the package index on their own; Saturn's network log does not see
  them. Not on Windows.

## What is enforced, and what is not

**Participation modes and locks are a workflow constraint, not a security boundary.** The HTTP API has one bearer token and
cannot tell the user from an agent that obtained it, and an agent with a shell can write any file the shell can.

| Backend | File tools | Anything else |
|---|---|---|
| API and local models | Refused before writing | A command is compared by hash afterwards |
| Claude Code | Refused through `can_use_tool` for the tools it asks about | Compared afterwards |
| Codex | Not possible per file: its sandbox is read-only or writable | Compared afterwards; a Delegate task runs in a worktree |
| MCP tools | Saturn cannot tell what they write | Compared afterwards |

- A file's mode is `manual`, `pair` or `delegate`, by file or folder, and the most specific one wins. A file with none is
  the agent's to change. `pair` makes a file tool wait for the user even with approvals off, and an accepted change is
  recorded with its content and the policy's revision. A mode that changes while a call waits applies to that call.
- Locked for agents: what the policy names, and the `data` and `scorer` inputs of each experiment's newest version. The
  user can release a lock (`released` in the policy) when an agent asks to change such a file: it may then change it,
  and the next frozen version locks what it uses again and ends every release, so older versions keep their results.
- Changes are noticed by a file's size and time, so an edit that keeps both is not.
- No agent tool sets a verdict, a mode, an approval or a frozen version, and file tools refuse `.saturn/research/`.
- A refused tool call is recorded as a confirmed violation. A hash that changed is recorded as `integrity_changed` with
  no claim about who changed it, since the user may have edited the file. A file changed and restored between checks
  is not detected.
