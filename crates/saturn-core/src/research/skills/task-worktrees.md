---
name: task-worktrees
description: How a task's git worktree relates to the project's records, runs and merging. Read when working as a task.
---
# Working as a task

A task runs in its own git worktree and branch. An Auto or Agent chat that is not a task works on the project itself.

## What is where
- **Code**: your edits are in the worktree. The project's checkout does not see them until the person merges.
- **Records**: questions, experiments, runs and findings are in the project's `.saturn/research`, shared with every chat, whichever chat made them. They are visible at once.
- **Freezing and running**: use this chat's folder. A version frozen here holds your worktree's code, and a run happens in the worktree.

## What follows
- Freeze and run from the task, so that a version holds the code you meant.
- A run holds its worktree: the task cannot be discarded while it runs.
- A version records the git commit and every uncommitted and untracked file, so committing is not needed to reproduce. Commit anyway at each milestone, so the person can read the branch as a story.
- Write outputs to `SATURN_RUN_OUTPUT`: a sandboxed run cannot write its worktree. See `checkpoints-and-lineage`.
- Environments are made at the project's root, in `.venv`, and shared. A task's worktree has no `.venv` of its own, so read `what: "environment"` for the interpreter's absolute path and start the command with it.

## Merging
You do not merge. At the end, say what is on the branch, what reaches the project if it is merged, and that results stay either way since records are shared. See `handing-back`.
