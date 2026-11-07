"""Looks inside a model on one input: the residual stream at every layer, read through the unembedding, and the same
after the residual stream leaving one layer is patched in from another model, so everything up to that layer comes
from the other model and everything after it from this one. Run by Saturn with the project's own Python, which must
have torch and transformers. The request is one JSON argument; the answer is one JSON object on standard output."""
import json
import sys

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

request = json.loads(sys.argv[1])


def load(weights):
    """A tokenizer and a model in float32, since published half-precision weights quantize the logits."""
    source, revision = weights["source"], weights.get("revision") or None
    tokenizer = AutoTokenizer.from_pretrained(source, revision=revision)
    model = AutoModelForCausalLM.from_pretrained(source, revision=revision, dtype=torch.float32).eval()
    return tokenizer, model


def blocks(model):
    """The model's transformer blocks, whatever the architecture calls them."""
    count = model.config.num_hidden_layers
    for module in model.modules():
        if isinstance(module, torch.nn.ModuleList) and len(module) == count:
            return module
    raise SystemExit("The model's blocks could not be found, so there is no layer to read or patch.")


def final_norm(model):
    """The normalization applied before the unembedding: the last norm module of the base model."""
    found = [module for module in model.base_model.modules() if "Norm" in type(module).__name__]
    if not found:
        raise SystemExit("The model has no final normalization to read the residual stream through.")
    return found[-1]


@torch.no_grad()
def read(tokenizer, model, hidden, expected_id):
    """One value per token at every layer: the log-probability of the expected token read from that layer's residual
    stream, or the residual stream's norm when there is nothing expected."""
    norm, unembed = final_norm(model), model.get_output_embeddings()
    layers = []
    for layer, state in enumerate(hidden):
        if expected_id is None:
            values = state[0].norm(dim=-1)
        else:
            # The final hidden state has already passed through the model's final normalization.
            normalized = state if layer == len(hidden) - 1 else norm(state)
            values = torch.log_softmax(unembed(normalized)[0], dim=-1)[:, expected_id]
        layers.append({"layer": layer, "values": [round(value, 4) for value in values.tolist()]})
    return layers


def patched_run(model, encoded, layer, donor):
    """The model on the input with the residual stream leaving `layer` replaced by `donor`."""

    def replace(module, inputs, result):
        return (donor,) + tuple(result[1:]) if isinstance(result, tuple) else donor

    handle = blocks(model)[layer].register_forward_hook(replace)
    try:
        with torch.no_grad():
            return model(**encoded, output_hidden_states=True)
    finally:
        handle.remove()


@torch.no_grad()
def block_residuals(model, encoded):
    """Captures actual block outputs before final normalization, including the last block.
    hidden_states[-1] is already normalized and cannot be transplanted into a block's output hook."""
    states = {}

    def remember(layer):
        def capture(module, inputs, result):
            states[layer] = (result[0] if isinstance(result, tuple) else result).detach().clone()
        return capture

    handles = [block.register_forward_hook(remember(layer)) for layer, block in enumerate(blocks(model))]
    try:
        model(**encoded, use_cache=False)
    finally:
        for handle in handles:
            handle.remove()
    return states


def last_token(tokenizer, logits, expected_id):
    """What the model ends on, and how likely the expected token is there."""
    final = torch.log_softmax(logits[0, -1], dim=-1)
    return tokenizer.decode(logits[0, -1].argmax()), (round(final[expected_id].item(), 4) if expected_id is not None else None)


def first_token(tokenizer, text):
    """The token a word starts with, or None when there is no word."""
    return tokenizer(text, add_special_tokens=False).input_ids[0] if text else None


def logit_margin(logits, expected_id, alternative_id):
    """How far the expected token is ahead of the alternative at the end, or None without both."""
    if expected_id is None or alternative_id is None:
        return None
    final = logits[0, -1]
    return round((final[expected_id] - final[alternative_id]).item(), 4)


