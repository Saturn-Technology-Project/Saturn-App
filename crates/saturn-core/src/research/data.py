# Prints a Parquet or Arrow file, or a Hugging Face dataset folder, one JSON line per row, so that the runtime can read it
# like any other table. It goes to the project's Python on standard input, with the request as its argument. The first line
# says what was opened, or {"missing": "datasets"} when that package cannot be imported. Nothing is fetched: it reads what
# is on disk, offline.
import itertools
import json
import math
import os
import sys

# A project's own folder called datasets must not stand in for the package.
sys.path = [entry for entry in sys.path if entry not in ("", ".", os.getcwd())]
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_DATASETS_OFFLINE"] = "1"


def plain(value):
    """A value that JSON can say: no bare NaN, and bytes by their size."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, (bytes, bytearray)):
        return f"<{len(value)} bytes>"
    if isinstance(value, dict):
        return {str(key): plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(item) for item in value]
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    return str(value)


def opened(datasets, ask):
    """The table asked for, and every split it could have been."""
    path, kind = ask["path"], ask["kind"]
    if kind in ("parquet", "arrow"):
        return datasets.load_dataset(kind, data_files=path, split="train", streaming=True), []
    names = os.listdir(path)
    if "dataset_dict.json" in names or "state.json" in names:
        found = datasets.load_from_disk(path)
    else:
        found = datasets.load_dataset(path, streaming=True)
    if not hasattr(found, "keys"):
        return found, []
    splits = list(found.keys())
    wanted = ask.get("split") or splits[0]
    if wanted not in found:
        raise SystemExit(f"This dataset has no split called {wanted}. It has: {', '.join(splits)}.")
    return found[wanted], splits


def main():
    ask = json.loads(sys.argv[1])
    try:
        import datasets
    except ImportError:
        print(json.dumps({"missing": "datasets"}), flush=True)
        return
    datasets.disable_progress_bars()
    table, splits = opened(datasets, ask)
    split = (ask.get("split") or splits[0]) if splits else None
    columns = list(table.column_names or [])
    print(json.dumps({"columns": columns, "splits": splits, "split": split}), flush=True)
    start = ask.get("start") or 0
    count = ask.get("count")
    for row in itertools.islice(table, start, None if count is None else start + count):
        sys.stdout.write(json.dumps(plain(row)) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
