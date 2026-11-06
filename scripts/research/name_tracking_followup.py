"""Offline follow-up to the Pythia name-tracking runs: embedding drift and residual prefix transplants.

Uses an existing samples file and checkpoint map, never regenerates prompts, and never changes prior results.
Run with the research project's Python (torch and transformers). Outputs baseline JSONL for Saturn and separate
intervention artifacts: aggregating baseline and patched scores together would change the evaluation.
"""
import argparse
import gc
import hashlib
import json
import os
import platform
import re
from datetime import datetime, timezone
from pathlib import Path

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

import torch
import torch.nn.functional as functional
import transformers
from transformers import AutoModelForCausalLM, AutoTokenizer


def digest(path):
    """Fingerprints a source file without reading a model into memory a second time."""
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def save(path, value):
    """Writes a complete analysis artifact; the output folder belongs to this new run."""
    Path(path).write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def sample_names(row):
    """Reads both candidates from the exact prompt format used by the original experiment."""
    matched = re.fullmatch(r"When (\w+) and (\w+) went to (.+), (\w+) gave a drink to", row["input"])
    if not matched or matched[2] != matched[4] or row["expected"] != " " + matched[1]:
        raise ValueError(f"Unrecognized prompt or expected name: {row['sampleId']}")
    return " " + matched[1], " " + matched[2]


def samples_from(path):
    """Keeps one input per stable sample id, refusing conflicting copies across checkpoints."""
    samples, recorded = {}, {}
    for line in Path(path).read_text().splitlines():
        row = json.loads(line)
        key = row["sampleId"]
        prompt = {field: row[field] for field in ("sampleId", "input", "expected")}
        sample_names(prompt)
        if key in samples and samples[key] != prompt:
            raise ValueError(f"Conflicting inputs for {key}")
        samples[key] = prompt
        identity = (row["modelId"], key)
        if identity in recorded:
            raise ValueError(f"Repeated original sample: {identity}")
        recorded[identity] = row
    return list(samples.values()), recorded


def snapshot(weights):
    """Resolves an already cached checkpoint to its immutable commit, with no network fallback."""
    root = Path(os.environ.get("HF_HUB_CACHE", str(Path.home() / ".cache/huggingface/hub")))
    repo = root / ("models--" + weights["source"].replace("/", "--"))
    revision = weights.get("commit", weights["revision"])
    ref = repo / "refs" / revision
    commit = ref.read_text().strip() if ref.exists() else revision
    folder = repo / "snapshots" / commit
    if not (folder / "model.safetensors").is_file():
        raise FileNotFoundError(f"Checkpoint is not cached: {weights['source']} {revision}")
    return folder, commit


def load(weights):
    """Loads the cached model in float32 on CPU with the original probe's default SDPA attention."""
    folder, _ = snapshot(weights)
    tokenizer = AutoTokenizer.from_pretrained(folder, local_files_only=True)
    model = AutoModelForCausalLM.from_pretrained(
        folder, local_files_only=True, dtype=torch.float32, attn_implementation="sdpa"
    ).eval()
    if model.config.model_type != "gpt_neox":
        raise ValueError("This follow-up explicitly supports GPT-NeoX/Pythia only")
    return tokenizer, model


def token_ids(tokenizer, row):
    """A multi-token candidate is unmeasurable under the original single-token scorer."""
    names = sample_names(row)
    ids = [tokenizer(name, add_special_tokens=False).input_ids for name in names]
    return tuple(item[0] for item in ids) if all(len(item) == 1 for item in ids) else None


def metric(tokenizer, logits, ids):
    """Keeps the original candidate margin and the independent full-vocabulary top-1 criterion."""
    correct, other = ids
    margin = float(logits[correct] - logits[other])
    return {
        "margin": margin,
        "correct": margin > 0,
        "top": tokenizer.decode([int(logits.argmax())]),
        "topCorrect": int(logits.argmax()) == correct,
        "expectedLogProb": float(torch.log_softmax(logits, dim=-1)[correct]),
    }


