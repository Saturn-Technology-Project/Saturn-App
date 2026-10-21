# @saturn-app/sdk

Drive the Saturn running on this computer from code: start agent runs, follow their steps as they happen,
answer approvals, read what changed. It talks to Saturn's local HTTP API with the runtime token, like the
desktop app, Saturn IDE and the `saturn` CLI; it starts nothing itself, so Saturn must be open.

Dependency-free TypeScript; Node 18 or later.

```ts
import { Saturn } from "@saturn-app/sdk";

const saturn = new Saturn();
const run = await saturn.run("add a --verbose flag and test it", {
  agent: "Saturn",               // name or id; optional when there is one agent
  project: "/path/to/repo",      // a Saturn project folder (or its id)
  mode: "agent",                 // "ask" and "plan" only read
  onStep: (step) => console.log(step.toolId, step.status),
  onApproval: (step) => false,   // answer steps that wait for approval; leave out to get the run back waiting
});
console.log(run.status, run.output);
console.log((await saturn.changes(run.id)).files.map((file) => file.path));
```

| Call | What it does |
|---|---|
| `run(prompt, options)` | Starts a run and waits for it to settle (or to wait for an approval it has no answer for). |
| `start(prompt, options)` | Starts a run and returns at once. |
| `stream(runId)` | An async iterator of the whole run each time it changes, until it settles. |
| `wait(runId, { onStep, onApproval })` | Follows a run to the end, answering approvals. |
| `decide(runId, actionId, allow)` | Allows or denies a step that waits. |
| `stop(runId)`, `getRun(runId)`, `changes(runId)`, `runs(limit)` | As named. |
| `agents()`, `projects()` | What Saturn has. |

`new Saturn({ baseUrl, token, dataDir })` overrides where it connects: by default `http://127.0.0.1:4700`
(or `SATURN_RUNTIME_PORT`) and the token in `~/.saturn-app/runtime-token` (or `SATURN_RUNTIME_TOKEN`,
`SATURN_DATA_DIR`). Errors are `SaturnError`, with the HTTP `status` when Saturn answered.

An agent on Claude (via Claude Code), a personal plan, is refused: Anthropic's terms allow automated access
to Claude only with an API key. Use an agent on an API model.

Build with `npm run build`; test with `npm test` (starts a real runtime from this repository with a scripted
model, so it spends nothing).
