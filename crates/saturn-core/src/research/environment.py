"""Says what this Python is and what it has: its version, the packages research code leans on, and the devices torch
can see. Run by Saturn with the project's Python. The answer is one JSON object on standard output."""
import importlib.metadata
import json
import os
import platform
import sys

PACKAGES = ["torch", "transformers", "numpy", "datasets", "accelerate", "trl", "peft", "transformer_lens", "sae_lens", "einops", "jupyter_core"]


def version(name):
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def devices():
    """What torch can compute on, or why not."""
    try:
        import torch
    except Exception as error:  # noqa: BLE001 - whatever stops torch is the answer
        return {"torch": None, "reason": f"torch could not be imported: {error}"}
    found = {"torch": torch.__version__, "cuda": torch.cuda.is_available(), "cudaDevices": [], "mps": False}
    if found["cuda"]:
        found["cudaDevices"] = [torch.cuda.get_device_name(index) for index in range(torch.cuda.device_count())]
    backends = getattr(torch, "backends", None)
    found["mps"] = bool(backends and hasattr(backends, "mps") and backends.mps.is_available())
    return found


json.dump({
    "executable": sys.executable,
    "version": platform.python_version(),
    "platform": platform.platform(),
    "cpus": os.cpu_count(),
    "packages": {name: version(name) for name in PACKAGES},
    "devices": devices(),
}, sys.stdout)
