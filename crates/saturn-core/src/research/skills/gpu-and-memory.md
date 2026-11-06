---
name: gpu-and-memory
description: Fit training and inference on the available device, and measure what it uses. Read on out-of-memory errors or slow runs.
---
# Device and memory

## Know the device
`research_environment_action { action: "check" }` reports CUDA and MPS. In the program, choose explicitly and print it. Do not fall back to CPU silently: fail, or say so.

```python
device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
```

## On out of memory
In order of cost:
1. Lower the batch size, and add gradient accumulation to keep the effective size.
2. Use mixed precision: `torch.autocast`. On MPS it is less mature, so check for NaN.
3. Turn on gradient checkpointing, and turn off `use_cache` when you do.
4. Shorten sequences. Memory is roughly linear in length, attention time worse.
5. For inference, use `torch.inference_mode()` and do not keep logits and caches between batches. Move results to CPU.
6. Evaluate with a smaller batch than you train.
7. Use a smaller model, or LoRA for fine-tuning.

Catch out-of-memory on a sample during evaluation, and record it with `error.kind: "infrastructure"`, so that it is not counted as a model failure. Empty the cache before continuing.

## Apple silicon
Memory is shared, so the system's pressure limits you. Some operations fall back or are missing: `PYTORCH_ENABLE_MPS_FALLBACK=1` trades speed for working, and is worth naming in `envNames`. float64 is not available. Results differ slightly from CUDA.

## Measure and report
Report `usage.deviceMemoryBytes` on sample lines:
```python
memory = torch.cuda.max_memory_allocated() if device == "cuda" else torch.mps.current_allocated_memory() if device == "mps" else None
```
The summary keeps the highest. Resources shows processor and memory for the process group, and GPU use where `nvidia-smi` exists. Low GPU use with a busy CPU usually means data loading is the bottleneck.

## Parallelism
Do not run two heavy runs on one device unless you measured they fit: both will slow down, and one may die.
