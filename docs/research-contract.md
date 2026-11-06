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
events.jsonl               refusals, unexplained changes and accepted Approve changes
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
- A model has a `source` (a name or a local path) and a `weightsRevision`. Only a full commit (40 hex digits) or hash
  (64) pins it. One with no revision, or a name that can move such as `main`, `latest` or a short commit, is
  `floating`, and a run on it says so. A version's models also say their `revisionKind` (`commit`, `hash`, `name`,
  `none`). A model whose source is a file or folder on this computer is hashed when the version is frozen
  (`weightsSha256`, a folder by each file's path and hash) and checked again when a run starts. Versions frozen before
  these fields were recorded still start when nothing they held changed. A hub model's weights are not read: its
  identity is its revision. Roles (`base`, `reference`, `policy`) belong to an experiment's use of a model, since one set of weights can
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

### Paired behavior changes

`POST .../research/comparisons` takes `left` and `right` (`runId`, optional `modelId`), `scorer`, optional
`higherIsBetter` (default true) and `sliceField` (default `category`). Each side selects one model; ambiguous runs are
refused. Only sealed bytes are read and their hash must still match. Each side is bounded to 64 MiB and 100,000 samples.

Pairs match `sampleId` and `trial`, then require identical known inputs, a finite numeric score on both sides, no error,
and no generated row identity. Missing sides, input mismatches, errors and other exclusions are counted separately.
Delta is right minus left; the chosen score direction decides improvement. The mean weights each sample ID equally
after averaging its trials. The conservative 95% paired t interval treats sample IDs as independent, assumes approximately
normal prompt means, has no multiple-comparison correction, and does not express uncertainty across training seeds.
Unknown or different evaluation conditions, or fewer than two independent sample IDs, omit the interval. Differences
remain descriptive. Category slices use the left sample's metadata when present.

`only` and `slice` filter before paging; `cursor` indexes the filtered rows, 200 per page. `save: true` and optional `title`
save every regression in the selected slice as a `counterexample_sets` record, including members beyond the visible page,
the original request, summary, method note and source digests. Scores and labels are never modified. Saved memberships
remain readable; recomputing their original request checks the source seals again.

## A run's life

```
starting → running → stopping → stopped
              ├────────────────→ completed | failed | protocol_error
              └────────────────→ interrupted
```

- The run is saved as `starting` before its process exists. A start carries a `clientId`; repeating it returns the same
  run and starts nothing.
- Inputs are checked against the version's fingerprint just before the run starts, and a mismatch starts nothing. The
  run then gets its own snapshot (see "Run evidence"), and the command runs there, not in the project folder. A file of
  the snapshot that differs from the version refuses the run (`failed`, `refused: true`). When the run ends, the snapshot
  is checked again, and a file replaced during the run is recorded on it as `inputsChanged`.
- The process is identified by its process id, its start time and a token in its environment. After the runtime restarts,
  a run left `starting` or `running` becomes `interrupted`. Its process group is ended only if the process is confirmed to
  be the same one; otherwise the run says it could not be confirmed.
- An interrupted run keeps its complete samples. A new run can be started; resuming the same one is not offered.
- Ending a run seals it: the hash of `samples.jsonl` is recorded, and later writes to the file do not count. Reading a
  run, its samples or its summary checks the seal again: `sealIntact: false` means the samples changed after the run
  ended, and they no longer stand for its results.
- A running run holds its worktree: discarding it, or the chat that owns it, gets 409.
- Process identity is implemented for macOS and Linux. On Windows, starting a run says it is not supported yet.

## Run evidence

A local run starts from its own snapshot in Saturn's data folder (`run-snapshots/<run>`), never from the folder being
edited:

- Committed files come from git's objects for the version's commit (`git archive`), uncommitted files from the copies
  saved at freezing (or copied from the project and checked), and declared inputs are copied in, copy-on-write where the
  file system can. Every file is checked against the hash the version recorded.
- On systems without copy-on-write, a data file over 1 GiB is linked instead and checked before and after the run.
- Top-level entries of the project that the version does not hold (except `.git` and `.saturn`) are linked and listed
  as uncontrolled.
- The snapshot's files are read-only. This is file permissions, not isolation. A program can still replace a file,
  which the check at the end records.
- Files the program writes in its working folder are moved to `runs/<id>/written/` when it ends, and the snapshot is
  removed. A snapshot a process might still be using after a restart is checked and kept.

`runs/<id>/evidence.json` (`GET .../research/runs/:run/evidence`, `research_read { what: "evidence" }`) keeps three
sources apart:

- `expected`: the version's command, commit, inputs, models and seeds.
- `observed`: what Saturn saw. That is the snapshot's files and their hashes with a manifest hash, how each input got
  there, what is uncontrolled, the seeds passed as `SATURN_RUN_SEED` and `SATURN_RUN_SEEDS`, and, after the run, what
  changed and what was written.
- `reported`: what the program wrote to `SATURN_RUN_REPORT`, one JSON object per line with `kind` of `seed`, `model`,
  `config` or `resume`. What it did not report is `null` and is never filled in from `expected`.

Three verdicts: `execution` (the run's status), `inputs` (`verified`, `partial`, `changed`, `unverified`) and
`outputs` (`sealed`, `incomplete`, `changed`, `none`). A run from before evidence was kept answers `recorded: false`.

A hash confirms which content a file had. It does not show that the program used that content, or that the scorer or
the conclusion is right.

A remote run sends the host what the version holds (commit, uncommitted files and declared inputs, each with its hash),
not the files themselves. The host's worker builds the snapshot in the job's folder from its own working tree and git,
checks every file, and only then runs the command there. A difference ends the job as `refused` before anything runs,
and the run is `failed` with `refused: true` and the files named. The snapshot's list (`snapshot.json`), the
program's report and what changed come back with the outputs, and the evidence says `executor: "ssh"`: the host
observed it, and Saturn here only received what the host recorded.

## Deleting an experiment

`DELETE .../research/experiments/:id?expectedRevision=N` moves the experiment, its versions, their runs (each run's
folder) and their labels to `.saturn/research/trash/<time>-<id>/`, with a `deleted.json` saying what moved, when, by
whom and how to put it back. Nothing is erased. It is refused while a run of it is going, at a revision other than the
one given, and while another record (a finding, a counterexample, a saved set, an inspection session, an analysis
output, a question, hypothesis or model) names the experiment, a version or a run: the answer names those records. Only
experiments can be deleted. The assistant can delete an imported experiment through `research_write` with
`delete: true`; one frozen or run in the project is the person's to delete.

## Importing completed results

`POST .../research/imports/preview` reads a project file without creating records. `POST .../research/imports`
creates a new experiment, imported version and completed run; no question or hypothesis is required. Both take `path`,
optional `format` (`jsonl`, `json`, `csv`, `tsv`, `trainer`), `columns` mapping protocol names to source columns,
and `scoreColumns` listing numeric columns. Existing JSONL `scores` and other metadata are preserved. CSV supports quoted
commas and newlines. Imports are bounded to 64 MiB and 100,000 rows; malformed rows, duplicate identities and invalid
scores reject the import before records are created. Source paths use the granted project and cannot escape it.

The preview includes the source SHA-256; passing it as `expectedSha256` rejects a changed file with 409. Provenance records
the source path, format, hash and size, and says that this is not a verified execution. Missing IDs become `row-N`, marked
as generated: positions do not establish identity across files. Unstated evaluation, weights and environment remain
unknown. An optional `modelId` names an existing project model; `evaluation` can explicitly declare known conditions.
Imported versions cannot be executed: set the experiment's command and freeze a new version to do that.

Trainer `log_history` is saved as `metrics.jsonl`, not as scored samples. `GET .../runs/{run}/metrics?cursor=0` pages up to
200 events using byte offsets. Each event has `schemaVersion: 1`, non-negative integer `step`, and finite numeric `values`.
The process environment now names `SATURN_RUN_METRICS` and `SATURN_RUN_ARTIFACTS` alongside `SATURN_RUN_SAMPLES`; writing
samples remains the execution contract for evaluation runs. The UI reads metrics separately and plots their source steps.

### Persistent SSH jobs

`GET/PUT .../research/remote` reads or saves `host`, absolute remote `workdir`, and `program` (the same version of
`saturn-server`, installed on that host). `POST .../remote/check` checks the worker without starting compute.
Saturn invokes OpenSSH with no terminal, no agent forwarding, BatchMode and a connection deadline. It keeps host-key
verification and uses the user's SSH configuration; it neither stores keys nor provisions or pays for a machine.

`POST .../remote/runs` takes an executable `versionId`, `clientId`, `timeoutSeconds` (1..604800, default 3600), and optional
`resumeFrom`. The launch intent is stored before SSH. A detached Rust worker, started with nohup in its own group,
owns the command, output streams, cancellation and wall-clock limit. Closing the desktop/runtime only detaches.
Restarting reconnects active remote runs this runtime started, instead of interrupting them; it records those launches in its own data folder (`remote-launches.json`), never in the project. A run whose remote record came with the project is marked `interrupted` with `remoteError`, and its host is not contacted. Only the first exchange carries the start; a worker without the job answers 410 and the run becomes `interrupted`, never resubmitted. Worker errors keep their status, and 400, 403, 404, 410, 413 and 422 end the run with that message rather than being retried. Retrying a client ID cannot submit another job.
An explicit stop persists a cancellation request even while disconnected; only the worker's acknowledgement ends it.
A stale heartbeat is unresponsive, not proof the computation stopped. A dead remote machine/worker is not resubmitted.

Code and data are not uploaded. The worker records its working directory and observed git commit, with an explicit
warning that these are not certified identical to the local frozen source. `resumeFrom` is passed as
`SATURN_RESUME_FROM`; the user's framework must restore weights, optimizer, scheduler and RNG state. A resumed attempt
is a new run. The wall-clock limit stops the process group; it is not a guarantee about a provider's GPU bill.

Samples, metrics, artifact manifest and stdout/stderr are pulled in bounded chunks, at most 64 MiB per stream.
Completion waits for every chunk and verifies the remote hashes. A transfer failure keeps the run pending/disconnected,
with a warning that computation may continue. Large weights remain external artifacts. Neither source nor outputs may
escape the configured job's state directory through symlinks. The worker's state lives under the remote project's
`.saturn/remote-jobs/<run>` and does not load Saturn settings or credentials or expose an HTTP server.

An experiment can explicitly set `kind: "training"` before freezing. Local and remote training runs can complete with
valid metrics alone; evaluation runs still require scored samples. Malformed metrics are protocol errors. Windows has
not been run; the detached worker is POSIX-only.

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
  With `{"action":"features","modelId","prompt","layer", "saeRelease","saeId" or "saePath", "expected"?,"alternative"?,"ablate"?}` it
  runs the residual stream leaving `layer` through a sparse autoencoder with `sae_lens`, and answers with `tokens`, `top`, `sae`
  (`release`, `id`, `path`, `hookName`, `width`, `trainedOn`, `startTokenAdded`, `centered`), `reconstruction` (`varianceExplained`,
  `relativeError`, `meanActiveFeatures`, `tokensLeftOut`) and `features`, up to 8 per token as `{"feature","activation"}`, by id with no
  names. A local `saePath` is relative to the experiment's folder, and a change to its files makes it a new question. Special tokens are
  not read and are left as they were. With both words it adds `margins` (`plain`, `spliced`, `spliceChange`, what splicing the unmodified
  reconstruction in did), and with `ablate`, a feature's id, it adds `ablation` (`feature`, `activation`, `margin`, `change` from the spliced
  margin, and `control`, the same for a random feature firing within a factor of two, or else the closest, with `controlSeed`). A change is
  read only against both the control and `spliceChange`. A missing `sae_lens`, an SAE made for another hook point or width, a feature that
  does not fire, and a prompt of more than 64 tokens are refused with 422 and the reason, and nothing is saved. Features are not compared across models.
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

### Standalone inspection sessions and analysis artifacts

`POST .../research/inspection-sessions` takes `modelIds` (1..32) and optional `title`/`cwd`. It snapshots the project's
configured Python path, model sources/revisions, known lock hashes and last environment report in an immutable
`inspection_sessions/<id>.json`. It creates no experiment or scored run and starts no model. Its `.../{id}/actions`
accept the same compare/prompts/features actions as a run's inspections, with evidence in
`inspection_sessions/<id>/inside/`. A model absent from the snapshot is refused. Changing the interpreter or model
record later does not change a session. Floating weights, mutable local model contents and changes inside an installed
Python environment remain limitations. Session observations use `inspectionIds`, not fictitious run IDs.

`POST .../research/artifacts/register` takes a project `path`, `kind` (`figure`, `json`, `notebook`, `reference`), optional
`runId`/`inspectionId` and metadata. A snapshot saves at most 16 MiB in content-addressed `artifact_data/<sha256>`;
its immutable record retains the original path/hash/size. JSON and nbformat 4 notebooks are validated; figures need a
PNG/JPEG/WebP signature. HTML and SVG are not rendered. The content endpoint verifies the saved hash and reports when
the source changed or cannot be checked. Opening a notebook explicitly opens its original editable project file.

A reference copies no contents. A project file reference records its measured hash/size; an external https/s3/hf/ssh URI
has unverified contents and must not contain passwords, tokens, query strings or fragments. Nothing is downloaded merely
to register an external URI. Large activation stores and SAE weights can remain references with framework/hook metadata.

Programs may append ordinary JSON objects to `SATURN_RUN_ARTIFACTS`, e.g.
`{"path":"figure.png","kind":"figure","metadata":{"framework":"TransformerLens"}}`. Paths are relative to
`SATURN_RUN_DIRECTORY`. `POST .../artifacts/from-run` explicitly validates every entry before saving any; repeated
imports are idempotent. The manifest is bounded to 1 MiB/100 entries. For remote runs, explicitly importing a small
output fetches it in bounded SSH chunks and checks its hash; it cannot read outside the job or read worker control files.
Archived remote references are never automatically reconnected. The optional `scripts/research/analysis_artifacts.py`
example writes plain files/JSONL and needs no Saturn SDK. Existing Notebook cells and kernels are reused.

## The data experiments read

Routes under `/projects/{id}/research/data` read a project's data files for the Data screen and the assistant. They read
only inside the project's main folder (not a chat's worktree), and refuse with 403 a path that climbs out, a path through
a symbolic link even one that stays inside the project, and Saturn's records and git's folder. Nothing is written. What a
file's rows say is data: it is shown as plain text and counted, and it is never put in a system prompt. An answer that
carries rows has a `note` saying so.

