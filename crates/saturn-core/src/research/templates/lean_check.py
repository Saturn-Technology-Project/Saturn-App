"""Check Lean 4 files with `lake env lean`, one sample per file, counting sorry, native_decide and axioms beyond the standard three.

    python3 lean_check.py --project path/to/lake/project --timeout 300 proofs/*.lean
    python3 lean_check.py --project . --lake /home/me/.elan/bin/lake --check-axioms proofs/*.lean
The files are declared in the experiment's `inputs.data`; the project is the lake project whose `lean-toolchain` and
`lake-manifest.json` pin Lean and Mathlib (build the Mathlib cache before the first run, not inside it). Each file is one
sample named after the file, with scores `accepted` (exit 0 and no error), `sorry` (declarations using sorry),
`native_decide` (uses of native_decide in the source) and `axioms` (axioms outside propext, Classical.choice and
Quot.sound), and `scorerLabel` Proved, Sorry, Rejected or Timeout. With --check-axioms, a copy of the file ending in
`#print axioms` for each theorem is what gets checked, written under the run's output; the checker's messages are saved
there too, one file per sample. A timeout is an infrastructure error: the theorem is not refuted.
What to change: ALLOWED_AXIOMS if the study admits more, DECLARATION if your files declare theorems another way.
"""
from __future__ import annotations

import argparse
import pathlib
import re
import subprocess
import sys

from saturn_run import Run

# Change here: the axioms a proof may depend on; anything else is counted and the sample is Rejected.
ALLOWED_AXIOMS = {"propext", "Classical.choice", "Quot.sound"}
# Change here: how a declaration to print axioms for is recognised in the source.
DECLARATION = re.compile(r"^(?:theorem|lemma)\s+([\w.'₀-₉]+)", re.MULTILINE)
ERROR_LINE = re.compile(r"^.+?:\d+:\d+: error", re.MULTILINE)
SORRY_LINE = re.compile(r"declaration uses 'sorry'")
AXIOMS_LINE = re.compile(r"'([^']+)' depends on axioms: \[([^\]]*)\]")


def toolchain(lake: str, project: pathlib.Path) -> dict:
    """The versions in play: `lean --version` through lake, the lean-toolchain file and the manifest's Mathlib revision."""
    version = subprocess.run([lake, "env", "lean", "--version"], cwd=project, capture_output=True, text=True, timeout=120)
    pinned = (project / "lean-toolchain").read_text(encoding="utf-8").strip() if (project / "lean-toolchain").exists() else None
    manifest = project / "lake-manifest.json"
    mathlib = None
    if manifest.exists():
        found = re.search(r'"name":\s*"mathlib".*?"rev":\s*"([0-9a-f]+)"', manifest.read_text(encoding="utf-8"), re.DOTALL)
        mathlib = found.group(1) if found else None
    return {"lean": version.stdout.strip() or version.stderr.strip(), "leanToolchain": pinned, "mathlibRev": mathlib}


def with_axiom_prints(source: str, target: pathlib.Path) -> pathlib.Path:
    """A copy of the file with `#print axioms` for every theorem appended, the program's own line the model never edits."""
    names = DECLARATION.findall(source)
    lines = [source.rstrip("\n"), ""] + [f"#print axioms {name}" for name in names]
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return target


def check(run: Run, lake: str, project: pathlib.Path, file: pathlib.Path, timeout: float, check_axioms: bool) -> None:
    """One file: run the checker, read its output, save it, write the sample."""
    sample_id = file.stem
    if run.finished(sample_id):
        return
    source = file.read_text(encoding="utf-8")
    checked = with_axiom_prints(source, run.output / "checked" / file.name) if check_axioms else file
    log = run.output / "checker" / f"{sample_id}.txt"
    log.parent.mkdir(parents=True, exist_ok=True)
    try:
        result = subprocess.run([lake, "env", "lean", str(checked.resolve())], cwd=project, capture_output=True, text=True,
                                timeout=timeout)
    except subprocess.TimeoutExpired as expired:
        log.write_text(f"timed out after {timeout}s\n{expired.stdout or ''}{expired.stderr or ''}", encoding="utf-8")
        run.artifact(log, "document")
        run.sample(sample_id, input=source, scorerLabel="Timeout", scores={"accepted": False, "timeoutSeconds": timeout},
                   error={"kind": "infrastructure", "message": f"lean did not finish within {timeout}s"})
        return
    output = (result.stdout or "") + (result.stderr or "")
    log.write_text(f"exit {result.returncode}\n{output}", encoding="utf-8")
    run.artifact(log, "document")
    accepted = result.returncode == 0 and not ERROR_LINE.search(output)
    sorry = len(SORRY_LINE.findall(output))
    native = len(re.findall(r"\bnative_decide\b", source))
    axioms_by_name = {name: [axiom.strip() for axiom in found.split(",") if axiom.strip()]
                      for name, found in AXIOMS_LINE.findall(output)}
    # sorryAx is what `sorry` depends on; the sorry score counts it, so it is not a new axiom here.
    extra = sorted({axiom for axioms in axioms_by_name.values() for axiom in axioms} - ALLOWED_AXIOMS - {"sorryAx"})
    if not accepted:
        label = "Rejected"
    elif sorry:
        label = "Sorry"
    elif extra:
        label = "Rejected"
    else:
        label = "Proved"
    run.sample(sample_id, input=source, output=output[:20000], scorerLabel=label,
               scores={"accepted": accepted, "sorry": sorry, "native_decide": native, "axioms": len(extra)},
               metadata={"axioms": axioms_by_name, "disallowedAxioms": extra, "checkerLog": log.name})
    print(f"{sample_id}: {label}", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("files", nargs="+", help="Lean files to check")
    parser.add_argument("--lake", default="lake", help="path to lake when the shell's PATH is bare")
    parser.add_argument("--project", default=".", help="the lake project whose environment checks the files")
    parser.add_argument("--timeout", type=float, default=300, help="seconds per file")
    parser.add_argument("--check-axioms", action="store_true", help="append #print axioms per theorem and read them")
    arguments = parser.parse_args()
    run = Run()
    run.seed()
    project = pathlib.Path(arguments.project)
    try:
        versions = toolchain(arguments.lake, project)
    except (FileNotFoundError, subprocess.TimeoutExpired) as problem:
        print(f"cannot run {arguments.lake} in {project}: {problem}", file=sys.stderr)
        return 2
    run.report("config", **versions, lake=arguments.lake, project=str(project.resolve()), timeoutSeconds=arguments.timeout,
               checkAxioms=arguments.check_axioms, allowedAxioms=sorted(ALLOWED_AXIOMS))
    files = [pathlib.Path(name) for name in arguments.files]
    for file in files:
        if not file.exists():
            run.sample(file.stem, scores={"accepted": False}, error={"kind": "infrastructure", "message": f"{file} is missing"})
            continue
        check(run, arguments.lake, project, file, arguments.timeout, arguments.check_axioms)
    return 0 if files else 1


if __name__ == "__main__":
    sys.exit(main())
