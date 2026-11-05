# Bringing an existing research workflow into Saturn

Research stays in the project's `.saturn/research` folder. None of the steps below requires a paid agent or changes
your Python framework. Use the project's own scripts for pretraining, post-training and interpretability.

## Start with results you already have

In **Home** or **Experiments → Import existing results**, name a file inside the project, choose its format and
preview it. JSONL, JSON arrays, CSV and TSV support explicit ID/input/output/score column mappings. For Hugging Face
Trainer state, choose **Trainer state JSON** explicitly; it reads `log_history`, not an array of evaluation samples.
An import creates a new experiment, descriptive version and completed run, without a hypothesis. It never executes the
imported version. Unknown model, environment and evaluation provenance remain unknown.

Imports are limited to 64 MiB and 100,000 rows. The preview hash must still match when the UI imports. Missing IDs can
be generated for browsing, but generated row IDs cannot establish paired comparisons. Keep stable IDs in your results.

Training metrics and evaluation samples remain separate. A training script may append complete UTF-8 JSONL lines to
`SATURN_RUN_METRICS`:

```json
{"schemaVersion":1,"step":100,"values":{"loss":2.1,"learning_rate":0.0001}}
```

Steps are nonnegative integers; values must be finite numbers. Explicit `training` runs can complete with valid metrics
alone. Evaluation runs still need samples. The metrics endpoint pages 200 events by byte offset; Experiments plots
loaded events and offers further pages. Partial trailing lines are left for a later read, not counted as finished events.

## Compare behavior, then preserve the cohort

**Experiments → Compare behavior changes** pairs sealed runs by stable sample ID and trial, and requires equal known
inputs. Choose a model on each side when a run contains several, name the numeric scorer, and select which score
direction is better. Delta always means right minus left. Missing sides, errors and invalid pairs are counted separately.

Slices use a top-level category or preserved `metadata.category`. You can name a nested field such as
`metadata.group.language` explicitly. The left sample supplies its slice when present. Saving a regression set keeps
all regressions in the selected slice, including rows beyond the visible page, with the request and evidence hashes.

The mean weights sample IDs equally after averaging their trials. The conservative 95% paired t interval assumes
independent sample IDs and approximately normal sample means. It measures neither variation across training seeds nor
multiple-comparison-adjusted significance. It is omitted when evaluation conditions differ or are unknown, or fewer
than two independent IDs remain. A descriptive delta under mismatched conditions does not establish an improvement.

## Leave a remote job running

Use an existing Linux or macOS SSH host. Install the same Saturn revision's `saturn-server` there, and put code, data,
Python and dependencies in the remote project first. Saturn does not provision machines or upload that tree.
Configure the host alias or `user@host`, absolute working directory and worker program in **Environment**. SSH uses
your existing configuration and host verification, with batch authentication; Saturn saves no SSH credentials.

Freeze a local experiment, then use **Experiments → Run on the configured SSH host**. The detached Rust worker owns
the process group, deadline and output. Closing the app detaches; reopening reconnects. A disconnected or unresponsive
worker may still be computing. Stop remains pending until the worker acknowledges cancellation. A new retry is a new
run; repeating the same launch ID does not launch another process.

The remote command is qualified by its observed working directory and git commit. It is not certified identical to
the local frozen files. Remote completion waits for bounded output synchronization and hash verification. A resume
checkpoint is passed as `SATURN_RESUME_FROM`; your framework must load model, optimizer and RNG state itself.

## Explore directly and keep Python outputs

**Inspect → Start exploration without an experiment** captures selected model references and the configured Python
path. It creates no scored run. A new session is appropriate when models or the interpreter change; pinning the path
does not make installed packages or floating weights immutable. Existing Workspace notebooks keep their native editor
and kernel. A notebook session itself is not a frozen experiment.

**Analysis outputs** snapshots PNG/JPEG/WebP, JSON or a version-4 notebook, up to 16 MiB per output. Registration leaves
the source untouched; subsequent previews verify the saved hash and warn if the source changed. Browse **All project
outputs** to reach outputs without a run link. Large files and activation/SAE stores can remain references. Reference
registration does not download or contact their destination. Preview never executes Python, notebook cells or HTML.

A run script can save files under `SATURN_RUN_DIRECTORY` and append to `SATURN_RUN_ARTIFACTS`:

```json
{"path":"analysis/results.json","kind":"json","metadata":{"method":"activation patching"}}
{"kind":"reference","uri":"s3://research/activations"}
```

Choose **Import run artifact manifest** to snapshot those outputs. The optional
[`analysis_artifacts.py`](../scripts/research/analysis_artifacts.py) helper writes this plain protocol; no Saturn SDK is
required. The manifest is limited to 1 MiB and 100 entries. Small remote snapshots are fetched explicitly over SSH and
verified; they must stay inside that job's directory. External references cannot contain credentials or query strings.

## Take evidence to another project

**Home / Experiments → Portable project research bundle** exports all project research records, samples, labels,
metrics, logs, Inspect results, saved source objects and analysis snapshots. It also writes escaped Markdown and HTML
reports. Weights, datasets, scorers, environments and unavailable saved objects are listed as external or missing;
they are not silently downloaded or reconstructed. Runtime settings, permissions and process control files are excluded.

Copy the bundle into another project, then validate and import. Extraction accepts only the research evidence
namespaces, verifies every file's size/hash, rejects symlinks and refuses conflicting contents before publishing files.
Identical evidence is reused. Imported versions and inspection contexts are read-only archives; active jobs become
interrupted evidence. Imported workers never reconnect, and imported commands/interpreters never execute. Explicitly
freeze a new local version or create a new local inspection session to compute again.

A bundle is limited to 5,000 files, 64 MiB decoded evidence and 96 MiB serialized JSON. Publication is staged, with
rollback on ordinary failures. A process crash is not an atomic database transaction: retry the same bundle to reuse
identical published files and finish. Hashes detect corruption, not authorship. This is evidence portability, not a
guarantee of reproducing training on another machine.
