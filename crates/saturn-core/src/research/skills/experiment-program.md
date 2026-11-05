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
```python
import json, os, sys

path = os.environ["SATURN_RUN_SAMPLES"]
output_folder = os.environ["SATURN_RUN_DIRECTORY"]

def write_sample(out, **fields):
    line = {"schemaVersion": 1, "trial": 0, "error": None, **fields}
    out.write(json.dumps(line, ensure_ascii=False) + "\n")
    out.flush()

with open(path, "a", encoding="utf-8") as out:
    for example in load_examples():
        try:
            answer = run_model(example)
            write_sample(out, sampleId=example["id"], modelId=MODEL_ID, input=example["prompt"],
                         output=answer, scores={"correct": answer.strip() == example["answer"]},
                         expected=example["answer"])
        except torch.cuda.OutOfMemoryError as error:
            write_sample(out, sampleId=example["id"], modelId=MODEL_ID, input=example["prompt"],
                         error={"kind": "infrastructure", "message": str(error)})
```

## Rules
- **Append only.** Never rewrite earlier lines. Saturn notices a rewrite and warns.
- **Whole lines, flushed.** A final line with no newline counts as a protocol error after the process ends.
- **Keep going past one bad sample**: record the error on its line. Crash only on what makes every later line meaningless.
- **Exit nonzero on failure.** Exit 0 means it worked; do not hide a failure.
- **Stdout and stderr are logs.** Print progress there, at a sensible rate.
- **Outputs go to `SATURN_RUN_DIRECTORY`** or a git-ignored folder. New untracked files make the next run a new version.
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
