// A chat's AI involvement and locks on files, on every kind of backend. It is a workflow constraint, not a security boundary, and
// docs/research-contract.md says what each backend can enforce: these tests hold it to exactly that.
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench, command, files, sha, until, write } from "./files-support.mjs";
import { startWithPrograms, untilCard, untilFinished } from "./programs.mjs";

let saturn;
before(async () => { saturn = await bench(); });
after(async () => { await saturn?.stop(); });

/** A project chat in a folder with these files. */
async function bed(files = { "probe.py": "mine\n", "data.py": "theirs\n", "pair.py": "ours\n" }) {
  const folder = await saturn.folder();
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(folder, name), content);
  const setup = await saturn.chat(folder);
  const projectId = (await saturn.api("GET", "/projects")).find((item) => item.path === folder).id;
  const route = `/projects/${projectId}/research`;
  const lock = (...locked) => saturn.api("PUT", `${route}/policy`, { expectedRevision: 0, locked });
  const chatMode = (mode) => saturn.api("PATCH", `/threads/${setup.thread.id}`, { chatMode: mode });
  const events = async () => (await saturn.api("GET", `${route}/events`)).items;
  return { ...setup, folder, route, lock, chatMode, events };
}

const text = (folder, name) => readFile(path.join(folder, name), "utf8");

test("a policy needs the revision it was based on", async () => {
  const { route } = await bed();
  assert.deepEqual((await saturn.api("GET", `${route}/policy`)).locked, []);
  assert.equal((await saturn.call("PUT", `${route}/policy`, { locked: [] })).status, 400);
  assert.equal((await saturn.api("PUT", `${route}/policy`, { expectedRevision: 0, locked: ["a.py"] })).revision, 1);
  assert.equal((await saturn.call("PUT", `${route}/policy`, { expectedRevision: 0, locked: [] })).status, 409);
});

test("a chat's mode must be a known one, and the chat keeps it", async () => {
  const { agent, thread, chatMode } = await bed();
  assert.equal((await saturn.call("PATCH", `/threads/${thread.id}`, { chatMode: "maybe" })).status, 400);
  assert.equal((await chatMode("pair")).chatMode, "pair");
  const listed = (await saturn.api("GET", `/agents/${agent.id}/threads`)).find((item) => item.id === thread.id);
  assert.equal(listed.chatMode, "pair");
});

test("a Manual chat only reads, even when a run asks for more", async () => {
  const { folder, chatMode, agent, thread, model } = await bed();
  await chatMode("manual");
  model.queue.push(write("probe.py", "agent\n"));
  const started = await saturn.api("POST", `/agents/${agent.id}/runs`, { input: "go", threadId: thread.id, mode: "agent" });
  const run = await saturn.finished(started.id);
  assert.equal(run.mode, "ask");
  assert.notEqual(run.actions[0]?.status, "completed");
  assert.equal(await text(folder, "probe.py"), "mine\n");
});

test("a run already going is refused a write once its chat becomes Manual, and the refusal is recorded", async () => {
  const { folder, chatMode, events, agent, thread, model } = await bed();
  await chatMode("pair");
  model.queue.push(write("probe.py", "agent\n"));
  const started = await saturn.api("POST", `/agents/${agent.id}/runs`, { input: "go", threadId: thread.id });
  const waiting = await until("the approval", () => saturn.api("GET", `/runs/${started.id}`), (run) => run.status === "waiting_approval");
  await chatMode("manual");
  await saturn.api("POST", `/runs/${started.id}/actions/${waiting.actions[0].id}/decision`, { allow: true });
  const run = await saturn.finished(started.id);
  assert.equal(run.actions[0].status, "failed");
  assert.match(run.actions[0].reason, /Ask mode/);
  assert.equal(await text(folder, "probe.py"), "mine\n");
  const [event] = await events();
  assert.equal(event.kind, "refused");
  assert.equal(event.path, "probe.py");
  assert.equal(event.runId, run.id);
});

