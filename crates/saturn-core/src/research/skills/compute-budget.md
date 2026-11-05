---
name: compute-budget
description: Estimate and keep to a budget of time, memory and money. Read before any long run or API-backed evaluation.
---
# Compute budget

## Know what you have
`research_environment_action { action: "check" }` for devices. Then estimate from a measurement, not a guess:

1. Run a few steps and time them. See `training-smoke-test`.
2. `total time ≈ seconds per step × steps + evaluation time × evaluations`.
3. Add half again for what goes wrong.

## Keep to it
- If the estimate exceeds the budget, shrink first: a smaller model, fewer steps, a sample of the data. Say what that costs in what the answer can claim.
- Set a time limit in the program, so it saves and exits on its own.
- `research_wait` returns resource readings while a run lives: elapsed time, processor, memory, GPU, samples. Check that speed matches the estimate early. If it is far off, stop and find out why: `research_run { action: "stop", run }`.

## Money
- Running a hosted model through an API, or using an API model for your own turns, costs the person money. Saturn does not cap it.
- Before a large evaluation on a paid API, compute `samples × (input + output tokens) × price`, and ask if the person set no budget.
- Report `usage` on sample lines, so the summary shows tokens per model.

## Stopping
Stopping a run keeps its complete samples. If a run is failing, stop it rather than letting it finish. Spending the whole budget on one attempt is the commonest way to end with nothing, so plan a pilot, the main run, and one retry.
