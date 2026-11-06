// A research assistant's tools, on the runtime's own agent loop and on the programs: a whole study through them, and what they
// must never do. docs/research-contract.md says what an agent may do.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench, posixOnly, until, write } from "./files-support.mjs";
import { startWithPrograms, runToEnd } from "./programs.mjs";

let saturn;
before(async () => { saturn = await bench(); });
after(async () => { await saturn?.stop(); });

/** A project chat whose agent has the research tools. */
async function bed(files = {}) {
  const folder = await saturn.folder();
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(folder, name), content);
  const setup = await saturn.chat(folder, { mcpConnectionIds: ["research"] });
  return { ...setup, folder, route: `/projects/${setup.project.id}/research` };
}

/** One tool call and what came of it. */
async function call(setup, name, args) {
  const run = await setup.turn([[name, args]]);
  const action = run.actions.at(-1);
  assert.equal(action.status, "completed", action.reason);
  return action.result;
}

/** The same, for a call that must be refused. */
async function refused(setup, name, args) {
  const run = await setup.turn([[name, args]]);
  const action = run.actions.at(-1);
  assert.equal(action.status, "failed", JSON.stringify(action.result));
  return action.reason;
}

// A training program with no dependencies: fits y = 3x, writes a line per evaluation, and saves its weight.
const TRAIN = `
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
let weight = 0;
for (let step = 1; step <= 50; step += 1) {
  weight += 0.1 * (3 - weight);
  if (step % 10 === 0) appendFileSync(process.env.SATURN_RUN_SAMPLES, JSON.stringify({ schemaVersion: 1, sampleId: "step-" + step, input: "validation", output: "", scores: { val_loss: (3 - weight) ** 2 }, error: null }) + "\\n");
}
writeFileSync(join(process.env.SATURN_RUN_DIRECTORY, "weight.json"), JSON.stringify({ weight }));
console.log("trained", weight);
`;

// An evaluation that measures a saved weight on fixed samples.
const EVALUATE = `
import { appendFileSync, readFileSync } from "node:fs";
const { weight } = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const x of [1, 2, 3, 4]) {
  const output = weight * x;
  appendFileSync(process.env.SATURN_RUN_SAMPLES, JSON.stringify({ schemaVersion: 1, sampleId: "x-" + x, modelId: process.argv[3], input: String(x), output: String(output), expected: String(3 * x), scores: { absolute_error: Math.abs(output - 3 * x) }, error: null }) + "\\n");
}
`;