@torch.inference_mode()
def capture(model, encoded):
    """Captures actual block outputs before final normalization, including the last block."""
    states = {}

    def remember(index):
        def hook(module, inputs, output):
            states[index] = (output[0] if isinstance(output, tuple) else output).detach().clone()
        return hook

    handles = [block.register_forward_hook(remember(index)) for index, block in enumerate(model.gpt_neox.layers)]
    try:
        logits = model(**encoded, use_cache=False).logits[0, -1].detach().clone()
    finally:
        for handle in handles:
            handle.remove()
    return logits, states


@torch.inference_mode()
def transplant(model, encoded, layer, donor):
    """Replaces the entire residual state after one block: this transplants a prefix, not one block's computation."""
    def replace(module, inputs, output):
        return (donor,) + output[1:] if isinstance(output, tuple) else donor

    handle = model.gpt_neox.layers[layer].register_forward_hook(replace)
    try:
        return model(**encoded, use_cache=False).logits[0, -1].detach().clone()
    finally:
        handle.remove()


@torch.inference_mode()
def embedding_logits(model, encoded, embeddings):
    """Changes only the input embedding values; every block, final norm and output head remains the target's."""
    return model(inputs_embeds=embeddings, attention_mask=encoded.get("attention_mask"), use_cache=False).logits[0, -1]


def check_same(actual, expected, what):
    """A self-patch must be a no-op across the full vocabulary, not only on the winning token."""
    difference = float((actual - expected).abs().max())
    if not torch.allclose(actual, expected, rtol=1e-5, atol=1e-4):
        raise AssertionError(f"{what}: self-patch changed logits (max error {difference})")
    return difference


@torch.inference_mode()
def embedding_drift(tokenizer, source, target, samples):
    """Measures input and output rows separately, including whole-vocabulary relative-drift reference quantiles."""
    names = sorted({name for row in samples for name in sample_names(row)})
    answer = {}
    for label, getter in (("input", "get_input_embeddings"), ("output", "get_output_embeddings")):
        before = getattr(source, getter)().weight
        after = getattr(target, getter)().weight
        delta = (after - before).norm(dim=-1)
        relative = delta / before.norm(dim=-1).clamp_min(1e-12)
        cosine = functional.cosine_similarity(before, after, dim=-1)
        rows = []
        for name in names:
            ids = tokenizer(name, add_special_tokens=False).input_ids
            if len(ids) != 1:
                rows.append({"name": name, "tokenIds": ids, "unmeasurable": True})
                continue
            token = ids[0]
            rows.append({
                "name": name, "tokenId": token, "sourceNorm": float(before[token].norm()),
                "targetNorm": float(after[token].norm()), "deltaL2": float(delta[token]),
                "relativeL2": float(relative[token]), "cosine": float(cosine[token]),
                "relativeDriftPercentile": float((relative <= relative[token]).float().mean() * 100),
            })
        answer[label] = {
            "reference": "all model vocabulary rows, including unused/padding rows",
            "relativeL2Quantiles": {str(q): float(torch.quantile(relative, q)) for q in (0.5, 0.9, 0.99)},
            "names": rows,
        }
    return answer


