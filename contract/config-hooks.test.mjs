// Hooks around an agent's tool calls and at the end of its turn, whichever language runs them; what comes with a project
// runs only once the user has allowed that exact set.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { hookCommand, logged, open, settled } from "./config-harness.mjs";

let saturn;
let scripts;

before(async () => {
  saturn = await open();
  scripts = await saturn.folder("scripts");
});
after(async () => {
  await saturn?.close();
});
// The user's hooks apply to every test's chats.
beforeEach(async () => {
  await saturn.api("PUT", "/hooks", { hooks: [] });
});

test("pre_tool blocks or allows ahead of the approval mode, post_tool adds feedback the model hears, and hooks run in the project", async () => {
  const root = await saturn.folder("user-hooks");
  const log = path.join(saturn.scratch, "user-hooks.log");
  const note = 'note(input.event + " " + input.tool + " " + process.cwd());';
  await saturn.api("PUT", "/hooks", {
    hooks: [
      { event: "pre_tool", matcher: "code", command: await hookCommand(scripts, "gate", log, `${note} if (String(input.arguments.command).includes("blocked")) { process.stderr.write("no blocked commands here"); process.exit(2); } process.stdout.write(JSON.stringify({ decision: "allow", reason: "the gate allows it" }));`) },
      { event: "post_tool", matcher: "code", command: await hookCommand(scripts, "lint", log, `${note} process.stderr.write("post-check: remember the changelog"); process.exit(2);`) },
      { event: "pre_tool", matcher: "files", command: await hookCommand(scripts, "never", log, 'note("the files hook ran");') },
    ],
  });
  const setup = await saturn.chat({ root, steps: [["code", { command: "echo blocked-one" }], ["code", { command: "echo hi" }]] });
  const run = await saturn.finished((await saturn.start(setup, "do it")).id);
  assert.equal(run.status, "completed", run.error);
  const [blocked, allowed] = run.actions;
  assert.equal(blocked.status, "denied");
  assert.match(blocked.reason, /Blocked by a hook: no blocked commands here/);
  assert.equal(allowed.status, "completed", "allowed by the hook: no card, even in Review mode");
  assert.equal(allowed.result.hookFeedback, "post-check: remember the changelog");
  assert.match(JSON.stringify(setup.model.requests.at(-1).messages), /remember the changelog/, "the model hears it");
  const events = await logged(log);
  assert.deepEqual(events.map((line) => line.split(" ").slice(0, 2).join(" ")), ["pre_tool code", "pre_tool code", "post_tool code"], "a blocked call has no post_tool, and another tool's hook did not run");
  assert.ok(events.every((line) => line.endsWith(` ${root}`)), JSON.stringify(events));
});

test("a pre_tool hook's answer counts like a rule, the stricter one winning, and a hook that fails decides nothing", async () => {
  const root = await saturn.folder("answers");
  const setup = await saturn.chat({ root, autonomy: "bypass" });
  const answer = async (text, code = 0) => saturn.api("PUT", "/hooks", { hooks: [{ event: "pre_tool", matcher: "code", command: await hookCommand(scripts, "answer", path.join(saturn.scratch, "answers.log"), `process.stdout.write(${JSON.stringify(text)}); process.exit(${code});`) }] });

  await answer(JSON.stringify({ decision: "deny", reason: "not today" }));
  setup.model.queue.push(["code", { command: "echo a" }]);
  let run = await saturn.finished((await saturn.start(setup)).id);
  assert.equal(run.actions[0].status, "denied");
  assert.match(run.actions[0].reason, /Blocked by a hook: not today/);

  await answer(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "Claude Code's way" } }));
  setup.model.queue.push(["code", { command: "echo b" }]);
  run = await saturn.finished((await saturn.start(setup)).id);
  assert.match(run.actions[0].reason, /Blocked by a hook: Claude Code's way/);

  await answer(JSON.stringify({ decision: "ask", reason: "look at this first" }));
  setup.model.queue.push(["code", { command: "echo c" }]);
  const asked = await saturn.start(setup);
  const { action } = await saturn.card(asked.id);
  assert.equal(action.reason, "look at this first", "asks even an agent that runs without asking");
  await saturn.api("POST", `/runs/${asked.id}/actions/${action.id}/decision`, { allow: false });
  await saturn.finished(asked.id);

  // A rule that denies or asks beats a hook that allows.
  await answer(JSON.stringify({ decision: "allow" }));
  const projectId = setup.project.id;
  await saturn.api("POST", "/permissions/rules", { scope: "project", projectId, rule: { tool: "code", pattern: "rm *", effect: "deny" } });
  await saturn.api("POST", "/permissions/rules", { scope: "project", projectId, rule: { tool: "code", pattern: "touch *", effect: "ask" } });
  assert.equal(await saturn.verdict(setup, "rm -rf dist"), "denied");
  assert.equal(await saturn.verdict(setup, "touch x"), "asked");

  // Exit 1 is the hook's own failure: logged, and the call goes on as if it were not there.
  await answer(JSON.stringify({ decision: "deny", reason: "ignored" }), 1);
  assert.equal(await saturn.verdict(setup, "echo d"), "completed");
  // So is an answer that is not JSON.
  await answer("nothing to say");
  assert.equal(await saturn.verdict(setup, "echo e"), "completed");
});

