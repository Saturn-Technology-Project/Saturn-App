

import contextlib
import re

MOST_TOKENS = 64
TOP_FEATURES = 8
CONTROL_SEED = 0
KIT = "Install the Interpretability kit on the Environment screen."


class Refused(Exception):
    """A reason the request cannot be answered, for the person to read. Nothing is saved for it."""


def load_sae(asked):
    """The SAE a request names, from SAELens's releases or a folder of its own, on the CPU like the model."""
    try:
        from sae_lens import SAE
    except ModuleNotFoundError as error:
        if error.name != "sae_lens":
            raise Refused(f"sae_lens could not be loaded in this project's Python, since it needs {error.name}. {KIT}") from error
        raise Refused(f"sae_lens is not installed in this project's Python. {KIT}") from error
    except ImportError as error:
        raise Refused(f"sae_lens could not be loaded in this project's Python: {error}. {KIT}") from error
    try:
        if asked.get("path"):
            return SAE.load_from_disk(asked["path"], device="cpu")
        loaded = SAE.from_pretrained(asked["release"], asked["id"], device="cpu")
    except Exception as error:
        where = asked.get("path") or f"{asked.get('release')} / {asked.get('id')}"
        raise Refused(f"The SAE {where} could not be loaded: {error}") from error
    # Older versions answer with the SAE, its configuration and its sparsity.
    return loaded[0] if isinstance(loaded, tuple) else loaded


def sae_setting(sae, name):
    """A setting of the SAE, which newer versions of SAELens keep in the configuration's metadata."""
    configuration = sae.cfg
    metadata = getattr(configuration, "metadata", None)
    found = getattr(metadata, name, None) if metadata is not None else None
    return found if found is not None else getattr(configuration, name, None)


def layer_of_hook(hook_name):
    """The layer whose outgoing residual stream a hook point reads, counted as a patch counts: the stream entering
    block 8 is the one leaving layer 7. None when the hook point is not that stream."""
    found = re.fullmatch(r"blocks\.(\d+)\.hook_resid_(pre|post)", hook_name or "")
    if not found:
        return None
    return int(found[1]) - 1 if found[2] == "pre" else int(found[1])


def check_fit(sae, model, layer):
    """Refuses an SAE that was not made for this residual stream, since its features would mean nothing here."""
    count = model.config.num_hidden_layers
    if not 0 <= layer < count:
        raise Refused(f"This model has layers 0 to {count - 1}; layer {layer} does not exist.")
    hook_name = sae_setting(sae, "hook_name")
    read = layer_of_hook(hook_name)
    if read is None:
        raise Refused(f"This SAE reads {hook_name}, which is not a residual stream between blocks, so it cannot be spliced in here.")
    if read < 0:
        raise Refused(f"This SAE reads {hook_name}, the embeddings before the first block, which no layer here leaves.")
    if read != layer:
        raise Refused(f"This SAE reads {hook_name}, the residual stream leaving layer {read}, but layer {layer} was asked for.")


def check_width(sae, state):
    """Refuses an SAE whose input does not have the residual stream's width."""
    width = sae.cfg.d_in
    if width != state.shape[-1]:
        raise Refused(f"This SAE takes activations {width} wide, but this model's residual stream is {state.shape[-1]} wide, so the SAE was made for another model.")


def encode_prompt(tokenizer, text, wants_bos):
    """A prompt as the model takes it, with the start token the SAE was trained on, and whether it had to be added.
    Refused when it is too long."""
    encoded = tokenizer(text, return_tensors="pt")
    first = encoded.input_ids[0, 0].item() if encoded.input_ids.shape[1] else None
    added = bool(wants_bos) and tokenizer.bos_token is not None and first != tokenizer.bos_token_id
    if added:
        encoded = tokenizer(tokenizer.bos_token + text, return_tensors="pt")
    if encoded.input_ids.shape[1] > MOST_TOKENS:
        raise Refused(f"A prompt here has at most {MOST_TOKENS} tokens; this one has {encoded.input_ids.shape[1]}.")
    return encoded, added


def ordinary_tokens(tokenizer, encoded):
    """Which tokens are the prompt's words rather than a start token and the like. The residual stream at a start token
    is far outside what an SAE is trained to rebuild, and SAELens's own evaluation leaves such tokens out too."""
    special = torch.tensor(tokenizer.all_special_ids, dtype=encoded.input_ids.dtype)
    kept = ~torch.isin(encoded.input_ids, special)
    if not kept.any():
        raise Refused("This prompt has only special tokens, so there is nothing for an SAE to read.")
    return kept


def splice_of(sae, activations, state, kept):
    """The residual stream rebuilt from these activations, with special tokens left as they were."""
    return torch.where(kept.unsqueeze(-1), sae.decode(activations).to(state.dtype), state)


def reconstruction_quality(state, rebuilt, activations, kept):
    """How well the SAE rebuilds the prompt's words in the residual stream. Variance is taken over this prompt's own
    tokens, so a short prompt gives a rough number, and none with a single token."""
    original, remade = state[kept], rebuilt[kept]
    error = (original - remade).pow(2).sum()
    spread = (original - original.mean(dim=0, keepdim=True)).pow(2).sum()
    return {
        "varianceExplained": round((1 - error / spread).item(), 4) if spread > 0 else None,
        "relativeError": round((error.sqrt() / original.norm()).item(), 4),
        "meanActiveFeatures": round((activations[kept] != 0).sum(dim=-1).float().mean().item(), 2),
        "tokensLeftOut": int((~kept).sum().item()),
    }


