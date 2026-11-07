"""Build a steering direction from two prompt sets or a probe, add it at a layer over a coefficient sweep, and measure effect and side effects with controls.

How to use: declare the prompt file and the side-effect text in the experiment's `inputs.data`, then run
    python3 steering_sweep.py --model gpt2 --prompts prompts.jsonl --layer 6 --side-text heldout.txt
The prompts are JSONL: {"prompt": "...", "set": "a"} and {"prompt": "...", "set": "b"} build the direction (mean of a
minus mean of b); rows with "split": "test" are held out and steered; an optional "id" names a row. `--direction
probe_layer_6.npz` (as `probe_train.py` saves it) uses a probe's direction instead. Coefficients are in units of the
mean residual norm at the layer; coefficient 0 must match the unsteered model exactly. One sample per held-out prompt
x coefficient x condition (`direction`; `random`, a vector of the same norm; `wrong_layer`, several layers away) carries
`coefficient`, `condition` and `layer` as fields and scores `target` (the measure below) and `perplexity` on the fixed
side text; `direction.npz` and `direction.json` (listed as an artifact) go to the run's output. What to change:
`measure`, a keyword count and therefore a weak scorer. Needs torch and transformers, not transformer_lens.
"""
import argparse
import hashlib
import json

import numpy as np

from saturn_run import Run

# Change here: the words whose count stands for the target behavior. Weak: a count moves with repetition and length.
KEYWORDS = ("happy", "joy", "delighted", "wonderful")
# Change here: how many tokens to generate, how much side text to score, how far away the wrong layer sits.
MAX_NEW_TOKENS, SIDE_TEXT_TOKENS, WRONG_LAYER_OFFSET = 24, 256, 6


def measure(text: str) -> float:
    """The target behavior as a number: how many keywords the text contains."""
    return float(sum(text.lower().count(word) for word in KEYWORDS))


def arguments():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model", required=True, help="a transformers causal language model name or path")
    parser.add_argument("--prompts", required=True, help="JSONL with prompt and set a|b; split test marks held-out rows")
    parser.add_argument("--layer", type=int, default=None, help="the decoder block whose output is steered")
    parser.add_argument("--position", choices=("last", "mean"), default="last", help="where the means are taken")
    parser.add_argument("--direction", default=None, help="an .npz with `direction` (and `layer`) from a probe")
    parser.add_argument("--coefficients", default="-4,-2,-1,0,1,2,4", help="in units of the mean residual norm")
    parser.add_argument("--side-text", required=True, help="a fixed held-out text whose perplexity shows fluency")
    return parser.parse_args()


def load_model(name):
    """The tokenizer and the model in evaluation mode, on the GPU when there is one."""
    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except ImportError as error:
        raise SystemExit("steering_sweep.py needs torch and transformers: pip install torch transformers") from error
    model = AutoModelForCausalLM.from_pretrained(name).eval().to("cuda" if torch.cuda.is_available() else "cpu")
    return AutoTokenizer.from_pretrained(name), model


def blocks(model):
    """The list of decoder blocks, wherever the architecture keeps it."""
    for path in ("model.layers", "transformer.h", "gpt_neox.layers", "model.decoder.layers"):  # Change here: other models
        found = model
        for part in path.split("."):
            found = getattr(found, part, None)
        if found is not None:
            return found
    raise SystemExit("could not find the decoder blocks; add the attribute path to `blocks`")


def residuals(model, tokenizer, prompts, layer, position):
    """One vector per prompt: the residual stream leaving `layer` (the block's output, or its first item), at the last token or averaged."""
    import torch
    kept, rows = [], []
    handle = blocks(model)[layer].register_forward_hook(lambda module, inputs, output: kept.append((output[0] if isinstance(output, tuple) else output)[0]))
    try:
        for prompt in prompts:
            with torch.inference_mode():
                model(**tokenizer(prompt, return_tensors="pt").to(model.device))
            states = kept.pop().float()
            rows.append((states[-1] if position == "last" else states.mean(0)).cpu().numpy())
    finally:
        handle.remove()
    return np.stack(rows)


def steer(model, layer, vector):
    """A hook adding `vector` at every position of the residual stream leaving block `layer`; returns its handle."""
    import torch
    added = torch.as_tensor(vector, device=model.device)

    def hook(module, inputs, output):
        if isinstance(output, tuple):
            return (output[0] + added.to(output[0].dtype),) + tuple(output[1:])
        return output + added.to(output.dtype)

    return blocks(model)[layer].register_forward_hook(hook)


