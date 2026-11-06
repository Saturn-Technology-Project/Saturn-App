// A chat's own git worktree: its work stays on its own branch until it is merged, kept for a pull request or discarded.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { bench, commitAll, git, write } from "./files-support.mjs";

let saturn;
before(async () => { saturn = await bench(); });
after(async () => { await saturn?.stop(); });

const text = async (...parts) => (await readFile(path.join(...parts), "utf8")).replace(/\r\n/g, "\n");
const branches = (repo, name) => git(repo, "branch", "--list", name).replace(/^[+*]\s*/, "");

/** A repository on main, and a chat in it. */
async function repositoryChat() {
  const repo = await saturn.folder();
  await writeFile(path.join(repo, "README.md"), "hello\n");
  commitAll(repo);
  return { repo, ...(await saturn.chat(repo)) };
}

const open = (thread) => saturn.api("POST", `/threads/${thread.id}/worktree`);
const finish = (thread, how, message) => saturn.call("POST", `/threads/${thread.id}/worktree/finish`, { how, ...(message ? { message } : {}) });

test("an isolated chat works in its own checkout on its own branch, away from the project folder", async () => {
  const { repo, thread, turn } = await repositoryChat();
  const created = await open(thread);
  assert.equal(created.threadId, thread.id);
  assert.equal(created.branch, `saturn/${thread.id.replace(/^thread_/, "")}`);
  assert.equal(created.base, "main");
  assert.equal(created.path, path.join(saturn.runtime.dataDir, "worktrees", thread.id));
  assert.deepEqual([created.ahead, created.dirty, created.changedFiles], [0, 0, []]);
  assert.ok((await stat(path.join(created.path, "README.md"))).isFile(), "a checkout of the project");
  assert.equal(branches(repo, created.branch), created.branch, "the branch is in the repository");
  assert.deepEqual(await open(thread), created, "asking again gives the same one");

  const run = await turn([write("notes.md", "from the agent\n")]);
  assert.equal(await text(created.path, "notes.md"), "from the agent\n");
  assert.equal(existsSync(path.join(repo, "notes.md")), false, "the project folder is untouched");
  const status = await saturn.api("GET", `/threads/${thread.id}/worktree`);
  assert.deepEqual([status.ahead, status.dirty, status.changedFiles], [0, 1, ["notes.md"]]);

  const changes = await saturn.api("GET", `/runs/${run.id}/changes`);
  assert.equal(changes.root, created.path, "review and revert work in the worktree too");
  await saturn.api("POST", `/runs/${run.id}/changes/revert`, {});
  assert.equal(existsSync(path.join(created.path, "notes.md")), false);
});

test("merging brings the work to the base branch, and removes the worktree and branch", async () => {
  const { repo, agent, thread, turn } = await repositoryChat();
  const created = await open(thread);
  await turn([write("notes.md", "from the agent\n")]);

  const finished = await finish(thread, "merge");
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  assert.deepEqual(finished.body, { how: "merge", branch: created.branch, merged: true });
  assert.equal(await text(repo, "notes.md"), "from the agent\n");
  assert.match(git(repo, "log", "--format=%s", "-1"), /^Merge saturn\/.*Files$/);
  assert.equal(git(repo, "rev-parse", "--verify", "-q", "HEAD^2").length > 0, true, "a merge commit, even when a fast-forward would do");
  assert.equal(branches(repo, created.branch), "", "the branch was removed");
  assert.equal(existsSync(created.path), false, "the folder was removed");
  assert.equal(git(repo, "worktree", "list").split("\n").length, 1);
  assert.equal((await saturn.api("GET", `/agents/${agent.id}/threads`)).find((item) => item.id === thread.id).worktree, undefined);
  assert.equal((await saturn.call("GET", `/threads/${thread.id}/worktree`)).status, 404);
  assert.equal((await finish(thread, "merge")).status, 404, "there is nothing to finish now");
});

