import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { githubRepository } from "../src/application/worktrees.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

test("a GitHub repository is read from https, ssh and git remotes", () => {
  assert.equal(githubRepository("https://github.com/acme/widgets.git"), "acme/widgets");
  assert.equal(githubRepository("git@github.com:acme/widgets.git"), "acme/widgets");
  assert.equal(githubRepository("ssh://git@github.com/acme/widgets"), "acme/widgets");
  assert.equal(githubRepository("https://gitlab.com/acme/widgets.git"), undefined);
  assert.equal(githubRepository(""), undefined);
});

test("a pull request from a chat's branch: pending work is committed, the branch pushed, and GitHub asked with the user's token", async () => {
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const origin = await mkdtemp(path.join(os.tmpdir(), "saturn-pr-origin-"));
  git(origin, ["init", "-q", "--bare"]);
  const folder = await mkdtemp(path.join(os.tmpdir(), "saturn-pr-project-"));
  git(folder, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(folder, "README.md"), "# Demo\n");
  git(folder, ["add", "-A"]);
  git(folder, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  git(folder, ["remote", "add", "origin", origin]);
  git(folder, ["push", "-q", "-u", "origin", "main"]);

  const calls: { method: string; url: string; auth: string; body?: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      calls.push({ method: req.method ?? "", url: req.url ?? "", auth: String(req.headers.authorization), body: raw ? JSON.parse(raw) : undefined });
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/repos/acme/widgets/pulls") {
        res.statusCode = 201;
        res.end(JSON.stringify({ number: 7, html_url: "https://github.com/acme/widgets/pull/7", title: "x", state: "open", draft: false, user: { login: "dev" }, head: { ref: "b", sha: "abc" }, base: { ref: "main" }, body: "" }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ message: "Not Found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const store = new FileStore(await mkdtemp(path.join(os.tmpdir(), "saturn-pr-data-")));
    await store.load();
    const { services } = createApp(store);
    const project = await services.createProject({ path: folder });
    await services.setProjectAccess(project.id, true);
    await store.update((state) => {
      state.agents.push({ id: "agt", name: "A", modelConnectionId: "", mcpConnectionIds: [], ragConnectionIds: [], instructions: "" } as never);
    });
    const thread = await services.createThread("agt", "Add a feature", project.id);
    await services.kernel.worktrees.create(thread.id);
    const worktree = services.kernel.worktrees.pathOf(services.kernel.store.state.threads!.find((item) => item.id === thread.id)!)!;
    await writeFile(path.join(worktree, "feature.ts"), "export const feature = true;\n");
    const now = new Date().toISOString();
    await store.update((state) => {
      state.runs.unshift({ id: "run_s", agentId: "agt", threadId: thread.id, input: "do it", status: "completed", output: "Done.\n\n## Summary\nAdded feature.ts.", actions: [], generation: 0, createdAt: now } as never);
    });

    const result = await services.kernel.worktrees.pullRequest(thread.id, { repository: "acme/widgets" }, { apiBase, token: "ghp_test" });
    assert.deepEqual(result, { url: "https://github.com/acme/widgets/pull/7", number: 7, branch: result.branch });
    assert.match(result.branch, /^saturn\//);
    assert.equal(git(origin, ["rev-parse", "--verify", `refs/heads/${result.branch}`]).length, 40, "the branch was pushed");
    assert.equal(git(worktree, ["status", "--porcelain"]), "", "pending work was committed first");
    const create = calls.find((call) => call.method === "POST");
    assert.equal(create?.auth, "Bearer ghp_test");
    assert.equal(create?.body?.title, "Add a feature");
    assert.equal(create?.body?.body, "Added feature.ts.", "the last summary is the description");
    assert.equal(create?.body?.head, result.branch);
    assert.equal(create?.body?.base, "main");

    // A repository GitHub does not know: the refusal reaches the user with GitHub's message, and the branch stays.
    await assert.rejects(services.kernel.worktrees.pullRequest(thread.id, { repository: "acme/other" }, { apiBase, token: "ghp_test" }), /GitHub refused the pull request/);
  } finally {
    server.close();
  }
});
