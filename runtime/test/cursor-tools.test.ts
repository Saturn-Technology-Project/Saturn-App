import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/presentation/app.js";
import { FileStore } from "../src/infrastructure/store.js";
import {
  CURSOR_COMPUTER_USE_ID,
  CURSOR_ORIGIN_ID,
  cursorComputerUseSkills,
  cursorOriginSkills,
} from "../src/domain/builtin.js";
import { runComputerUseSkill, runOriginSkill } from "../src/infrastructure/skills.js";

test("cursor tools definitions contain exact tools matching Cursor schemas", () => {
  const cu = cursorComputerUseSkills();
  assert.equal(cu.id, CURSOR_COMPUTER_USE_ID);
  assert.equal(cu.tools.length, 16);
  assert.ok(cu.tools.every((t) => t.category === "write"));
  assert.ok(cu.tools.some((t) => t.toolId === "computer_screenshot"));
  assert.ok(cu.tools.some((t) => t.toolId === "computer_check_permissions"));

  const origin = cursorOriginSkills();
  assert.equal(origin.id, CURSOR_ORIGIN_ID);
  assert.equal(origin.tools.length, 31);
  const reads = origin.tools.filter((t) => t.category === "read");
  const writes = origin.tools.filter((t) => t.category === "write");
  assert.equal(reads.length, 13);
  assert.equal(writes.length, 18);
  assert.ok(reads.some((t) => t.toolId === "get_repository"));
  assert.ok(writes.some((t) => t.toolId === "create_pull_request"));
});

test("computer use skills can check permissions and list apps", { skip: process.platform !== "darwin" && "this test checks the macOS permissions and app list" }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "saturn-cu-test-"));
  const perms = (await runComputerUseSkill(dir, "computer_check_permissions", {})) as {
    status: string;
    displayAttached: boolean;
  };
  assert.ok(perms.displayAttached);

  const apps = (await runComputerUseSkill(dir, "computer_apps", {})) as {
    apps: { name: string; pid: number }[];
  };
  assert.ok(Array.isArray(apps.apps));
});

test("origin reads a real git repository and refuses unsafe refs and paths", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "saturn-origin-test-"));
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "saturn-origin-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  git("remote", "add", "origin", "https://github.com/acme/widgets.git");
  await mkdir(path.join(repoDir, "src"), { recursive: true });
  await writeFile(path.join(repoDir, "src", "app.ts"), "export const answer = 42;\nconsole.log(answer);\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  git("checkout", "-q", "-b", "feature");
  await writeFile(path.join(repoDir, "README.md"), "# Widgets\n");
  git("add", ".");
  git("commit", "-q", "-m", "add readme");
  const context = { repoDir, token: "none" };
  const repo = { owner: "acme", name: "widgets" };

  const file = (await runOriginSkill(dir, "get_file_contents", { ...repo, path: "src/app.ts", ref: "main", startLine: 1, endLine: 1 }, undefined, context)) as { content: string; totalLines: number; sha: string };
  assert.equal(file.content, "export const answer = 42;");
  assert.match(file.sha, /^[0-9a-f]{40}$/);

  const dirListing = (await runOriginSkill(dir, "get_file_contents", { ...repo, path: "src", ref: "main" }, undefined, context)) as { type: string; entries: { path: string }[] };
  assert.equal(dirListing.type, "dir");
  assert.deepEqual(dirListing.entries.map((entry) => entry.path), ["src/app.ts"]);

  const grep = (await runOriginSkill(dir, "grep_contents", { ...repo, query: "answer", ref: "main", literal: true }, undefined, context)) as { totalMatches: number; matches: { path: string; line: number }[] };
  assert.equal(grep.totalMatches, 2);
  assert.deepEqual(grep.matches[0], { path: "src/app.ts", line: 1, text: "export const answer = 42;", context: false });

  const branches = (await runOriginSkill(dir, "list_branches", repo, undefined, context)) as { branches: { name: string }[] };
  assert.deepEqual(branches.branches.map((branch) => branch.name).sort(), ["feature", "main"]);

  const commits = (await runOriginSkill(dir, "list_commits", { ...repo, ref: "feature" }, undefined, context)) as { commits: { message: string }[] };
  assert.deepEqual(commits.commits.map((commit) => commit.message), ["add readme", "first"]);

  const compare = (await runOriginSkill(dir, "compare_commits", { ...repo, base: "main", head: "feature" }, undefined, context)) as { aheadBy: number; files: { path: string }[] };
  assert.equal(compare.aheadBy, 1);
  assert.deepEqual(compare.files.map((item) => item.path), ["README.md"]);

  const commit = (await runOriginSkill(dir, "commit_read", { ...repo, sha: "feature", view: "files" }, undefined, context)) as { message: string; files: { path: string; additions: number }[] };
  assert.equal(commit.message, "add readme");
  assert.deepEqual(commit.files, [{ path: "README.md", additions: 1, deletions: 0 }]);

  // Tool arguments can never become git options or escape the repository.
  await assert.rejects(() => runOriginSkill(dir, "commit_read", { ...repo, sha: "--output=/tmp/x" }, undefined, context), /Invalid sha/);
  await assert.rejects(() => runOriginSkill(dir, "get_file_contents", { ...repo, path: "../../etc/passwd" }, undefined, context), /inside the repository/);
  await assert.rejects(() => runOriginSkill(dir, "get_file_contents", { ...repo, path: "/etc/passwd" }, undefined, context), /inside the repository/);
});

