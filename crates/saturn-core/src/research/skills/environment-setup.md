---
name: environment-setup
description: Create, check and pin the project's Python environment with the right kits. Read before writing any experiment.
---
# Environment setup

## Look first
```
research_read { what: "environment" }
research_environment_action { action: "check" }
```
The check reports the interpreter, package versions, processors and the devices torch sees. Use what exists when it is adequate.

## Make one
```
research_environment_action { action: "create", python: "3.12", withCore: true, timeoutSeconds: 1800 }
```
It makes `.venv` with `uv` when present, else `python3 -m venv`. A version needs `uv`. `withCore` installs torch, transformers and numpy, which Saturn's helpers need.

Add what the study needs:
```
research_environment_action { action: "install", kit: "training" }
```
| Kit | Packages |
|---|---|
| `core` | torch, transformers, numpy |
| `interpretability` | transformer_lens, sae_lens, einops |
| `training` | trl, peft, datasets, accelerate |
| `analysis` | pandas, matplotlib |
| `notebooks` | jupyter, ipykernel |

Or name them: `packages: ["wandb==0.17.0"]`. Install only what you need; nothing goes in unasked.

These are jobs and return at once. One job at a time per project. Follow with `research_read { what: "environment" }`: `job.status` and `job.logTail`. A large torch download can exceed the default 30 minutes; set `timeoutSeconds` higher rather than retrying.

## Check before trusting
After installing, run `check`. Confirm the device you expect is there. A run that silently fell back to CPU wastes the budget.

## Pin it
Keep a lock file at the project root: `uv.lock`, `requirements.lock` or similar. Name it in `inputs.environment` so it freezes with the version, and a changed environment becomes a new version.

## In the command
Start the experiment's command with the interpreter's path, for example `.venv/bin/python probe.py`. Looking inside models uses that interpreter, and a command that starts otherwise is refused. In a task, see `task-worktrees`.

Installs reach the package index directly and are not in Saturn's network log. Say so in the report if that matters.
