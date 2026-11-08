---
name: remote-runs
description: Run a frozen experiment on the SSH host the person configured, leave it going, and follow it. Read when a run needs a machine other than this computer.
---
# Remote runs

Saturn can start a frozen version on an existing Linux or macOS host over SSH and follow it while Saturn is closed. It does not provision machines or copy the project there.

## What is the person's
The host itself: its address and working folder, set in Environment, with the person's own SSH configuration and host keys, and installing Saturn's worker there. You never set or change the host, never install anything on it, and never handle SSH keys or passwords. If no host is configured, say what you would run there and ask the person to set one.

## Before starting
1. `research_read` with `what: "remote"`: the configured host, and the remote runs so far.
2. `research_remote` with `action: "pair"`: whether this Saturn's worker is on the host. `state` is `ready`, `missing`, `wrong_version` (a worker of another Saturn, which refuses to run), `broken` or `unsupported` (only Linux on x86-64 or ARM, and Apple Silicon Macs). Anything but `ready`: tell the person, and ask them to press **Connect** and **Install worker** in Environment. `source` says where an install would take it from; `null` means this build of Saturn cannot install it, and the person installs saturn-server of the same version themselves.
3. `research_remote` with `action: "check"`: connects to the worker and checks the working folder. Read its answer before anything else.
4. The code, data, Python and packages must already be in the remote folder, at the commit you mean. The host checks every file the version holds before it runs anything: the frozen commit must be in the host's git, and each uncommitted file and declared input must match its hash. The remote command runs with the system `PATH`: name programs by absolute path, such as the project's `.venv/bin/python`.

## Start and follow
- Freeze first: `research_run` with `action: "freeze"`. See `freeze-and-run`.
- `research_remote` with `action: "start"`, `version`, `attempt` and `timeoutSeconds` (up to 7 days). It returns at once.
- Follow it with `research_wait`, as a local run. A disconnected worker may still be computing: its status says so.
- Stop it with `research_run` and `action: "stop"`. The stop stays pending until the worker acknowledges it.
- A new `attempt` is a new run. A run that was lost on the host is reported as interrupted and never started again on its own.

## When the host differs
A run whose host files differ is `failed` with `refused: true`, and its error names each file. Nothing ran. Do not
change the version's records: tell the person which files differ, and either they bring the host's folder to the
version (with git, say) or you freeze a new version from what should run.

## What a remote run proves
It ran from a snapshot the host built and checked against the version. `what: "evidence"` shows it, with
`executor: "ssh"`. That is what the host's worker recorded: Saturn here did not see the files itself. The host runs it
in its own sandbox when it has one (bubblewrap on Linux); `observed.sandbox` says whether it did, and why not if not.
Files written to `SATURN_RUN_OUTPUT` stay on the host, in the job's `written/` folder. Say where it ran in any finding. Outputs stream back over one SSH connection while the run goes on, with hash checks at the end; a resume checkpoint reaches the program as `SATURN_RESUME_FROM`, and the program must load its own state.