test("a chat with no mode, like a task's, is the agent's to change", async () => {
  const { folder, turn, events } = await bed();
  const run = await turn([write("data.py", "changed\n")]);
  assert.equal(run.actions[0].status, "completed");
  assert.equal(await text(folder, "data.py"), "changed\n");
  assert.deepEqual(await events(), []);
});

test("a Delegate chat still cannot write a locked file", async () => {
  const { folder, lock, chatMode, turn } = await bed();
  await lock("probe.py");
  await chatMode("delegate");
  const patch = "*** Begin Patch\n*** Update File: data.py\n@@\n-theirs\n+changed\n*** Update File: probe.py\n@@\n-mine\n+changed\n*** End Patch\n";
  const run = await turn([["files", { action: "patch", patch }]]);
  assert.equal(run.actions[0].status, "failed");
  assert.match(run.actions[0].reason, /locked/);
  assert.equal(await text(folder, "data.py"), "theirs\n", "nothing of the patch applied");
  assert.equal(await text(folder, "probe.py"), "mine\n");
});

test("the data and scorer of a frozen version are locked for agents, and the code is not", async () => {
  const { folder, route, turn } = await bed({ "probe.py": "c\n", "set.jsonl": "{}\n", "score.py": "s\n" });
  const experiment = await saturn.api("POST", `${route}/experiments`, { title: "E", command: "x", inputs: { code: ["probe.py"], data: ["set.jsonl"], scorer: ["score.py"] } });
  await saturn.api("POST", `${route}/experiments/${experiment.id}/versions`, {});
  const run = await turn([[write("set.jsonl", "x\n"), write("score.py", "x\n"), write("probe.py", "x\n")]]);
  assert.deepEqual(run.actions.map((item) => item.status), ["failed", "failed", "completed"]);
  assert.match(run.actions[0].reason, /locked/);
  assert.equal(await text(folder, "set.jsonl"), "{}\n");
});

test("a lock can be released for the next version, and freezing it locks the file again", async () => {
  const { folder, route, turn, events } = await bed({ "probe.py": "c\n", "set.jsonl": "{}\n", "score.py": "s\n" });
  const experiment = await saturn.api("POST", `${route}/experiments`, { title: "E", command: "x", inputs: { code: ["probe.py"], scorer: ["score.py"] } });
  await saturn.api("POST", `${route}/experiments/${experiment.id}/versions`, {});
  const refused = await turn([write("score.py", "v4\n")]);
  assert.equal(refused.actions[0].status, "failed");
  const policy = await saturn.api("GET", `${route}/policy`);
  assert.equal((await saturn.call("PUT", `${route}/policy`, { expectedRevision: policy.revision, locked: [], released: "score.py" })).status, 400);
  await saturn.api("PUT", `${route}/policy`, { expectedRevision: policy.revision, locked: [], released: ["score.py"] });
  const allowed = await turn([write("score.py", "v4\n")]);
  assert.equal(allowed.actions[0].status, "completed");
  assert.equal(await text(folder, "score.py"), "v4\n");
  const next = await saturn.api("POST", `${route}/experiments/${experiment.id}/versions`, {});
  assert.equal(next.number, 2, "the changed scorer is a new version; the old one keeps its results");
  assert.deepEqual((await saturn.api("GET", `${route}/policy`)).released, []);
  const again = await turn([write("score.py", "v5\n")]);
  assert.equal(again.actions[0].status, "failed", "the new version locks the scorer again");
  assert.deepEqual((await events()).map((event) => event.kind), ["refused", "refused"]);
});

test("records cannot be written by an agent's file tool, so neither a verdict nor a policy can", async () => {
  const { folder, route, turn } = await bed();
  const hypothesis = await saturn.api("POST", `${route}/hypotheses`, { title: "H" });
  const file = `.saturn/research/hypotheses/${hypothesis.id}.json`;
  const before = await text(folder, file);
  const run = await turn([[write(file, "{}"), write(".saturn/research/policy.json", "{}")]]);
  assert.deepEqual(run.actions.map((item) => item.status), ["failed", "failed"]);
  assert.equal(await text(folder, file), before);
});

