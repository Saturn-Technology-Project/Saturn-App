"""A minimal torch training loop that Saturn can follow by its metrics, stop, and resume from its checkpoints.

How to use: declare the text file in the experiment's `inputs.data`, then run
    python3 train_loop.py --data data/train.txt --model tiny --steps 2000
    python3 train_loop.py --smoke
`--model tiny` builds a small byte-level transformer here; any other value is loaded with AutoModelForCausalLM and its
tokenizer. `--smoke` runs a few steps of the tiny model on this file's own text, to prove the pipeline before the real
run. AdamW with linear warmup and cosine decay, gradient clipping at 1.0. It writes a metric line (loss, lr, tokens_seen)
every `--log-every` steps, a sample `eval-step-<n>` with score `loss` on a fixed held-out batch every `--eval-every`
steps, and a checkpoint folder `step-<n>` (model, optimizer, scheduler, step, and the state of every random generator in
use: Python's, NumPy's, torch's CPU one and each CUDA device's; saved atomically and listed with `run.checkpoint`) every
`--checkpoint-every` steps and when stopped. A resume restores all of it from `SATURN_RESUME_FROM` and reports exactly
what it restored. On CPU a resumed run then goes on as the uninterrupted one would have; on CUDA some kernels are not
deterministic, so the two agree only to within those kernels' noise unless `torch.use_deterministic_algorithms(True)`
is set. What to change: the model in `build`, the batch sampling in the loop, and the defaults below.
"""
import argparse
import math
import os
import pathlib
import random
from types import SimpleNamespace

import numpy as np

from saturn_run import Run

# Change here: training defaults; the command line overrides them, and --smoke shrinks them.
DEFAULTS = {"steps": 1000, "batch": 8, "seq": 128, "lr": 3e-4, "warmup": 50, "log_every": 10, "eval_every": 100, "checkpoint_every": 250}
SMOKE = {"steps": 30, "batch": 4, "seq": 32, "lr": 1e-3, "warmup": 5, "log_every": 5, "eval_every": 10, "checkpoint_every": 15}
HELD_OUT_SHARE = 0.1


def arguments():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", default=None, help="a UTF-8 text file; --smoke falls back to this script's own text")
    parser.add_argument("--model", default="tiny", help="tiny, or a transformers causal language model name")
    parser.add_argument("--smoke", action="store_true", help="a few steps of the tiny model, to prove the pipeline")
    for name, value in DEFAULTS.items():
        parser.add_argument(f"--{name.replace('_', '-')}", type=type(value), default=None)
    args = parser.parse_args()
    for name in DEFAULTS:
        if getattr(args, name) is None:
            setattr(args, name, (SMOKE if args.smoke else DEFAULTS)[name])
    return args


def build(name, device):
    """The model and its tokenizer (None for the byte-level tiny model), on the device."""
    try:
        import torch
        from torch import nn
    except ImportError as error:
        raise SystemExit("train_loop.py needs torch: pip install torch") from error
    if name != "tiny":
        from transformers import AutoModelForCausalLM, AutoTokenizer
        return AutoModelForCausalLM.from_pretrained(name).to(device), AutoTokenizer.from_pretrained(name)

    class Tiny(nn.Module):
        """A two-block causal transformer over bytes, small enough for a laptop CPU."""
        def __init__(self, vocab=256, width=64, positions=1024):
            super().__init__()
            self.embed, self.pos = nn.Embedding(vocab, width), nn.Embedding(positions, width)
            block = nn.TransformerEncoderLayer(width, 4, 4 * width, dropout=0.0, batch_first=True)
            self.blocks, self.head = nn.TransformerEncoder(block, 2), nn.Linear(width, vocab)

        def forward(self, input_ids, labels=None):
            length = input_ids.shape[1]
            states = self.embed(input_ids) + self.pos(torch.arange(length, device=input_ids.device))
            mask = nn.Transformer.generate_square_subsequent_mask(length, device=input_ids.device)
            logits = self.head(self.blocks(states, mask=mask, is_causal=True))
            loss = None if labels is None else nn.functional.cross_entropy(logits[:, :-1].reshape(-1, logits.shape[-1]), labels[:, 1:].reshape(-1))
            return SimpleNamespace(loss=loss, logits=logits)  # shaped like a transformers output, so the loop reads .loss either way

    return Tiny().to(device), None


def batch_at(ids, starts, seq, device):
    """Windows of seq + 1 tokens starting at `starts`, as a tensor; the +1 is for next-token labels."""
    import torch
    return torch.as_tensor(np.stack([ids[s : s + seq + 1] for s in starts]), device=device)


def generator_states():
    """The state of every random generator training draws from: Python's, NumPy's, torch's CPU one, and each CUDA device's
    (the batch sampling uses NumPy; dropout, initialization and CUDA kernels use torch's). `cuda` is None without CUDA."""
    import torch
    return {"python": random.getstate(), "numpy": np.random.get_state(), "torch": torch.get_rng_state(),
            "cuda": torch.cuda.get_rng_state_all() if torch.cuda.is_available() else None}


