"""What a Saturn experiment program needs to write its records right, in one file with no dependencies.

Copy this file into the project (Saturn hands it out as the template `saturn_run`) and import it from an experiment's
program. It reads the SATURN_RUN_* variables Saturn sets, and writes the records Saturn reads: sample lines, training
metrics, the program's report about itself, checkpoints and artifacts. Every write is one whole JSON line, flushed, so
a stopped run keeps what was finished. Outside a Saturn run (no SATURN_RUN_SAMPLES), it writes to ./saturn-run/ so the
program can be tried by hand.

    from saturn_run import Run
    run = Run()
    seed = run.seed()                      # the version's first seed, applied to random/numpy/torch and reported
    run.report("model", source="huggingface", id=name, revision=model.config._commit_hash)
    for example in examples:
        run.sample(example["id"], input=example["prompt"], output=answer, scores={"correct": ok}, expected=example["answer"])
    run.metric(step, loss=0.42)
    run.checkpoint(run.output / "step-100", step=100)
"""
from __future__ import annotations

import json
import os
import pathlib
import signal
import sys
import threading
import time

SCHEMA_VERSION = 1
ERROR_KINDS = ("infrastructure", "model", "scorer")


class Run:
    """One experiment run: where its records go, and the writers for each kind."""

    def __init__(self) -> None:
        samples = os.environ.get("SATURN_RUN_SAMPLES")
        if samples:
            self.directory = pathlib.Path(os.environ.get("SATURN_RUN_DIRECTORY") or pathlib.Path(samples).parent)
            self.output = pathlib.Path(os.environ.get("SATURN_RUN_OUTPUT") or self.directory / "written")
            self.samples_path = pathlib.Path(samples)
            self.metrics_path = pathlib.Path(os.environ.get("SATURN_RUN_METRICS") or self.directory / "metrics.jsonl")
            self.artifacts_path = pathlib.Path(os.environ.get("SATURN_RUN_ARTIFACTS") or self.directory / "artifacts.jsonl")
            self.report_path = pathlib.Path(os.environ.get("SATURN_RUN_REPORT") or self.directory / "report.jsonl")
            self.in_saturn = True
        else:
            self.directory = pathlib.Path("saturn-run")
            self.output = self.directory / "written"
            self.samples_path = self.directory / "samples.jsonl"
            self.metrics_path = self.directory / "metrics.jsonl"
            self.artifacts_path = self.directory / "artifacts.jsonl"
            self.report_path = self.directory / "report.jsonl"
            self.in_saturn = False
        self.output.mkdir(parents=True, exist_ok=True)
        self.run_id = os.environ.get("SATURN_RUN_ID")
        self.version_id = os.environ.get("SATURN_RUN_VERSION")
        # What a resumed run takes over: the checkpoint to restore and the run it continues.
        self.resume_from = os.environ.get("SATURN_RESUME_FROM") or None
        self.resumes_run = os.environ.get("SATURN_RESUME_RUN") or None
        self.resumes_directory = os.environ.get("SATURN_RESUME_DIRECTORY") or None
        self._lock = threading.Lock()
        self._identities: set[tuple[str, int, str | None]] = set()
        self._stop_handlers: list = []
        self.stopping = False
        self._load_finished()

    # Records ---------------------------------------------------------------------------------------------------------

    def sample(self, sample_id: str, *, trial: int = 0, model_id: str | None = None, error: dict | None = None, **fields) -> dict:
        """Writes one sample line. `scores` is a dict by scorer name; `error` is None or {"kind", "message"}."""
        if not sample_id or not isinstance(sample_id, str):
            raise ValueError("sampleId must be a non-empty string")
        if error is not None and error.get("kind") not in ERROR_KINDS:
            raise ValueError(f"error.kind must be one of {ERROR_KINDS}")
        identity = (sample_id, int(trial), model_id)
        with self._lock:
            if identity in self._identities:
                raise ValueError(f"sample {sample_id} trial {trial} model {model_id} was already written in this run")
            self._identities.add(identity)
        line = {"schemaVersion": SCHEMA_VERSION, "sampleId": sample_id, "trial": int(trial), "error": error, **fields}
        if model_id is not None:
            line["modelId"] = model_id
        line.setdefault("scores", {})
        self._append(self.samples_path, line)
        return line

    def finished(self, sample_id: str, *, trial: int = 0, model_id: str | None = None) -> bool:
        """Whether a resumed run already holds this sample, so the program can skip it."""
        return (sample_id, int(trial), model_id) in self._identities

    def metric(self, step: int, **values) -> None:
        """One training metric line: the step and its values (loss, learning rate, whatever the curve should show)."""
        self._append(self.metrics_path, {"schemaVersion": SCHEMA_VERSION, "step": int(step), "values": values})

    def report(self, kind: str, **fields) -> None:
        """What the program says about itself: kind seed, model, config or resume. Unreported stays unknown in Saturn."""
        self._append(self.report_path, {"kind": kind, **fields})

    def checkpoint(self, path: str | os.PathLike, *, step: int | None = None, **metadata) -> None:
        """Lists a saved checkpoint for resuming; the newest listed is what a resume restores by default."""
        entry = {"kind": "checkpoint", "path": self._relative(path)}
        if step is not None:
            entry["step"] = int(step)
        if metadata:
            entry["metadata"] = metadata
        self._append(self.artifacts_path, entry)

    def artifact(self, path: str | os.PathLike, kind: str = "json", **metadata) -> None:
        """Lists an output (figure, json, notebook, document) for `artifacts_from_run` to keep with its hash."""
        entry = {"kind": kind, "path": self._relative(path)}
        if metadata:
            entry["metadata"] = metadata
        self._append(self.artifacts_path, entry)

    # Seeds and stopping ----------------------------------------------------------------------------------------------

    def seed(self, default: int | None = None) -> int | None:
        """The version's first seed (SATURN_RUN_SEED), or `default`, applied to the libraries present and reported."""
        raw = os.environ.get("SATURN_RUN_SEED")
        value = int(raw) if raw not in (None, "") else default
        if value is None:
            return None
        applied = []
        import random

        random.seed(value)
        applied.append("python")
        try:
            import numpy

            numpy.random.seed(value % (2**32))
            applied.append("numpy")
        except ImportError:
            pass
        try:
            import torch

            torch.manual_seed(value)
            applied.append("torch")
        except ImportError:
            pass
        self.report("seed", value=value, applied=applied)
        return value

    def seeds(self) -> list[int]:
        """Every seed the version names (SATURN_RUN_SEEDS), for a program that runs them all."""
        raw = os.environ.get("SATURN_RUN_SEEDS", "")
        return [int(part) for part in raw.split(",") if part.strip()]

    def on_stop(self, handler) -> None:
        """Calls `handler()` when Saturn stops the run (SIGTERM), so work in hand can be saved; `run.stopping` is set."""
        self._stop_handlers.append(handler)
        if len(self._stop_handlers) == 1:
            def stop(_signal, _frame):
                self.stopping = True
                for registered in self._stop_handlers:
                    registered()
                sys.exit(143)

            signal.signal(signal.SIGTERM, stop)

    # Inside --------------------------------------------------------------------------------------------------------------

    def _append(self, path: pathlib.Path, record: dict) -> None:
        text = json.dumps(record, ensure_ascii=False, default=_plain)
        if "\n" in text:
            raise ValueError("a record is one line")
        with self._lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "a", encoding="utf-8") as out:
                out.write(text + "\n")
                out.flush()
                os.fsync(out.fileno())

    def _relative(self, path: str | os.PathLike) -> str:
        """A checkpoint or artifact path as Saturn reads it: relative to the run's folder when it lies inside it."""
        given = pathlib.Path(path)
        try:
            return given.resolve().relative_to(self.directory.resolve()).as_posix()
        except ValueError:
            return given.as_posix()

    def _load_finished(self) -> None:
        """The identities already in the samples file: a resumed run's carried samples, which it must not write again."""
        try:
            with open(self.samples_path, encoding="utf-8") as lines:
                for line in lines:
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(record, dict) and "sampleId" in record:
                        self._identities.add((record["sampleId"], int(record.get("trial", 0)), record.get("modelId")))
        except FileNotFoundError:
            pass


def _plain(value):
    """JSON for what json does not know: numpy and torch scalars by their value, paths by their text."""
    if hasattr(value, "item"):
        return value.item()
    if isinstance(value, os.PathLike):
        return os.fspath(value)
    raise TypeError(f"{type(value).__name__} is not JSON")


if __name__ == "__main__":
    # A trial by hand: writes one sample, one metric and a report into ./saturn-run/ (or the run's folder in Saturn).
    run = Run()
    run.report("config", resolved={"tried": "by hand", "at": time.time()})
    run.sample("example-1", input="2 + 2", output="4", scores={"correct": True}, expected="4")
    run.metric(1, loss=1.0)
    print(f"wrote to {run.directory}")