test("a Pair chat waits for the user even with approvals off, and an accepted change is recorded", async () => {
  const { folder, chatMode, events, agent, thread, model } = await bed();
  await chatMode("pair");
  model.queue.push(write("pair.py", "changed\n"));
  const started = await saturn.api("POST", `/agents/${agent.id}/runs`, { input: "go", threadId: thread.id });
  const waiting = await until("the approval", () => saturn.api("GET", `/runs/${started.id}`), (run) => run.status === "waiting_approval");
  const action = waiting.actions[0];
  assert.match(action.reason, /Approve mode/);
  assert.equal(await text(folder, "pair.py"), "ours\n");
  await saturn.api("POST", `/runs/${started.id}/actions/${action.id}/decision`, { allow: true });
  const run = await saturn.finished(started.id);
  assert.equal(run.actions[0].status, "completed");
  assert.equal(await text(folder, "pair.py"), "changed\n");
  const [event] = await events();
  assert.equal(event.kind, "assisted");
  assert.equal(event.path, "pair.py");
  assert.equal(event.policyRevision, 0);
  assert.equal(event.changeSha256, sha("changed\n"));
  assert.equal(await text(folder, `.saturn/research/objects/${sha("changed\n")}`), "changed\n");
});

test("a chat's mode decides how much it asks, over the agent's own setting", async () => {
  const folder = await saturn.folder();
  const asks = await saturn.chat(folder, { autonomy: "bypass" });
  await saturn.api("PATCH", `/threads/${asks.thread.id}`, { chatMode: "delegate" });
  const started = await asks.start([command("rm -rf nothing-here")]);
  const waiting = await until("the approval", () => saturn.api("GET", `/runs/${started.id}`), (run) => run.status === "waiting_approval");
  assert.equal(waiting.actions[0].toolId, "code", "delegate asks before what is sensitive, though the agent says bypass");
  await saturn.api("POST", `/runs/${started.id}/actions/${waiting.actions[0].id}/decision`, { allow: false });
  await saturn.finished(started.id);

  const free = await saturn.chat(await saturn.folder(), { autonomy: "review" });
  await saturn.api("PATCH", `/threads/${free.thread.id}`, { chatMode: "delegate_auto" });
  const run = await free.turn([command("rm -rf nothing-here")]);
  assert.equal(run.actions[0].status, "completed", "auto asks nothing, though the agent says review");

  const unset = await saturn.chat(await saturn.folder(), { autonomy: "review" });
  const started2 = await unset.start([command("true")]);
  await until("the approval", () => saturn.api("GET", `/runs/${started2.id}`), (item) => item.status === "waiting_approval");
  await saturn.api("POST", `/runs/${started2.id}/stop`, {});
});

test("auto still cannot write a locked file", async () => {
  const { folder, lock, chatMode, turn } = await bed();
  await lock("probe.py");
  await chatMode("delegate_auto");
  const run = await turn([write("probe.py", "agent\n")]);
  assert.equal(run.actions[0].status, "failed");
  assert.match(run.actions[0].reason, /locked/);
  assert.equal(await text(folder, "probe.py"), "mine\n");
});

test("a Pair chat asks before a command too, and not before a read", async () => {
  const { folder, chatMode, agent, thread, model } = await bed();
  await chatMode("pair");
  model.queue.push(["files", { action: "read", path: "pair.py" }]);
  model.queue.push(command("printf 'by a shell\\n' > pair.py"));
  const started = await saturn.api("POST", `/agents/${agent.id}/runs`, { input: "go", threadId: thread.id });
  const waiting = await until("the approval", () => saturn.api("GET", `/runs/${started.id}`), (run) => run.status === "waiting_approval");
  const asked = waiting.actions.find((action) => action.status === "waiting_approval");
  assert.equal(asked.toolId, "code");
  assert.equal(waiting.actions[0].status, "completed", "the read did not wait");
  assert.equal(await text(folder, "pair.py"), "ours\n");
  await saturn.api("POST", `/runs/${started.id}/actions/${asked.id}/decision`, { allow: false });
  await saturn.finished(started.id);
  assert.equal(await text(folder, "pair.py"), "ours\n");
});

