// Plugins as Claude Code lays them out, whichever language installs them: nothing of theirs runs until the user allows it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { hookCommand, logged, open } from "./config-harness.mjs";

let saturn;

before(async () => {
  saturn = await open();
});
after(async () => {
  await saturn?.close();
});

/** The files of a plugin laid out as Claude Code's are: .claude-plugin/plugin.json, skills/, commands/, hooks/hooks.json, .mcp.json. */
const claudeLayout = (name) => ({
  ".claude-plugin/plugin.json": { name, description: "Review helpers", version: "1.2.0" },
  "skills/security-review/SKILL.md": "---\nname: security-review\ndescription: Look for injection and secrets\n---\nCheck every input.",
  "commands/pr-summary.md": "---\ndescription: Summarize a PR\n---\nSummarize $ARGUMENTS.",
  "hooks/hooks.json": { hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/scripts/format.sh" }] }] } },
  ".mcp.json": { mcpServers: { tracker: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js"], env: { TOKEN_FILE: "${CLAUDE_PLUGIN_ROOT}/token" } } } },
});

test("a plugin in Claude Code's layout brings its skills, commands, held hooks and held servers; off silences them and removing clears them", async () => {
  const source = await saturn.folder("review-kit", claudeLayout("review-kit"));
  const installed = await saturn.api("POST", "/plugins", { source });
  const folder = path.join(saturn.dataDir, "plugins/review-kit");
  assert.equal(installed.name, "review-kit");
  assert.equal(installed.version, "1.2.0");
  assert.equal(installed.enabled, true);
  assert.deepEqual(installed.skills, ["security-review"]);
  assert.deepEqual(installed.commands, ["pr-summary"]);
  assert.equal(installed.path, folder);
  assert.ok(await stat(path.join(folder, "skills/security-review/SKILL.md")), "copied into the data folder");
  assert.deepEqual(installed.hooks, [{ event: "post_tool", matcher: "files", command: `${folder}/scripts/format.sh` }]);
  assert.equal(installed.hooksApproved, false);

  // Skills and commands are offered everywhere; a personal skill of the same name wins.
  assert.deepEqual((await saturn.api("GET", "/skills")).map((item) => [item.name, item.source]), [["security-review", "plugin"]]);
  assert.deepEqual((await saturn.api("GET", "/commands")).map((item) => [item.name, item.source]), [["pr-summary", "plugin"]]);
  assert.equal((await saturn.api("POST", "/commands/pr-summary/expand", { arguments: "#7" })).prompt, "Summarize #7.");
  await saturn.folder("data/skills", { "security-review/SKILL.md": "---\nname: security-review\ndescription: Mine\n---\nMine." });
  assert.deepEqual((await saturn.api("GET", "/skills")).map((item) => [item.name, item.source]), [["security-review", "user"]]);

  // Its hooks are listed but held.
  const held = (await saturn.api("GET", "/hooks")).find((item) => item.source === "plugin");
  assert.equal(held.approved, false);
  assert.equal(held.path, "review-kit");
  await saturn.refused("POST", "/plugins/review-kit/hooks/approve", { fingerprint: "0".repeat(64) }, 409, /changed since you looked/);

  // Its server is a connection that waits for the usual approval of its exact command.
  const server = (await saturn.api("GET", "/connections/mcp")).find((item) => item.pluginName === "review-kit");
  assert.equal(server.name, "review-kit: tracker");
  assert.deepEqual(server.command.args, [`${folder}/server.js`]);
  assert.deepEqual(server.command.env, ["TOKEN_FILE"], "names only");
  assert.equal(server.approval, "needed");
  await saturn.refused("POST", `/connections/mcp/${server.id}/discover`, undefined, 409, /Allow it in Saturn Settings/);
  assert.equal(installed.mcpServers[0].id, server.id);

  // Off: silent, and its server gone. On again: back, and still not allowed.
  await saturn.api("PATCH", "/plugins/review-kit", { enabled: false });
  assert.ok(!(await saturn.api("GET", "/connections/mcp")).some((item) => item.pluginName === "review-kit"));
  assert.ok(!(await saturn.api("GET", "/hooks")).some((item) => item.source === "plugin"));
  assert.deepEqual(await saturn.api("GET", "/commands"), []);
  await saturn.api("PATCH", "/plugins/review-kit", { enabled: true });
  const back = (await saturn.api("GET", "/connections/mcp")).filter((item) => item.pluginName === "review-kit");
  assert.equal(back.length, 1);
  assert.equal(back[0].approval, "needed");

  await saturn.refused("POST", "/plugins", { source }, 409, /installed already/);
  await saturn.refused("POST", "/plugins", { source: "relative/path" }, 400, /absolute folder path or an https/);
  await saturn.api("DELETE", "/plugins/review-kit");
  assert.deepEqual(await saturn.api("GET", "/plugins"), []);
  assert.ok(!(await saturn.api("GET", "/connections/mcp")).some((item) => item.pluginName === "review-kit"));
  assert.ok(!(await saturn.api("GET", "/hooks")).some((item) => item.source === "plugin"));
  await assert.rejects(stat(folder), "its files are removed");
  await saturn.api("DELETE", "/plugins/review-kit", undefined, [404]);
  await saturn.refused("PATCH", "/plugins/review-kit", { enabled: true }, 404);
  await saturn.refused("POST", "/plugins/review-kit/hooks/approve", { fingerprint: "x" }, 404);
});

test("a git checkout installs as a folder without its .git, and only https and ssh URLs are cloned", async () => {
  const repo = await saturn.folder("git-kit", claudeLayout("git-kit"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "plugin");
  await saturn.refused("POST", "/plugins", { source: `file://${repo}` }, 400, /absolute folder path or an https/);
  const installed = await saturn.api("POST", "/plugins", { source: repo });
  assert.equal(installed.name, "git-kit");
  await assert.rejects(stat(path.join(installed.path, ".git")), "no .git is copied");
  await saturn.api("DELETE", "/plugins/git-kit");
});

test("a plugin's hooks run only once its exact set is allowed, stop when it is off, and a changed set asks again", async () => {
  const log = path.join(saturn.scratch, "plugin-hook.log");
  const source = await saturn.folder("hook-kit", { "plugin.json": { name: "hook-kit" }, "hooks/placeholder": "" });
  const command = await hookCommand(source, "gate", log, 'note(input.tool_name + " " + process.env.SATURN_HOOK_EVENT);');
  await writeFile(path.join(source, "hooks/hooks.json"), JSON.stringify({ hooks: [{ event: "pre_tool", matcher: "code", command }] }));
  const plugin = await saturn.api("POST", "/plugins", { source });
  assert.deepEqual(plugin.hooks, [{ event: "pre_tool", matcher: "code", command }]);
  const setup = await saturn.chat({ root: await saturn.folder("plugin-hook-chat"), autonomy: "bypass" });

  assert.equal(await saturn.verdict(setup, "echo held"), "completed");
  assert.deepEqual(await logged(log), [], "held: it did not run");

  assert.equal((await saturn.api("POST", "/plugins/hook-kit/hooks/approve", { fingerprint: plugin.hooksFingerprint })).hooksApproved, true);
  assert.equal(await saturn.verdict(setup, "echo allowed"), "completed");
  assert.deepEqual(await logged(log), ["code pre_tool"]);

  await saturn.api("PATCH", "/plugins/hook-kit", { enabled: false });
  assert.equal(await saturn.verdict(setup, "echo off"), "completed");
  assert.equal((await logged(log)).length, 1, "off: it did not run");
  await saturn.api("PATCH", "/plugins/hook-kit", { enabled: true });
  assert.equal(await saturn.verdict(setup, "echo on"), "completed");
  assert.equal((await logged(log)).length, 2, "the approval outlasts turning it off");

  // The copy in the data folder is edited: that is a different set, so it is held again.
  const copy = path.join(plugin.path, "hooks/hooks.json");
  await writeFile(copy, (await readFile(copy, "utf8")).replace('"code"', '"code|files"'));
  const changed = (await saturn.api("GET", "/plugins")).find((item) => item.name === "hook-kit");
  assert.equal(changed.hooksApproved, false);
  assert.notEqual(changed.hooksFingerprint, plugin.hooksFingerprint);
  assert.equal(await saturn.verdict(setup, "echo changed"), "completed");
  assert.equal((await logged(log)).length, 2, "changed: it did not run");
  await saturn.api("DELETE", "/plugins/hook-kit");
});

test("a plugin with no hooks has nothing to allow", async () => {
  await saturn.api("POST", "/plugins", { source: await saturn.folder("quiet-kit", { "plugin.json": { name: "quiet-kit" } }) });
  await saturn.refused("POST", "/plugins/quiet-kit/hooks/approve", { fingerprint: "x" }, 400, /has no hooks/);
  await saturn.api("DELETE", "/plugins/quiet-kit");
});
