---
name: activation-reading
description: Read what each layer says on a sample with research_inspect, and interpret it within its limits. Read before claiming where something happens in a model.
---
# Reading activations

```
research_inspect { action: "activations", runId, sampleId, modelId }
```
It answers with `tokens`, and `layers` with one value per token at each layer, read from the residual stream leaving that layer. Layer 0 is the embedding. `top` is the token the model ends on. The result is saved with the run.

## What the value is
- With `expected` on the sample line: the log-probability of `expected`'s first token, read through the final norm and the unembedding. It is a logit lens.
- Without one: the residual stream's norm, which says far less.

So write `expected` on sample lines when you plan to look inside.

## Requirements
The experiment's command must start with a Python path, and that environment needs `torch` and `transformers`. Weights load as float32 in the version's working folder. Helpers load plain transformers models, so merge any LoRA first. It is not available on Windows.

## Reading it
- Where the expected token's probability rises tells you where the answer becomes readable by this lens.
- That is not where it is computed. Later layers may read a signal earlier layers wrote in a form the lens cannot see.
- Early layers read poorly through the final unembedding. A low value there means little.
- Compare the same sample across models and across correct and failed samples, and read several. One sample is an anecdote.

Then test causally: see `activation-patching`. A reading shows correlation only.
