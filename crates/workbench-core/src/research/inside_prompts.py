

MOST_TOKENS = 64
CONTROL_SEED = 0


def encode_within_limit(tokenizer, text):
    """A prompt as the model takes it, refused when one sweep over it would take too long."""
    encoded = tokenizer(text, return_tensors="pt")
    if encoded.input_ids.shape[1] > MOST_TOKENS:
        raise SystemExit(f"A prompt here has at most {MOST_TOKENS} tokens; this one has {encoded.input_ids.shape[1]}.")
    return encoded


def spelled(tokenizer, encoded):
    """A prompt's tokens as text."""
    return [tokenizer.decode([token]) for token in encoded.input_ids[0].tolist()]


def compare():
    """Two models read on the same prompt, layer by layer, for a difference that means the same thing in each cell."""
    tokenizer, model = load(request["target"])
    other_tokenizer, other = load(request["other"])
    encoded = encode_within_limit(tokenizer, request["input"])
    other_encoded = encode_within_limit(other_tokenizer, request["input"])
    if encoded.input_ids.tolist() != other_encoded.input_ids.tolist():
        raise SystemExit("The two models split this prompt into different tokens, so their layers cannot be compared cell by cell.")
    expected = request.get("expected")
    expected_id = first_token(tokenizer, expected)
    with torch.no_grad():
        output = model(**encoded, output_hidden_states=True)
        other_output = other(**encoded, output_hidden_states=True)
    measure = f"log-probability of {expected!r} at each layer" if expected else "residual stream norm at each layer"
    json.dump({
        "modelId": request["modelId"],
        "otherModelId": request["otherModelId"],
        "measure": measure,
        "tokens": spelled(tokenizer, encoded),
        "layers": read(tokenizer, model, output.hidden_states, expected_id),
        "otherLayers": read(tokenizer, other, other_output.hidden_states, expected_id),
        "top": tokenizer.decode(output.logits[0, -1].argmax()),
        "otherTop": tokenizer.decode(other_output.logits[0, -1].argmax()),
    }, sys.stdout)


def with_position(model, encoded, layer, position, value):
    """The model on the input with one position of the residual stream leaving `layer` replaced by `value`."""

    def replace(module, inputs, result):
        state = (result[0] if isinstance(result, tuple) else result).clone()
        state[0, position] = value
        return (state,) + tuple(result[1:]) if isinstance(result, tuple) else state

    handle = blocks(model)[layer].register_forward_hook(replace)
    try:
        with torch.no_grad():
            return model(**encoded, use_cache=False)
    finally:
        handle.remove()


def prompts():
    """The corrupted prompt run with each layer and position restored from the clean one in turn, and how much of the
    margin between them comes back. The control puts in a random vector of the same size as the difference at the same
    place, so a cell is read against what any change of that size does."""
    tokenizer, model = load(request["target"])
    clean = encode_within_limit(tokenizer, request["clean"])
    corrupted = encode_within_limit(tokenizer, request["corrupted"])
    if clean.input_ids.shape != corrupted.input_ids.shape:
        raise SystemExit(f"The prompts must have the same number of tokens to be patched position by position: {clean.input_ids.shape[1]} and {corrupted.input_ids.shape[1]}.")
    expected_id = first_token(tokenizer, request["expected"])
    alternative_id = first_token(tokenizer, request["alternative"])
    if expected_id == alternative_id:
        raise SystemExit("The expected word and its alternative start with the same token, so no margin separates them.")
    with torch.no_grad():
        clean_output = model(**clean, use_cache=False)
        corrupted_output = model(**corrupted, use_cache=False)
    clean_margin = logit_margin(clean_output.logits, expected_id, alternative_id)
    corrupted_margin = logit_margin(corrupted_output.logits, expected_id, alternative_id)
    gap = clean_margin - corrupted_margin
    if abs(gap) < 1e-3:
        raise SystemExit("The two prompts give the same margin, so there is nothing to bring back.")
    clean_states = block_residuals(model, clean)
    corrupted_states = block_residuals(model, corrupted)
    generator = torch.Generator().manual_seed(CONTROL_SEED)
    layers = [int(layer) for layer in request.get("layers") or range(model.config.num_hidden_layers)]
    recovery, control = [], []
    for layer in layers:
        recovered, controlled = [], []
        for position in range(clean.input_ids.shape[1]):
            donor = clean_states[layer][0, position]
            base = corrupted_states[layer][0, position]
            patched = with_position(model, corrupted, layer, position, donor)
            recovered.append(round((logit_margin(patched.logits, expected_id, alternative_id) - corrupted_margin) / gap, 4))
            direction = torch.randn(donor.shape, generator=generator)
            noise = direction / direction.norm() * (donor - base).norm()
            noised = with_position(model, corrupted, layer, position, base + noise)
            controlled.append(round((logit_margin(noised.logits, expected_id, alternative_id) - corrupted_margin) / gap, 4))
        recovery.append(recovered)
        control.append(controlled)
    json.dump({
        "modelId": request["modelId"],
        "tokens": spelled(tokenizer, clean),
        "corruptedTokens": spelled(tokenizer, corrupted),
        "expected": request["expected"],
        "alternative": request["alternative"],
        "cleanMargin": clean_margin,
        "corruptedMargin": corrupted_margin,
        "cleanTop": tokenizer.decode(clean_output.logits[0, -1].argmax()),
        "corruptedTop": tokenizer.decode(corrupted_output.logits[0, -1].argmax()),
        "layers": layers,
        "recovery": recovery,
        "control": control,
        "controlSeed": CONTROL_SEED,
    }, sys.stdout)


if request["action"] == "compare":
    compare()
else:
    prompts()
