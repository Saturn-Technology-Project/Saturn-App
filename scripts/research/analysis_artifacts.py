"""Keep Python analysis outputs with a Saturn run, using ordinary files and JSONL, without an SDK.

Import publish from this file in a training/analysis script. Save a plot, JSON result or notebook under
SATURN_RUN_DIRECTORY first, then publish its relative path. In Saturn choose Import run artifact manifest.
Large activation caches or SAE weights can instead use publish_reference. Neither function contacts Saturn.
"""

import json
import os
from pathlib import Path


def publish(relative_path, kind="json", **metadata):
    """Append one analysis output to the run's plain artifact manifest; Rust validates and snapshots it on import."""
    root = Path(os.environ["SATURN_RUN_DIRECTORY"]).resolve()
    source = (root / relative_path).resolve()
    source.relative_to(root)
    entry = {"path": str(source.relative_to(root)), "kind": kind, "metadata": metadata}
    _append(entry)


def publish_reference(uri, **metadata):
    """Describe a large external store without copying or downloading its contents."""
    _append({"kind": "reference", "uri": uri, "metadata": metadata})


def _append(entry):
    """Write one complete JSONL line so an interrupted script leaves earlier entries readable."""
    with open(os.environ["SATURN_RUN_ARTIFACTS"], "a", encoding="utf-8") as output:
        output.write(json.dumps(entry, ensure_ascii=False) + "\n")
