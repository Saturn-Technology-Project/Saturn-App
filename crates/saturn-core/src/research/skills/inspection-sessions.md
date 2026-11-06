---
name: inspection-sessions
description: Explore a model on prompts of your own without a scored run, and keep what you read. Read when looking inside a model before there is an experiment to run.
---
# Inspection sessions

Interpretability often starts before there is an evaluation. A session keeps which models and which Python you explored with, so the readings stay attached to what produced them.

## Open one
`research_inspect` with `action: "session"`, `modelIds` (1 to 32 project models; record them first with `research_write` in `models`), a `title`, and `cwd` if the helpers live in a subfolder. It records the configured Python. It creates no run and no score.

Open a new session when the models or the interpreter change. Pinning a Python path does not freeze its packages or floating weights.

## Read inside it
`research_inspect` with `sessionId` in place of `runId`:
- `action: "compare"`: two models on one prompt, and their difference.
- `action: "prompts"`: a clean prompt patched into a corrupted one at every layer and position, beside a random control.
- `action: "features"`: one layer through a sparse autoencoder.

`research_read` with `what: "session_inside"`, `session` lists what the session read. The readings and their limits are the same as on a run: see `activation-reading`, `activation-patching` and `sparse-autoencoders`.

## Keep the outputs
Figures, analysis JSON and notebook snapshots can be kept with the session: `research_evidence` with `action: "artifact_register"` and `inspectionId`. See `analysis-outputs`.

## From exploration to a claim
A session is exploration. Before a claim about a model, turn it into an experiment with fixed prompts and a scorer, freeze it, and run it. See `experiment-program`.