def strongest_per_token(activations):
    """The strongest firing features at each token, each with its activation."""
    values, features = activations[0].topk(min(TOP_FEATURES, activations.shape[-1]), dim=-1)
    return [
        [{"feature": feature, "activation": round(value, 4)} for feature, value in zip(token_features, token_values) if value > 0]
        for token_features, token_values in zip(features.tolist(), values.tolist())
    ]


def control_feature(peaks, chosen):
    """A random other feature firing about as strongly on this prompt: within a factor of two, or else the closest one.
    None when no other feature fires."""
    peak = peaks[chosen].item()
    firing = [feature for feature in (peaks > 0).nonzero().flatten().tolist() if feature != chosen]
    if not firing:
        return None
    similar = [feature for feature in firing if peak / 2 <= peaks[feature].item() <= peak * 2]
    pool = similar or [min(firing, key=lambda feature: abs(peaks[feature].item() - peak))]
    generator = torch.Generator().manual_seed(CONTROL_SEED)
    return pool[torch.randint(len(pool), (1,), generator=generator).item()]


def ablate(activations, margin_of, feature, spliced_margin):
    """What setting one feature to zero at every token does to the margin, against the reconstruction it is part of and
    beside a control."""
    width = activations.shape[-1]
    if not 0 <= feature < width:
        raise Refused(f"This SAE has features 0 to {width - 1}; feature {feature} does not exist.")
    peaks = activations[0].max(dim=0).values
    if peaks[feature] <= 0:
        raise Refused(f"Feature {feature} does not fire on this prompt, so setting it to zero changes nothing.")

    def effect(item):
        changed = activations.clone()
        changed[..., item] = 0
        margin = margin_of(changed)
        return {"feature": item, "activation": round(peaks[item].item(), 4), "margin": margin, "change": round(margin - spliced_margin, 4)}

    control = control_feature(peaks, feature)
    return {**effect(feature), "control": effect(control) if control is not None else None, "controlSeed": CONTROL_SEED}


def wants_centering(sae):
    """Whether the SAE was trained on weights centered by TransformerLens. Its training never saw the mean over a token's
    dimensions, so even a small one fires features at random. A model's LayerNorms ignore that mean, so removing it
    changes nothing the model does."""
    settings = sae_setting(sae, "model_from_pretrained_kwargs") or {}
    return bool(settings.get("center_writing_weights"))


@torch.no_grad()
def features():
    """The residual stream at one layer on one prompt, through an SAE: the strongest features per token and how well it
    was rebuilt, and, when asked, what setting a feature to zero does to the margin between two words."""
    sae = load_sae(request["sae"])
    tokenizer, model = load(request["target"])
    layer = int(request["layer"])
    check_fit(sae, model, layer)
    encoded, bos_added = encode_prompt(tokenizer, request["prompt"], sae_setting(sae, "prepend_bos"))
    kept = ordinary_tokens(tokenizer, encoded)
    expected, alternative = request.get("expected"), request.get("alternative")
    ids = (first_token(tokenizer, expected), first_token(tokenizer, alternative))
    if expected and ids[0] == ids[1]:
        raise Refused("The expected word and its alternative start with the same token, so no margin separates them.")

    plain = model(**encoded, use_cache=False)
    stream = block_residuals(model, encoded)[layer]
    check_width(sae, stream)
    centered = wants_centering(sae)
    offset = stream.mean(dim=-1, keepdim=True) if centered else torch.zeros_like(stream)
    state = stream - offset
    activations = sae.encode(state.to(next(sae.parameters()).dtype))
    activations[~kept] = 0

    def margin_of(chosen):
        """The margin with the residual stream rebuilt from these activations spliced in."""
        return logit_margin(patched_run(model, encoded, layer, splice_of(sae, chosen, state, kept) + offset).logits, *ids)

    margins, ablation = None, None
    if expected:
        plain_margin = logit_margin(plain.logits, *ids)
        spliced_margin = margin_of(activations)
        margins = {"plain": plain_margin, "spliced": spliced_margin, "spliceChange": round(spliced_margin - plain_margin, 4)}
        if request.get("ablate") is not None:
            ablation = ablate(activations, margin_of, int(request["ablate"]), spliced_margin)

    return {
        "modelId": request["modelId"],
        "layer": layer,
        "tokens": [tokenizer.decode([token]) for token in encoded.input_ids[0].tolist()],
        "top": tokenizer.decode(plain.logits[0, -1].argmax()),
        "sae": {
            "release": request["sae"].get("release"),
            "id": request["sae"].get("id"),
            "path": request["sae"].get("path"),
            "hookName": sae_setting(sae, "hook_name"),
            "width": sae.cfg.d_sae,
            "trainedOn": sae_setting(sae, "model_name"),
            "startTokenAdded": bos_added,
            "centered": centered,
        },
        "reconstruction": reconstruction_quality(state, splice_of(sae, activations, state, kept), activations, kept),
        "features": strongest_per_token(activations),
        "expected": expected,
        "alternative": alternative,
        "margins": margins,
        "ablation": ablation,
    }


# Libraries may print while they load, and standard output carries only the answer.
try:
    with contextlib.redirect_stdout(sys.stderr):
        answer = features()
except Refused as reason:
    answer = {"refused": str(reason)}
json.dump(answer, sys.stdout)
