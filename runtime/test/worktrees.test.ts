import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";

/** A model that writes one file with the files tool, then answers. */
async function writingModel(file: string, content: string) {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const messages = (JSON.parse(raw || "{}") as { messages?: { role?: string; content?: string }[] }).messages ?? [];
      const wrote = messages.some((item) => item.role === "assistant" && typeof item.content === "string" && item.content.includes("\"toolId\""));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        choices: [{
          message: wrote
            ? { content: "written" }
            : { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "files", arguments: JSON.stringify({ action: "write", path: file, content }) } }] },
        }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

async function settled(services: ReturnType<typeof createApp>["services"], runId: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const run = services.kernel.getRun(runId);
    if (["completed", "failed", "cancelled"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("run did not settle");
}

test("an isolated chat works in its own worktree and branch; finishing merges, keeps or discards it", async () => {
  const model = await writingModel("notes.md", "from the agent\n");
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-wt-"));
  const repo = await mkdtemp(path.join(os.tmpdir(), "saturn-wt-repo-"));
  try {
    git(repo, "init", "-q", "-b", "main");
    await writeFile(path.join(repo, "README.md"), "hello\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");

    const store = new FileStore(directory);
    await store.load();
    const { services } = createApp(store);
    const connection = await services.createModel({ name: "Local", provider: "openai", baseUrl: model.url });
    const agent = await services.createAgent({ name: "Writer", modelConnectionId: connection.id, autonomy: "fully_autonomous" });
    const project = await services.createProject({ name: "Repo", path: repo, grant: true });
    const thread = await services.createThread(agent.id, "Isolated work", project.id);

    const created = await services.kernel.worktrees.create(thread.id);
    assert.equal(created.branch, `saturn/${thread.id.replace(/^thread_/, "")}`);
    assert.equal(created.base, "main");
    assert.ok((await stat(path.join(created.path, "README.md"))).isFile(), "the worktree is a checkout of the project");
    assert.equal(git(repo, "branch", "--list", created.branch).trim().replace(/^[+*]\s*/, ""), created.branch, "the branch exists in the repository");

    // The agent's edit lands in the worktree, not in the project folder.
    const run = await services.startRun(agent.id, "write notes", thread.id);
    const done = await settled(services, run.id);
    assert.equal(done.status, "completed", done.error);
    assert.equal(await readFile(path.join(created.path, "notes.md"), "utf8"), "from the agent\n");
    await assert.rejects(() => stat(path.join(repo, "notes.md")), "the project folder is untouched");
    const status = await services.kernel.worktrees.status(thread.id);
    assert.deepEqual([status.ahead, status.dirty, status.changedFiles], [0, 1, ["notes.md"]]);

    // Merge: the change reaches main, the worktree and branch are gone.
    const merged = await services.kernel.worktrees.finish(thread.id, "merge");
    assert.equal(merged.merged, true);
    assert.equal(await readFile(path.join(repo, "notes.md"), "utf8"), "from the agent\n");
    assert.match(git(repo, "log", "--oneline", "-1"), /Merge saturn\//);
    assert.equal(git(repo, "branch", "--list", created.branch), "", "the branch was removed");
    await assert.rejects(() => stat(created.path), "the worktree folder was removed");
    assert.equal((await services.listThreads(agent.id)).find((item) => item.id === thread.id)?.worktree, undefined);

    // Keep: the branch stays for a pull request.
    const second = await services.createThread(agent.id, "Keep me", project.id);
    const kept = await services.kernel.worktrees.create(second.id);
    await writeFile(path.join(kept.path, "kept.txt"), "x\n");
    await services.kernel.worktrees.finish(second.id, "keep", "Keep this");
    assert.equal(git(repo, "branch", "--list", kept.branch).trim().replace(/^[+*]\s*/, ""), kept.branch);
    assert.match(git(repo, "log", "--oneline", "-1", kept.branch), /Keep this/);
    await assert.rejects(() => stat(kept.path));

    // A conflicting merge is refused with the files named, and nothing is lost.
    const third = await services.createThread(agent.id, "Conflict", project.id);
    const wt = await services.kernel.worktrees.create(third.id);
    await writeFile(path.join(wt.path, "README.md"), "agent version\n");
    await writeFile(path.join(repo, "README.md"), "user version\n");
    git(repo, "commit", "-qam", "user edit");
    await assert.rejects(() => services.kernel.worktrees.finish(third.id, "merge"), /conflicts in README\.md/);
    assert.equal(await readFile(path.join(repo, "README.md"), "utf8"), "user version\n", "the merge was aborted cleanly");
    assert.ok((await services.kernel.worktrees.status(third.id)).ahead >= 1, "the agent's work is committed on its branch");

    // Deleting the chat discards its worktree.
    await services.deleteThread(third.id);
    await assert.rejects(() => stat(wt.path));
    assert.equal(git(repo, "branch", "--list", wt.branch), "");

    const loose = await services.createThread(agent.id, "No project");
    await assert.rejects(() => services.kernel.worktrees.create(loose.id), /Only a chat in a project/);
  } finally {
    model.server.close();
  }
});