test("a project file's stop hook waits for that exact set; then it sends one follow-up and accepts; editing the file withdraws the approval", async () => {
  const root = await saturn.folder("stop-hook");
  const log = path.join(saturn.scratch, "stop-hook.log");
  const marker = path.join(saturn.scratch, "stopped-once");
  const command = await hookCommand(scripts, "stop", log, `note(input.event + " " + input.output); const seen = fs.existsSync(${JSON.stringify(marker)}); fs.writeFileSync(${JSON.stringify(marker)}, "1"); if (!seen) { process.stderr.write("tests are not green yet"); process.exit(2); }`);
  await saturn.folder("stop-hook", { ".saturn/hooks.json": { hooks: [{ event: "stop", command }, { event: "never", command: "ignored" }] } });
  const setup = await saturn.chat({ root, autonomy: "bypass" });
  const projectId = setup.project.id;
  const fileSet = async () => (await saturn.api("GET", `/hooks?projectId=${projectId}`)).find((item) => item.source === "project-file");

  const held = await fileSet();
  assert.equal(held.approved, false);
  assert.equal(held.path, ".saturn/hooks.json");
  assert.deepEqual(held.hooks, [{ event: "stop", command }], "what is not a hook is left out");
  assert.equal((await saturn.finished((await saturn.start(setup, "first")).id)).status, "completed");
  await saturn.stays("the held hook staying quiet", () => logged(log), (lines) => lines.length === 0, 400);

  await saturn.refused("POST", `/projects/${projectId}/hooks/approve`, { file: ".saturn/hooks.json", fingerprint: "0".repeat(64) }, 409, /changed since you looked/);
  await saturn.refused("POST", `/projects/${projectId}/hooks/approve`, { file: ".claude/settings.json", fingerprint: held.fingerprint }, 404, /has no hooks/);
  await saturn.api("POST", `/projects/${projectId}/hooks/approve`, { file: ".saturn/hooks.json", fingerprint: held.fingerprint });
  assert.equal((await fileSet()).approved, true);

  const second = await saturn.finished((await saturn.start(setup, "once more")).id);
  assert.equal(second.status, "completed");
  // The hook objects once: a follow-up starts with its message, and after that turn it accepts.
  const messages = () => saturn.api("GET", `/agents/${setup.agent.id}/messages?threadId=${setup.thread.id}`);
  const followUp = await saturn.until("the follow-up", messages, (runs) => runs.some((item) => item.automatic && settled(item)));
  const automatic = followUp.filter((item) => item.automatic);
  assert.equal(automatic.length, 1);
  assert.match(automatic[0].input, /A stop hook did not accept this turn:[\s\S]*tests are not green yet/);
  await saturn.until("the follow-up's own stop hook", () => logged(log), (lines) => lines.length === 2);
  await saturn.stays("one follow-up only", messages, (runs) => runs.filter((item) => item.automatic).length === 1, 400);

  // Editing the file withdraws the approval, and the hook no longer runs.
  await writeFile(path.join(root, ".saturn/hooks.json"), JSON.stringify({ hooks: [{ event: "stop", command: `${command} --changed` }] }));
  assert.equal((await fileSet()).approved, false);
  await saturn.finished((await saturn.start(setup, "after the edit")).id);
  await saturn.stays("the changed hook staying quiet", () => logged(log), (lines) => lines.length === 2, 400);
});