test("a whole study: a question to a finding, training and evaluation, through the tools alone", posixOnly, async () => {
  const setup = await bed();
  const listed = await call(setup, "research_skill", {});
  assert.ok(listed.skills.length >= 40);
  assert.equal(listed.startWith, "research-autopilot");
  assert.match((await call(setup, "research_skill", { name: "research-autopilot" })).instructions, /Write the prediction before the result/);

  const question = await call(setup, "research_write", { collection: "questions", fields: { title: "Does 50 steps fit y = 3x?" } });
  const hypothesis = await call(setup, "research_write", { collection: "hypotheses", fields: { title: "Mean absolute error below 0.1", questionId: question.id } });
  assert.equal(hypothesis.verdict, "undecided");

  // Training: its own experiment, with its weights left in the run's folder.
  await setup.turn([write("train.mjs", TRAIN)]);
  const training = await call(setup, "research_write", { collection: "experiments", fields: { title: "Train", command: "node train.mjs", inputs: { code: ["train.mjs"] }, questionId: question.id } });
  const { version: trainVersion, new: isNew } = await call(setup, "research_run", { action: "freeze", experiment: training.id });
  assert.equal(isNew, true);
  const { run: trainRun } = await call(setup, "research_run", { action: "start", version: trainVersion.id });
  let waited = await call(setup, "research_wait", { run: trainRun.id, seconds: 60 });
  assert.equal(waited.ended, true);
  assert.equal(waited.run.status, "completed", waited.run.error);
  assert.equal(waited.summary.models[0].scores.val_loss.count, 5);
  assert.match((await call(setup, "research_read", { what: "log", run: trainRun.id })).text, /trained/);

  // The checkpoint joins the lineage, pinned.
  const parent = await call(setup, "research_write", { collection: "models", fields: { name: "untrained", source: "init", weightsRevision: "0".repeat(40) } });
  const weights = path.join(setup.folder, ".saturn/research/runs", trainRun.id, "weight.json");
  const trained = await call(setup, "research_write", { collection: "models", fields: { name: "trained", source: weights, weightsRevision: "a".repeat(64), parentId: parent.id, producedBy: `run ${trainRun.id}` } });
  assert.equal(trained.floating, false);

  // Evaluation: a separate experiment, so that it stays the same whatever is trained.
  await setup.turn([write("evaluate.mjs", EVALUATE)]);
  const evaluation = { dataset: "x", split: "test", sampleSet: "1-4", scorer: "absolute_error", promptFormat: "none", chatTemplate: null, generation: null };
  const measuring = await call(setup, "research_write", { collection: "experiments", fields: { title: "Evaluate", command: `node evaluate.mjs ${weights} ${trained.id}`, inputs: { code: ["evaluate.mjs"] }, evaluation, models: [{ modelId: trained.id, role: "base" }], hypothesisId: hypothesis.id } });
  const { version } = await call(setup, "research_run", { action: "freeze", experiment: measuring.id });
  const { run } = await call(setup, "research_run", { action: "start", version: version.id });
  waited = await call(setup, "research_wait", { run: run.id, seconds: 60 });
  assert.equal(waited.run.status, "completed", waited.run.error);

  const page = await call(setup, "research_read", { what: "samples", run: run.id, limit: 2 });
  assert.deepEqual(page.items.map((item) => item.sample.sampleId), ["x-1", "x-2"]);
  await call(setup, "research_write", { collection: "counterexamples", fields: { runId: run.id, sampleId: "x-4", note: "The largest error" } });
  const finding = await call(setup, "research_write", { collection: "findings", fields: { text: "The error is below 0.1. Suggests the hypothesis holds.", runIds: [run.id] } });
  assert.equal(finding.kind, "ai_suggestion");

  // The person sees all of it, and the verdict is still theirs.
  const status = await call(setup, "research_read", { what: "status" });
  assert.equal(status.hypotheses[0].verdict, "undecided");
  assert.equal(status.runs.length, 2);
  assert.equal(status.models.length, 2);
  assert.equal(status.findings[0].kind, "ai_suggestion");
  assert.deepEqual((await saturn.api("GET", `${setup.route}/events`)).items, [], "nothing it did through the tools reads as unexplained");
});

test("freezing and running a task use the task's own worktree, and its records are the project's", posixOnly, async () => {
  const folder = await saturn.folder();
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-q"], { cwd: folder });
  await writeFile(path.join(folder, "readme.md"), "start\n");
  execFileSync("git", ["add", "."], { cwd: folder });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "start"], { cwd: folder });
  const setup = await saturn.chat(folder, { mcpConnectionIds: ["research"] });
  await saturn.api("POST", `/threads/${setup.thread.id}/worktree`, {});
  await setup.turn([write("probe.mjs", `import { appendFileSync } from "node:fs"; appendFileSync(process.env.SATURN_RUN_SAMPLES, JSON.stringify({ schemaVersion: 1, sampleId: "a", scores: { worktree: process.cwd() }, error: null }) + "\\n");`)]);
  await assert.rejects(readFile(path.join(folder, "probe.mjs")), "the project's checkout does not have it");
  const experiment = await call(setup, "research_write", { collection: "experiments", fields: { title: "E", command: "node probe.mjs", inputs: { code: ["probe.mjs"] } } });
  const { version } = await call(setup, "research_run", { action: "freeze", experiment: experiment.id });
  const { run } = await call(setup, "research_run", { action: "start", version: version.id });
  const waited = await call(setup, "research_wait", { run: run.id, seconds: 60 });
  assert.equal(waited.run.status, "completed", waited.run.error);
  const [item] = (await call(setup, "research_read", { what: "samples", run: run.id })).items;
  // The run ran in its own snapshot, made from the task's worktree rather than the project's checkout.
  assert.match(item.sample.scores.worktree, /run-snapshots/);
  const evidence = await call(setup, "research_read", { what: "evidence", run: run.id });
  assert.notEqual(await realpath(evidence.observed.snapshot.source), await realpath(folder));
  assert.equal(evidence.verdicts.inputs, "verified");
  await readFile(path.join(folder, ".saturn/research/runs", run.id, "run.json"));
});

