---
name: experiment-program
description: Write a program that runs as an experiment and writes valid samples. Read before writing any experiment or training script.
---
# Writing an experiment program

An experiment is a command. Saturn runs it and reads one JSON object per line from `SATURN_RUN_SAMPLES`.

## A sample line
```json
{"schemaVersion":1,"sampleId":"sample-0412","trial":0,"modelId":"model_abc","input":"...","output":"...","scores":{"logit-diff":0.42},"error":null}
```
- `schemaVersion` must be 1, and `sampleId` is required and stable across runs.
- `sampleId`, `trial` and `modelId` together must be unique in a run.
- `modelId`: the Saturn model record's id, when the run measures several.
- `scores`: numbers, strings or booleans, by scorer name.
- `error`: null, or `{"kind":"infrastructure"|"model"|"scorer","message":"..."}`. Infrastructure errors are counted apart.
- Optional: `scorerLabel` (the scorer's verdict in the words a person labels with), `expected` (what it compared with), `alternative` (the other word, for a two-way scorer: needed for logit margins in sweeps), `usage` (`inputTokens`, `outputTokens`, `deviceMemoryBytes`).

## A starting point
Do not write the record-keeping yourself. `research_template` with `name: "saturn_run"` gives `saturn_run.py`, a file
with no dependencies: write it into the project with your file tools, name it in `inputs.code`, and import it.
```python
from saturn_run import Run

run = Run()                      # reads SATURN_RUN_*; outside Saturn it writes to ./saturn-run/
seed = run.seed()                # the version's first seed, applied to random/numpy/torch and reported
run.report("model", source="huggingface", id=MODEL_NAME, revision=model.config._commit_hash)
for example in load_examples():
    if run.finished(example["id"]):   # a resumed run skips what came along
        continue
    try:
        answer = run_model(example)
        run.sample(example["id"], model_id=MODEL_ID, input=example["prompt"], output=answer,
                   scores={"correct": answer.strip() == example["answer"]}, expected=example["answer"])
    except torch.cuda.OutOfMemoryError as error:
        run.sample(example["id"], model_id=MODEL_ID, input=example["prompt"],
                   error={"kind": "infrastructure", "message": str(error)})
```
`run.metric(step, loss=…)`, `run.checkpoint(path, step=…)`, `run.artifact(path, kind)` and `run.on_stop(save)` write the
other records the same way. For a whole study there is usually a template to start from (`research_template` with no
name lists them): a harness wrapper, a red-team harness, a trajectory recorder, a Lean checker, a probe trainer, a
steering sweep, a training loop, a paper compiler. Copy one, change it where it says `# Change here:`, keep the rest.

## Rules
- **Append only.** Never rewrite earlier lines. Saturn notices a rewrite and warns.
- **Whole lines, flushed.** A final line with no newline counts as a protocol error after the process ends.
- **Keep going past one bad sample**: record the error on its line. Crash only on what makes every later line meaningless.
- **Exit nonzero on failure.** Exit 0 means it worked; do not hide a failure.
- **Stdout and stderr are logs.** Print progress there, at a sensible rate.
- **Files go to `SATURN_RUN_OUTPUT`**, scratch to `TMPDIR`. The program runs in the sandbox, in a read-only snapshot of
  the version: it cannot write its working folder or the project. What it writes to `SATURN_RUN_OUTPUT` is kept in the
  run's `written/` folder.
- **Name the variables it needs** in the experiment's `envNames` (an API key, `HF_TOKEN`); nothing else that could be a
  credential reaches it. Adding a name, allowing the network or turning the sandbox off is the person's to do, in
  Experiments: ask, and say why.
- **Report what it actually used** to `SATURN_RUN_REPORT`: the seed it applied, the model revision it loaded, what a
  resume restored. Without it those are unknown. See `run-provenance`.
- **Handle SIGTERM** if it holds work that should be saved. Stopping a run signals the process group.

## What decides the status
| Written | Exit | Status |
|---|---|---|
| Valid lines | 0 | `completed` |
| Valid lines | not 0 | `failed`, samples kept |
| A bad line, a repeat, or a partial last line | 0 | `protocol_error` |
| No valid line | 0 | `protocol_error` |

A training program must write at least one line too: see `pretraining`.

## Register it
```
research_write { collection: "experiments", fields: { title, command: ".venv/bin/python probe.py", inputs: { code: ["probe.py"], data: ["eval.jsonl"], scorer: ["score.py"] }, evaluation: {...}, models: [{ modelId, role: "base" }], hypothesisId } }
```
Then read `freeze-and-run`. Smoke test first with a very small sample.
