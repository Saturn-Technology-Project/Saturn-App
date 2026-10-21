import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Run } from "../src/domain/model.js";
import { commandSegments, fromClaudeRule, matchesRule, resolvePermission, suggestedPattern, type PermissionLayer } from "../src/domain/permissions.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";
import { toolSteps } from "./tool-steps.js";

const code = (command: string) => ({ command });
const layer = (scope: PermissionLayer["scope"], ...rules: PermissionLayer["rules"]): PermissionLayer => ({ scope, rules });

test("shell rules: a trailing * is a prefix, segments are judged one by one, deny beats ask beats allow", () => {
  const allowNpmTest = { tool: "code", pattern: "npm test *", effect: "allow" as const };
  assert.ok(matchesRule(allowNpmTest, "code", code("npm test")));
  assert.ok(matchesRule(allowNpmTest, "code", code("npm   test --watch")));
  assert.ok(!matchesRule(allowNpmTest, "code", code("npm testing")));
  assert.ok(!matchesRule(allowNpmTest, "code", code("npm run test")));
  assert.ok(matchesRule({ tool: "code", pattern: "git * --dry-run *", effect: "allow" }, "code", code("git push --dry-run origin")));

  assert.deepEqual(commandSegments("npm test && git push | tee log; echo 'a;b' || true"), ["npm test", "git push", "tee log", "echo 'a;b'", "true"]);

  const layers = [layer("user", allowNpmTest, { tool: "code", pattern: "git *", effect: "allow" }), layer("project", { tool: "code", pattern: "git push *", effect: "ask" }, { tool: "code", pattern: "rm *", effect: "deny" })];
  assert.equal(resolvePermission(layers, "code", code("npm test"))?.effect, "allow");
  assert.equal(resolvePermission(layers, "code", code("npm test && git status"))?.effect, "allow", "every segment allowed");
  assert.equal(resolvePermission(layers, "code", code("npm test && ls")), undefined, "one segment has no rule: the agent's own mode decides");
  assert.equal(resolvePermission(layers, "code", code("git push origin main"))?.effect, "ask", "ask beats allow");
  assert.equal(resolvePermission(layers, "code", code("npm test; rm -rf dist"))?.effect, "deny", "deny beats everything");
  assert.equal(resolvePermission(layers, "code", code("rm -rf dist"))?.scope, "project");
});

test("file rules: action and path glob; other tools match their first text argument or *", () => {
  const writeSrc = { tool: "files", pattern: "write src/**", effect: "allow" as const };
  assert.ok(matchesRule(writeSrc, "files", { action: "write", path: "src/a/b.ts" }));
  assert.ok(matchesRule(writeSrc, "files", { action: "write", path: "src/top.ts" }));
  assert.ok(matchesRule(writeSrc, "files", { action: "append", path: "src/top.ts" }), "append counts as a write");
  assert.ok(!matchesRule(writeSrc, "files", { action: "write", path: "lib/a.ts" }));
  assert.ok(!matchesRule(writeSrc, "files", { action: "delete", path: "src/a.ts" }));
  assert.ok(matchesRule({ tool: "files", pattern: "read", effect: "allow" }, "files", { action: "read", path: "anything/at/all" }));
  assert.ok(matchesRule({ tool: "files", pattern: "*.md", effect: "deny" }, "files", { action: "write", path: "README.md" }));
  assert.ok(!matchesRule({ tool: "files", pattern: "*.md", effect: "deny" }, "files", { action: "write", path: "docs/README.md" }), "* stays inside one folder");

  assert.ok(matchesRule({ tool: "web", pattern: "*example.com*", effect: "deny" }, "web", { url: "https://example.com/page" }));
  assert.ok(matchesRule({ tool: "github_*", pattern: "*", effect: "ask" }, "github_create_issue", { title: "x" }));
  assert.ok(!matchesRule({ tool: "github_*", pattern: "*", effect: "ask" }, "linear_create_issue", {}));
});

test("Claude Code's permission syntax translates where it can, and Always allow suggests a prefix", () => {
  assert.deepEqual(fromClaudeRule("Bash(npm test:*)", "allow"), { tool: "code", pattern: "npm test *", effect: "allow" });
  assert.deepEqual(fromClaudeRule("Bash(git status)", "allow"), { tool: "code", pattern: "git status", effect: "allow" });
  assert.deepEqual(fromClaudeRule("Read(src/**)", "allow"), { tool: "files", pattern: "read src/**", effect: "allow" });
  assert.deepEqual(fromClaudeRule("Edit", "deny"), { tool: "files", pattern: "write", effect: "deny" });
  assert.deepEqual(fromClaudeRule("WebFetch(domain:example.com)", "allow"), { tool: "web", pattern: "*example.com*", effect: "allow" });
  assert.deepEqual(fromClaudeRule("mcp__github__create_issue", "ask"), { tool: "*create_issue", pattern: "*", effect: "ask" });
  assert.equal(fromClaudeRule("Task", "allow"), undefined);

  assert.equal(suggestedPattern("code", code("npm test --watch")), "npm test *");
  assert.equal(suggestedPattern("code", code("ls -la")), "ls *");
  assert.equal(suggestedPattern("files", { action: "write", path: "src/a/b.ts" }), "write src/a/**");
  assert.equal(suggestedPattern("web", { url: "x" }), "*");
});

