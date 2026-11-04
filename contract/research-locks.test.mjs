// Per-file AI involvement and locks, on every kind of backend. It is a workflow constraint, not a security boundary, and
// docs/research-contract.md says what each backend can enforce: these tests hold it to exactly that.
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench, command, posixOnly, sha, until, write } from "./files-support.mjs";
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
  const policy = (modes, locked = []) => saturn.api("PUT", `${route}/policy`, { expectedRevision: 0, modes, locked });
  const events = async () => (await saturn.api("GET", `${route}/events`)).items;
  return { ...setup, folder, route, policy, events };
}

const text = (folder, name) => readFile(path.join(folder, name), "utf8");

test("a policy needs the revision it was based on and a known mode", async () => {
  const { route } = await bed();
  assert.deepEqual((await saturn.api("GET", `${route}/policy`)).modes, {});
  assert.equal((await saturn.call("PUT", `${route}/policy`, { modes: {} })).status, 400);
  assert.equal((await saturn.call("PUT", `${route}/policy`, { expectedRevision: 0, modes: { "a.py": "maybe" } })).status, 400);
  assert.equal((await saturn.api("PUT", `${route}/policy`, { expectedRevision: 0, modes: { "a.py": "manual" } })).revision, 1);
  assert.equal((await saturn.call("PUT", `${route}/policy`, { expectedRevision: 0, modes: {} })).status, 409);
});

test("an agent's file tool cannot write a Manual file, and the refusal is recorded as confirmed", async () => {
  const { folder, policy, events, turn } = await bed();
  await policy({ "probe.py": "manual" });
  const run = await turn([write("probe.py", "agent\n")]);
  assert.equal(run.actions[0].status, "failed");
  assert.match(run.actions[0].reason, /Manual mode/);
  assert.equal(await text(folder, "probe.py"), "mine\n");
  const [event] = await events();
  assert.equal(event.kind, "refused");
  assert.equal(event.path, "probe.py");
  assert.equal(event.runId, run.id);
});

test("a patch cannot reach a Manual file, even as one of several", async () => {
  const { folder, policy, turn } = await bed();
  await policy({ "probe.py": "manual" });
  const patch = "*** Begin Patch\n*** Update File: data.py\n@@\n-theirs\n+changed\n*** Update File: probe.py\n@@\n-mine\n+changed\n*** End Patch\n";
  const run = await turn([["files", { action: "patch", patch }]]);
  assert.equal(run.actions[0].status, "failed");
  assert.equal(await text(folder, "data.py"), "theirs\n", "nothing of the patch applied");
  assert.equal(await text(folder, "probe.py"), "mine\n");
});

test("a folder's mode covers what is in it, and the most specific key wins", async () => {
  const { folder, policy, turn } = await bed();
  await mkdir(path.join(folder, "core"));
  await writeFile(path.join(folder, "core/a.py"), "a\n");
  await writeFile(path.join(folder, "core/b.py"), "b\n");
  await policy({ core: "manual", "core/b.py": "delegate" });
  const run = await turn([[write("core/a.py", "x\n"), write("core/b.py", "y\n"), write("./core/../core/a.py", "z\n")]]);
  assert.deepEqual(run.actions.map((item) => item.status), ["failed", "completed", "failed"]);
  assert.equal(await text(folder, "core/a.py"), "a\n");
  assert.equal(await text(folder, "core/b.py"), "y\n");
});

