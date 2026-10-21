import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PullRequestService } from "../src/application/pull-requests.js";
import type { Run } from "../src/domain/model.js";
import { FileStore } from "../src/infrastructure/store.js";
import { createApp } from "../src/presentation/app.js";
import { toolSteps } from "./tool-steps.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

async function body(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw;
}

/** GitHub's REST and GraphQL answers for pull request #7 of acme/site: one failing check, a comment, a review thread. */
async function fakeGitHub() {
  const seen: string[] = [];
  let head = "sha-one";
  let conclusion = "failure";
  const server = createServer(async (req, res) => {
    const url = req.url ?? "";
    seen.push(`${req.method} ${url.split("?")[0]}`);
    await body(req);
    res.setHeader("content-type", "application/json");
    const json = (value: unknown) => res.end(JSON.stringify(value));
    if (url.startsWith("/repos/acme/site/pulls/7")) return json({ number: 7, state: "open", merged_at: null, head: { ref: "saturn/x", sha: head }, base: { ref: "main" }, html_url: "https://github.com/acme/site/pull/7" });
    if (url.startsWith(`/repos/acme/site/commits/${head}/check-runs`)) return json({ total_count: 2, check_runs: [{ id: 11, name: "test", status: "completed", conclusion }, { id: 12, name: "lint", status: "completed", conclusion: "success" }] });
    if (url.startsWith("/repos/acme/site/check-runs/11/annotations")) return json([{ path: "src/a.ts", start_line: 3, annotation_level: "failure", message: "expected 2, got 3" }]);
    if (url.startsWith("/repos/acme/site/check-runs/11")) return json({ id: 11, name: "test", conclusion, html_url: "https://github.com/acme/site/runs/11", output: { summary: "1 failed" } });
    if (url.startsWith("/repos/acme/site/actions/jobs/11/logs")) {
      res.setHeader("content-type", "text/plain");
      return res.end("2026-10-21T00:00:00.0000000Z npm test\n2026-10-21T00:00:01.0000000Z FAIL src/a.test.ts: expected 2, got 3\n");
    }
    if (url.startsWith("/repos/acme/site/issues/7/comments")) return json([{ id: 501, user: { login: "rev" }, body: "Please add a changelog entry.", created_at: "2026-10-21T01:00:00Z" }]);
    if (url.startsWith("/graphql")) return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [
      { id: "T1", isResolved: false, isOutdated: false, path: "src/a.ts", line: 3, startLine: null, diffSide: "RIGHT", comments: { nodes: [{ databaseId: 9, author: { login: "rev" }, body: "Off by one here.", createdAt: "2026-10-21T01:05:00Z" }] } },
      { id: "T2", isResolved: true, isOutdated: false, path: "README.md", line: 1, startLine: null, diffSide: "RIGHT", comments: { nodes: [{ databaseId: 10, author: { login: "rev" }, body: "Resolved already.", createdAt: "2026-10-21T01:06:00Z" }] } },
    ], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
    res.statusCode = 404;
    return json({ message: `not faked: ${url}` });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    seen,
    server,
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    pass(nextHead: string) {
      head = nextHead;
      conclusion = "success";
    },
  };
}

/** A model that, asked about failed checks, writes a fix with the shell; anything else, it just answers. */
async function fixingModel() {
  const inputs: string[] = [];
  const server = createServer(async (req, res) => {
    const messages = (JSON.parse((await body(req)) || "{}") as { messages?: { role?: string; content?: string }[] }).messages ?? [];
    const first = messages.filter((item) => item.role === "user").at(-1)?.content ?? "";
    const acted = toolSteps(messages).length > 0;
    const ask = messages.filter((item) => item.role === "user" && /checks failed|Review comments/.test(item.content ?? "")).at(-1)?.content ?? first;
    if (!acted) inputs.push(ask);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: !acted && /checks failed/.test(ask) ? { content: "", tool_calls: [{ id: "c0", type: "function", function: { name: "code", arguments: JSON.stringify({ command: "echo fixed > fix.txt" }) } }] } : { content: "done" } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { inputs, server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("a followed pull request: failing checks go to the agent with their logs, the fix is pushed, comments wait for the user", async () => {
  const github = await fakeGitHub();
  const model = await fixingModel();
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-pr-"));
  const remote = path.join(directory, "remote.git");
  const folder = path.join(directory, "site");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", folder]);
  await writeFile(path.join(folder, "README.md"), "site\n");
  git(folder, "add", ".");
  git(folder, "commit", "-q", "-m", "init");
  git(folder, "remote", "add", "origin", remote);
  git(folder, "push", "-q", "origin", "main");
  try {
    const store = new FileStore(path.join(directory, "data"));
    await store.load();
    const { services } = createApp(store);
    const connection = await services.createModel({ name: "Fixer", provider: "openai", baseUrl: model.url });
    const agent = await services.createAgent({ name: "Fixer", modelConnectionId: connection.id, autonomy: "bypass" });
    const project = await services.createProject({ path: folder });
    await services.setProjectAccess(project.id, true);
    const thread = await services.kernel.runs.createThread(agent.id, "Change", project.id);
    const worktree = await services.kernel.worktrees.create(thread.id);
    git(directory, "-C", folder, "fetch", "-q", "origin");
    const prs = new PullRequestService(services.kernel, () => ({ token: "test-token", apiBase: github.url }));
    await prs.follow(thread.id, { number: 7, url: "https://github.com/acme/site/pull/7", repository: "acme/site", branch: worktree.branch });
    const threadNow = () => store.state.threads!.find((item) => item.id === thread.id)!;

    // First look: failing check → an automatic turn with the log tail and annotations; two new pieces of feedback.
    const watched = await prs.check(thread.id);
    assert.equal(watched.state, "open");
    assert.equal(watched.checks, "failure");
    assert.deepEqual(watched.failed, [{ name: "test", url: "" }]);
    assert.equal(watched.fixRounds, 1);
    assert.deepEqual(watched.feedback.map((item) => [item.author, item.body, item.path ?? ""]), [["rev", "Please add a changelog entry.", ""], ["rev", "Off by one here.", "src/a.ts"]]);
    const fixRun = store.state.runs.find((run) => run.id === watched.fixRunId)!;
    assert.equal(fixRun.automatic, true);
    assert.match(fixRun.input, /checks failed on pull request #7 \(test\)/);
    assert.match(fixRun.input, /FAIL src\/a\.test\.ts: expected 2, got 3/);
    assert.match(fixRun.input, /src\/a\.ts:3 failure: expected 2, got 3/);
    assert.ok(!/2026-10-21T00:00/.test(fixRun.input), "log timestamps are dropped");

    // The fix round ends: its change is committed and pushed to the branch on origin.
    await until(() => (store.state.runs.find((run) => run.id === fixRun.id)?.status === "completed" ? true : undefined), "the fix round");
    await until(() => (threadNow().pullRequest?.fixRunId === undefined ? true : undefined), "the push");
    assert.match(git(directory, "--git-dir", remote, "log", "--format=%s", "-1", worktree.branch), /Saturn: fix the checks on #7 \(round 1\)/);
    assert.equal(git(directory, "--git-dir", remote, "show", `${worktree.branch}:fix.txt`), "fixed");

    // The same head again: no second round. Comments already seen are not added twice.
    const again = await prs.check(thread.id);
    assert.equal(again.fixRounds, 1);
    assert.equal(again.feedback.length, 2);

    // The user sends the comments: one message to the agent, the feedback list empties.
    const sent = await prs.sendFeedback(thread.id);
    assert.equal(sent.sent, 2);
    const feedbackRun = store.state.runs.find((run) => run.id === sent.runId)!;
    assert.match(feedbackRun.input, /Review comments on pull request #7/);
    assert.match(feedbackRun.input, /rev on `src\/a\.ts:3`: Off by one here\./);
    assert.equal(threadNow().pullRequest?.feedback.length, 0);

    // Green on a new head; stopping follow-up is remembered.
    github.pass("sha-two");
    await until(() => (store.state.runs.find((run) => run.id === sent.runId)?.status === "completed" ? true : undefined), "the feedback turn");
    await until(() => (threadNow().pullRequest?.pushRunId === undefined ? true : undefined), "the feedback push");
    const green = await prs.check(thread.id);
    assert.equal(green.checks, "success");
    assert.equal((await prs.setWatching(thread.id, false)).watching, false);
    assert.ok(github.seen.includes("GET /repos/acme/site/actions/jobs/11/logs"));
  } finally {
    github.server.close();
    model.server.close();
  }
});

test("without a GitHub token the follow-up records why, and a run that is not a fix round pushes nothing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saturn-pr-token-"));
  const store = new FileStore(directory);
  await store.load();
  const { services } = createApp(store);
  const agent = await services.createAgent({ name: "A" });
  const thread = await services.kernel.runs.createThread(agent.id, "x");
  const prs = new PullRequestService(services.kernel, () => ({ apiBase: "http://127.0.0.1:9", token: "" }));
  await prs.follow(thread.id, { number: 1, url: "https://github.com/a/b/pull/1", repository: "a/b", branch: "b" });
  const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN, PATH: process.env.PATH };
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  process.env.PATH = "/nonexistent";
  try {
    const watch = await prs.check(thread.id);
    assert.match(watch.error ?? "", /No GitHub token/);
    await prs.afterRun("run_missing");
    await assert.rejects(prs.sendFeedback(thread.id), /No review comments/);
  } finally {
    Object.assign(process.env, saved);
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key];
  }
});