def restore_generators(saved):
    """Puts the saved generator states back; what was restored (`rng:cpu`, `rng:cuda`) and what could not be: CUDA state
    saved on another number of devices, or on a machine with CUDA when this one has none, is left alone and said so.
    A generator takes its state as a CPU byte tensor only, wherever `torch.load` mapped the checkpoint's tensors."""
    import torch
    random.setstate(saved["python"])
    np.random.set_state(saved["numpy"])
    torch.set_rng_state(saved["torch"].cpu())
    restored, not_restored = ["rng:cpu"], []
    cuda = saved.get("cuda")
    if cuda is not None:
        if torch.cuda.is_available() and len(cuda) == torch.cuda.device_count():
            torch.cuda.set_rng_state_all([state.cpu() for state in cuda])
            restored.append("rng:cuda")
        else:
            not_restored.append("rng:cuda")
    return restored, not_restored


def save_checkpoint(run, folder, model, optimizer, scheduler, step):
    """Everything a resume needs, written to a temporary folder and renamed, then listed for Saturn."""
    import torch
    if folder.exists():
        return
    temporary = folder.with_name(folder.name + ".tmp")
    temporary.mkdir(parents=True, exist_ok=True)
    torch.save({"model": model.state_dict(), "optimizer": optimizer.state_dict(), "scheduler": scheduler.state_dict(), "step": step,
                "rng": generator_states()}, temporary / "state.pt")
    os.replace(temporary, folder)
    run.checkpoint(folder, step=step)


def restore(run, model, optimizer, scheduler, device):
    """The checkpoint SATURN_RESUME_FROM names, put back into the model, optimizer, scheduler and generators, with a report
    naming each thing restored (and `notRestored` for what could not be); the step it was at."""
    import torch
    saved = torch.load(pathlib.Path(run.resume_from) / "state.pt", map_location=device, weights_only=False)
    for name, target in (("model", model), ("optimizer", optimizer), ("scheduler", scheduler)):
        target.load_state_dict(saved[name])
    generators, not_restored = restore_generators(saved["rng"])
    report = {"checkpoint": run.resume_from, "restored": ["weights", "optimizer", "scheduler", "step", *generators], "step": saved["step"]}
    if not_restored:
        report["notRestored"] = not_restored
    run.report("resume", **report)
    return saved["step"]


def main():
    args = arguments()
    run = Run()
    run.seed(default=0)
    import torch
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model, tokenizer = build(args.model, device)
    run.report("model", source="template" if args.model == "tiny" else "huggingface", id=args.model,
               revision=getattr(getattr(model, "config", None), "_commit_hash", None), parameters=sum(p.numel() for p in model.parameters()))
    text = pathlib.Path(args.data or __file__).read_text(encoding="utf-8")
    ids = np.frombuffer(text.encode("utf-8"), dtype=np.uint8).astype(np.int64) if tokenizer is None else np.asarray(tokenizer(text)["input_ids"])
    split = int(len(ids) * (1 - HELD_OUT_SHARE))
    room = max(len(ids) - split - args.seq - 1, 1)  # the held-out batch: consecutive windows of the tail, wrapping when short
    held_out = batch_at(ids[split:], [start % room for start in range(0, args.batch * args.seq, args.seq)], args.seq, device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.1)
    schedule = lambda step: step / max(args.warmup, 1) if step < args.warmup else 0.5 * (1 + math.cos(math.pi * (step - args.warmup) / max(args.steps - args.warmup, 1)))
    scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, schedule)
    state = {"step": restore(run, model, optimizer, scheduler, device) if run.resume_from else 0}
    run.report("config", resolved={name: getattr(args, name) for name in DEFAULTS} | {"model": args.model, "device": device, "tokens": len(ids)})

    def evaluate():
        """Loss on the fixed held-out batch, as a sample line Saturn's summary can follow."""
        model.eval()
        with torch.inference_mode():
            value = model(input_ids=held_out, labels=held_out).loss.item()
        model.train()
        if not run.finished(f"eval-step-{state['step']}"):
            run.sample(f"eval-step-{state['step']}", scores={"loss": value}, input=f"held-out batch {held_out.shape[0]} x {args.seq}")
        return value

    run.on_stop(lambda: save_checkpoint(run, run.output / f"step-{state['step']}", model, optimizer, scheduler, state["step"]))
    if state["step"] == 0:
        print(f"loss before training {evaluate():.3f} (ln(vocab) is the expectation for random weights)")
    while state["step"] < args.steps and not run.stopping:
        starts = np.random.randint(0, split - args.seq - 1, size=args.batch)
        batch = batch_at(ids, starts, args.seq, device)
        loss = model(input_ids=batch, labels=batch).loss
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        scheduler.step()
        state["step"] = step = state["step"] + 1
        if step % args.log_every == 0 or step == args.steps:
            run.metric(step, loss=loss.item(), lr=scheduler.get_last_lr()[0], tokens_seen=step * args.batch * args.seq)
        if step % args.eval_every == 0 or step == args.steps:
            print(f"step {step}: train loss {loss.item():.3f}, held-out loss {evaluate():.3f}")
        if step % args.checkpoint_every == 0 or step == args.steps:
            save_checkpoint(run, run.output / f"step-{step}", model, optimizer, scheduler, step)


if __name__ == "__main__":
    main()
