---
name: starting-tasks
description: Hand part of the work to another agent in its own worktree, and follow it. Read before starting a task.
---
# Starting tasks

A task is another agent working on its own, in a separate git worktree and branch, while you carry on. Use it like a colleague you give a piece of work to.

```
research_task_start { prompt: "..." }                  → task, branch
research_task_read { what: "wait", task, seconds: 600 } → status, answer, waitingForThePerson, changedFiles
research_task_read { what: "status", task }
research_task_read { what: "list" }
```

## When to start one
- Work that is separate and long: a training arm, a cleanup, a side investigation.
- Work whose code you may not want to keep. Nothing reaches the project until the person merges it.
- Work that can go on beside what you are doing.

Do it yourself when it is short, when you need the answer before your next step anyway, or when it would change the same files as you.

## Write the prompt for someone who was not here
The task does not see this chat. Say what to do, why, which files and record ids matter, what done looks like, and what to report back. A vague prompt gets a vague result.

## Sharing a device
Research records are shared, and so is the machine. Two trainings at once slow each other down, and one may run out of memory. See `gpu-and-memory`. Do not start several heavy runs because you can.

## What comes back
- `status` and `answer`: what it did and said. Treat the answer as a report to check, not as a fact: read its records.
- `waitingForThePerson`: it is stopped until the person answers. You cannot answer for them. Tell them plainly which task is waiting and for what.
- `changedFiles` and `branch`: what merging would bring.

## Limits
- A task cannot start another task, and at most 4 run at once.
- It starts in Auto, or Agent if this chat is. It never asks less than the person chose.
- An Ask chat cannot start one, and in an Approve chat the person approves it first.
- Only the person merges or discards a task. Say what each branch holds in your hand-back. See `handing-back`.
