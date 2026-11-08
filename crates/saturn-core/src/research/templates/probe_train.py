"""Train linear probes on saved activations at every layer, with shuffled-label and random-direction controls in the same run.

How to use: declare the activation files and their manifest in the experiment's `inputs.data`, then run
    python3 probe_train.py --manifest activations/manifest.jsonl --position last
The manifest is JSONL, one object per example: {"path": "activations/s-1.npz", "label": "yes", "split": "train"},
with an optional "sampleId" (else the file's stem). `path` is relative to the manifest's folder or absolute; `split` is
"train" or "test"; labels must be two classes. Each .npz holds `layer_<n>` arrays of shape tokens x hidden and `tokens`,
as `research_inspect activations` with `save` writes them, or as a hook script of your own saves them.

What it writes: one sample line per held-out example with scores `layer_<n>`, `layer_<n>_shuffled` and
`layer_<n>_random` (1.0 right, 0.0 wrong), so Saturn's summary is accuracy per layer and per control; `probes.json` in
the run's output with every probe's weights, accuracies and bootstrap intervals, listed as a json artifact; and
`probe_layer_<n>.npz` beside it with each direction in activation space, which `steering_sweep.py --direction` loads.
What to change: the regularization constants below, or `fit` for another probe type.
"""
from __future__ import annotations

import argparse
import json
import pathlib

import numpy as np

from saturn_run import Run

# Change here: regularization and gradient descent settings for the logistic regression.
L2 = 1e-2
STEPS = 500
LEARNING_RATE = 0.1
BOOTSTRAPS = 1000


def arguments():
    """The command line: the manifest, the position rule and which layers."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--manifest", required=True, help="JSONL with path, label and split per example")
    parser.add_argument("--position", choices=("last", "mean"), default="last", help="the vector that stands for a sample")
    parser.add_argument("--layers", default="", help="comma-separated layer numbers; default every layer in the files")
    return parser.parse_args()


def read_manifest(path):
    """The manifest's rows, with each file path resolved against the manifest's folder when it lies there."""
    rows = []
    base = pathlib.Path(path).parent
    with open(path, encoding="utf-8") as lines:
        for line in lines:
            if line.strip():
                row = json.loads(line)
                file = pathlib.Path(row["path"])
                row["path"] = file if file.is_absolute() or not (base / file).exists() else base / file
                row.setdefault("sampleId", row["path"].stem)
                rows.append(row)
    return rows


def load(rows, position, wanted):
    """One vector per row per layer: the last token's residual or the mean over tokens, as float64 matrices by layer."""
    vectors: dict[int, list] = {}
    for row in rows:
        with np.load(row["path"]) as data:
            layers = wanted or sorted(int(name[6:]) for name in data.files if name.startswith("layer_"))
            for layer in layers:
                array = np.asarray(data[f"layer_{layer}"], dtype=np.float64)
                vectors.setdefault(layer, []).append(array[-1] if position == "last" else array.mean(axis=0))
    return {layer: np.stack(stack) for layer, stack in vectors.items()}


def fit(x, y):
    """Logistic regression by gradient descent with L2, on features standardized with the training statistics."""
    mean, std = x.mean(axis=0), x.std(axis=0) + 1e-6
    z = (x - mean) / std
    weights, bias = np.zeros(z.shape[1]), 0.0
    for _ in range(STEPS):
        p = 1.0 / (1.0 + np.exp(-(z @ weights + bias)))
        weights -= LEARNING_RATE * (z.T @ (p - y) / len(y) + L2 * weights)
        bias -= LEARNING_RATE * float((p - y).mean())
    return {"weights": weights, "bias": bias, "mean": mean, "std": std}


def predict(probe, x):
    """The probe's class (0 or 1) for each row of x."""
    return (((x - probe["mean"]) / probe["std"]) @ probe["weights"] + probe["bias"] > 0).astype(float)


def interval(hits, rng):
    """Accuracy with a 95% bootstrap interval over the held-out examples."""
    draws = [hits[rng.integers(0, len(hits), len(hits))].mean() for _ in range(BOOTSTRAPS)]
    return {"accuracy": float(hits.mean()), "low": float(np.percentile(draws, 2.5)), "high": float(np.percentile(draws, 97.5))}


def main():
    args = arguments()
    run = Run()
    rng = np.random.default_rng(run.seed(default=0))
    if run.resume_from:
        run.report("resume", checkpoint=run.resume_from, restored=[], note="probes are refit; finished samples are skipped")
    rows = read_manifest(args.manifest)
    train, test = [r for r in rows if r["split"] == "train"], [r for r in rows if r["split"] != "train"]
    classes = sorted({r["label"] for r in rows})
    if len(classes) != 2 or not train or not test:
        raise SystemExit(f"need two classes with train and test rows; got classes {classes}, {len(train)} train, {len(test)} test")
    wanted = [int(part) for part in args.layers.split(",") if part.strip()]
    x_train, x_test = load(train, args.position, wanted), load(test, args.position, wanted)
    y_train = np.array([r["label"] == classes[1] for r in train], dtype=float)
    y_test = np.array([r["label"] == classes[1] for r in test], dtype=float)
    run.report("config", resolved={"position": args.position, "layers": sorted(x_train), "l2": L2, "steps": STEPS,
                                   "train": len(train), "test": len(test), "classes": classes})
    summary: dict[str, dict] = {}
    hits: dict[str, np.ndarray] = {}

    def save():
        """The probes fitted so far, as JSON the run keeps; also what a stop leaves behind."""
        with open(run.output / "probes.json", "w", encoding="utf-8") as out:
            json.dump({"position": args.position, "classes": classes, "layers": summary}, out)
        run.artifact(run.output / "probes.json", "json", layers=len(summary))

    run.on_stop(save)
    for layer in sorted(x_train):
        probe = fit(x_train[layer], y_train)
        shuffled = fit(x_train[layer], rng.permutation(y_train))
        random_direction = rng.standard_normal(x_train[layer].shape[1])
        random_direction /= np.linalg.norm(random_direction)
        random_probe = fit(x_train[layer] @ random_direction[:, None], y_train)
        hits[f"layer_{layer}"] = predict(probe, x_test[layer]) == y_test
        hits[f"layer_{layer}_shuffled"] = predict(shuffled, x_test[layer]) == y_test
        hits[f"layer_{layer}_random"] = predict(random_probe, x_test[layer] @ random_direction[:, None]) == y_test
        direction = probe["weights"] / probe["std"]
        np.savez(run.output / f"probe_layer_{layer}.npz", direction=direction, layer=layer, position=args.position)
        summary[f"layer_{layer}"] = {**interval(hits[f"layer_{layer}"], rng), "n": len(test),
                                     "shuffled": float(hits[f"layer_{layer}_shuffled"].mean()),
                                     "random": float(hits[f"layer_{layer}_random"].mean()),
                                     "weights": direction.tolist(), "bias": probe["bias"], "mean": probe["mean"].tolist()}
        print(f"layer {layer}: {summary[f'layer_{layer}']['accuracy']:.3f} "
              f"(shuffled {summary[f'layer_{layer}']['shuffled']:.3f}, random {summary[f'layer_{layer}']['random']:.3f})")
    for index, row in enumerate(test):
        if not run.finished(row["sampleId"]):
            run.sample(row["sampleId"], input=str(row["path"]), expected=row["label"],
                       scores={name: float(correct[index]) for name, correct in hits.items()})
    save()


if __name__ == "__main__":
    main()
