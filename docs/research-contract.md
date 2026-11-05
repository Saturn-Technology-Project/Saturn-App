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
policy.json                the locks
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
- An experiment's optional `labelAliases` explicitly maps a person's words to the scorer's, for example
  `{"Wrong name":"Wrong"}`. Comparisons trim whitespace and ignore case; Saturn does not guess that differently
  worded labels mean the same thing. Editing the map updates review comparisons for that experiment, including
  earlier labels, without changing the saved labels or scores. The labels response adds `agreesWithScorer` to each
  entry: true, false, or null when no matching sample with a scorer word was found.
- `GET .../runs/{id}/samples` accepts `only=all|disputed|errors` before paging, so a dispute anywhere in the run is
  reachable, including beyond 5,000 lines. `cursor` and `next` remain absolute byte positions in the samples file.
  Disputed filtering and agreement use the same Rust rule and experiment vocabulary; error filtering uses `error`.
- `expected`, optional, is what the scorer compared the output with: the right name, the reference answer. It is shown
  with the sample and never used by the runtime.
- `alternative`, optional, is the word `expected` is scored against, for a scorer that compares two: the other name. A
  layer sweep then reports the logit margin of `expected` over it. Only each word's first token is compared.
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

When a run ends, `samplesPerModel` records the most samples any one model got, and `warnings` holds what the runtime
noticed: for now, a count unlike that of the last completed run of the same experiment whose version compares as the
same evaluation, since a stated evaluation can go stale while the program changes. Only completed runs compare: a run
that failed or was stopped neither gets this warning nor is compared with. A warning changes nothing else.

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
- `POST /projects/{id}/research/runs/{run}/inspections` looks at prompts of the person's own, with the run's Python and weights,
  and saves the answer as `inside/inspect-*.json`; the same request again is answered from there. With `{"action":"compare",
  "modelId","otherModelId","input","expected"?}` it answers with `measure`, `tokens`, `layers`, `otherLayers`, `top` and `otherTop`, and
  refuses models that split the prompt into different tokens. With `{"action":"prompts","modelId","clean","corrupted","expected",
  "alternative","layers"?}` it restores each layer and position of the corrupted prompt from the clean one, and answers with
  `recovery`, the share of the margin between the prompts brought back, 0 none and 1 all, and `control`, the same for a random vector
  of the size of the difference at that place. It refuses prompts of different token counts, more than 64 tokens, and prompts with the same margin. These prompts are not samples: an answer is one case, not a measurement.
- `POST /projects/{id}/research/interventions/sweep` with `{"runId","sampleIds":[...],"sourceModelId",
  "targetModelId","layers"?}` does the patch at every layer (or the ones named) on up to 32 samples in one helper
  process, both models loaded once, and answers `{"sourceModelId","targetModelId","layers":[...],"samples":[{"sampleId",
  "expected","alternative","top","expectedLogProb","margin","byLayer":[{"layer","top","expectedLogProb","margin"}]}]}`:
  what the target ends on with each layer patched, the log-probability of the expected token there, and its logit margin
  over `alternative` (null when the line names none). Whether a layer "restores" a sample is for the reader: the runtime
  gives the numbers, not a verdict. The interface counts a margin above zero when every sample has one, since that is
  what a two-way scorer judges, and the top token otherwise, and says which.
- Block patches use the actual residual leaving the block, before final normalization. The final logit-lens reading
  uses the already normalized final hidden state without normalizing it again. Reading layer 0 is the embedding;
  intervention layer 0 is the output of the first block. A residual transplant replaces the whole prefix's state,
  not only that block's contribution, and cannot by itself locate a defect to that block.
- The answer includes `helperSha256` and is saved in the run's folder under `inside/`, named by the request and the
  helper's hash. The same request with the same helper is answered from there without running again. An updated
  helper computes a new result and keeps earlier results intact. `GET /projects/{id}/research/runs/{run}/inside` lists everything saved there, newest
  first, each with `kind` `reading` or `sweep`, and `current` true when this runtime's helper made it. An interface
  counts only current results as findings and says how many earlier ones are kept. `GET .../activations?sample=&model=` reads what was saved, or 404.
- A helper that fails answers 422 with the end of its error output. The runtime never interprets the values.

## What a run costs

