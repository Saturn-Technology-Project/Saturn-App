---
name: transformer-lens-probes
description: Write custom interpretability experiments with hooks when the built-in inspection is not enough. Read for attention, neuron or input-pair patching.
---
# Custom probes

`research_inspect` covers reading, patching between models, patching between two prompts, and reading a prompt through a sparse autoencoder. For anything else, write an experiment. The `interpretability` kit has `transformer_lens`, `sae_lens` and `einops`.

## Loading
```python
from transformer_lens import HookedTransformer
model = HookedTransformer.from_pretrained_no_processing("gpt2", device=device, dtype=torch.float32)
logits, cache = model.run_with_cache(tokens)
```
`from_pretrained_no_processing` keeps weights as they are; `from_pretrained` centers and folds them, which changes values. To use your own checkpoint: load it with transformers, and pass `hf_model=` with the base architecture's name. Verify by comparing logits with the plain model on a few inputs. They should agree closely: if not, stop.

## Input-pair patching
Within one model, take a clean and a corrupted prompt with the same token length, and patch a hook point from clean into corrupted:
```python
def patch(activation, hook, position):
    activation[:, position] = clean_cache[hook.name][:, position]
    return activation
patched = model.run_with_hooks(corrupted, fwd_hooks=[(name, partial(patch, position=p))])
```
Measure the logit difference, normalized: `(patched - corrupted) / (clean - corrupted)`. 0 means no effect, and 1 means full recovery.

## Good practice
- **Metric first**: logit difference over probability, since it is less saturated.
- **Matched pairs**: same length and aligned positions. Check tokenization, and name tokens with a leading space.
- **Many pairs**: per-position heatmaps averaged over a set, with spread.
- **Mean ablation can mislead**: name the baseline you ablate to. Zero ablation pushes the model off its distribution.
- **Direct logit attribution** shows what writes to the logits, and not what it depends on. Combine with patching.

## As a run
Use the same sample line format: each pair is a `sampleId`, with the result in `scores`. Larger outputs such as heatmaps go in `SATURN_RUN_DIRECTORY`. See `experiment-program`. Keep `torch.inference_mode()` on and the cache small: full caches take a lot of memory, so use `names_filter`.
