// Plugins as Claude Code lays them out, whichever language installs them: nothing of theirs runs until the user allows it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { hookCommand, logged, open } from "./config-harness.mjs";

let workbench;

before(async () => {
  workbench = await open();
});
after(async () => {
  await workbench?.close();
});

/** The files of a plugin laid out as Claude Code's are: .claude-plugin/plugin.json, skills/, commands/ (which the app does not use), hooks/hooks.json, .mcp.json. */
const claudeLayout = (name) => ({
  ".claude-plugin/plugin.json": { name, description: "Review helpers", version: "1.2.0" },
  "skills/security-review/SKILL.md": "---\nname: security-review\ndescription: Look for injection and secrets\n---\nCheck every input.",
  "commands/pr-summary.md": "---\ndescription: Summarize a PR\n---\nSummarize $ARGUMENTS.",
  "hooks/hooks.json": { hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/scripts/format.sh" }] }] } },
  ".mcp.json": { mcpServers: { tracker: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js"], env: { TOKEN_FILE: "${CLAUDE_PLUGIN_ROOT}/token" } } } },
});

test("a plugin in Claude Code's layout brings its skills, held hooks and held servers; off silences them and removing clears them", async () => {
  const source = await workbench.folder("review-kit", claudeLayout("review-kit"));
  const installed = await workbench.api("POST", "/plugins", { source });
  const folder = path.join(workbench.dataDir, "plugins/review-kit");
  assert.equal(installed.name, "review-kit");
  assert.equal(installed.version, "1.2.0");
  assert.equal(installed.enabled, true);
  assert.deepEqual(installed.skills, ["security-review"]);
  assert.equal(installed.commands, undefined, "its prompt commands are not offered");
  assert.equal(installed.path, folder);
  assert.ok(await stat(path.join(folder, "skills/security-review/SKILL.md")), "copied into the data folder");
  assert.deepEqual(installed.hooks, [{ event: "post_tool", matcher: "files", command: `${folder}/scripts/format.sh` }]);
  assert.equal(installed.hooksApproved, false);

  // Skills are offered everywhere; a personal skill of the same name wins.
  assert.deepEqual((await workbench.api("GET", "/skills")).map((item) => [item.name, item.source]), [["security-review", "plugin"]]);
  await workbench.folder("data/skills", { "security-review/SKILL.md": "---\nname: security-review\ndescription: Mine\n---\nMine." });
  assert.deepEqual((await workbench.api("GET", "/skills")).map((item) => [item.name, item.source]), [["security-review", "user"]]);

  // Its hooks are listed but held.
  const held = (await workbench.api("GET", "/hooks")).find((item) => item.source === "plugin");
  assert.equal(held.approved, false);
  assert.equal(held.path, "review-kit");
  await workbench.refused("POST", "/plugins/review-kit/hooks/approve", { fingerprint: "0".repeat(64) }, 409, /changed since you looked/);

  // Its server is a connection that waits for the usual approval of its exact command.
  const server = (await workbench.api("GET", "/connections/mcp")).find((item) => item.pluginName === "review-kit");
  assert.equal(server.name, "review-kit: tracker");
  assert.deepEqual(server.command.args, [`${folder}/server.js`]);
  assert.deepEqual(server.command.env, ["TOKEN_FILE"], "names only");
  assert.equal(server.approval, "needed");
  await workbench.refused("POST", `/connections/mcp/${server.id}/discover`, undefined, 409, /Allow it in the app Settings/);
  assert.equal(installed.mcpServers[0].id, server.id);

  // Off: silent, and its server gone. On again: back, and still not allowed.
  await workbench.api("PATCH", "/plugins/review-kit", { enabled: false });
  assert.ok(!(await workbench.api("GET", "/connections/mcp")).some((item) => item.pluginName === "review-kit"));
  assert.ok(!(await workbench.api("GET", "/hooks")).some((item) => item.source === "plugin"));
  await workbench.api("PATCH", "/plugins/review-kit", { enabled: true });
  const back = (await workbench.api("GET", "/connections/mcp")).filter((item) => item.pluginName === "review-kit");
  assert.equal(back.length, 1);
  assert.equal(back[0].approval, "needed");

  await workbench.refused("POST", "/plugins", { source }, 409, /installed already/);
  await workbench.refused("POST", "/plugins", { source: "relative/path" }, 400, /absolute folder path or an https/);
  await workbench.api("DELETE", "/plugins/review-kit");
  assert.deepEqual(await workbench.api("GET", "/plugins"), []);
  assert.ok(!(await workbench.api("GET", "/connections/mcp")).some((item) => item.pluginName === "review-kit"));
  assert.ok(!(await workbench.api("GET", "/hooks")).some((item) => item.source === "plugin"));
  await assert.rejects(stat(folder), "its files are removed");
  await workbench.api("DELETE", "/plugins/review-kit", undefined, [404]);
  await workbench.refused("PATCH", "/plugins/review-kit", { enabled: true }, 404);
  await workbench.refused("POST", "/plugins/review-kit/hooks/approve", { fingerprint: "x" }, 404);
});

test("a git checkout installs as a folder without its .git, and only https and ssh URLs are cloned", async () => {
  const repo = await workbench.folder("git-kit", claudeLayout("git-kit"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "plugin");
  await workbench.refused("POST", "/plugins", { source: `file://${repo}` }, 400, /absolute folder path or an https/);
  const installed = await workbench.api("POST", "/plugins", { source: repo });
  assert.equal(installed.name, "git-kit");
  await assert.rejects(stat(path.join(installed.path, ".git")), "no .git is copied");
  await workbench.api("DELETE", "/plugins/git-kit");
});

test("a plugin's hooks run only once its exact set is allowed, stop when it is off, and a changed set asks again", async () => {
  const log = path.join(workbench.scratch, "plugin-hook.log");
  const source = await workbench.folder("hook-kit", { "plugin.json": { name: "hook-kit" }, "hooks/placeholder": "" });
  const command = await hookCommand(source, "gate", log, 'note(input.tool_name + " " + process.env.WORKBENCH_HOOK_EVENT);');
  await writeFile(path.join(source, "hooks/hooks.json"), JSON.stringify({ hooks: [{ event: "pre_tool", matcher: "code", command }] }));
  const plugin = await workbench.api("POST", "/plugins", { source });
  assert.deepEqual(plugin.hooks, [{ event: "pre_tool", matcher: "code", command }]);
  const setup = await workbench.chat({ root: await workbench.folder("plugin-hook-chat"), autonomy: "bypass" });

  assert.equal(await workbench.verdict(setup, "echo held"), "completed");
  assert.deepEqual(await logged(log), [], "held: it did not run");

  assert.equal((await workbench.api("POST", "/plugins/hook-kit/hooks/approve", { fingerprint: plugin.hooksFingerprint })).hooksApproved, true);
  assert.equal(await workbench.verdict(setup, "echo allowed"), "completed");
  assert.deepEqual(await logged(log), ["code pre_tool"]);

  await workbench.api("PATCH", "/plugins/hook-kit", { enabled: false });
  assert.equal(await workbench.verdict(setup, "echo off"), "completed");
  assert.equal((await logged(log)).length, 1, "off: it did not run");
  await workbench.api("PATCH", "/plugins/hook-kit", { enabled: true });
  assert.equal(await workbench.verdict(setup, "echo on"), "completed");
  assert.equal((await logged(log)).length, 2, "the approval outlasts turning it off");

  // The copy in the data folder is edited: that is a different set, so it is held again.
  const copy = path.join(plugin.path, "hooks/hooks.json");
  await writeFile(copy, (await readFile(copy, "utf8")).replace('"code"', '"code|files"'));
  const changed = (await workbench.api("GET", "/plugins")).find((item) => item.name === "hook-kit");
  assert.equal(changed.hooksApproved, false);
  assert.notEqual(changed.hooksFingerprint, plugin.hooksFingerprint);
  assert.equal(await workbench.verdict(setup, "echo changed"), "completed");
  assert.equal((await logged(log)).length, 2, "changed: it did not run");
  await workbench.api("DELETE", "/plugins/hook-kit");
});

test("a plugin with no hooks has nothing to allow", async () => {
  await workbench.api("POST", "/plugins", { source: await workbench.folder("quiet-kit", { "plugin.json": { name: "quiet-kit" } }) });
  await workbench.refused("POST", "/plugins/quiet-kit/hooks/approve", { fingerprint: "x" }, 400, /has no hooks/);
  await workbench.api("DELETE", "/plugins/quiet-kit");
});