def sweep(tokenizer, model, request):
    """Every sample at every layer: the residual stream leaving that layer taken from the source model, and what the
    target then ends on. Both models are loaded once."""
    asked = request["sweep"]
    _, source = load(asked["source"])
    layers = asked.get("layers") or list(range(model.config.num_hidden_layers))
    samples = []
    for item in asked["samples"]:
        encoded = tokenizer(item["input"], return_tensors="pt")
        expected = item.get("expected")
        expected_id = first_token(tokenizer, expected)
        alternative_id = first_token(tokenizer, item.get("alternative"))
        with torch.no_grad():
            plain = model(**encoded, output_hidden_states=True)
            donor = block_residuals(source, encoded)
        top, likelihood = last_token(tokenizer, plain.logits, expected_id)
        by_layer = []
        for layer in layers:
            layer = int(layer)
            if donor[layer].shape != plain.hidden_states[layer + 1].shape:
                raise SystemExit("The two models' residual streams differ in shape, so one cannot be patched into the other.")
            patched = patched_run(model, encoded, layer, donor[layer])
            patched_top, patched_likelihood = last_token(tokenizer, patched.logits, expected_id)
            by_layer.append({"layer": layer, "top": patched_top, "expectedLogProb": patched_likelihood, "margin": logit_margin(patched.logits, expected_id, alternative_id)})
        samples.append({"sampleId": item["sampleId"], "expected": expected, "alternative": item.get("alternative"), "top": top, "expectedLogProb": likelihood, "margin": logit_margin(plain.logits, expected_id, alternative_id), "byLayer": by_layer})
    json.dump({"sourceModelId": asked.get("modelId"), "targetModelId": request.get("modelId"), "layers": layers, "samples": samples}, sys.stdout)


def main():
    tokenizer, model = load(request["target"])
    if "sweep" in request:
        sweep(tokenizer, model, request)
        return
    encoded = tokenizer(request["input"], return_tensors="pt")
    tokens = [tokenizer.decode([token]) for token in encoded.input_ids[0].tolist()]
    expected = request.get("expected")
    expected_id = tokenizer(expected, add_special_tokens=False).input_ids[0] if expected else None
    measure = f"log-probability of {expected!r} at each layer" if expected else "residual stream norm at each layer"

    with torch.no_grad():
        output = model(**encoded, output_hidden_states=True)
    answer = {
        "sampleId": request["sampleId"],
        "modelId": request.get("modelId"),
        "measure": measure,
        "tokens": tokens,
        "layers": read(tokenizer, model, output.hidden_states, expected_id),
        "top": tokenizer.decode(output.logits[0, -1].argmax()),
        "patched": None,
    }

    patch = request.get("patch")
    if patch:
        layer = int(patch["layer"])
        _, source = load(patch["source"])
        with torch.no_grad():
            donor = block_residuals(source, encoded)[layer]
        if donor.shape != output.hidden_states[layer + 1].shape:
            raise SystemExit("The two models' residual streams differ in shape, so one cannot be patched into the other.")
        patched = patched_run(model, encoded, layer, donor)
        answer["patched"] = {
            "layer": layer,
            "sourceModelId": patch.get("modelId"),
            "layers": read(tokenizer, model, patched.hidden_states, expected_id),
            "top": tokenizer.decode(patched.logits[0, -1].argmax()),
        }

    save = request.get("save")
    if save:
        # The raw residual stream, one array per layer, for probes and directions to be trained on outside this helper.
        import numpy
        import os
        os.makedirs(os.path.dirname(save) or ".", exist_ok=True)
        arrays = {f"layer_{index}": state[0].float().cpu().numpy() for index, state in enumerate(output.hidden_states)}
        if patch:
            arrays.update({f"patched_layer_{index}": state[0].float().cpu().numpy() for index, state in enumerate(patched.hidden_states)})
        numpy.savez(save, tokens=numpy.array(tokens), **arrays)
        answer["saved"] = {"path": save, "layers": len(output.hidden_states), "shape": list(output.hidden_states[0][0].shape)}

    json.dump(answer, sys.stdout)


if __name__ == "__main__":
    main()