- `GET .../data` lists every file named as a `data` input by an experiment or a version. A declared folder counts as its
  files, up to 2000 (`filesCapped`), except a Hugging Face dataset folder (one holding `dataset_dict.json`, `state.json` or
  `dataset_info.json`), which is one entry of `kind` `dataset`. Each of `items` has `path`, `kind`, `format`, `exists`,
  `problem` (why a path was refused; nothing else is said about it then), `size`, `modifiedAt`, `frozen` (the newest
  version that froze it: `versionId`, `number`, `experimentId`, `sha256`, `size`, `frozenAt`; a folder's `sha256` is
  of its files' paths and hashes), `frozenBy` (every such version), `changed` (differs from `frozen` now; null when never
  frozen), `experiments`, `runs`, `looksLikeTest`, `declaredSplits` and `testReads`. A file is hashed only when its size
  matches, and a hash is remembered by size and time, so the first list after a change can take a while.
- A run in `runs` read what its version froze, once its process had started: `id`, `versionId`, `experimentId`, `status`,
  `at`, `split` (its version's `evaluation.split`) and `testRead`. `testRead` is `declared` when that split says test,
  `name` when no split was stated and the file's name looks like a test split, `conflict` when another split was stated
  but the name looks like test, and null otherwise. `testReads` counts the runs where it is not null. This is how a person checks how often test
  data was touched, and it has limits: a name is not proof, only words in the file's name or the folder right above it count (`test`, `testing`, `testset`, `holdout`, `heldout`, `held-out`, so not `latest`),
  and only declared inputs are known, since a program can read a file it never declared.
- `GET .../data/preview?path=&cursor=&limit=&split=` answers a page of rows without holding the file in memory, from a
  `.jsonl` or `.ndjson`, a `.json` array, a `.csv` or a `.tsv` with a header: `items`, each `{"offset","row"}` or
  `{"offset","problem","raw"?}`, and `next`, the `cursor` of the next page or null. `limit` is 50 by default and 200
  at most, and a page also ends once it holds 4 MiB. A row longer than `maxRowBytes` (1 MiB) is left out and says so, a malformed line
  or a row with the wrong number of fields is shown as a problem, and neither stops the read. Quoted fields may hold line
  breaks; an unclosed quote stops counting at the row limit, so it cannot swallow the file. A cursor that is not the start of a row is 400, a
  `.json` file that is not an array 422, and any other kind of file 415.
- `GET .../data/profile?path=&split=` reads every row and answers `rows`, `malformed`, `tooLong`, `columnsCapped` and
  `columns`: for each `name`, `kind` (`number`, `text`, `other`, `mixed` or `empty`), `present`, `missing` (null, empty
  text, or a row without the column), `numbers`, `texts`, `others`, `distinct`, `distinctCapped`, `common` (the five most
  common values, each up to 200 characters) and `range` or `lengths`. A number written in a `.csv` or `.tsv` counts as a number; a JSON string does not.
  Memory is capped: 200 columns, and 1000 different values per column. Past that `distinct` is the least there are, and
  `common` counts only values seen before the limit. A profile is remembered until the file's size or time changes
  (`remembered`), so an edit that keeps both is not noticed.
- `GET .../data/overlap?left=&right=&columns=&leftSplit=&rightSplit=` finds **exact duplicates only**: rows identical
  by the hash of the canonical row (keys in order, missing fields left out, numbers and booleans as their text, so that a
  `.csv` compares with a `.jsonl`), or of the chosen `columns`, comma separated. It answers `left` and `right`, each
  with `path`, `split`, `rows`, `malformed`, `tooLong`, `withoutColumns` (rows with none of the chosen columns, not
  compared) and `inBoth`; `sharedDistinct`; `comparedBy`; and `capped`. Paraphrases, reformatted text and near duplicates
  are not found, so zero does not mean no leakage. The smaller file's hashes are kept, up to 4,000,000 different rows; past that `capped` is true and
  the counts are the least there are.
- Parquet (`.parquet`), Arrow (`.arrow`) and Hugging Face dataset folders are answered by a helper run with the project's
  Python, using `datasets` if it is there, in the project's folder without the folder on its import path, offline, in streaming mode for files. The helper's rows
  go through the same reading as any other file, and `cursor` and `next` count rows there. A folder with splits answers `splits`
  and `split`, and takes `split`; the first one is read otherwise. Without `datasets` the answer is 422 and says to install the Post-training kit on the Environment screen.
  With no Python set it is 422 too, and a helper that fails is 422 with the end of its error output. Not on Windows.

## What a run costs

While a run lives the runtime samples its process group every two seconds into `runs/{id}/resources.jsonl`, one
object per line: `at`, `elapsedMs`, `cpuPercent` and `memoryBytes` (every process in the group, added up, from `ps`),
`processes`, `samplesBytes` and `samplesLines` (the samples file so far), `inputTokens` and `outputTokens` (the
`usage` of the lines so far, added up), `deviceMemoryBytes` (the last `usage.deviceMemoryBytes` a line gave, or null),
and `gpus` (each GPU's name, utilization and memory from `nvidia-smi`, or null where there is none). `GET /projects/{id}/research/runs/{run}/resources` answers
with `{"runId","status","system":{"cpus","platform"},"points":[...]}`, the newest 900 points. The readings are what
the system said; nothing is derived from them.

A remote run is sampled the same way on its host: the detached worker samples the job's process group into
`resources.jsonl` in the job's folder, stops before it writes the job's final state, and the file comes back with the
other outputs. The run records the host's `remoteSystem` (`cpus`, `platform`), and `system` in the answer is that, with
`host` naming the configured host.

`GET .../research/source?path=` opens a PDF or an image (`.pdf`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`) as
`{"kind":"document","path","mime","size","revision","data"}`, its bytes in base64, up to 32 MiB, to be shown and never
edited. Any other file that is not text is still refused with 415.

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

## Notebooks

A notebook is a file of the project's, read and saved through `GET`/`PUT .../research/source` with the same revision
check as any other file. A `.ipynb` opens up to 8 MB rather than 2 MB. Running its cells is the person's own action, like
the terminal: it records no run, is no research record, changes no version, and no assistant tool reaches it. To have
results to compare, freeze an experiment.

`POST .../research/notebook/start` with `{"path"}` starts a kernel for that notebook, or answers with the one it has.
`POST .../notebook/run` with `{"path", "cells": [{"cell", "code"}]}` queues cells in order, starting a kernel when there
is none that can take them, so installing a missing package and running again is enough. `cell` is the client's name for
it and comes back in the events. `POST .../notebook/interrupt` and `.../notebook/restart` act on the kernel and answer
409 when it has none. `POST .../notebook/stop` ends it and answers `{"stopped"}`. `GET .../notebook?path=` is its state:
`kernel` (an id, or null), `state` (`none`, `starting`, `idle`, `busy`, `restarting`, `stopping`, `stopped`, `dead`,
`missing`, `failed`), `python`, `message`, `missing` (the packages), `running`, `queued` and `seq`, the number the next
event will have.

`GET .../notebook/events?path=&kernel=&after=` is a server-sent stream of `notebook` events, from `after` or else from now,
that ends with the kernel. It answers 404 when that kernel is gone. Each event has `type` and `seq`: `state` (the fields
above), `started` (`cell`), `output` (`cell`, and `output` as a notebook stores it), `clear` (`cell`, `wait`), `finished`
(`cell`, `status`, `count`), `ended`. `status` is `ok`, `error`, `aborted` (let go by a restart, a stop or the helper's end),
`skipped` (it waited behind a cell that did not finish) or `dead` (the kernel died under it). 16 MB of events are kept for a
client reconnecting; one that was away longer first hears `gap`, without a `seq`.

One run of one cell keeps 2 MB of output as stored JSON. Text keeps its start; an image or table past the limit is left out.
Either way, one `display_data` output with `metadata.saturn.truncated` says so, which is valid in the notebook when saved.
The cell itself goes on. The interface shows output only as text and PNG images: HTML, SVG and the like appear in their
text form, and output is never read as instructions.

The kernel runs with the project's Python, in the notebook's folder, with `SATURN_*` removed from its environment. A
helper in that Python holds it with `jupyter_client`, and asks for `ipykernel_launcher` directly rather than by kernel
name, as a `python3` kernel spec in the person's own Jupyter folder could start another Python. Without `jupyter_client`
or `ipykernel` the state is `missing` and `message` points at the Notebooks kit under Environment; no Python, or one that
cannot start, answers 422. The notebook still opens, edits and saves. `input()` is refused, as in the terminal.

A kernel ends when its notebook is closed, its project is removed or loses access, or the runtime stops. The helper is
asked, then signalled, then ended by force. If the runtime dies, the helper's standard input closes and it ends the kernel,
and a kernel whose helper was killed ends by itself. A path that leads out of the project or into `.saturn` or `.git` answers
403, as for the editor, and one that is not a `.ipynb` answers 400. Running a notebook answers 501 on Windows.

## What is enforced, and what is not

**Participation modes and locks are a workflow constraint, not a security boundary.** The HTTP API has one bearer token and
cannot tell the user from an agent that obtained it, and an agent with a shell can write any file the shell can.

| Backend | File tools | Anything else |
|---|---|---|
| API and local models | Refused before writing | A command is compared by hash afterwards |
| Claude Code | Refused through `can_use_tool` for the tools it asks about | Compared afterwards |
| Codex | Not possible per file: its sandbox is read-only or writable, so an Approve chat runs read-only | Compared afterwards; a task runs in a worktree |
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

An agent with the built-in `research` server, which an agent has only when its list names it, has thirteen tools, on every backend. `docs/research-skills.md` lists the skills that teach them.

| Tool | Reads or writes | What it does |
|---|---|---|
| `research_skill` | Reads | Lists or reads a skill. A project's or user's skill of the same name comes first |
| `research_read` | Reads | Status, records, runs, summaries, samples (50 at most at a time), logs, resources, training metrics, labels, comparisons by condition and sample by sample (`paired`, which saves nothing), events, the environment, the policy, saved readings, the SSH host and remote runs, inspection sessions, kept outputs, a notebook kernel's state, previews of an import or a bundle, and the project's data: which files were read (`data_list`), what is in one (`data_profile`, `data_preview`), and what two share (`data_overlap`) |
| `research_wait` | Reads | Holds the turn until a run ends, for up to 600 seconds at a time, and ends with the turn |
| `research_write` | Writes | Makes questions, hypotheses, experiments, models, findings and counterexamples, changes them with `expectedRevision`, and deletes an imported experiment (`delete: true`) |
| `research_run` | Writes | Freezes an experiment from the chat's own folder, starts a version, stops a run |
| `research_environment_action` | Writes | Checks, makes, fills and chooses the project's Python |
| `research_inspect` | Writes | Activations, a patch, a sweep, two models on a prompt, two prompts on a model, and a prompt's sparse-autoencoder features, on a run or in an inspection session it opens |
| `research_evidence` | Writes | Imports results made elsewhere, exports and imports bundles, keeps analysis outputs, and saves a paired comparison's samples as a counterexample set |
| `research_remote` | Writes | Checks the SSH host the person configured, and starts a frozen version there |
| `research_notebook` | Writes | Starts a notebook's kernel, runs code in its cells, and interrupts, restarts or stops it |
| `research_task_start` | Writes | Starts a task: another agent on its own, in a separate worktree |
| `research_task_read` | Reads | Lists tasks, reports on one, or waits until one ends or needs the person, for up to 600 seconds at a time |
| `research_task_delete` | Writes | Deletes a task that has ended and whose worktree the person merged or discarded; its conversation goes, no code is lost |

- An Ask chat keeps the tools that read. An Approve chat waits for the user before those that write, even with approvals off.
- What an agent finds is always `ai_suggestion`: `kind` is set for it, and a `conclusion` is refused.
- A hypothesis it makes has no verdict, and it does not change once made, so that nothing under a person's verdict moves. It changes only its own findings. A record's other changes go through `expectedRevision` as usual.
- There is no tool for labels, verdicts, modes, the policy, merging a task, or the SSH host: the person configures the host, and an agent only checks it and starts runs there.
- A task cannot start a task, and at most 4 of an agent's tasks in a project are going at once. A task starts in `delegate`, or `delegate_auto` if the chat that started it is. Only the person answers its approvals, and merges or discards it.
- A task reports back to the chat that started it. When its newest turn completes, fails, is stopped or waits for approval, the chat keeps the report (`taskReports`) and a turn starts there by itself (`automatic`, with `fromTasks`), carrying the report as context; a chat in the middle of a turn hears when that turn ends. Each report is passed on once, and the turn keeps the chat's mode.
- A start's `attempt` (default 1) makes its `clientId` with the turn and the version: repeating a call in a turn starts nothing, and a new attempt runs the version again.
- An answer over 60,000 characters is cut, and says to read less.
- A turn of an agent with these tools may take 400 tool steps, where others take 60. This applies to Saturn's own agent loop. Claude Code and Codex keep their own limits. No limit caps what a study spends on a paid model: a person or a skill's budget has to.
- A freeze that ends lifted locks changes `policy.json`, and is not recorded as an unexplained change.