test("a start repeated in one turn starts once, and a new attempt runs the version again", posixOnly, async () => {
  const setup = await bed({ "probe.mjs": `import { appendFileSync } from "node:fs"; appendFileSync(process.env.SATURN_RUN_SAMPLES, JSON.stringify({ schemaVersion: 1, sampleId: "a", error: null }) + "\\n");` });
  const experiment = await call(setup, "research_write", { collection: "experiments", fields: { title: "E", command: "node probe.mjs", inputs: { code: ["probe.mjs"] } } });
  const { version } = await call(setup, "research_run", { action: "freeze", experiment: experiment.id });
  const run = await setup.turn([
    [["research_run", { action: "start", version: version.id }]],
    [["research_run", { action: "start", version: version.id }]],
    [["research_run", { action: "start", version: version.id, attempt: 2 }]],
  ]);
  const [first, again, second] = run.actions.map((action) => action.result);
  assert.equal(first.new, true);
  assert.equal(again.new, false);
  assert.equal(again.run.id, first.run.id);
  assert.equal(second.new, true);
  assert.notEqual(second.run.id, first.run.id);
});

test("what is the person's has no way through the tools", async () => {
  const setup = await bed();
  const hypothesis = await call(setup, "research_write", { collection: "hypotheses", fields: { title: "H" } });
  assert.match(await refused(setup, "research_write", { collection: "hypotheses", fields: { title: "H", verdict: "supported" } }), /person's/);
  assert.match(await refused(setup, "research_write", { collection: "hypotheses", id: hypothesis.id, expectedRevision: 1, fields: { verdict: "supported" } }), /does not change/);
  assert.match(await refused(setup, "research_write", { collection: "findings", fields: { text: "T", kind: "conclusion" } }), /conclusion is the person's/);
  assert.match(await refused(setup, "research_write", { collection: "versions", fields: {} }), /cannot make records/);
  const theirs = await saturn.api("POST", `${setup.route}/findings`, { text: "Mine", kind: "conclusion" });
  assert.match(await refused(setup, "research_write", { collection: "findings", id: theirs.id, expectedRevision: 1, fields: { text: "Changed" } }), /the person's/);
  assert.equal((await saturn.api("GET", `${setup.route}/hypotheses/${hypothesis.id}`)).verdict, "undecided");
  const tools = (await saturn.api("GET", "/connections/mcp")).find((item) => item.id === "research").tools.map((tool) => tool.toolId);
  for (const tool of tools) assert.doesNotMatch(tool, /label|verdict|policy|mode|merge/);
});

test("a change needs the revision it read, and a stale one changes nothing", async () => {
  const setup = await bed();
  const question = await call(setup, "research_write", { collection: "questions", fields: { title: "Q" } });
  assert.match(await refused(setup, "research_write", { collection: "questions", id: question.id, fields: { title: "No revision" } }), /expectedRevision/);
  assert.equal((await call(setup, "research_write", { collection: "questions", id: question.id, expectedRevision: 1, fields: { title: "Q2" } })).revision, 2);
  assert.match(await refused(setup, "research_write", { collection: "questions", id: question.id, expectedRevision: 1, fields: { title: "Q3" } }), /has changed/);
});

test("a Manual chat reads through the tools and cannot change anything", async () => {
  const setup = await bed();
  await saturn.api("POST", `${setup.route}/questions`, { title: "Q" });
  await saturn.api("PATCH", `/threads/${setup.thread.id}`, { chatMode: "manual" });
  const read = await setup.turn([["research_read", { what: "status" }]]);
  assert.equal(read.mode, "ask");
  assert.equal(read.actions[0].status, "completed", read.actions[0].reason);
  assert.equal(read.actions[0].result.questions.length, 1);
  const wrote = await setup.turn([["research_write", { collection: "questions", fields: { title: "No" } }]]);
  assert.notEqual(wrote.actions[0].status, "completed");
  assert.equal((await saturn.api("GET", `${setup.route}/questions`)).items.length, 1);
});

test("a Pair chat waits before a change through the tools, and not before a read", async () => {
  const setup = await bed();
  await saturn.api("PATCH", `/threads/${setup.thread.id}`, { chatMode: "pair" });
  assert.equal((await setup.turn([["research_read", { what: "status" }]])).actions[0].status, "completed");
  const started = await setup.start([["research_write", { collection: "questions", fields: { title: "Q" } }]]);
  const waiting = await until("the approval", () => saturn.api("GET", `/runs/${started.id}`), (run) => run.status === "waiting_approval");
  assert.match(waiting.actions[0].reason, /Approve mode/);
  assert.equal((await saturn.api("GET", `${setup.route}/questions`)).items.length, 0);
  await saturn.api("POST", `/runs/${started.id}/actions/${waiting.actions[0].id}/decision`, { allow: true });
  await saturn.finished(started.id);
  assert.equal((await saturn.api("GET", `${setup.route}/questions`)).items.length, 1);
});

test("a stopped turn does not keep waiting on a run", posixOnly, async () => {
  const setup = await bed({ "slow.mjs": `setTimeout(() => {}, 60000);` });
  const experiment = await call(setup, "research_write", { collection: "experiments", fields: { title: "E", command: "node slow.mjs", inputs: { code: ["slow.mjs"] } } });
  const { version } = await call(setup, "research_run", { action: "freeze", experiment: experiment.id });
  const { run } = await call(setup, "research_run", { action: "start", version: version.id });
  const started = await setup.start([["research_wait", { run: run.id, seconds: 600 }]]);
  await until("the wait", () => saturn.api("GET", `/runs/${started.id}`), (item) => item.rounds?.length > 0);
  await saturn.api("POST", `/runs/${started.id}/stop`, {});
  const begun = Date.now();
  await saturn.finished(started.id);
  assert.ok(Date.now() - begun < 30000);
  await call(setup, "research_run", { action: "stop", run: run.id });
});

test("an agent has the research tools only when it asks for them, and keeps the usual limit otherwise", async () => {
  const connection = await saturn.api("POST", "/connections/models", { name: "M", provider: "openai", model: "m", baseUrl: "http://127.0.0.1:9" });
  const usual = await saturn.api("POST", "/agents", { name: "Usual", modelConnectionId: connection.id });
  assert.ok(!usual.mcpConnectionIds.includes("research"));
  assert.ok(usual.mcpConnectionIds.includes("browser"));
  const added = await saturn.api("PATCH", `/agents/${usual.id}`, { mcpConnectionIds: [...usual.mcpConnectionIds, "research"] });
  assert.ok(added.mcpConnectionIds.includes("research"));
});

test("the tools refuse outside a project, and a skill's name that does not exist lists how to find them", async () => {
  const setup = await saturn.chat(undefined, { mcpConnectionIds: ["research"] });
  assert.match(await refused(setup, "research_read", { what: "status" }), /not in a project/);
  assert.match(await refused(setup, "research_skill", { name: "no-such-skill" }), /Call research_skill with no name/);
  assert.ok((await call(setup, "research_skill", {})).skills.length >= 40, "skills do not need a project");
});

test("a project's own skill of the same name comes first", async () => {
  const setup = await bed();
  const skills = path.join(setup.folder, ".saturn/skills/study-report");
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(skills, "SKILL.md"), "---\nname: study-report\ndescription: Ours.\n---\nOur format.\n");
  assert.match((await call(setup, "research_skill", { name: "study-report" })).instructions, /Our format/);
  const listed = (await call(setup, "research_skill", {})).skills.filter((item) => item.name === "study-report");
  assert.deepEqual(listed.map((item) => item.source), ["project"]);
});

test("a long answer is cut and says how to read less", async () => {
  const setup = await bed();
  for (let index = 0; index < 8; index += 1) await saturn.api("POST", `${setup.route}/findings`, { text: "x".repeat(10000), kind: "observation" });
  const answer = await call(setup, "research_read", { what: "list", collection: "findings" });
  assert.equal(answer.clipped, true);
  assert.match(answer.note, /smaller part/);
});

/** A chat in a git project whose agent has the research tools, so that a task can have its own worktree. */
async function gitBed(options = {}) {
  const folder = await saturn.folder();
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-q"], { cwd: folder });
  await writeFile(path.join(folder, "readme.md"), "start\n");
  execFileSync("git", ["add", "."], { cwd: folder });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "start"], { cwd: folder });
  const setup = await saturn.chat(folder, { mcpConnectionIds: ["research"], ...options });
  return { ...setup, folder };
}