test("origin pull request tools call the GitHub API with the user's token", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "saturn-origin-gh-"));
  const calls: { method: string; url: string; auth: string; body: unknown }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      calls.push({ method: req.method ?? "", url: req.url ?? "", auth: String(req.headers.authorization), body: raw ? JSON.parse(raw) : undefined });
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/repos/acme/widgets/pulls") {
        res.statusCode = 201;
        res.end(JSON.stringify({ number: 7, title: "Add readme", state: "open", draft: false, user: { login: "dev" }, head: { ref: "feature", sha: "abc" }, base: { ref: "main" }, body: "Docs" }));
        return;
      }
      if (req.method === "PUT" && req.url === "/repos/acme/widgets/pulls/7/merge") {
        res.end(JSON.stringify({ merged: true, sha: "def", message: "Pull Request successfully merged" }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ message: "Not Found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const context = { apiBase: `http://127.0.0.1:${address.port}`, token: "ghp_test" };
  try {
    const created = (await runOriginSkill(dir, "create_pull_request", { owner: "acme", name: "widgets", title: "Add readme", head: "feature", base: "main", body: "Docs" }, undefined, context)) as { pullRequest: { number: number; headSha: string } };
    assert.equal(created.pullRequest.number, 7);
    assert.deepEqual(calls[0], { method: "POST", url: "/repos/acme/widgets/pulls", auth: "Bearer ghp_test", body: { title: "Add readme", head: "feature", base: "main", body: "Docs", draft: false } });

    await assert.rejects(() => runOriginSkill(dir, "merge_pull_request", { owner: "acme", name: "widgets", number: 7 }, undefined, context), /expectedHeadSha is required/);
    const merged = (await runOriginSkill(dir, "merge_pull_request", { owner: "acme", name: "widgets", number: 7, expectedHeadSha: "abc", mergeMethod: "squash" }, undefined, context)) as { merged: boolean };
    assert.equal(merged.merged, true);
    assert.deepEqual(calls.at(-1)?.body, { sha: "abc", merge_method: "squash" });

    await assert.rejects(() => runOriginSkill(dir, "pull_request_read", { owner: "acme", name: "widgets", number: 99 }, undefined, context), /GitHub 404: Not Found/);
  } finally {
    server.close();
  }
});

test("built-in cursor tools are installed and tool disabling works", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-cursor-test-"));
  const store = new FileStore(directory);
  await store.load();
  const { services } = createApp(store);

  const mcps = (await services.listConnections("mcp")) as { id: string; name: string }[];
  assert.ok(mcps.some((m) => m.id === CURSOR_COMPUTER_USE_ID));
  assert.ok(mcps.some((m) => m.id === CURSOR_ORIGIN_ID));

  // Disable a tool in cursor-computer-use
  await services.updateMcp(CURSOR_COMPUTER_USE_ID, {
    disabledTools: ["computer_drag"],
  });
  const updated = (await services.listConnections("mcp")) as { id: string; disabledTools?: string[] }[];
  const cuServer = updated.find((m) => m.id === CURSOR_COMPUTER_USE_ID);
  assert.deepEqual(cuServer?.disabledTools, ["computer_drag"]);
});

test("buildSystemPrompt informs model of its capabilities and removes restrictive constraints", async () => {
  const { buildSystemPrompt } = await import("../src/domain/policies.js");
  const prompt = buildSystemPrompt({
    agent: {
      id: "agent_1",
      name: "Saturn Assistant",
      instructions: "Custom user goal here",
      description: "",
      responseStyle: "professional",
      autonomy: "execute_when_allowed",
      temperature: 0.2,
      maxOutput: 4000,
      status: "active",
      modelConnectionId: null,
      mcpConnectionIds: ["general-skills", "computer-use", "origin"],
      ragConnectionIds: [],
    },
    context: "Some RAG knowledge",
  });

  // Confirms capabilities awareness
  assert.ok(prompt.includes("Custom user goal here"));
  assert.ok(prompt.includes("Computer Use: Desktop Automation on macOS and Windows"));
  assert.ok(prompt.includes("computer_screenshot"));
  assert.ok(prompt.includes("Origin & Git Repository Tools"));
  assert.ok(prompt.includes("get_repository"));
  assert.ok(prompt.includes("Workspace & System Tools"));
  assert.ok(prompt.includes("files"));
  assert.ok(prompt.includes("Some RAG knowledge"));

  // Confirms no restrictive constraints
  assert.ok(!prompt.includes("Do not call tools"));
  assert.ok(!prompt.includes("Answer briefly"));
  assert.ok(!prompt.includes("Otherwise say what approval is needed"));
});