test("the merge commit is the user's when git knows who they are, otherwise Saturn's", async () => {
  const { repo, thread, newThread } = await repositoryChat();
  const created = await open(thread);
  await writeFile(path.join(created.path, "a.txt"), "x\n");
  assert.equal((await finish(thread, "merge")).status, 200);
  assert.equal(git(repo, "log", "-1", "--format=%an <%ae>"), "Saturn <saturn@localhost>");
  assert.equal(git(repo, "log", "-1", "--format=%an", "HEAD^2"), "Saturn", "and so is the branch's commit");

  git(repo, "config", "user.name", "The User");
  git(repo, "config", "user.email", "user@example.test");
  const second = await newThread("Second");
  const worktree = await open(second);
  await writeFile(path.join(worktree.path, "b.txt"), "x\n");
  assert.equal((await finish(second, "merge")).status, 200);
  assert.equal(git(repo, "log", "-1", "--format=%an <%ae>"), "The User <user@example.test>");
});

test("keeping commits what is pending and leaves the branch for a pull request", async () => {
  const { repo, thread, newThread } = await repositoryChat();
  const kept = await open(thread);
  await writeFile(path.join(kept.path, "kept.txt"), "x\n");
  const answer = await finish(thread, "keep", "Keep this");
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { how: "keep", branch: kept.branch });
  assert.equal(branches(repo, kept.branch), kept.branch);
  assert.equal(git(repo, "log", "--format=%s", "-1", kept.branch), "Keep this");
  assert.equal(existsSync(kept.path), false);
  assert.equal(existsSync(path.join(repo, "kept.txt")), false, "not merged");

  const second = await newThread("Named after the chat");
  const unnamed = await open(second);
  await writeFile(path.join(unnamed.path, "other.txt"), "x\n");
  assert.equal((await finish(second, "keep")).status, 200);
  assert.equal(git(repo, "log", "--format=%s", "-1", unnamed.branch), "Saturn: Named after the chat");
});

test("discarding removes the worktree, the branch and the work", async () => {
  const { repo, thread } = await repositoryChat();
  const created = await open(thread);
  await writeFile(path.join(created.path, "gone.txt"), "x\n");
  const answer = await finish(thread, "discard");
  assert.deepEqual(answer.body, { how: "discard", branch: created.branch });
  assert.equal(existsSync(created.path), false);
  assert.equal(branches(repo, created.branch), "");
  assert.equal(existsSync(path.join(repo, "gone.txt")), false);
});

test("a conflicting merge is refused with the files named, and nothing is lost", async () => {
  const { repo, thread } = await repositoryChat();
  const created = await open(thread);
  await writeFile(path.join(created.path, "README.md"), "agent version\n");
  await writeFile(path.join(repo, "README.md"), "user version\n");
  git(repo, "commit", "-qam", "user edit");

  const refused = await finish(thread, "merge");
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /conflicts in README\.md/);
  assert.equal(await text(repo, "README.md"), "user version\n", "the merge was aborted cleanly");
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.equal(existsSync(path.join(repo, ".git/MERGE_HEAD")), false);
  const status = await saturn.api("GET", `/threads/${thread.id}/worktree`);
  assert.ok(status.ahead >= 1, "the agent's work is committed on its branch");
  assert.deepEqual(status.changedFiles, ["README.md"]);
  assert.equal(await text(created.path, "README.md"), "agent version\n");
});

test("a merge waits for the project's own uncommitted changes, but not for untracked files", async () => {
  const { repo, thread } = await repositoryChat();
  const created = await open(thread);
  await writeFile(path.join(created.path, "work.txt"), "x\n");
  await writeFile(path.join(repo, "README.md"), "the user's edit\n");
  const refused = await finish(thread, "merge");
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /uncommitted changes/);
  assert.equal(await text(repo, "README.md"), "the user's edit\n");
  assert.equal(existsSync(path.join(repo, "work.txt")), false);
  assert.ok(existsSync(created.path), "the chat keeps its worktree");

  git(repo, "checkout", "README.md");
  await writeFile(path.join(repo, "untracked.txt"), "the user's\n");
  assert.equal((await finish(thread, "merge")).status, 200);
  assert.equal(await text(repo, "untracked.txt"), "the user's\n");
  assert.equal(await text(repo, "work.txt"), "x\n");
});

