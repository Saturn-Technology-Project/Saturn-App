import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listCommands, listSkills } from "../src/application/skill-files.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

/** A plugin laid out as Claude Code's are: .claude-plugin/plugin.json, skills/, commands/, hooks/hooks.json, .mcp.json. */
async function writePlugin(dir: string, name = "review-kit") {
  await mkdir(path.join(dir, ".claude-plugin"), { recursive: true });
  await writeFile(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name, description: "Review helpers", version: "1.2.0" }));
  await mkdir(path.join(dir, "skills", "security-review"), { recursive: true });
  await writeFile(path.join(dir, "skills", "security-review", "SKILL.md"), "---\nname: security-review\ndescription: Look for injection and secrets\n---\nCheck every input.");
  await mkdir(path.join(dir, "commands"), { recursive: true });
  await writeFile(path.join(dir, "commands", "pr-summary.md"), "---\ndescription: Summarize a PR\n---\nSummarize $ARGUMENTS.");
  await mkdir(path.join(dir, "hooks"), { recursive: true });
  await writeFile(path.join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/scripts/format.sh" }] }] } }));
  await writeFile(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { tracker: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js"], env: { TOKEN_FILE: "${CLAUDE_PLUGIN_ROOT}/token" } } } }));
}

test("a plugin installs from a folder: skills, commands, hooks waiting for approval, MCP servers waiting for approval", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-plugins-"));
  const source = path.join(directory, "source");
  await writePlugin(source);
  const store = new FileStore(path.join(directory, "data"));
  await store.load();
  const { services } = createApp(store);
  const plugins = services.kernel.plugins;

  const installed = await plugins.install(source);
  assert.equal(installed.name, "review-kit");
  assert.equal(installed.version, "1.2.0");
  assert.equal(installed.enabled, true);
  assert.deepEqual(installed.skills, ["security-review"]);
  assert.deepEqual(installed.commands, ["pr-summary"]);
  const folder = path.join(directory, "data", "plugins", "review-kit");
  assert.ok(await stat(path.join(folder, "skills", "security-review", "SKILL.md")), "copied into the data folder");
  assert.deepEqual(installed.hooks, [{ event: "post_tool", matcher: "files", command: `${folder}/scripts/format.sh` }]);
  assert.equal(installed.hooksApproved, false);

  // Skills and commands of a plugin that is on are offered everywhere; a personal skill of the same name wins.
  const userSkills = path.join(directory, "data", "skills");
  assert.deepEqual((await listSkills(undefined, userSkills, plugins.enabledFolders())).map((item) => [item.name, item.source]), [["security-review", "plugin"]]);
  assert.deepEqual((await listCommands(undefined, path.join(directory, "data", "commands"), plugins.enabledFolders())).map((item) => item.name), ["pr-summary"]);

  // Its hooks are listed but do not run until allowed.
  const sets = await services.kernel.hooks.sets();
  const set = sets.find((item) => item.source === "plugin");
  assert.equal(set?.approved, false);
  await assert.rejects(plugins.approveHooks("review-kit", "0".repeat(64)), /changed since you looked/);
  await plugins.approveHooks("review-kit", installed.hooksFingerprint!);
  assert.equal((await services.kernel.hooks.sets()).find((item) => item.source === "plugin")?.approved, true);

  // Its MCP server is a connection that waits for the usual approval of its command.
  const server = store.state.mcp.find((item) => item.pluginName === "review-kit");
  assert.equal(server?.name, "review-kit: tracker");
  assert.deepEqual(server?.command?.args, [`${folder}/server.js`]);
  assert.equal(server?.approvedCommand, undefined, "nothing runs until the user allows the command");

  // Off: skills, commands and hooks go quiet and the server is removed; on brings the server back.
  await plugins.setEnabled("review-kit", false);
  assert.deepEqual(plugins.enabledFolders(), []);
  assert.equal(store.state.mcp.some((item) => item.pluginName === "review-kit"), false);
  assert.equal((await services.kernel.hooks.sets()).some((item) => item.source === "plugin"), false);
  await plugins.setEnabled("review-kit", true);
  assert.equal(store.state.mcp.filter((item) => item.pluginName === "review-kit").length, 1);

  await assert.rejects(plugins.install(source), /installed already/);
  await assert.rejects(plugins.install("relative/path"), /absolute folder path or an https/);
  await plugins.uninstall("review-kit");
  assert.equal((await plugins.list()).length, 0);
  assert.equal(store.state.mcp.some((item) => item.pluginName === "review-kit"), false);
  await assert.rejects(stat(folder), "the files are removed");
});

test("a git checkout installs as a folder without its .git, and file:// URLs are refused", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-plugins-git-"));
  const repo = path.join(directory, "repo");
  await writePlugin(repo, "git-kit");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "plugin");
  const store = new FileStore(path.join(directory, "data"));
  await store.load();
  const { services } = createApp(store);
  // Only https and ssh URLs are cloned (cloning one needs the network, so it is not exercised here).
  await assert.rejects(services.kernel.plugins.install(`file://${repo}`), /absolute folder path or an https/);
  const installed = await services.kernel.plugins.install(repo);
  assert.equal(installed.name, "git-kit");
  await assert.rejects(stat(path.join(directory, "data", "plugins", "git-kit", ".git")), "no .git is copied");
});