@torch.inference_mode()
def baselines(weights, samples, recorded, output, lines):
    """Replays every existing prompt and refuses to proceed if any old score cannot be reproduced."""
    all_metrics = {}
    for model_id, spec in weights.items():
        tokenizer, model = load(spec)
        measurements = {}
        for row in samples:
            ids = token_ids(tokenizer, row)
            old = recorded.get((spec.get("originalModelId", model_id), row["sampleId"]))
            if old is None:
                raise ValueError(f"No original baseline for {model_id} {row['sampleId']}")
            if ids is None:
                if not old.get("error"):
                    raise AssertionError("An unmeasurable prompt was previously scored")
                result = {"scores": None, "scorerLabel": "Unmeasurable", "output": None, "error": old["error"]}
            else:
                encoded = tokenizer(row["input"], return_tensors="pt")
                value = metric(tokenizer, model(**encoded).logits[0, -1], ids)
                previous = old["scores"]["logit-difference"]
                if abs(value["margin"] - previous) > 0.002 or value["correct"] != old["scores"]["correct"] or value["top"] != old["output"]:
                    raise AssertionError(f"Baseline differs: {spec['revision']} {row['sampleId']}: {value}, previous {old}")
                measurements[row["sampleId"]] = value
                result = {"output": value["top"], "scores": {"logit-difference": value["margin"], "correct": value["correct"]}, "scorerLabel": "Correct" if value["correct"] else "Wrong", "error": None}
            lines.write(json.dumps({"schemaVersion": 1, "modelId": model_id, **row, **result}) + "\n")
            lines.flush()
        all_metrics[spec["revision"]] = measurements
        save(output / "baselines.json", all_metrics)
        print(f"Baseline {spec['revision']}: {sum(v['correct'] for v in measurements.values())}/{len(measurements)} reproduced", flush=True)
        del model
        gc.collect()
    return all_metrics


@torch.inference_mode()
def sweep(source_spec, target_spec, samples, baseline, output):
    """Tests every failing target prompt; donor failures remain visible rather than being silently excluded."""
    tokenizer, target = load(target_spec)
    donor_tokenizer, source = load(source_spec)
    if tokenizer.get_vocab() != donor_tokenizer.get_vocab():
        raise ValueError("Tokenizers differ")
    source_revision, target_revision = source_spec["revision"], target_spec["revision"]
    count = len(target.gpt_neox.layers)
    selected = [row for row in samples if row["sampleId"] in baseline[target_revision] and not baseline[target_revision][row["sampleId"]]["correct"]]
    answer = {"source": source_revision, "target": target_revision, "selection": "target baseline candidate margin <= 0", "layers": list(range(count)), "samples": [], "controls": []}
    if target_revision == "step143000":
        answer["embeddingDrift"] = embedding_drift(tokenizer, source, target, samples)
    for row in selected:
        encoded, ids = tokenizer(row["input"], return_tensors="pt"), token_ids(tokenizer, row)
        plain, own = capture(target, encoded)
        donor_logits, states = capture(source, encoded)
        errors = {str(layer): check_same(transplant(target, encoded, layer, own[layer]), plain, f"block {layer}") for layer in (0, count - 1)}
        own_embed = target.get_input_embeddings()(encoded.input_ids)
        errors["embedding"] = check_same(embedding_logits(target, encoded, own_embed), plain, "embedding")
        by_layer = [{"layer": layer, **metric(tokenizer, transplant(target, encoded, layer, states[layer]), ids)} for layer in range(count)]
        embedding = metric(tokenizer, embedding_logits(target, encoded, source.get_input_embeddings()(encoded.input_ids)), ids)
        # The old helper took hidden_states[-1], which is post-final-norm in GPT-NeoX, and fed it into a pre-norm hook.
        normalized = source.gpt_neox.final_layer_norm(states[count - 1])
        legacy = metric(tokenizer, transplant(target, encoded, count - 1, normalized), ids)
        answer["samples"].append({**row, "baseline": metric(tokenizer, plain, ids), "donor": metric(tokenizer, donor_logits, ids), "selfPatchMaxErrors": errors, "embedding": embedding, "byLayer": by_layer, "legacyLastLayer": legacy})
        print(f"{source_revision} -> {target_revision} {row['sampleId']}: margin restored at {[v['layer'] for v in by_layer if v['correct']]}; top-1 at {[v['layer'] for v in by_layer if v['topCorrect']]}", flush=True)
        save(output / f"{source_revision}-into-{target_revision}.json", answer)
    if target_revision == "step143000":
        # All orders/places of the questioned pair plus two matched control pairs; this is specified before running.
        for row in samples:
            if frozenset(sample_names(row)) not in (frozenset((" Laura", " David")), frozenset((" Mike", " Sarah")), frozenset((" Mary", " John"))):
                continue
            encoded, ids = tokenizer(row["input"], return_tensors="pt"), token_ids(tokenizer, row)
            own_embed = target.get_input_embeddings()(encoded.input_ids)
            donor_embed = source.get_input_embeddings()(encoded.input_ids)
            mask = (encoded.input_ids == ids[0]) | (encoded.input_ids == ids[1])
            names_only = torch.where(mask.unsqueeze(-1), donor_embed, own_embed)
            answer["controls"].append({**row, "baseline": baseline[target_revision][row["sampleId"]], "allEmbeddings": metric(tokenizer, embedding_logits(target, encoded, donor_embed), ids), "nameEmbeddingsOnly": metric(tokenizer, embedding_logits(target, encoded, names_only), ids)})
    answer["restoredByLayer"] = [{"layer": layer, "margin": sum(row["byLayer"][layer]["correct"] for row in answer["samples"]), "top1": sum(row["byLayer"][layer]["topCorrect"] for row in answer["samples"])} for layer in range(count)]
    answer["embeddingRestored"] = {"margin": sum(row["embedding"]["correct"] for row in answer["samples"]), "top1": sum(row["embedding"]["topCorrect"] for row in answer["samples"])}
    save(output / f"{source_revision}-into-{target_revision}.json", answer)
    del target, source
    gc.collect()
    return {key: answer[key] for key in ("source", "target", "restoredByLayer", "embeddingRestored")}