/** A model that runs `commands` one per turn, then answers "finished". */
async function commandModel(commands: string[]) {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const messages = (JSON.parse(raw || "{}") as { messages?: { role?: string; content?: string }[] }).messages ?? [];
      // Every tool result so far, however the runtime packs them into messages.
      const done = toolSteps(messages).length;
      const next = commands[done];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        choices: [{
          message: next === undefined
            ? { content: "finished" }
            : { content: "", tool_calls: [{ id: `c${done}`, type: "function", function: { name: "code", arguments: JSON.stringify({ command: next }) } }] },
        }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function until(read: () => Run, done: (run: Run) => boolean): Promise<Run> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const run = read();
    if (done(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`run stuck at ${read().status}`);
}
const settled = (run: Run) => run.status !== "running" && run.status !== "queued" && run.status !== "waiting_approval";

test("rules decide before the approval mode: deny refuses, ask asks, allow skips even Review mode, and Always allow saves a rule", async () => {
  const model = await commandModel(["rm -rf build", "echo hi", "ls -la"]);
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-permissions-"));
  const folder = path.join(directory, "site");
  await mkdir(path.join(folder, ".saturn"), { recursive: true });
  await writeFile(path.join(folder, ".saturn", "settings.json"), JSON.stringify({ permissions: { rules: [{ tool: "code", pattern: "rm *", effect: "deny" }] } }));
  await mkdir(path.join(folder, ".claude"), { recursive: true });
  await writeFile(path.join(folder, ".claude", "settings.json"), JSON.stringify({ permissions: { ask: ["Bash(echo:*)"] } }));
  try {
    const store = new FileStore(path.join(directory, "data"));
    await store.load();
    const { services } = createApp(store);
    const connection = await services.createModel({ name: "Local", provider: "openai", baseUrl: model.url });
    // Review mode: every command would ask, unless a rule allows it.
    const agent = await services.createAgent({ name: "Builder", modelConnectionId: connection.id, autonomy: "review" });
    const project = await services.createProject({ path: folder });
    await services.setProjectAccess(project.id, true);
    const thread = await services.kernel.runs.createThread(agent.id, "Build", project.id);
    await services.kernel.permissions.addRule("user", { tool: "code", pattern: "ls *", effect: "allow" });

    const layers = await services.kernel.permissions.layers({ agentId: agent.id, projectId: project.id });
    assert.deepEqual(layers.map((item) => item.scope), ["user", "project", "project-file", "claude-file", "agent"]);
    assert.deepEqual(layers.find((item) => item.scope === "claude-file")?.rules, [{ tool: "code", pattern: "echo *", effect: "ask" }]);

    const run = await services.startRun(agent.id, "build it", thread.id);
    // 1. `rm -rf build` is denied by the project file: no card, the model is told and moves on.
    // 2. `echo hi` asks (from .claude/settings.json).
    const waiting = await until(() => services.kernel.getRun(run.id), (item) => item.status === "waiting_approval");
    const denied = waiting.actions.find((item) => item.arguments.command === "rm -rf build");
    assert.equal(denied?.status, "denied");
    assert.match(denied?.reason ?? "", /Denied by a permission rule \(\.saturn\/settings\.json: code: rm \*\)/);
    const card = waiting.actions.find((item) => item.status === "waiting_approval");
    assert.equal(card?.arguments.command, "echo hi");
    assert.match(card?.reason ?? "", /\.claude\/settings\.json: code: echo \*/);

    // Always allow: saves `echo *` for this project and approves. Then `ls -la` runs without a card (user rule).
    await services.kernel.permissions.addRule("project", { tool: "code", pattern: "echo *", effect: "allow" }, { projectId: project.id });
    await services.kernel.runs.decide(run.id, card!.id, true);
    const done = await until(() => services.kernel.getRun(run.id), settled);
    assert.equal(done.status, "completed", done.error);
    assert.equal(done.actions.filter((item) => item.toolId === "code").map((item) => item.status).join(","), "denied,completed,completed");
    assert.ok(!done.actions.some((item) => item.arguments.command === "ls -la" && item.status === "waiting_approval"));

    // The project layer holds the saved rule, and removing it empties the layer again.
    const after = await services.kernel.permissions.layers({ projectId: project.id });
    assert.deepEqual(after.find((item) => item.scope === "project")?.rules, [{ tool: "code", pattern: "echo *", effect: "allow" }]);
    await services.kernel.permissions.removeRule("project", { tool: "code", pattern: "echo *", effect: "allow" }, { projectId: project.id });
    assert.deepEqual((await services.kernel.permissions.layers({ projectId: project.id })).find((item) => item.scope === "project")?.rules, []);

    await assert.rejects(services.kernel.permissions.addRule("user", { tool: "code", pattern: "*", effect: "allow" }), /not a rule/);
    await assert.rejects(services.kernel.permissions.addRule("project-file", { tool: "code", pattern: "x", effect: "allow" }, { projectId: project.id }), /edited in that file/);
  } finally {
    model.server.close();
  }
});
