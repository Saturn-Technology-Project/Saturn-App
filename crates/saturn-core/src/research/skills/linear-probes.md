---
name: linear-probes
description: Train linear probes on activations to test whether a property is linearly readable at a layer, with held-out splits and controls. Read before claiming a model represents something.
---
# Linear probes

A probe is a small classifier trained on a layer's activations to predict a property of the input. Above chance, it shows the property is linearly readable there. It does not show the model reads it.

## Getting activations
`research_template` with `name: "probe_train"` trains the probes below in numpy from saved activations, with the shuffled-label and random-direction controls, one sample per held-out example. Start from it.

- `research_inspect` with `action: "activations"` gives one value per token per layer on a run's sample, read through the logit lens, which helps choose a layer. With `save: "activations/<sampleId>.npz"` it also keeps the raw residual stream of every layer (`layer_<n>`, tokens × hidden, with `tokens`) at that project path, hashed in the answer. One call per sample; for hundreds of samples a hook script in a run is quicker.
- For many samples or chosen positions, write a hook script that saves the residual stream. The `interpretability` kit has `transformer_lens`; `run_with_cache` with `names_filter` keeps memory down. See `transformer-lens-probes`.
- Declare the saved arrays in the probe experiment's `inputs.data`, so they freeze with the version and the run can read them in the sandbox. Arrays a run writes go under `SATURN_RUN_OUTPUT`, never in sample lines; register them with `research_evidence` action `artifacts_from_run`, or as a `reference` when they are too large to keep. See `analysis-outputs`.

## Layer and position
- Sweep layers rather than picking one: train the same probe at every layer and plot accuracy by layer.
- Position: the last token, the token carrying the property, or a mean over tokens. Say which, since they answer different questions, and a mean over tokens can read the property from the input's surface form.
- Use the residual stream leaving each block, so layer numbers match `activation-patching`.

## Splits
- Split by example before extracting anything. Held-out examples must share no template, source document or entity with training ones where the property could be inferred from those.
- Fit the probe and any normalization on the training split only.
- Logistic regression with its regularization chosen on a validation split is enough. A stronger probe finds more and says less about the model.

## Controls
Run these in the same run, as scorers beside the real probe:
- **Shuffled labels**: the same probe on permuted labels. It should sit at chance; if it does not, the split leaks. See `data-leakage-audit`.
- **Random direction**: project onto a random unit vector and fit a threshold. Its accuracy is the floor a trained direction must clear.
- **Input alone**: a bag-of-tokens classifier on the text, with no model. If it matches the probe, the probe reads the surface form.
- **Layer 0**: the embedding. Accuracy there is what token identity alone gives.

## As a run
One sample line per held-out example: `sampleId` the example's id, `expected` the label, and `scores` keyed by layer and control (`correct_layer_8`, `prob_layer_8`, `shuffled_layer_8`), so `research_read` with `what: "summary"` gives accuracy per scorer and a comparison between layers stays paired by sample. Write the per-layer accuracies with bootstrap intervals and n to a JSON file under `SATURN_RUN_OUTPUT` and register it. See `experiment-program`.

## Reporting
- Accuracy per layer with an interval and n, on the same plot as the controls. See `statistics-for-comparisons`.
- Accuracy rises with depth for most properties, so a late peak alone means little. Where it first clears the controls, and by how much, matters more.
- A probe shows the information is linearly present at that layer. It does not show the model uses it, or uses that direction. To test use, intervene: add or remove the probe's direction and measure behavior. See `steering-vectors` and `activation-patching`.

## Record
A finding names the run, the layer, the position rule, the split rule, the probe type, n and the controls' numbers. "Linearly decodable at layer 8 (0.91, interval and n given; shuffled labels 0.52)" is what was measured. "The model represents X at layer 8" is more than this measures. See `recording-findings`.