test("a shell command is not stopped, and its change is recorded without naming who made it", async () => {
  const { folder, lock, events, turn } = await bed();
  await lock("probe.py");
  await turn([command(files(["write", "probe.py", "by a shell\n"]))]);
  assert.equal(await text(folder, "probe.py"), "by a shell\n", "this is the limit the contract states");
  const [event] = await events();
  assert.equal(event.kind, "integrity_changed");
  assert.deepEqual(event.paths, ["probe.py"]);
  assert.equal(event.actor, undefined);
});

test("a shell writing a record is recorded too", async () => {
  const { route, lock, events, turn } = await bed();
  await lock("probe.py");
  const hypothesis = await saturn.api("POST", `${route}/hypotheses`, { title: "H" });
  const file = `.saturn/research/hypotheses/${hypothesis.id}.json`;
  await turn([command(`printf '{}' > ${file}`)]);
  const [event] = await events();
  assert.deepEqual(event.paths, [file]);
});

test("a background command's later change is caught at the next tool call", async () => {
  const { lock, events, turn } = await bed();
  await lock("probe.py");
  const run = await turn([command("sleep 0.2; printf 'late\\n' > probe.py", { background: true }), command("sleep 0.5"), command("true")]);
  assert.equal(run.status, "completed", run.error);
  const found = (await events()).filter((event) => event.kind === "integrity_changed");
  assert.deepEqual(found.flatMap((event) => event.paths), ["probe.py"]);
});

test("the user's own edit during a turn is never recorded as a refusal", async () => {
  const { folder, lock, events, turn } = await bed();
  await lock("probe.py");
  const editing = writeFile(path.join(folder, "probe.py"), "by me\n");
  await turn([command("sleep 0.1"), command("true")]);
  await editing;
  for (const event of await events()) assert.equal(event.kind === "refused", false);
});