test("a file with no mode is the agent's to change", async () => {
  const { folder, policy, turn, events } = await bed();
  await policy({ "probe.py": "manual" });
  const run = await turn([write("data.py", "changed\n")]);
  assert.equal(run.actions[0].status, "completed");
  assert.equal(await text(folder, "data.py"), "changed\n");
  assert.deepEqual(await events(), []);
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

test("records cannot be written by an agent's file tool, so neither a verdict nor a policy can", async () => {
  const { folder, route, turn } = await bed();
  const hypothesis = await saturn.api("POST", `${route}/hypotheses`, { title: "H" });
  const file = `.saturn/research/hypotheses/${hypothesis.id}.json`;
  const before = await text(folder, file);
  const run = await turn([[write(file, "{}"), write(".saturn/research/policy.json", "{}")]]);
  assert.deepEqual(run.actions.map((item) => item.status), ["failed", "failed"]);
  assert.equal(await text(folder, file), before);
});

test("a Pair file waits for the user even with approvals off, and an accepted change is recorded", async () => {
  const { folder, policy, events, agent, thread, model } = await bed();
  await policy({ "pair.py": "pair" });
  model.queue.push(write("pair.py", "changed\n"));
  const started = await saturn.api("POST", `/agents/${agent.id}/runs`, { input: "go", threadId: thread.id });
  const waiting = await until("the approval", () => saturn.api("GET", `/runs/${started.id}`), (run) => run.status === "waiting_approval");
  const action = waiting.actions[0];
  assert.match(action.reason, /Pair mode/);
  assert.equal(await text(folder, "pair.py"), "ours\n");
  await saturn.api("POST", `/runs/${started.id}/actions/${action.id}/decision`, { allow: true });
  const run = await saturn.finished(started.id);
  assert.equal(run.actions[0].status, "completed");
  assert.equal(await text(folder, "pair.py"), "changed\n");
  const [event] = await events();
  assert.equal(event.kind, "assisted");
  assert.equal(event.path, "pair.py");
  assert.equal(event.policyRevision, 1);
  assert.equal(event.changeSha256, sha("changed\n"));
  assert.equal(await text(folder, `.saturn/research/objects/${sha("changed\n")}`), "changed\n");
});

test("a change waiting for approval does not survive its file becoming Manual", async () => {
  const { folder, route, policy, agent, thread, model } = await bed();
  await policy({ "pair.py": "pair" });
  model.queue.push(write("pair.py", "changed\n"));
  const started = await saturn.api("POST", `/agents/${agent.id}/runs`, { input: "go", threadId: thread.id });
  const waiting = await until("the approval", () => saturn.api("GET", `/runs/${started.id}`), (run) => run.status === "waiting_approval");
  await saturn.api("PUT", `${route}/policy`, { expectedRevision: 1, modes: { "pair.py": "manual" } });
  await saturn.api("POST", `/runs/${started.id}/actions/${waiting.actions[0].id}/decision`, { allow: true });
  const run = await saturn.finished(started.id);
  assert.equal(run.actions[0].status, "failed");
  assert.equal(await text(folder, "pair.py"), "ours\n");
});

test("a shell command is not stopped, and its change is recorded without naming who made it", posixOnly, async () => {
  const { folder, policy, events, turn } = await bed();
  await policy({ "probe.py": "manual" });
  await turn([command("printf 'by a shell\\n' > probe.py")]);
  assert.equal(await text(folder, "probe.py"), "by a shell\n", "this is the limit the contract states");
  const [event] = await events();
  assert.equal(event.kind, "integrity_changed");
  assert.deepEqual(event.paths, ["probe.py"]);
  assert.equal(event.actor, undefined);
});

test("a shell writing a record is recorded too", posixOnly, async () => {
  const { route, policy, events, turn } = await bed();
  await policy({ "probe.py": "manual" });
  const hypothesis = await saturn.api("POST", `${route}/hypotheses`, { title: "H" });
  const file = `.saturn/research/hypotheses/${hypothesis.id}.json`;
  await turn([command(`printf '{}' > ${file}`)]);
  const [event] = await events();
  assert.deepEqual(event.paths, [file]);
});

test("a background command's later change is caught at the next tool call", posixOnly, async () => {
  const { policy, events, turn } = await bed();
  await policy({ "probe.py": "manual" });
  const run = await turn([command("sleep 0.2; printf 'late\\n' > probe.py", { background: true }), command("sleep 0.5"), command("true")]);
  assert.equal(run.status, "completed", run.error);
  const found = (await events()).filter((event) => event.kind === "integrity_changed");
  assert.deepEqual(found.flatMap((event) => event.paths), ["probe.py"]);
});

test("the user's own edit during a turn is never recorded as a refusal", posixOnly, async () => {
  const { folder, policy, events, turn } = await bed();
  await policy({ "probe.py": "manual" });
  const editing = writeFile(path.join(folder, "probe.py"), "by me\n");
  await turn([command("sleep 0.1"), command("true")]);
  await editing;
  for (const event of await events()) assert.equal(event.kind === "refused", false);
});

test("Claude Code: its file tools are refused or asked about, and its shell is compared afterwards", posixOnly, async () => {
  const programs = await startWithPrograms();
  try {
    const home = await realpath(programs.folder);
    const folder = path.join(home, "project");
    await mkdir(folder, { recursive: true });
    for (const name of ["probe.py", "pair.py", "other.py"]) await writeFile(path.join(folder, name), "start\n");
    const project = await programs.api("POST", "/projects", { path: folder, grant: true });
    const route = `/projects/${project.id}/research`;
    await programs.api("PUT", `${route}/policy`, { expectedRevision: 0, modes: { "probe.py": "manual", "pair.py": "pair" } });
    const connection = await programs.api("POST", "/connections/models", { provider: "claude-code", model: "the-model" });
    const agent = await programs.api("POST", "/agents", { name: "Coder", modelConnectionId: connection.id, autonomy: "bypass" });
    const thread = await programs.api("POST", `/agents/${agent.id}/threads`, { title: "Work", projectId: project.id });
    await programs.scenario({ steps: [
      { permission: { tool: "Write", input: { file_path: path.join(folder, "probe.py") }, id: "tu_manual", write: { path: path.join(folder, "probe.py"), content: "agent\n" } } },
      { permission: { tool: "Edit", input: { file_path: "other.py" }, id: "tu_free" } },
      { permission: { tool: "Edit", input: { file_path: "pair.py" }, id: "tu_pair" } },
      { permission: { tool: "Bash", input: { command: "x" }, id: "tu_bash", write: { path: path.join(folder, "probe.py"), content: "by bash\n" } } },
      { send: { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s", usage: { input_tokens: 1, output_tokens: 1 } } },
    ] });
    const begun = await programs.api("POST", `/agents/${agent.id}/runs`, { input: "go", threadId: thread.id, projectId: project.id });
    const card = await untilCard(programs, begun.id);
    assert.equal(card.action.id, "tu_pair", "a Pair file asks even with approvals off");
    await programs.api("POST", `/runs/${begun.id}/actions/tu_pair/decision`, { allow: true });
    const done = await untilFinished(programs, begun.id);
    assert.equal(done.status, "completed", done.error);
    const answers = (await programs.journal()).filter((entry) => entry.permission);
    assert.deepEqual(answers.map((entry) => [entry.permission, entry.response.behavior]), [["tu_manual", "deny"], ["tu_free", "allow"], ["tu_pair", "allow"], ["tu_bash", "allow"]]);
    assert.match(answers[0].response.message, /Manual mode/);
    assert.equal(done.actions.find((item) => item.id === "tu_manual").status, "denied");
    assert.equal(await readFile(path.join(folder, "probe.py"), "utf8"), "by bash\n");
    const events = (await programs.api("GET", `${route}/events`)).items;
    assert.deepEqual(events.map((event) => event.kind), ["refused", "integrity_changed"]);
    assert.deepEqual(events[1].paths, ["probe.py"]);
  } finally {
    await programs.stop();
  }
});

test("Codex: nothing can refuse its file writes, so they are compared after its turn", posixOnly, async () => {
  const programs = await startWithPrograms();
  try {
    const home = await realpath(programs.folder);
    const folder = path.join(home, "project");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "probe.py"), "start\n");
    const project = await programs.api("POST", "/projects", { path: folder, grant: true });
    const route = `/projects/${project.id}/research`;
    await programs.api("PUT", `${route}/policy`, { expectedRevision: 0, modes: { "probe.py": "manual" } });
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
    const events = (await programs.api("GET", `${route}/events`)).items;
    assert.deepEqual(events.map((event) => [event.kind, event.paths, event.afterTool]), [["integrity_changed", ["probe.py"], "Codex"]]);
  } finally {
    await programs.stop();
  }
});
