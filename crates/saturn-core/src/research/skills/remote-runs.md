---
name: remote-runs
description: Run a frozen experiment on the SSH host the person configured, leave it going, and follow it. Read when a run needs a machine other than this computer.
---
# Remote runs

Saturn can start a frozen version on an existing Linux or macOS host over SSH and follow it while Saturn is closed. It does not provision machines or copy the project there.

## What is the person's
The host itself: its address, working folder and worker program, set in Environment, with the person's own SSH configuration and host keys. You never set or change it, and you never handle SSH keys or passwords. If no host is configured, say what you would run there and ask the person to set one.

## Before starting
1. `research_read` with `what: "remote"`: the configured host, and the remote runs so far.
2. `research_remote` with `action: "check"`: connects and checks Saturn's worker and the working folder. Read its answer before anything else.
3. The code, data, Python and packages must already be in the remote folder, at the commit you mean. The remote command runs with the system `PATH`: name programs by absolute path, such as the project's `.venv/bin/python`.

## Start and follow
- Freeze first: `research_run` with `action: "freeze"`. See `freeze-and-run`.
- `research_remote` with `action: "start"`, `version`, `attempt` and `timeoutSeconds` (up to 7 days). It returns at once.
- Follow it with `research_wait`, as a local run. A disconnected worker may still be computing: its status says so.
- Stop it with `research_run` and `action: "stop"`. The stop stays pending until the worker acknowledges it.
- A new `attempt` is a new run. A run that was lost on the host is reported as interrupted and never started again on its own.

## What a remote run proves
It is qualified by the working folder and git commit the worker saw there, not certified identical to the local frozen files. Say where it ran in any finding. Outputs come back by bounded synchronization with hash checks; a resume checkpoint reaches the program as `SATURN_RESUME_FROM`, and the program must load its own state.
