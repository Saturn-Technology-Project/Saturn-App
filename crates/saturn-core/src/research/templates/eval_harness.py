"""Turn a published benchmark run from lm-eval or inspect_ai into Saturn samples, one per item, beside the harness's own aggregate.

Run the harness first and keep its output under the experiment's `inputs.data`, so it is frozen and hashed:
    lm_eval --model hf --model_args pretrained=<model> --tasks <task> --log_samples --output_path results/
    inspect eval <task> --model <model>; inspect log dump logs/<file>.eval > logs/<file>.json
Then this program is the experiment's command:
    python3 eval_harness.py --format lm-eval --path results/            (a folder with samples_*.jsonl and results_*.json)
    python3 eval_harness.py --format inspect --path logs/<file>.json    (one inspect_ai JSON export)
It writes one sample per item with `category` the task, `scores` the harness's metrics, `expected` the target and
`scorerLabel` Correct or Wrong where a correctness metric exists; the suite's version, judge model and aggregate go to
the report as `config`, and the raw harness files are copied into the run's output and listed as artifacts.
What to change: JUDGE_MODEL when the suite is model-graded, and CORRECTNESS_METRICS if your task names its metric differently.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import shutil
import sys

from saturn_run import Run

# Change here: the judge model and revision a model-graded suite used (StrongREJECT, HarmBench), or None.
JUDGE_MODEL = None
# Change here: metric names that mean "this item was right", read for scorerLabel; the first present wins.
CORRECTNESS_METRICS = ("acc", "acc_norm", "exact_match", "correct", "accuracy", "match")
# lm-eval sample fields that are not metrics.
LM_EVAL_FIELDS = {"doc_id", "doc", "target", "arguments", "resps", "filtered_resps", "filter", "metrics",
                  "doc_hash", "prompt_hash", "target_hash"}
LM_EVAL_TASK = re.compile(r"^samples_(.+?)(?:_\d{4}-\d{2}-\d{2}T[\d.\-]+)?$")


def correctness_label(scores: dict) -> str | None:
    """Correct or Wrong from the first correctness metric present; None when the task has none."""
    for name in CORRECTNESS_METRICS:
        if name in scores and scores[name] is not None:
            value = scores[name]
            if isinstance(value, str):
                return {"C": "Correct", "I": "Wrong", "P": "Partial"}.get(value, None)
            return "Correct" if float(value) >= 0.5 else "Wrong"
    return None


def as_text(value) -> str:
    """A target or reply as a string, so `expected` and `output` are text."""
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


def keep_copy(run: Run, path: pathlib.Path) -> None:
    """Copies one harness file into the run's output and lists it, so the raw result stays with the run."""
    target = run.output / "harness" / path.name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(path, target)
    run.artifact(target, "json")


def write_item(run: Run, counter: dict, sample_id: str, trial: int | None = None, **fields) -> None:
    """One sample line; without a trial given, a repeated id within the harness output becomes the next trial."""
    trials = counter.setdefault("trials", {})
    if trial is None:
        trial = trials.get(sample_id, 0)
    trials[sample_id] = trial + 1
    counter["written"] = counter.get("written", 0) + 1
    run.sample(sample_id, trial=trial, **fields)


def read_lm_eval(run: Run, folder: pathlib.Path, counter: dict) -> dict:
    """Every samples_*.jsonl under the folder as samples; the results_*.json files give the aggregate and versions."""
    config: dict = {"harness": "lm-eval", "aggregate": {}, "versions": {}}
    for results in sorted(folder.rglob("results*.json")):
        data = json.loads(results.read_text(encoding="utf-8"))
        config["aggregate"].update(data.get("results", {}))
        config["versions"].update(data.get("versions", {}))
        config.setdefault("model", data.get("config", {}).get("model_args") or data.get("config", {}).get("model"))
        config.setdefault("gitHash", data.get("git_hash"))
        keep_copy(run, results)
    for samples in sorted(folder.rglob("samples_*.jsonl")):
        task = LM_EVAL_TASK.match(samples.stem).group(1)
        keep_copy(run, samples)
        with open(samples, encoding="utf-8") as lines:
            for number, line in enumerate(lines, 1):
                try:
                    item = json.loads(line)
                    doc_id = item["doc_id"]
                except (json.JSONDecodeError, KeyError, TypeError) as problem:
                    write_item(run, counter, f"{task}/line-{number}", category=task,
                               error={"kind": "infrastructure", "message": f"unreadable harness line: {problem}"})
                    continue
                names = item.get("metrics") or [key for key in item if key not in LM_EVAL_FIELDS]
                scores = {name: item[name] for name in names if isinstance(item.get(name), (int, float, bool, str))}
                replies = item.get("filtered_resps") or item.get("resps") or []
                write_item(run, counter, f"{task}/{doc_id}", category=task, scores=scores,
                           input=as_text(item.get("arguments", "")), output=as_text(replies),
                           expected=as_text(item.get("target", "")), scorerLabel=correctness_label(scores),
                           error=None if scores else {"kind": "scorer", "message": "the harness recorded no metric"})
    return config


def read_inspect(run: Run, path: pathlib.Path, counter: dict) -> dict:
    """One inspect_ai JSON export: each sample's scorer values, with the epoch as the trial."""
    data = json.loads(path.read_text(encoding="utf-8"))
    keep_copy(run, path)
    header = data.get("eval", {})
    task = header.get("task", path.stem)
    config = {"harness": "inspect_ai", "task": task, "taskVersion": header.get("task_version"),
              "model": header.get("model"), "revision": header.get("revision"), "taskArgs": header.get("task_args"),
              "aggregate": {score.get("name"): score.get("metrics") for score in data.get("results", {}).get("scores", [])}}
    for item in data.get("samples", []):
        scores = {}
        for scorer, record in (item.get("scores") or {}).items():
            scores[scorer] = record.get("value") if isinstance(record, dict) else record
        choices = (item.get("output") or {}).get("choices") or []
        reply = choices[0].get("message", {}).get("content", "") if choices else ""
        label = correctness_label(scores) or correctness_label({"match": next(iter(scores.values()), None)} if scores else {})
        write_item(run, counter, f"{task}/{item.get('id')}", trial=max(int(item.get("epoch", 1)) - 1, 0), category=task,
                   input=as_text(item.get("input", "")), output=as_text(reply), expected=as_text(item.get("target", "")),
                   scores=scores, scorerLabel=label,
                   error=None if scores else {"kind": "scorer", "message": "the harness recorded no score"})
    return config


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--format", choices=("lm-eval", "inspect"), required=True)
    parser.add_argument("--path", required=True, help="lm-eval output folder, or one inspect_ai JSON export")
    arguments = parser.parse_args()
    run = Run()
    run.seed()
    path = pathlib.Path(arguments.path)
    if not path.exists():
        print(f"no harness output at {path}", file=sys.stderr)
        return 2
    counter: dict = {}
    config = read_lm_eval(run, path, counter) if arguments.format == "lm-eval" else read_inspect(run, path, counter)
    config["judge"] = JUDGE_MODEL
    run.report("config", **config)
    if config.get("model"):
        run.report("model", source="harness", id=as_text(config["model"]), revision=config.get("revision") or config.get("gitHash"))
    written = counter.get("written", 0)
    print(f"wrote {written} samples from {path}")
    return 0 if written else 1


if __name__ == "__main__":
    sys.exit(main())
