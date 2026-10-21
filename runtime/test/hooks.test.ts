import { realpathSync } from "node:fs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fromClaudeHooks, matchesTool } from "../src/application/hooks.js";
import type { Run } from "../src/domain/model.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";
import { toolSteps } from "./tool-steps.js";

/** A model that runs `commands` in order, one per turn, then answers "finished"; it records the tool results it saw. */
async function commandModel(commands: string[]) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const messages = (JSON.parse(raw || "{}") as { messages?: { role?: string; content?: string }[] }).messages ?? [];
      const steps = toolSteps(messages);
      const last = steps.length ? JSON.stringify(steps) : "";
      if (last) seen.push(last);
      const done = steps.length;
      const next = commands[done];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: next === undefined ? { content: "finished" } : { content: "", tool_calls: [{ id: `c${done}`, type: "function", function: { name: "code", arguments: JSON.stringify({ command: next }) } }] } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { seen, server, url: `http://127.0.0.1:${address.port}` };
}

async function until(read: () => Run, done: (run: Run) => boolean): Promise<Run> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const run = read();
    if (done(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run stuck at ${read().status}`);
}
const settled = (run: Run) => run.status !== "running" && run.status !== "queued" && run.status !== "waiting_approval";

/** A hook script written to a file, run with node, so the test reads the same on every platform. */
async function hookScript(dir: string, name: string, body: string): Promise<string> {
  const file = path.join(dir, `${name}.cjs`);
  await writeFile(file, `let raw = ""; process.stdin.on("data", (c) => (raw += c)); process.stdin.on("end", () => { const input = JSON.parse(raw); ${body} });`);
  return `"${process.execPath}" "${file}"`;
}

test("matchers and Claude Code's hook format", () => {
  assert.ok(matchesTool(undefined, "code"));
  assert.ok(matchesTool("code|files", "files"));
  assert.ok(matchesTool("github_*", "github_create_issue"));
  assert.ok(!matchesTool("code", "files"));
  assert.deepEqual(fromClaudeHooks({
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./check.sh", timeout: 5 }] }],
    PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "prettier --write" }] }],
    Stop: [{ hooks: [{ type: "command", command: "npm test" }] }],
    Notification: [{ hooks: [{ type: "command", command: "say hi" }] }],
  }), [
    { event: "pre_tool", matcher: "code", command: "./check.sh", timeoutMs: 5000 },
    { event: "post_tool", matcher: "files", command: "prettier --write" },
    { event: "stop", command: "npm test" },
  ]);
});

test("pre_tool blocks or allows, post_tool adds feedback, stop sends a follow-up; project hooks wait for approval", async () => {
  const model = await commandModel(["echo blocked-one", "echo hi", "echo again"]);
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-hooks-"));
  const folder = path.join(directory, "site");
  const scripts = path.join(directory, "scripts");
  await mkdir(folder);
  await mkdir(scripts);
  try {
    const store = new FileStore(path.join(directory, "data"));
    await store.load();
    const { services } = createApp(store);
    const connection = await services.createModel({ name: "Local", provider: "openai", baseUrl: model.url });
    // Review mode: every command would ask, unless a hook allows it.
    const agent = await services.createAgent({ name: "Hooked", modelConnectionId: connection.id, autonomy: "review" });
    const project = await services.createProject({ path: folder });
    await services.setProjectAccess(project.id, true);
    const thread = await services.kernel.runs.createThread(agent.id, "Hooks", project.id);

    const log = path.join(directory, "events.log");
    const record = `require("fs").appendFileSync(${JSON.stringify(log)}, input.event + " " + (input.tool ?? "-") + " " + process.cwd() + "\\n");`;
    await services.kernel.hooks.setUserHooks([
      { event: "pre_tool", matcher: "code", command: await hookScript(scripts, "gate", `${record} if (String(input.arguments.command).includes("blocked")) { process.stderr.write("no blocked commands here"); process.exit(2); } process.stdout.write(JSON.stringify({ decision: "allow", reason: "the gate allows echo" }));`) },
      { event: "post_tool", matcher: "code", command: await hookScript(scripts, "lint", `${record} process.stderr.write("post-check: remember the changelog"); process.exit(2);`) },
    ]);

    // A project file's stop hook: it does not run until allowed.
    await mkdir(path.join(folder, ".saturn"), { recursive: true });
    const stopHook = await hookScript(scripts, "stop", `${record} if (!input.output.includes("finished")) process.exit(0); const seen = require("fs").existsSync(${JSON.stringify(path.join(directory, "stopped-once"))}); require("fs").writeFileSync(${JSON.stringify(path.join(directory, "stopped-once"))}, "1"); if (!seen) { process.stderr.write("tests are not green yet"); process.exit(2); }`);
    await writeFile(path.join(folder, ".saturn", "hooks.json"), JSON.stringify({ hooks: [{ event: "stop", command: stopHook }] }));
    const sets = await services.kernel.hooks.sets(project.id);
    const fileSet = sets.find((set) => set.source === "project-file")!;
    assert.equal(fileSet.approved, false, "a project's hooks need the user's approval");

    const run = await services.startRun(agent.id, "do it", thread.id);
    const done = await until(() => services.kernel.getRun(run.id), settled);
    assert.equal(done.status, "completed", done.error);
    const [blocked, allowed, again] = done.actions;
    assert.equal(blocked?.status, "denied");
    assert.match(blocked?.reason ?? "", /Blocked by a hook: no blocked commands here/);
    assert.equal(allowed?.status, "completed", "allowed by the hook: no approval card even in Review mode");
    assert.equal((allowed?.result as { hookFeedback?: string }).hookFeedback, "post-check: remember the changelog");
    assert.equal(again?.status, "completed");
    assert.ok(model.seen.some((text) => text.includes("remember the changelog")), "the model saw the feedback");
    let events = (await readFile(log, "utf8")).trim().split("\n");
    // Compared resolved: on Windows the hook may see the temp folder's short (8.3) name.
    const real = realpathSync.native(folder);
    assert.ok(events.every((line) => realpathSync.native(line.split(" ").slice(2).join(" ")) === real), `hooks run in the project folder: ${JSON.stringify(events)}`);
    assert.ok(!events.some((line) => line.startsWith("stop")), "the unapproved stop hook did not run");

    // Allowing the exact set: a stale fingerprint is refused, the right one runs it at the next turn's end.
    await assert.rejects(services.kernel.hooks.approve(project.id, ".saturn/hooks.json", "0".repeat(64)), /changed since you looked/);
    await services.kernel.hooks.approve(project.id, ".saturn/hooks.json", fileSet.fingerprint!);
    const second = await services.startRun(agent.id, "once more", thread.id);
    await until(() => services.kernel.getRun(second.id), settled);
    // The stop hook objects once: an automatic follow-up starts with its message, then it accepts.
    const followUp = await until(() => store.state.runs.find((item) => item.threadId === thread.id && item.automatic) ?? ({ status: "running" } as Run), (item) => Boolean(item.id) && settled(item));
    assert.match(followUp.input, /tests are not green yet/);
    // The follow-up's own stop hook runs just after it settles; this time it accepts, so nothing else starts.
    for (let attempt = 0; attempt < 100 && (await readFile(log, "utf8")).split("\n").filter((line) => line.startsWith("stop")).length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    events = (await readFile(log, "utf8")).trim().split("\n");
    assert.equal(events.filter((line) => line.startsWith("stop")).length, 2, "the stop hook ran after the turn and after the follow-up");
    assert.equal(store.state.runs.filter((item) => item.threadId === thread.id && item.automatic).length, 1, "one follow-up only");

    // Editing the file withdraws the approval.
    await writeFile(path.join(folder, ".saturn", "hooks.json"), JSON.stringify({ hooks: [{ event: "stop", command: `${stopHook} --changed` }] }));
    assert.equal((await services.kernel.hooks.sets(project.id)).find((set) => set.source === "project-file")?.approved, false);
    await assert.rejects(services.kernel.hooks.setUserHooks([{ event: "later", command: "x" }]), /needs an event/);
  } finally {
    model.server.close();
  }
});

async function realpath(file: string): Promise<string> {
  return (await import("node:fs/promises")).realpath(file);
}