test("an assistant starts a task, which works apart, and follows it to its answer", posixOnly, async () => {
  const setup = await gitBed();
  const begun = await call(setup, "research_task_start", { prompt: "Clean up the data\nand say what you did" });
  assert.match(begun.branch, /saturn\//);
  const threads = await saturn.api("GET", `/agents/${setup.agent.id}/threads`);
  const task = threads.find((item) => item.id === begun.task);
  assert.equal(task.title, "Task: Clean up the data", "named so that it shows on the Tasks screen");
  assert.equal(task.projectId, setup.project.id);
  assert.equal(task.chatMode, "delegate");
  assert.ok(task.worktree, "it has its own worktree");
  const report = await call(setup, "research_task_read", { what: "wait", task: begun.task, seconds: 30 });
  assert.equal(report.status, "completed", report.error);
  assert.equal(report.answer, "done");
  assert.deepEqual(report.waitingForThePerson, []);
  const listed = await call(setup, "research_task_read", { what: "list" });
  assert.deepEqual(listed.tasks.map((item) => item.task), [begun.task]);
  assert.equal(listed.tasks[0].answer, undefined, "a list stays short");
  assert.equal((await readFile(path.join(setup.folder, "readme.md"), "utf8")), "start\n");
});

test("a finished task tells the chat that started it, which hears of it in a turn of its own", posixOnly, async () => {
  const setup = await gitBed();
  const begun = await call(setup, "research_task_start", { prompt: "Count the rows" });
  const told = await until("the chat to hear from its task", () => saturn.api("GET", `/agents/${setup.agent.id}/threads`), (threads) => {
    const chat = threads.find((item) => item.id === setup.thread.id);
    return chat?.taskReports?.some((report) => report.task === begun.task && report.delivered);
  });
  const chat = told.find((item) => item.id === setup.thread.id);
  const [report] = chat.taskReports;
  assert.equal(report.report.status, "completed");
  assert.equal(report.report.answer, "done");
  assert.equal(told.find((item) => item.id === begun.task).taskOf, setup.thread.id, "the task knows which chat started it");

  const recent = await saturn.api("GET", "/runs?limit=50");
  const full = await Promise.all((recent.items ?? recent).filter((run) => run.threadId === setup.thread.id).map((run) => saturn.api("GET", `/runs/${run.id}`)));
  const woken = full.find((run) => run.fromTasks?.includes(begun.task));
  assert.ok(woken, "a turn of its own started in the chat");
  assert.equal(woken.automatic, true);
  assert.match(woken.input, /^Task "Task: Count the rows" completed\./);
  assert.match(woken.input, /<saturn_context sources="task reports">[\s\S]*Its answer: done/);

  // Each report is told once: the chat's next turn carries nothing more.
  const next = await setup.turn([], "and now?");
  assert.doesNotMatch(next.input, /task reports/);
});

test("a task starts in the mode of the chat that started it, and never asks less than that", posixOnly, async () => {
  const auto = await gitBed();
  await saturn.api("PATCH", `/threads/${auto.thread.id}`, { chatMode: "delegate_auto" });
  const fromAuto = await call(auto, "research_task_start", { prompt: "One" });
  const threads = await saturn.api("GET", `/agents/${auto.agent.id}/threads`);
  assert.equal(threads.find((item) => item.id === fromAuto.task).chatMode, "delegate_auto");
});

test("a Manual chat cannot start a task, and a Pair chat waits for the person first", posixOnly, async () => {
  const manual = await gitBed();
  await saturn.api("PATCH", `/threads/${manual.thread.id}`, { chatMode: "manual" });
  const refused = await manual.turn([["research_task_start", { prompt: "No" }]]);
  assert.notEqual(refused.actions[0].status, "completed");
  assert.equal((await saturn.api("GET", `/agents/${manual.agent.id}/threads`)).length, 1);
  assert.deepEqual((await manual.turn([["research_task_read", { what: "list" }]])).actions[0].result.tasks, [], "it can still read them");

  const pair = await gitBed();
  await saturn.api("PATCH", `/threads/${pair.thread.id}`, { chatMode: "pair" });
  const started = await pair.start([["research_task_start", { prompt: "Wait for me" }]]);
  const waiting = await until("the approval", () => saturn.api("GET", `/runs/${started.id}`), (run) => run.status === "waiting_approval");
  assert.match(waiting.actions[0].reason, /Approve mode/);
  assert.equal((await saturn.api("GET", `/agents/${pair.agent.id}/threads`)).length, 1, "nothing has started");
  await saturn.api("POST", `/runs/${started.id}/actions/${waiting.actions[0].id}/decision`, { allow: false });
  await saturn.finished(started.id);
  assert.equal((await saturn.api("GET", `/agents/${pair.agent.id}/threads`)).length, 1);
});

test("a task cannot start a task, and one that cannot begin leaves nothing behind", posixOnly, async () => {
  const setup = await gitBed();
  const inner = await setup.newThread("Task: already one");
  const run = await setup.turn([["research_task_start", { prompt: "Deeper" }]], "go", inner.id);
  assert.equal(run.actions[0].status, "failed");
  assert.match(run.actions[0].reason, /cannot start another task/);

  const plain = await bed();
  assert.match(await refused(plain, "research_task_start", { prompt: "No git here" }), /could not start/);
  assert.equal((await saturn.api("GET", `/agents/${plain.agent.id}/threads`)).length, 1);
  assert.match(await refused(setup, "research_task_read", { what: "status", task: "thread_none" }), /No task/);
});

test("a chat that moves from Manual to Delegate goes on in the same chat, and no task starts", async () => {
  const setup = await bed();
  await saturn.api("PATCH", `/threads/${setup.thread.id}`, { chatMode: "manual" });
  const read = await setup.turn([["research_read", { what: "questions" }]]);
  assert.equal(read.threadId, setup.thread.id);
  await saturn.api("PATCH", `/threads/${setup.thread.id}`, { chatMode: "delegate_auto" });
  const wrote = await setup.turn([["research_write", { collection: "questions", fields: { title: "Why?" } }]]);
  assert.equal(wrote.threadId, setup.thread.id);
  assert.equal(wrote.actions.at(-1).status, "completed", wrote.actions.at(-1).reason);
  const threads = await saturn.api("GET", `/agents/${setup.agent.id}/threads`);
  assert.deepEqual(threads.map((item) => item.id), [setup.thread.id]);
});

test("the assistant can look at prompts of its own, under the same rules", posixOnly, async () => {
  const setup = await bed();
  assert.match(await refused(setup, "research_inspect", { action: "prompts", runId: "run_0000000000000000", modelId: "m", clean: "a", corrupted: "a", expected: " x", alternative: " y" }), /same/);
  assert.match(await refused(setup, "research_inspect", { action: "compare", runId: "run_0000000000000000", modelId: "m", otherModelId: "m", input: "a" }), /different models/);
  assert.match(await refused(setup, "research_inspect", { action: "features", runId: "run_0000000000000000", modelId: "m", prompt: "a", layer: 1 }), /names an SAE/);
  assert.match(await refused(setup, "research_inspect", { action: "features", runId: "run_0000000000000000", modelId: "m", prompt: "a", layer: 1, saeRelease: "r", saeId: "i", ablate: 3 }), /margin/);
});

test("a turn with the research tools goes on past the usual limit on tool steps", async () => {
  const setup = await bed();
  const steps = Array.from({ length: 70 }, () => [["research_read", { what: "events" }]]);
  const run = await setup.turn(steps);
  assert.equal(run.actions.length, 70);
  assert.doesNotMatch(run.output, /tool steps/);
});

test("the tools reach Claude Code, which sees them and calls them like any other", async () => {
  const programs = await startWithPrograms();
  try {
    const home = await realpath(programs.folder);
    const folder = path.join(home, "project");
    await mkdir(folder, { recursive: true });
    const project = await programs.api("POST", "/projects", { path: folder, grant: true });
    const connection = await programs.api("POST", "/connections/models", { provider: "claude-code", model: "the-model" });
    const agent = await programs.api("POST", "/agents", { name: "Coder", modelConnectionId: connection.id, autonomy: "bypass", mcpConnectionIds: ["research"] });
    const thread = await programs.api("POST", `/agents/${agent.id}/threads`, { title: "Work", projectId: project.id });
    await programs.scenario({ steps: [
      { mcp: { method: "initialize", id: 1, params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stand-in", version: "1" } } } },
      { mcp: { method: "tools/call", id: 2, params: { name: "research_write", arguments: { collection: "questions", fields: { title: "Asked through the program" } } } } },
      { send: { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s", usage: { input_tokens: 1, output_tokens: 1 } } },
    ] });
    const run = await runToEnd(programs, agent.id, { input: "go", threadId: thread.id });
    assert.equal(run.status, "completed", run.error);
    const initialize = (await programs.journal()).filter((entry) => entry.received?.request?.subtype === "initialize").at(-1).received;
    const offered = Object.values(initialize.request.sdkMcpServerManifests)[0].toolsListResult.tools.map((tool) => tool.name);
    assert.ok(offered.includes("research_skill"), offered.join(" "));
    assert.ok(offered.includes("research_run"), offered.join(" "));
    assert.ok(offered.includes("research_task_start"), offered.join(" "));
    const questions = await programs.api("GET", `/projects/${project.id}/research/questions`);
    assert.deepEqual(questions.items.map((item) => item.title), ["Asked through the program"]);
  } finally {
    await programs.stop();
  }
});