test("deleting a chat discards its worktree and branch", async () => {
  const { repo, thread } = await repositoryChat();
  const created = await open(thread);
  await saturn.api("DELETE", `/threads/${thread.id}`);
  assert.equal(existsSync(created.path), false);
  assert.equal(branches(repo, created.branch), "");
});

test("work committed on the branch counts as ahead, with its files listed", async () => {
  const { thread } = await repositoryChat();
  const created = await open(thread);
  await writeFile(path.join(created.path, "committed.txt"), "x\n");
  git(created.path, "add", ".");
  git(created.path, "commit", "-qm", "work");
  await writeFile(path.join(created.path, "pending.txt"), "y\n");
  const status = await saturn.api("GET", `/threads/${thread.id}/worktree`);
  assert.deepEqual([status.ahead, status.dirty, status.changedFiles.sort()], [1, 1, ["committed.txt", "pending.txt"]]);
});

test("on a detached HEAD the base is the commit", async () => {
  const { repo, thread } = await repositoryChat();
  git(repo, "checkout", "-q", "--detach");
  const created = await open(thread);
  assert.equal(created.base, git(repo, "rev-parse", "--short", "HEAD"));
});

test("only a chat in a git project gets a worktree, up to six at once, and how to finish is checked", async () => {
  const loose = await saturn.chat();
  const refused = await saturn.call("POST", `/threads/${loose.thread.id}/worktree`);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /Only a chat in a project/);
  assert.equal((await saturn.call("POST", "/threads/thread_none/worktree")).status, 404);

  const plain = await saturn.folder();
  const outside = await saturn.chat(plain);
  const noGit = await saturn.call("POST", `/threads/${outside.thread.id}/worktree`);
  assert.equal(noGit.status, 409);
  assert.match(noGit.body.error, /not a git repository/);
  assert.equal((await saturn.call("GET", `/threads/${outside.thread.id}/worktree`)).status, 404);
  assert.equal((await finish(outside.thread, "merge")).status, 404);

  const { thread, newThread } = await repositoryChat();
  await open(thread);
  assert.equal((await finish(thread, "squash")).status, 400);
  for (let opened = 1; opened < 6; opened += 1) await open(await newThread(`Chat ${opened}`));
  const seventh = await saturn.call("POST", `/threads/${(await newThread("One too many")).id}/worktree`);
  assert.equal(seventh.status, 409);
  assert.match(seventh.body.error, /already work in their own worktrees/);
});

test("at startup the worktree of a chat that no longer exists is removed, and live ones stay", async () => {
  const first = await bench({ keepData: true });
  let second;
  try {
    const repo = await saturn.folder();
    await writeFile(path.join(repo, "README.md"), "hello\n");
    commitAll(repo);
    const setup = await first.chat(repo);
    const live = await first.api("POST", `/threads/${setup.thread.id}/worktree`);
    await first.stop();

    const stale = path.join(first.runtime.dataDir, "worktrees", "thread_gone");
    git(repo, "worktree", "add", "-q", "-b", "saturn/gone", stale, "HEAD");
    second = await bench({ dataDir: first.runtime.dataDir });
    assert.equal(existsSync(stale), false);
    assert.ok(!git(repo, "worktree", "list").includes("thread_gone"));
    assert.ok(existsSync(live.path));
    assert.equal((await second.api("GET", `/threads/${setup.thread.id}/worktree`)).path, live.path);
  } finally {
    await second?.stop();
  }
});