def main():
    """Records the inputs and environment before the first inference; all weights must already be cached."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=Path, required=True)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--threads", type=int, default=6)
    args = parser.parse_args()
    torch.set_num_threads(args.threads)
    torch.manual_seed(0)
    torch.use_deterministic_algorithms(True)
    output = args.output or Path(os.environ["SATURN_RUN_DIRECTORY"]) / "followup"
    output.mkdir(parents=True, exist_ok=False)
    weights = json.loads(args.models.read_text())
    wanted = {"step100000", "step120000", "step130000", "step143000"}
    weights = {key: value for key, value in weights.items() if value["revision"] in wanted}
    if {value["revision"] for value in weights.values()} != wanted or len(weights) != 4:
        raise ValueError("Exactly one model for each of 100k, 120k, 130k and 143k is required")
    manifest = {
        "createdAt": datetime.now(timezone.utc).isoformat(), "scriptSha256": digest(__file__),
        "samplesSha256": digest(args.samples), "modelsSha256": digest(args.models),
        "python": platform.python_version(), "torch": torch.__version__, "transformers": transformers.__version__,
        "dtype": "float32", "device": "cpu", "attention": "sdpa", "threads": args.threads, "seed": 0,
        "models": {key: {**value, "commit": snapshot(value)[1], "weightsSha256": digest(snapshot(value)[0] / "model.safetensors")} for key, value in weights.items()},
        "protocol": {
            "baseline": "all original prompts; margin > 0; reproduce previous rounded margins within 0.002 and exact correctness/top-1",
            "embedding": "130k -> 143k input/output row drift; all input embeddings and name-position-only swaps on Laura/David, Mike/Sarah, Mary/John, both orders, all four places",
            "sweep": "all target failures, no exclusion by donor correctness; 130k -> 143k and 100k/130k -> 120k; actual post-block residual before final norm",
            "metrics": "candidate margin and full-vocabulary top-1 reported separately; no statistical or mechanistic hypothesis verdict",
        },
    }
    save(output / "manifest.json", manifest)
    samples, recorded = samples_from(args.samples)
    sample_file = Path(os.environ.get("SATURN_RUN_SAMPLES", str(output / "samples.jsonl")))
    with sample_file.open("x") as lines:
        baseline = baselines(weights, samples, recorded, output, lines)
    by_revision = {spec["revision"]: spec for spec in weights.values()}
    results = []
    for source, target in (("step130000", "step143000"), ("step100000", "step120000"), ("step130000", "step120000")):
        results.append(sweep(by_revision[source], by_revision[target], samples, baseline, output))
    save(output / "summary.json", results)
    print(f"Complete: {output}", flush=True)


if __name__ == "__main__":
    main()