test("a stop hook that never accepts gets two follow-ups, then it is left to the user", async () => {
  const log = path.join(saturn.scratch, "insisting.log");
  await saturn.api("PUT", "/hooks", { hooks: [{ event: "stop", command: await hookCommand(scripts, "insist", log, 'note("stop"); process.stderr.write("again"); process.exit(2);') }] });
  const setup = await saturn.chat({ root: await saturn.folder("insisting"), autonomy: "bypass" });
  await saturn.finished((await saturn.start(setup, "work")).id);
  await saturn.until("three stop hooks", () => logged(log), (lines) => lines.length === 3);
  const messages = () => saturn.api("GET", `/agents/${setup.agent.id}/messages?threadId=${setup.thread.id}`);
  await saturn.stays("two follow-ups only", messages, (runs) => runs.filter((item) => item.automatic).length <= 2, 500);
  assert.equal((await messages()).filter((item) => item.automatic).length, 2);
});

test("hooks in Claude Code's settings file are translated, wait for approval, and stop when revoked", async () => {
  const root = await saturn.folder("claude-hooks");
  const log = path.join(saturn.scratch, "claude-hooks.log");
  const command = await hookCommand(scripts, "claude", log, 'note(input.hook_event_name + " " + input.tool_name + " " + JSON.stringify(input.tool_input));');
  await saturn.folder("claude-hooks", {
    ".claude/settings.json": { hooks: {
      PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command, timeout: 5 }] }],
      Notification: [{ hooks: [{ type: "command", command: "not one of ours" }] }],
    } },
  });
  const setup = await saturn.chat({ root, autonomy: "bypass" });
  const projectId = setup.project.id;
  const held = (await saturn.api("GET", `/hooks?projectId=${projectId}`)).find((item) => item.source === "claude-file");
  assert.equal(held.approved, false);
  assert.deepEqual(held.hooks, [{ event: "post_tool", matcher: "code", command, timeoutMs: 5000 }]);
  assert.equal(await saturn.verdict(setup, "echo held"), "completed");
  assert.deepEqual(await logged(log), [], "it did not run");

  await saturn.api("POST", `/projects/${projectId}/hooks/approve`, { file: ".claude/settings.json", fingerprint: held.fingerprint });
  assert.equal(await saturn.verdict(setup, "echo allowed"), "completed");
  assert.deepEqual(await logged(log), ['post_tool code {"command":"echo allowed"}']);

  const revoked = await saturn.api("DELETE", `/projects/${projectId}/hooks/approve`, { file: ".claude/settings.json" });
  assert.equal(revoked.find((item) => item.source === "claude-file").approved, false);
  assert.equal(await saturn.verdict(setup, "echo revoked"), "completed");
  assert.equal((await logged(log)).length, 1);
});

test("the user's hooks are checked when saved", async () => {
  for (const hooks of [undefined, "x", [{ event: "later", command: "x" }], [{ event: "stop" }], [{ event: "stop", command: "  " }], [{ event: "pre_tool", command: "x", matcher: 3 }]]) {
    await saturn.refused("PUT", "/hooks", { hooks }, 400, /needs an event/);
  }
  const [user] = await saturn.api("PUT", "/hooks", { hooks: [{ event: "stop", matcher: "  ", command: " true ", timeoutMs: 2000 }] });
  assert.equal(user.source, "user");
  assert.equal(user.approved, true);
  assert.deepEqual(user.hooks, [{ event: "stop", command: "true", timeoutMs: 2000 }]);
  await saturn.restart();
  assert.deepEqual((await saturn.api("GET", "/hooks")).find((item) => item.source === "user").hooks, user.hooks, "saved");
});