def generate(model, tokenizer, prompt):
    """Greedy continuation of the prompt, a few tokens, without the prompt itself."""
    import torch
    ids = tokenizer(prompt, return_tensors="pt").to(model.device)
    with torch.inference_mode():
        out = model.generate(**ids, max_new_tokens=MAX_NEW_TOKENS, do_sample=False, pad_token_id=tokenizer.eos_token_id)
    return tokenizer.decode(out[0, ids.input_ids.shape[1]:], skip_special_tokens=True)


def perplexity(model, tokenizer, text):
    """exp(mean loss) of the model on the side text: the side effect every condition is measured by."""
    import torch
    ids = tokenizer(text, return_tensors="pt", truncation=True, max_length=SIDE_TEXT_TOKENS).to(model.device)
    with torch.inference_mode():
        return float(np.exp(model(**ids, labels=ids.input_ids).loss.item()))


def main():
    args = arguments()
    run = Run()
    rng = np.random.default_rng(run.seed(default=0))
    if run.resume_from:
        run.report("resume", checkpoint=run.resume_from, restored=[], note="the direction is rebuilt; finished samples are skipped")
    with open(args.prompts, encoding="utf-8") as lines:
        rows = [{"id": f"prompt-{index}", **json.loads(line)} for index, line in enumerate(lines) if line.strip()]
    build = {name: [r["prompt"] for r in rows if r.get("split") != "test" and r["set"] == name] for name in "ab"}
    held_out = [r for r in rows if r.get("split") == "test"]
    side_text = open(args.side_text, encoding="utf-8").read()
    tokenizer, model = load_model(args.model)
    run.report("model", source="huggingface", id=args.model, revision=getattr(model.config, "_commit_hash", None))
    layer, direction = args.layer, None
    if args.direction:
        with np.load(args.direction) as saved:
            direction, layer = np.asarray(saved["direction"], dtype=np.float64), args.layer if args.layer is not None else int(saved["layer"])
    if layer is None:
        raise SystemExit("--layer is required unless the direction file names one")
    set_a, set_b = (residuals(model, tokenizer, build[name], layer, args.position) for name in "ab")
    direction = set_a.mean(0) - set_b.mean(0) if direction is None else direction
    scale = float(np.linalg.norm(np.concatenate([set_a, set_b]), axis=1).mean())
    unit, random_unit = (v / np.linalg.norm(v) for v in (direction, rng.standard_normal(direction.shape)))
    wrong_layer = layer + WRONG_LAYER_OFFSET if layer + WRONG_LAYER_OFFSET < len(blocks(model)) else max(layer - WRONG_LAYER_OFFSET, 0)
    np.savez(run.output / "direction.npz", direction=unit, layer=layer, scale=scale, position=args.position)
    with open(run.output / "direction.json", "w", encoding="utf-8") as out:
        json.dump({"layer": layer, "position": args.position, "meanResidualNorm": scale, "source": args.direction or "difference of means",
                   "prompts": {name: {"n": len(build[name]), "sha256": hashlib.sha256("\n".join(build[name]).encode()).hexdigest()} for name in "ab"},
                   "direction": unit.tolist()}, out)
    run.artifact(run.output / "direction.json", "json", layer=layer, scale=scale)
    run.on_stop(lambda: run.report("stopped", note="direction saved; the samples written so far are complete"))
    coefficients = [float(part) for part in args.coefficients.split(",") if part.strip()]
    conditions = {"direction": (layer, unit), "random": (layer, random_unit), "wrong_layer": (wrong_layer, unit)}
    for condition, (at_layer, vector) in conditions.items():
        for coefficient in coefficients:
            handle = steer(model, at_layer, coefficient * scale * vector)
            try:
                side = perplexity(model, tokenizer, side_text)
                for row in held_out:
                    sample_id = f"{row['id']}-{condition}-c{coefficient:+g}"
                    if not run.finished(sample_id):
                        text = generate(model, tokenizer, row["prompt"])
                        run.sample(sample_id, input=row["prompt"], output=text, coefficient=coefficient, condition=condition,
                                   layer=at_layer, scores={"target": measure(text), "perplexity": side})
            finally:
                handle.remove()
            print(f"{condition} at layer {at_layer}, coefficient {coefficient:+g}: perplexity {side:.2f}")


if __name__ == "__main__":
    main()
