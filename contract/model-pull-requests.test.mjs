// Opening and following a pull request, whichever language runs the runtime: GitHub's refusal reaching the user, the remote
// forms a chat can open from, and what is sent to the agent. GitHub is a fake server, git goes to local folders, and the
// token is a made-up value.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { api, call, fakeModel, finished, actedSinceAsking, request, until } from "./model-harness.mjs";
import { startRuntime } from "./runtime.mjs";

const TOKEN = "made-up-github-token";

let scratch;
let github;
let runtime;
const stops = [];

/** The pull request GitHub knows, with the given changes. */
const pull = (extra = {}) => ({ number: 7, title: "x", state: "open", merged_at: null, draft: false, user: { login: "dev" }, head: { ref: "saturn/x", sha: github.state.head }, base: { ref: "main" }, html_url: "https://github.com/acme/site/pull/7", body: "", ...extra });

/** GitHub for acme/site: `state` says how creating a pull request goes and what its checks conclude. */
async function fakeGitHub() {
  const requests = [];
  const state = { head: "sha-one", conclusion: "success", refusal: undefined, htmlUrl: undefined };
  const server = createServer((incoming, response) => {
    let raw = "";
    incoming.on("data", (chunk) => { raw += chunk; });
    incoming.on("end", () => {
      const url = incoming.url.split("?")[0];
      requests.push({ method: incoming.method, url, authorization: incoming.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
      const send = (status, value) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (incoming.method === "POST" && url === "/repos/acme/site/pulls") return state.refusal ? send(state.refusal.status, state.refusal.body) : send(201, pull());
      if (url === "/repos/acme/site/pulls/7") return send(200, pull());
      if (url === `/repos/acme/site/commits/${state.head}/check-runs`) return send(200, { total_count: 2, check_runs: [{ id: 11, name: "test", status: "completed", conclusion: state.conclusion, ...(state.htmlUrl ? { html_url: state.htmlUrl } : {}) }, { id: 12, name: "lint", status: "completed", conclusion: "success" }] });
      if (url === "/repos/acme/site/check-runs/11/annotations") return send(200, []);
      if (url === "/repos/acme/site/check-runs/11") return send(200, { id: 11, name: "test", conclusion: state.conclusion, output: { summary: "1 failed" } });
      if (url === "/repos/acme/site/actions/jobs/11/logs") return response.writeHead(200, { "content-type": "text/plain" }).end("2026-10-21T00:00:01.0000000Z FAIL a test\n");
      if (url === "/repos/acme/site/issues/7/comments") return send(200, [{ id: 501, user: { login: "rev" }, body: "Please add a changelog entry.\nAnd a test.", created_at: "2026-10-21T01:00:00Z" }]);
      if (url === "/graphql") return send(200, { data: { repository: { pullRequest: { reviewThreads: { nodes: [
        { id: "T1", isResolved: false, isOutdated: false, path: "src/a.ts", line: 3, startLine: null, diffSide: "RIGHT", comments: { nodes: [{ databaseId: 9, author: { login: "rev" }, body: "Off by one here.", createdAt: "2026-10-21T01:05:00Z" }] } },
        { id: "T2", isResolved: true, isOutdated: false, path: "README.md", line: 1, startLine: null, diffSide: "RIGHT", comments: { nodes: [{ databaseId: 10, author: { login: "rev" }, body: "Resolved already.", createdAt: "2026-10-21T01:06:00Z" }] } },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
      return send(404, { message: "Not Found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  stops.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { requests, state, url: `http://127.0.0.1:${server.address().port}` };
}

const git = (cwd, ...args) => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@example.test", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@example.test", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
}).trim();

before(async () => {
  scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "saturn-contract-prs-")));
  github = await fakeGitHub();
  runtime = await startRuntime({ env: { SATURN_GITHUB_API: github.url, GH_TOKEN: TOKEN, GITHUB_TOKEN: "", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
});
after(async () => {
  await runtime?.stop();
  await Promise.all(stops.map((stop) => stop()));
  await rm(scratch, { recursive: true, force: true });
});

let chats = 0;

/** A project and a chat on its own branch; pushes go to a local bare repository, whatever `remote` reads as. */
async function chatOnBranch(target = runtime, { remote = "https://github.com/acme/site.git", reply } = {}) {
  chats += 1;
  const folder = path.join(scratch, `chat-${chats}`);
  const bare = path.join(scratch, `chat-${chats}.git`);
  git(scratch, "init", "-q", "--bare", "-b", "main", bare);
  git(scratch, "init", "-q", "-b", "main", folder);
  await writeFile(path.join(folder, "README.md"), "# Site\n");
  git(folder, "add", ".");
  git(folder, "commit", "-q", "-m", "First commit");
  if (remote) {
    git(folder, "remote", "add", "origin", remote);
    git(folder, "config", `url.file://${bare}.pushInsteadOf`, remote);
    git(folder, "push", "-q", "origin", "main");
  }
  const model = await fakeModel(reply);
  stops.push(model.stop);
  const connection = await api(target, "POST", "/connections/models", { name: "Scripted", provider: "openai", model: "s", baseUrl: model.url, apiKey: "scripted-test-value" });
  const agent = await api(target, "POST", "/agents", { name: "Fixer", modelConnectionId: connection.id, autonomy: "bypass" });
  const project = await api(target, "POST", "/projects", { path: folder, grant: true });
  const thread = await api(target, "POST", `/agents/${agent.id}/threads`, { title: "Add a feature", projectId: project.id });
  const worktree = await api(target, "POST", `/threads/${thread.id}/worktree`);
  await writeFile(path.join(worktree.path, "feature.ts"), "export const feature = true;\n");
  return { folder, bare, model, agent, project, thread, worktree };
}

const threadOf = async (setup) => (await api(runtime, "GET", `/agents/${setup.agent.id}/threads`)).find((item) => item.id === setup.thread.id);

test("GitHub's refusal of a pull request reaches the user with its message, and the pushed branch stays", async () => {
  const setup = await chatOnBranch();
  github.state.refusal = { status: 422, body: { message: "Validation Failed", errors: [{ message: "No commits between main and the branch" }] } };
  try {
    const refused = await request(runtime, "POST", `/threads/${setup.thread.id}/pull-request`, {});
    assert.equal(refused.status, 502, JSON.stringify(refused.body));
    assert.match(refused.body.error, /^GitHub refused the pull request: /);
    assert.match(refused.body.error, /Validation Failed/);
    assert.match(refused.body.error, /No commits between main and the branch/);
    assert.ok(!refused.body.error.includes(TOKEN));
    assert.equal(git(setup.bare, "rev-parse", "--verify", `refs/heads/${setup.worktree.branch}`).length, 40, "the branch stays pushed");
    assert.equal((await threadOf(setup)).pullRequest, undefined, "there is nothing to follow");

    // The next try, once GitHub agrees, opens it.
    github.state.refusal = undefined;
    const opened = await api(runtime, "POST", `/threads/${setup.thread.id}/pull-request`, {});
    assert.equal(opened.number, 7);
    assert.equal((await threadOf(setup)).pullRequest.number, 7);
  } finally {
    github.state.refusal = undefined;
  }
});

test("a refusal about the token says how to sign in, not what GitHub said", async () => {
  const setup = await chatOnBranch();
  github.state.refusal = { status: 401, body: { message: "Bad token" } };
  try {
    const refused = await request(runtime, "POST", `/threads/${setup.thread.id}/pull-request`, {});
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.error, /^No GitHub token: sign in with `gh auth login`, set GH_TOKEN, or install GitHub under Customizations, then try again\./);
  } finally {
    github.state.refusal = undefined;
  }
});

test("a chat's pull request opens from https, ssh and git remotes, and a project without an origin says so", async () => {
  for (const remote of ["git@github.com:acme/site.git", "ssh://git@github.com/acme/site"]) {
    const setup = await chatOnBranch(runtime, { remote });
    github.requests.length = 0;
    const opened = await api(runtime, "POST", `/threads/${setup.thread.id}/pull-request`, {});
    assert.equal(opened.number, 7, remote);
    const create = github.requests.find((item) => item.method === "POST");
    assert.equal(create.url, "/repos/acme/site/pulls", remote);
    assert.equal(create.authorization, `Bearer ${TOKEN}`);
  }
  const lookalike = await chatOnBranch(runtime, { remote: "https://notgithub.com/acme/site.git" });
  const refused = await request(runtime, "POST", `/threads/${lookalike.thread.id}/pull-request`, {});
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /The origin remote \(https:\/\/notgithub\.com\/acme\/site\.git\) is not a GitHub repository/);

  const local = await chatOnBranch(runtime, { remote: "" });
  const none = await request(runtime, "POST", `/threads/${local.thread.id}/pull-request`, {});
  assert.equal(none.status, 409);
  assert.match(none.body.error, /The project has no origin remote to push to/);
});

test("without any GitHub token, opening a pull request says how to sign in, and GitHub is not asked", async () => {
  // A PATH with git and no gh, so the developer's own token is never looked at.
  const tools = path.join(scratch, "only-git");
  await mkdir(tools, { recursive: true });
  await symlink(execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), path.join(tools, "git"));
  const quiet = await fakeGitHub();
  const own = await startRuntime({ env: { SATURN_GITHUB_API: quiet.url, GH_TOKEN: "", GITHUB_TOKEN: "", PATH: tools, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
  try {
    const setup = await chatOnBranch(own);
    const refused = await request(own, "POST", `/threads/${setup.thread.id}/pull-request`, {});
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.error, /^No GitHub token: sign in with `gh auth login`/);
    assert.equal(quiet.requests.length, 0);
    assert.equal(git(setup.bare, "rev-parse", "--verify", `refs/heads/${setup.worktree.branch}`).length, 40, "the branch was pushed first");
  } finally {
    await own.stop();
  }
});

test("the user sends all the review comments at once: a resolved thread is left out, and sent ones do not come back", async () => {
  github.state.conclusion = "success";
  const setup = await chatOnBranch(runtime, { reply: () => "done" });
  await api(runtime, "POST", `/threads/${setup.thread.id}/pull-request`, {});
  const watch = await api(runtime, "POST", `/threads/${setup.thread.id}/pull-request/check`);
  assert.equal(watch.checks, "success");
  assert.equal(watch.fixRounds, 0);
  assert.deepEqual(watch.feedback.map((item) => [item.author, item.path ?? ""]), [["rev", ""], ["rev", "src/a.ts"]]);
  const headBefore = git(setup.bare, "rev-parse", setup.worktree.branch);

  const sent = await api(runtime, "POST", `/threads/${setup.thread.id}/pull-request/feedback/send`, {});
  assert.equal(sent.sent, 2);
  const review = await api(runtime, "GET", `/runs/${sent.runId}`);
  assert.match(review.input, /Review comments on pull request #7:\n\n- rev: Please add a changelog entry\.\n {2}And a test\.\n- rev on `src\/a\.ts:3`: Off by one here\./, "a comment's further lines stay under it");
  assert.ok(!review.input.includes("Resolved already"));
  assert.deepEqual((await threadOf(setup)).pullRequest.feedback, []);
  await finished(runtime, sent.runId);
  await until("the review turn is done", () => threadOf(setup), (thread) => thread.pullRequest.pushRunId === undefined);

  const again = await api(runtime, "POST", `/threads/${setup.thread.id}/pull-request/check`);
  assert.deepEqual(again.feedback, [], "comments already sent are not added again");
  const nothing = await request(runtime, "POST", `/threads/${setup.thread.id}/pull-request/feedback/send`, {});
  assert.equal(nothing.status, 409);
  assert.match(nothing.body.error, /No review comments to send/);
  assert.equal(git(setup.bare, "rev-parse", setup.worktree.branch), headBefore, "a turn that changed nothing pushes nothing");
});

test("a run that is not a fix round pushes nothing, and a failed check with no address is still listed", async () => {
  github.state.conclusion = "failure";
  github.state.head = "sha-plain";
  const setup = await chatOnBranch(runtime, {
    reply: (body) => {
      const asked = body.messages.filter((item) => item.role === "user").at(-1)?.content ?? "";
      if (body.tools?.length && !actedSinceAsking(body.messages) && /write a note/.test(asked)) return [call("files", { action: "write", path: "note.txt", content: "not for the branch yet\n" })];
      return "done";
    },
  });
  try {
    await api(runtime, "POST", `/threads/${setup.thread.id}/pull-request`, {});
    const pushed = git(setup.bare, "rev-parse", setup.worktree.branch);

    const started = await api(runtime, "POST", `/agents/${setup.agent.id}/runs`, { input: "write a note", threadId: setup.thread.id });
    const ordinary = await finished(runtime, started.id);
    assert.equal(ordinary.status, "completed", ordinary.error);
    assert.equal(await readFile(path.join(setup.worktree.path, "note.txt"), "utf8"), "not for the branch yet\n");
    assert.equal(git(setup.bare, "rev-parse", setup.worktree.branch), pushed);

    const watch = await api(runtime, "POST", `/threads/${setup.thread.id}/pull-request/check`);
    assert.deepEqual(watch.failed, [{ name: "test", url: "" }]);
    assert.ok(github.requests.some((item) => item.url === "/repos/acme/site/actions/jobs/11/logs"), "the log was looked up");
    assert.equal(watch.fixRounds, 1);
    await finished(runtime, watch.fixRunId);
    await until("the fix round is over", () => threadOf(setup), (thread) => thread.pullRequest.fixRunId === undefined);
  } finally {
    github.state.conclusion = "success";
    github.state.head = "sha-one";
  }
});