While a run lives the runtime samples its process group every two seconds into `runs/{id}/resources.jsonl`, one
object per line: `at`, `elapsedMs`, `cpuPercent` and `memoryBytes` (every process in the group, added up, from `ps`),
`processes`, `samplesBytes` and `samplesLines` (the samples file so far), `inputTokens` and `outputTokens` (the
`usage` of the lines so far, added up), `deviceMemoryBytes` (the last `usage.deviceMemoryBytes` a line gave, or null),
and `gpus` (each GPU's name, utilization and memory from `nvidia-smi`, or null where there is none). `GET /projects/{id}/research/runs/{run}/resources` answers
with `{"runId","status","system":{"cpus","platform"},"points":[...]}`, the newest 900 points. The readings are what
the system said; nothing is derived from them.

Resource points also carry `samplesRewrites`, the number of times an already counted prefix was changed or truncated.
An unchanged file uses a metadata check; when it changes, the consumed prefix is verified by streaming SHA-256 before
adding new complete lines. A changed prefix restarts line/token counts from the current file and the interface warns
that the program violated the append protocol. Throughput starts again at that point. Verification can read a large
prefix, although only appended lines need JSON parsing in the normal case. Rewrites before a prefix was sampled,
or changes restored between readings, cannot be observed; this does not enforce append-only access to the file.

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
- Both requests accept `timeoutSeconds`, an integer from 1 to 86400, default 1800. This is the wall-clock limit for
  the whole job, including all its commands. The Environment screen offers 1 to 1440 whole minutes, default 30.
  A deadline ends the entire process group, forcibly after the grace period if needed, before the job slot is released.
  It preserves the log and records `status: "timed_out"`, `timeoutSeconds` and `error`, and never switches the project's
  interpreter to an environment whose creation timed out. The user can retry with a longer limit.
- A job runs the commands one after another in the project's folder, writes their output to
  `.saturn/research/environment-job.log`, and records itself in `environment-job.json`: `kind`, `commands`, `status`
  (`running`, `completed`, `failed`, `timed_out`, or `interrupted` when the runtime that started it is gone), `exitCode`,
  `startedAt`, `endedAt`. The record's `job` adds `logTail` and `logLines`. One job at a time per project (409).
  `POST .../environment/job/stop` ends the whole group, including children that ignore the initial stop signal;
  `.saturn/research` changes as it starts and ends.
- The installs are made by uv or pip, which reach the package index on their own; Saturn's network log does not see
  them. Not on Windows.

## What is enforced, and what is not

**Participation modes and locks are a workflow constraint, not a security boundary.** The HTTP API has one bearer token and
cannot tell the user from an agent that obtained it, and an agent with a shell can write any file the shell can.

| Backend | File tools | Anything else |
|---|---|---|
| API and local models | Refused before writing | A command is compared by hash afterwards |
| Claude Code | Refused through `can_use_tool` for the tools it asks about | Compared afterwards |
| Codex | Not possible per file: its sandbox is read-only or writable, so a Pair chat runs read-only | Compared afterwards; a task runs in a worktree |
| MCP tools | Saturn cannot tell what they write | Compared afterwards |

- A chat's mode is `manual`, `pair`, `delegate` or `delegate_auto` (`chatMode`, set with `PATCH /threads/{id}`), kept on the
  chat rather than in the project's records. It also decides how much the chat asks, in place of the agent's own approval
  setting: `delegate` asks before what is sensitive, and `delegate_auto` asks nothing. A chat with no mode goes by the agent's. `manual` makes every run of the chat read-only. `pair` makes a file tool, a command or any other
  call that changes something wait for the user even with approvals off, and an accepted file change is recorded with its
  content and the policy's revision. `delegate` and `delegate_auto` put no limit on what the chat changes, and the chat goes on in place, on the project itself unless it has a worktree. A task, started on the Tasks screen or with `research_task_start`, has its own worktree and keeps the mode it was started in. A chat with no mode is the agent's to change. A mode that changes while a call waits applies to that call.
- Locked for agents: what the policy names, and the `data` and `scorer` inputs of each experiment's newest version. The
  user can release a lock (`released` in the policy) when an agent asks to change such a file: it may then change it,
  and the next frozen version locks what it uses again and ends every release, so older versions keep their results.
- Changes are noticed by a file's size and time, so an edit that keeps both is not.
- No agent tool sets a verdict, a label, a chat's mode, an approval or a lock, or changes a frozen version, and file tools refuse `.saturn/research/`. An agent can make new versions and start runs: see below.
- A refused tool call is recorded as a confirmed violation. A hash that changed is recorded as `integrity_changed` with
  no claim about who changed it, since the user may have edited the file. A file changed and restored between checks
  is not detected.

## What an agent does with the records

An agent with the built-in `research` server, which an agent has only when its list names it, has nine tools, on every backend. `docs/research-skills.md` lists the skills that teach them.

| Tool | Reads or writes | What it does |
|---|---|---|
| `research_skill` | Reads | Lists or reads a skill. A project's or user's skill of the same name comes first |
| `research_read` | Reads | Status, records, runs, summaries, samples (50 at most at a time), logs, resources, labels, comparisons, events, the environment, the policy, saved readings |
| `research_wait` | Reads | Holds the turn until a run ends, for up to 600 seconds at a time, and ends with the turn |
| `research_write` | Writes | Makes questions, hypotheses, experiments, models, findings and counterexamples, and changes them with `expectedRevision` |
| `research_run` | Writes | Freezes an experiment from the chat's own folder, starts a version, stops a run |
| `research_environment_action` | Writes | Checks, makes, fills and chooses the project's Python |
| `research_inspect` | Writes | Activations, a patch, a sweep, two models on a prompt, and two prompts on a model |
| `research_task_start` | Writes | Starts a task: another agent on its own, in a separate worktree |
| `research_task_read` | Reads | Lists tasks, reports on one, or waits until one ends or needs the person, for up to 600 seconds at a time |

- A Manual chat keeps the tools that read. A Pair chat waits for the user before those that write, even with approvals off.
- What an agent finds is always `ai_suggestion`: `kind` is set for it, and a `conclusion` is refused.
- A hypothesis it makes has no verdict, and it does not change once made, so that nothing under a person's verdict moves. It changes only its own findings. A record's other changes go through `expectedRevision` as usual.
- There is no tool for labels, verdicts, modes, the policy, or merging a task.
- A task cannot start a task, and at most 4 of an agent's tasks in a project are going at once. A task starts in `delegate`, or `delegate_auto` if the chat that started it is. Only the person answers its approvals, and merges or discards it.
- A start's `attempt` (default 1) makes its `clientId` with the turn and the version: repeating a call in a turn starts nothing, and a new attempt runs the version again.
- An answer over 60,000 characters is cut, and says to read less.
- A turn of an agent with these tools may take 400 tool steps, where others take 60. This applies to Saturn's own agent loop. Claude Code and Codex keep their own limits. No limit caps what a study spends on a paid model: a person or a skill's budget has to.
- A freeze that ends lifted locks changes `policy.json`, and is not recorded as an unexplained change.

