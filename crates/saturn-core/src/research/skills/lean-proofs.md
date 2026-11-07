---
name: lean-proofs
description: Check Lean 4 proofs as runs, evaluate a model that writes them, and accept only what the checker accepts without sorry or new axioms. Read before any formal proof or autoformalization work.
---
# Lean proofs

A proof Lean accepts is the one kind of result that needs no scorer validation: the checker is the scorer. Everything
around it still does: the statement must mean what was asked, and the proof must not smuggle in what it proves.

## The toolchain
- Lean 4 comes with elan and lake, and Mathlib as a lake dependency. Neither is a Python package, so
  `research_environment_action` does not install them, but `action: "check"` reports whether `elan`, `lake` and `lean`
  are on the interpreter's PATH and which versions: check before promising a run. Ask the person to install elan, and
  record the lean-toolchain file and `lake-manifest.json` in `inputs.environment`, so the version freezes with the
  experiment.
- Mathlib's compiled cache is large and slow to build. `lake exe cache get` fetches it once; the sandbox lets a run
  write the shared caches and the project's `.lake` folder only when it is a linked, uncontrolled folder. Build the
  cache before the first run, as a check, not inside the run.
- A run's command is `lake env lean <file>` or `lake build <target>`, by absolute path to `lake` when the shell's
  `PATH` is bare, as on an SSH host. See `environment-setup` and `remote-runs`.

## Checking a proof as a run
One sample per theorem or file: `sampleId` is the declaration's name, `scores.accepted` is whether `lean` exited 0
with no error, and `scores.sorry` and `scores.axioms` come from reading the output. `error.kind: "infrastructure"` is
for a toolchain or timeout failure, not a wrong proof. The checker's messages go to `SATURN_RUN_OUTPUT`, one file per
sample, so a failure can be read: `research_read { what: "output", run }` lists them and, with `path`, reads one.
Give each check a time limit (`timeout` in the command, or `maxHeartbeats` in the
file) and record it; a proof that times out is not refuted.

## What acceptance does not show
- **`sorry`** compiles with a warning. Count every `sorry` as not proved, whatever the exit code.
- **Axioms**: end each file with `#print axioms <name>`, and accept only `propext`, `Classical.choice` and `Quot.sound`
  unless the study says otherwise. A new `axiom` or an `unsafe` definition proves anything.
- **The statement**: a model asked to formalize a theorem may state something weaker, vacuous or different. Read the
  statement against the informal one, and check it is not trivially true (`exact?` finds a one-line proof; a hypothesis
  that is `False`; a conclusion already an assumption). Keep a `statementOk` label, by a person who reads Lean.
- **Decidability and `native_decide`**: a proof by `native_decide` trusts the compiler. Count it apart.
- **Timeouts and heartbeats** are limits on this machine, not facts about the theorem.

## Evaluating a model that writes proofs
- The task set is a declared data file of statements with their informal versions and a known-difficulty tag;
  miniF2F and ProofNet are the usual public ones, so check contamination and say so: see `data-leakage-audit`.
- One sample per statement and attempt; `trial` is the attempt, so pass@k is read from the summary without rerunning.
  Record the model's full output in `output` and the checker's verdict in `scores`, with `scorerLabel` `Proved`,
  `Sorry`, `Rejected`, `Timeout` in the experiment's `labels`.
- Pin the model's revision, the sampling settings and the Lean and Mathlib versions in `evaluation`: a theorem that
  Mathlib later names is easier the next month. Compare two models on the same set with `what: "paired"`: see
  `paired-comparisons`.
- A proof search that calls the model many times is an agent: budget steps and tokens, log the search to
  `SATURN_RUN_OUTPUT`, and read `agentic-evals`.
- Never let the model edit the statement, the imports or the `#print axioms` line. Generate the proof body into a
  template the program owns, and check the file the program wrote, not one the model wrote.

## Report
Proved counts per difficulty tag with intervals and n, `sorry` and axiom rejections counted separately, statements a
person judged wrong, and the toolchain versions. A proof accepted by Lean is a proof of the statement as written, on
this toolchain; say which. See `recording-findings` and `statistics-for-comparisons`.
