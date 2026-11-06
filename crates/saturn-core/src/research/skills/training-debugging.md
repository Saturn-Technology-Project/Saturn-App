---
name: training-debugging
description: Diagnose loss that is NaN, flat, exploding or too good. Read when training misbehaves.
---
# Debugging training

Change one thing at a time. Return to overfitting one batch (`training-smoke-test`), since it separates bugs from tuning.

Read the curve before guessing: a program that appends `{"schemaVersion":1,"step":100,"values":{"loss":2.1}}` lines to `SATURN_RUN_METRICS` can be read with `research_read`, `what: "metrics"`, `run`, 200 events at a time from `cursor`. A Trainer state brought in with `importing-results` reads the same way.

| Sign | Likely causes | Check |
|---|---|---|
| NaN or inf | Learning rate too high; fp16 overflow; log of zero; bad data | `torch.autograd.set_detect_anomaly(True)` on a short run; try full precision; lower the rate |
| Loss flat near `ln(V)` | Weights frozen; labels misaligned; optimizer missing parameters; gradients zero | Parameter gradient norms; that the optimizer holds the parameters |
| Loss falls then explodes | Learning rate too high after warmup; no clipping | Log gradient norm; clip at 1.0; halve the rate |
| Loss near zero very fast | Leak: input contains labels; labels not shifted | Decode a batch; see `data-leakage-audit` |
| Good train, bad validation | Overfitting, or a distribution difference | Compare validation with a sample of train data, scored the same way |
| Good loss, bad generation | Padding side; EOS missing; different template at generation | Read generated text; see `tokenizer-and-format` |
| Sudden jump at a checkpoint | Resume lost the optimizer or schedule | Compare stopped and unstopped runs |
| Slow | Data loading; CPU fallback | Time the loader; check the device; read the GPU line in resources |

## Log what tells you
Loss, gradient norm, learning rate, tokens per second, memory. As scores on your step lines, so you can read them while it runs.

## Compare with something known
Load a known-good configuration for this architecture, or a tiny task with a known answer. If that also fails, the bug is in your framework code.

## Limit yourself
After two failed fixes, write down what you tried and what it showed. See `run-failures`.