test("Claude Code in a Pair chat: a locked file is refused, changes and commands ask, and what a command did is compared", async () => {
  const programs = await startWithPrograms();
  try {
    const home = await realpath(programs.folder);
    const folder = path.join(home, "project");
    await mkdir(folder, { recursive: true });
    for (const name of ["probe.py", "pair.py", "other.py"]) await writeFile(path.join(folder, name), "start\n");
    const project = await programs.api("POST", "/projects", { path: folder, grant: true });
    const route = `/projects/${project.id}/research`;
    await programs.api("PUT", `${route}/policy`, { expectedRevision: 0, locked: ["probe.py"] });
    const connection = await programs.api("POST", "/connections/models", { provider: "claude-code", model: "the-model" });
    const agent = await programs.api("POST", "/agents", { name: "Coder", modelConnectionId: connection.id, autonomy: "bypass" });
    const thread = await programs.api("POST", `/agents/${agent.id}/threads`, { title: "Work", projectId: project.id });
    await programs.api("PATCH", `/threads/${thread.id}`, { chatMode: "pair" });
    await programs.scenario({ steps: [
      { permission: { tool: "Write", input: { file_path: path.join(folder, "probe.py") }, id: "tu_manual", write: { path: path.join(folder, "probe.py"), content: "agent\n" } } },
      { permission: { tool: "Read", input: { file_path: "other.py" }, id: "tu_free" } },
      { permission: { tool: "Edit", input: { file_path: "pair.py" }, id: "tu_pair" } },
      { permission: { tool: "Bash", input: { command: "x" }, id: "tu_bash", write: { path: path.join(folder, "probe.py"), content: "by bash\n" } } },
      { send: { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s", usage: { input_tokens: 1, output_tokens: 1 } } },
    ] });
    const begun = await programs.api("POST", `/agents/${agent.id}/runs`, { input: "go", threadId: thread.id, projectId: project.id });
    const card = await untilCard(programs, begun.id);
    assert.equal(card.action.id, "tu_pair", "a change asks even with approvals off");
    await programs.api("POST", `/runs/${begun.id}/actions/tu_pair/decision`, { allow: true });
    const command = await programs.until("the command's card", () => programs.api("GET", `/runs/${begun.id}`), (run) => run.status === "waiting_approval" && run.actions.some((action) => action.id === "tu_bash" && action.status === "waiting_approval"));
    assert.equal(command.status, "waiting_approval");
    await programs.api("POST", `/runs/${begun.id}/actions/tu_bash/decision`, { allow: true });
    const done = await untilFinished(programs, begun.id);
    assert.equal(done.status, "completed", done.error);
    const answers = (await programs.journal()).filter((entry) => entry.permission);
    assert.deepEqual(answers.map((entry) => [entry.permission, entry.response.behavior]), [["tu_manual", "deny"], ["tu_free", "allow"], ["tu_pair", "allow"], ["tu_bash", "allow"]]);
    assert.match(answers[0].response.message, /locked/);
    assert.equal(done.actions.find((item) => item.id === "tu_manual").status, "denied");
    assert.equal(await readFile(path.join(folder, "probe.py"), "utf8"), "by bash\n");
    // The comparison comes after the run says it finished.
    const { items: events } = await programs.until("the comparison", () => programs.api("GET", `${route}/events`), (answer) => answer.items.length > 1);
    assert.deepEqual(events.map((event) => event.kind), ["refused", "integrity_changed"]);
    assert.deepEqual(events[1].paths, ["probe.py"]);
  } finally {
    await programs.stop();
  }
});

test("Codex: nothing can refuse its file writes, so they are compared after its turn", async () => {
  const programs = await startWithPrograms();
  try {
    const home = await realpath(programs.folder);
    const folder = path.join(home, "project");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "probe.py"), "start\n");
    const project = await programs.api("POST", "/projects", { path: folder, grant: true });
    const route = `/projects/${project.id}/research`;
    await programs.api("PUT", `${route}/policy`, { expectedRevision: 0, locked: ["probe.py"] });
    const connection = await programs.api("POST", "/connections/models", { provider: "codex", model: "the-model" });
    const agent = await programs.api("POST", "/agents", { name: "Coder", modelConnectionId: connection.id, autonomy: "bypass" });
    const thread = await programs.api("POST", `/agents/${agent.id}/threads`, { title: "Work", projectId: project.id });
    await programs.scenario({ steps: [
      { write: { path: path.join(folder, "probe.py"), content: "by codex\n" } },
      { send: { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } } },
    ] });
    const begun = await programs.api("POST", `/agents/${agent.id}/runs`, { input: "go", threadId: thread.id, projectId: project.id });
    await untilFinished(programs, begun.id);
    assert.equal(await readFile(path.join(folder, "probe.py"), "utf8"), "by codex\n");
    // The comparison comes after the run says it finished.
    const { items: events } = await programs.until("the comparison", () => programs.api("GET", `${route}/events`), (answer) => answer.items.length > 0);
    assert.deepEqual(events.map((event) => [event.kind, event.paths, event.afterTool]), [["integrity_changed", ["probe.py"], "Codex"]]);
  } finally {
    await programs.stop();
  }
});
test("Codex in a Pair chat only reads, because it cannot ask before it writes", async () => {
  const programs = await startWithPrograms();
  try {
    const folder = path.join(await realpath(programs.folder), "project");
    await mkdir(folder, { recursive: true });
    const project = await programs.api("POST", "/projects", { path: folder, grant: true });
    const connection = await programs.api("POST", "/connections/models", { provider: "codex", model: "the-model" });
    const agent = await programs.api("POST", "/agents", { name: "Coder", modelConnectionId: connection.id, autonomy: "bypass" });
    const thread = await programs.api("POST", `/agents/${agent.id}/threads`, { title: "Work", projectId: project.id });
    await programs.api("PATCH", `/threads/${thread.id}`, { chatMode: "pair" });
    await programs.scenario({ steps: [{ send: { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } } }] });
    const begun = await programs.api("POST", `/agents/${agent.id}/runs`, { input: "go", threadId: thread.id });
    const done = await untilFinished(programs, begun.id);
    assert.equal(done.mode, "ask");
    const [program] = (await programs.journal()).filter((entry) => entry.args);
    assert.match(program.args.join(" "), /read-only/);
  } finally {
    await programs.stop();
  }
});
