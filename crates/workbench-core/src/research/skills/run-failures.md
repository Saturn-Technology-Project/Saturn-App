---
name: run-failures
description: Diagnose failed, interrupted and protocol-error runs without repeating the same attempt. Read when a run did not complete.
---
# When a run fails

## By status
| Status | Meaning | First look |
|---|---|---|
| `failed` | Exit code not 0. Samples kept | `what: "log", stream: "stderr"` |
| `protocol_error` | A bad line, a repeated identity, a partial last line, or no valid line | The run's `problems`, with the line number |
| `interrupted` | The runtime stopped while it ran | Whether samples are complete; resume it |
| `stopped` | It was stopped | Who stopped it, and why |

## Common causes
- **Out of memory**: see `gpu-and-memory`. Do not just retry.
- **Protocol error, repeated identity**: `sampleId`, `trial` and `modelId` are not unique. Often a resume re-wrote samples, or several seeds share a `trial`.
- **Protocol error, partial line**: the process died mid-write, or did not write a final newline. Write whole lines and flush.
- **Import error**: wrong interpreter. Start the command with the environment's Python. See `environment-setup`.
- **File not found**: the command's `cwd`, or a path relative to the wrong folder. In a task, see `task-worktrees`.
- **409 on start**: an input changed since freezing. Freeze again.
- **Model download fails**: network or a gated repo. Say which, and stop that line: you cannot sign in on the person's behalf.

## The rule for retrying
1. Read the actual error before changing anything.
2. State the cause you believe, in one line, with the evidence.
3. Fix that, test on a tiny sample, then run again.
4. After two failed fixes of the same problem, stop. Record what you tried, and hand back.

A retry with nothing changed is only justified for a known transient cause, such as a network failure.

## Keep the failed runs
Do not hide them. They are part of the record, and a finding says why a run is invalid. An error line stays an error: never rewrite samples to make a run look clean, and never drop failures from a mean without saying so.

## Interrupted runs
A run left running when the runtime restarts becomes `interrupted`, and cannot go on as the same run. Resume it: a new run of the same version keeps the samples it finished, or restores its last checkpoint. For long training, write and list checkpoints, so that there is one to continue from. See `pause-and-resume` and `checkpoints-and-lineage`.
