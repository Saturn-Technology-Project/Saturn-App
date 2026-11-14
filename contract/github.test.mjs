// The GitHub tools and following a pull request, whichever language runs them. Nothing here reaches GitHub: the API is a
// fake server, git goes to local folders, and the token is a made-up value. Each tool's answer and each request GitHub got
// are compared with contract/cases/origin.json, recorded from the TypeScript runtime before it was removed; a change here is a deliberate one.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { placed, startRuntime } from "./runtime.mjs";

const casesFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "cases/origin.json");
const TOKEN = "made-up-github-token";

let scratch;
let github;
let runtime;
const servers = [];

/** git with fixed names and dates, so commits have the same ids on every run. */
const git = (cwd, ...args) => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@example.test", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@example.test", GIT_AUTHOR_DATE: "2026-01-02T03:04:05+00:00", GIT_COMMITTER_DATE: "2026-01-02T03:04:05+00:00", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
}).trim();

const pullRequest = (extra = {}) => ({
  number: 7, title: "Add it", state: "open", draft: false, user: { login: "dev" }, head: { ref: "feature", sha: "sha-one" }, base: { ref: "main" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", closed_at: null, merged_at: null, html_url: "https://github.com/acme/site/pull/7", body: "The body", labels: [{ name: "bug" }], requested_reviewers: [{ login: "rev" }], requested_teams: [{ slug: "core" }], node_id: "PR_node", mergeable: true, mergeable_state: "clean", ...extra,
});
const repository = { owner: { login: "acme" }, name: "site", description: "A site", default_branch: "main", visibility: "private", archived: false, clone_url: "https://github.com/acme/site.git", html_url: "https://github.com/acme/site", created_at: "2026-01-01T00:00:00Z", pushed_at: "2026-01-03T00:00:00Z" };

/** GitHub's answers, enough for every tool; `state` changes what the pull request and its checks say. */
async function fakeGitHub() {
  const requests = [];
  const state = { head: "sha-one", conclusion: "failure", merged: false };
  const answer = (method, url, body, response) => {
    const route = url.split("?")[0];
    const site = "/repos/acme/site";
    const key = `${method} ${route}`;
    const routes = {
      "GET /user": { login: "dev", name: "Dev" },
      "GET /user/orgs": [{ login: "acme" }],
      "GET /user/repos": [{ ...repository, name: "mine" }, { ...repository, name: "other-thing" }],
      "GET /users/someone/repos": [{ ...repository, name: "theirs" }],
      "POST /user/repos": { ...repository, name: "fresh", owner: { login: "dev" } },
      "POST /orgs/acme/repos": { ...repository, name: "team" },
      "POST /repos/acme/team/branches/main/rename": { name: "trunk" },
      [`GET ${site}`]: repository,
      [`GET ${site}/pulls`]: [pullRequest(), pullRequest({ number: 8, user: { login: "other" }, body: undefined, labels: undefined, requested_reviewers: undefined, requested_teams: undefined, mergeable: undefined })],
      [`POST ${site}/pulls`]: () => { if (body.head === "refused") { response.statusCode = 422; return { message: "Validation Failed", errors: [{ message: "No commits between" }] }; } response.statusCode = 201; return pullRequest(); },
      [`GET ${site}/pulls/7`]: () => pullRequest({ head: { ref: "feature", sha: state.head }, merged_at: state.merged ? "2026-01-05T00:00:00Z" : null, state: state.merged ? "closed" : "open" }),
      [`PATCH ${site}/pulls/7`]: () => pullRequest({ title: body.title ?? "Add it", ...(body.base ? { base: { ref: body.base } } : {}) }),
      [`GET ${site}/pulls/3`]: () => pullRequest({ number: 3, head: { ref: "parent-branch", sha: "p" } }),
      [`GET ${site}/pulls/7/files`]: [{ filename: "a.ts", status: "modified", additions: 1, deletions: 2, patch: "@@" }, { filename: "b.ts", status: "renamed", additions: 0, deletions: 0, previous_filename: "old.ts" }],
      [`GET ${site}/pulls/7/commits`]: [{ sha: "c1", commit: { message: "One", author: { name: "Dev", date: "2026-01-01T00:00:00Z" } } }],
      [`GET ${site}/pulls/7/reviews`]: [{ id: 3, user: { login: "rev" }, state: "APPROVED", body: "ok", submitted_at: "2026-01-01T00:00:00Z", commit_id: "c1" }],
      [`POST ${site}/pulls/7/reviews`]: { id: 3, state: body?.event, body: body?.body, html_url: "https://github.com/r" },
      [`PUT ${site}/pulls/7/reviews/3`]: { id: 3, state: "COMMENTED", body: body?.body },
      [`PUT ${site}/pulls/7/reviews/3/dismissals`]: { id: 3, state: "DISMISSED" },
      [`PUT ${site}/pulls/7/merge`]: { merged: true, sha: "merged-sha", message: "Merged" },
      [`GET ${site}/issues/7/comments`]: [{ id: 501, user: { login: "rev" }, body: "Please add a changelog entry.", created_at: "2026-01-01T01:00:00Z", updated_at: "2026-01-01T01:00:00Z" }, { id: 502, user: { login: "rev" }, body: "   ", created_at: "2026-01-01T01:01:00Z" }],
      [`POST ${site}/issues/7/comments`]: { id: 44, body: body?.body, html_url: "https://github.com/c" },
      [`POST ${site}/pulls/7/comments`]: { id: 45, path: body?.path, line: body?.line ?? null, side: body?.side ?? null, html_url: "https://github.com/i" },
      [`POST ${site}/pulls/7/comments/9/replies`]: { id: 46, body: body?.body, html_url: "https://github.com/re" },
      [`PATCH ${site}/issues/comments/44`]: { id: 44, body: body?.body },
      [`PATCH ${site}/pulls/comments/45`]: { id: 45, body: body?.body },
      [`PUT ${site}/issues/7/labels`]: (body?.labels ?? []).map((name) => ({ name })),
      [`POST ${site}/labels`]: { name: body?.name, color: body?.color ?? "ededed", description: body?.description ?? null },
      [`POST ${site}/pulls/7/requested_reviewers`]: pullRequest(),
      [`DELETE ${site}/pulls/7/requested_reviewers`]: pullRequest({ requested_reviewers: [], requested_teams: [] }),
      [`GET ${site}/check-runs/11/annotations`]: [{ path: "src/a.ts", start_line: 3, annotation_level: "failure", message: "expected 2, got 3" }],
      [`GET ${site}/check-runs/11`]: () => ({ id: 11, name: "test", status: "completed", conclusion: state.conclusion, html_url: "https://github.com/acme/site/runs/11", output: { summary: "1 failed", text: "details" } }),
      [`GET ${site}/check-runs/12/annotations`]: [],
      [`GET ${site}/check-runs/12`]: { id: 12, name: "external", conclusion: "failure", html_url: "https://ci.test/12", output: { summary: "From elsewhere", text: "More text" } },
      [`GET ${site}/check-suites/5/check-runs`]: { total_count: 1, check_runs: [{ id: 13, name: "suite", status: "in_progress", conclusion: null, started_at: "2026-01-01T00:00:00Z", completed_at: null, html_url: "https://github.com/s" }] },
      [`GET ${site}/commits/passing/check-runs`]: { total_count: 1, check_runs: [{ id: 14, name: "ok", status: "completed", conclusion: "success" }] },
      [`GET ${site}/commits/nothing/check-runs`]: { total_count: 0, check_runs: [] },
      [`GET ${site}/commits/many/check-runs`]: { total_count: 5, check_runs: [{ id: 15, name: "one", status: "completed", conclusion: "success" }] },
    };
    if (key === `GET ${site}/actions/jobs/11/logs`) {
      response.setHeader("content-type", "text/plain");
      return "2026-10-21T00:00:00.0000000Z npm test\n2026-10-21T00:00:01.0000000Z FAIL src/a.test.ts: expected 2, got 3\n";
    }
    if (key === `GET ${site}/commits/${state.head}/check-runs`) return { total_count: 2, check_runs: [{ id: 11, name: "test", status: "completed", conclusion: state.conclusion, html_url: "https://github.com/acme/site/runs/11" }, { id: 12, name: "lint", status: "completed", conclusion: "success" }] };
    if (key === "POST /graphql") {
      if (body.query.includes("reviewThreads")) return { data: { repository: { pullRequest: { reviewThreads: { nodes: [
        { id: "T1", isResolved: false, isOutdated: false, path: "src/a.ts", line: 3, startLine: null, diffSide: "RIGHT", comments: { nodes: [{ databaseId: 9, author: { login: "rev" }, body: "Off by one here.", createdAt: "2026-01-01T01:05:00Z" }] } },
        { id: "T2", isResolved: true, isOutdated: true, path: "README.md", line: 1, startLine: null, diffSide: "RIGHT", comments: { nodes: [{ databaseId: 10, author: null, body: "Resolved already.", createdAt: "2026-01-01T01:06:00Z" }] } },
      ], pageInfo: { hasNextPage: true, endCursor: "CURSOR" } } } } } };
      if (body.query.includes("PullRequestReviewThread")) return body.variables.id === "T1" ? { data: { node: { comments: { nodes: [{ databaseId: 9 }] } } } } : { data: { node: null } };
      if (body.query.includes("resolveReviewThread") || body.query.includes("unresolveReviewThread")) return { data: { x: { thread: { id: body.variables.id, isResolved: !body.query.includes("unresolve") } } } };
      if (body.query.includes("convertPullRequestToDraft") || body.query.includes("markPullRequestReadyForReview")) return { data: { x: {} } };
      return { errors: [{ message: "bad query" }, { message: "and another" }] };
    }
    if (key in routes) return typeof routes[key] === "function" ? routes[key]() : routes[key];
    response.statusCode = 404;
    return { message: "Not Found" };
  };
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, accept: request.headers.accept, version: request.headers["x-github-api-version"], agent: request.headers["user-agent"], contentType: request.headers["content-type"], ...(body === undefined ? {} : { body }) });
      response.setHeader("content-type", "application/json");
      const reply = answer(request.method, request.url, body, response);
      response.end(typeof reply === "string" ? reply : JSON.stringify(reply));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { requests, state, url: `http://127.0.0.1:${server.address().port}` };
}

before(async () => {
  scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "saturn-contract-github-")));
  github = await fakeGitHub();
  // The one repository a mirror may clone, from a local folder; anything else named would fail, not reach the network.
  const mirrored = path.join(scratch, "mirrored.git");
  git(scratch, "init", "-q", "--bare", "-b", "main", mirrored);
  const seed = path.join(scratch, "mirrored-seed");
  git(scratch, "init", "-q", "-b", "main", seed);
  await writeFile(path.join(seed, "hello.txt"), "from the mirror\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "mirror");
  git(seed, "push", "-q", mirrored, "main");
  const gitConfig = path.join(scratch, "gitconfig");
  await writeFile(gitConfig, `[url "${pathToFileURL(mirrored).href}"]\n\tinsteadOf = https://github.com/acme/mirrored.git\n[url "file:///nonexistent/blocked/"]\n\tinsteadOf = https://github.com/acme/never/\n`);
  runtime = await startRuntime({ env: { SATURN_GITHUB_API: github.url, GH_TOKEN: TOKEN, GITHUB_TOKEN: "", GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
});
after(async () => {
  await runtime?.stop();
  await Promise.all(servers.map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
  await rm(scratch, { recursive: true, force: true });
});

async function call(target, method, route, body) {
  const token = (await readFile(path.join(target.dataDir, "runtime-token"), "utf8")).trim();
  const response = await fetch(`${target.origin}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function api(method, route, body, target = runtime) {
  const answer = await call(target, method, route, body);
  assert.ok(answer.status < 300, `${method} ${route}: ${answer.status} ${JSON.stringify(answer.body)}`);
  return answer.body;
}

async function until(what, read, done) {
  let value;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`never happened: ${what}; last ${JSON.stringify(value)}`);
}

/** A model that answers with what `reply` says for each request. */
async function model(reply, target = runtime) {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw || "{}");
      requests.push(body);
      const answer = reply(body);
      const message = Array.isArray(answer) ? { role: "assistant", content: "", tool_calls: answer } : { role: "assistant", content: answer };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "r", object: "chat.completion", model: "s", choices: [{ index: 0, finish_reason: Array.isArray(answer) ? "tool_calls" : "stop", message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const connection = await api("POST", "/connections/models", { name: "Scripted", provider: "openai", model: "s", baseUrl: `http://127.0.0.1:${server.address().port}` }, target);
  return { requests, connection };
}

const toolCall = (name, args, id = "c0") => [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }];

/** A git repository on main and a feature branch, the same commits every run. */
async function repository_(name, remote) {
  const folder = path.join(scratch, name);
  git(scratch, "init", "-q", "-b", "main", folder);
  await mkdir(path.join(folder, "src"), { recursive: true });
  await writeFile(path.join(folder, "src/app.ts"), "export const answer = 42;\nexport const Other = 'answer';\nconst third = 3;\n");
  await writeFile(path.join(folder, "README.md"), "# Site\nThe answer is here.\n");
  await writeFile(path.join(folder, "bin.dat"), "bin\0ary\n");
  git(folder, "add", ".");
  git(folder, "commit", "-q", "-m", "First commit\n\nWith a body.");
  git(folder, "checkout", "-q", "-b", "feature");
  await writeFile(path.join(folder, "src/new.ts"), "export const fresh = true;\n");
  await writeFile(path.join(folder, "src/app.ts"), "export const answer = 43;\nexport const Other = 'answer';\nconst third = 3;\n");
  git(folder, "add", ".");
  git(folder, "commit", "-q", "-m", "Second commit");
  git(folder, "checkout", "-q", "main");
  if (remote) git(folder, "remote", "add", "origin", remote);
  return folder;
}

/** Runs each [tool, arguments] through a scripted agent, a few to a run, and gives what each answered. */
async function runTools(steps, folder) {
  const queue = [];
  const { connection } = await model((body) => {
    // Background work (a chat's title, memory) asks without tools and must not take a step meant for the run.
    const next = body.tools?.length ? queue.shift() : undefined;
    return next ? toolCall(next[0], next[1]) : "done";
  });
  const agent = await api("POST", "/agents", { name: "Tools", modelConnectionId: connection.id, autonomy: "bypass", mcpConnectionIds: ["general-skills", "origin"] });
  const project = await api("POST", "/projects", { path: folder, grant: true });
  const thread = await api("POST", `/agents/${agent.id}/threads`, { title: "Tools", projectId: project.id });
  const answers = [];
  for (let at = 0; at < steps.length; at += 8) {
    const batch = steps.slice(at, at + 8);
    queue.push(...batch);
    const started = await api("POST", `/agents/${agent.id}/runs`, { input: "go", threadId: thread.id });
    const run = await until("the run", () => api("GET", `/runs/${started.id}`), (item) => !["queued", "running", "waiting_approval"].includes(item.status));
    assert.equal(run.status, "completed", run.error);
    assert.equal(run.actions.length, batch.length);
    for (const [index, action] of run.actions.entries()) {
      answers.push({ tool: batch[index][0], arguments: batch[index][1], status: action.status, ...(action.result === undefined ? {} : { result: action.result }), ...(action.reason === undefined ? {} : { reason: action.reason }) });
    }
  }
  return answers;
}

/** Compares with the recording, or makes it. */
async function matchesRecording(name, value) {
  const normalized = JSON.parse(JSON.stringify(placed(value, [[runtime.dataDir, "<data>"], [scratch, "<scratch>"]])).replaceAll(github.url, "<github>").replaceAll(TOKEN, "<token>"));
  const all = await readFile(casesFile, "utf8").then(JSON.parse).catch(() => ({}));
  assert.ok(all[name], `${name} is not recorded`);
  for (const [index, expected] of (Array.isArray(all[name]) ? all[name] : [all[name]]).entries()) {
    assert.deepEqual(Array.isArray(all[name]) ? normalized[index] : normalized, expected, `${name}[${index}]`);
  }
  if (Array.isArray(all[name])) assert.equal(normalized.length, all[name].length);
}

const site = { owner: "acme", name: "site" };

test("the repository tools read a local checkout, and refuse what would climb out of it", async () => {
  const folder = await repository_("reading", "https://github.com/acme/site.git");
  const main = git(folder, "rev-parse", "main");
  const feature = git(folder, "rev-parse", "feature");
  const outside = path.join(scratch, "not-a-project");
  git(scratch, "init", "-q", "-b", "main", outside);
  await writeFile(path.join(outside, "private.txt"), "OUTSIDE PRIVATE\n");
  git(outside, "add", ".");
  git(outside, "commit", "-q", "-m", "private");
  const steps = [
    ["get_file_contents", { ...site, path: "src/app.ts", ref: "main", startLine: 2, endLine: 3 }],
    ["get_file_contents", { ...site, path: "README.md" }],
    ["get_file_contents", { ...site, path: "src", ref: "feature" }],
    ["get_file_contents", { ...site, path: "" }],
    ["get_file_contents", { ...site, path: "bin.dat" }],
    ["get_file_contents", { ...site, path: "missing.txt", ref: "main" }],
    ["get_file_contents", { ...site, path: "../../etc/passwd" }],
    ["get_file_contents", { ...site, path: "/etc/passwd" }],
    ["get_git_tree", { ...site, sha: "feature" }],
    ["get_git_tree", { ...site, recursive: false }],
    ["grep_contents", { ...site, query: "answer", ref: "main", literal: true }],
    ["grep_contents", { ...site, query: "OTHER", caseInsensitive: true, contextBefore: 1, contextAfter: 1 }],
    ["grep_contents", { ...site, query: "the", wholeWord: true, filterPath: "README.md" }],
    ["grep_contents", { ...site, query: "answer", includes: ["*.md"] }],
    ["grep_contents", { ...site, query: "answer", excludes: ["*.md"], maxResults: 1 }],
    ["grep_contents", { ...site, query: "nowhere to be found" }],
    ["grep_contents", { ...site }],
    ["list_branches", { ...site }],
    ["list_branches", { ...site, prefix: "fea" }],
    ["list_branches", { ...site, pageSize: 1 }],
    ["list_branches", { ...site, pageSize: 1, pageToken: "2" }],
    ["list_commits", { ...site, ref: "feature" }],
    ["list_commits", { ...site, ref: "feature", pageSize: 1 }],
    ["list_commits", { ...site, ref: "feature", pageSize: 1, pageToken: "2" }],
    ["list_commits", { ...site, ref: "feature", authorEmails: ["nobody@example.test"] }],
    ["list_commits", { ...site, ref: "feature", since: "2027-01-01" }],
    ["commit_read", { ...site, sha: main }],
    ["commit_read", { ...site, sha: feature, view: "files" }],
    ["commit_read", { ...site, sha: feature, view: "patch", startLine: 1, endLine: 4 }],
    ["commit_read", { ...site, sha: "--output=/tmp/saturn-contract-x" }],
    ["commit_read", { ...site, sha: "main:README.md" }],
    ["compare_commits", { ...site, base: "main", head: "feature" }],
    ["compare_commits", { ...site, base: "feature", head: "main" }],
    ["compare_commits", { ...site, base: "--all", head: "main" }],
    ["list_commits", { owner: "acme" }],
    ["get_file_contents", { owner: "local", name: "reading", path: "README.md" }],
    ["get_file_contents", { owner: "local", name: "somewhere-else", path: "README.md" }],
    // A name is not a path: these would otherwise reach a repository elsewhere on the computer, or be read as options.
    ["get_file_contents", { owner: "../..", name: "not-a-project", path: "private.txt" }],
    ["get_file_contents", { owner: "acme", name: "../../../../not-a-project", path: "private.txt" }],
    ["get_file_contents", { owner: "acme", name: "--upload-pack=x", path: "private.txt" }],
    ["get_file_contents", { owner: "..", name: "..", path: "private.txt" }],
    ["get_repository", { owner: "..", name: "x" }],
    // A repository that is not this one: cloned once under the data folder, with the file there.
    ["get_file_contents", { owner: "acme", name: "mirrored", path: "hello.txt" }],
    ["get_file_contents", { owner: "acme", name: "mirrored", path: "hello.txt" }],
    ["sync_mirror", { owner: "acme", name: "mirrored", ref: "main" }],
    ["sync_mirror", { owner: "acme", name: "mirrored", ref: "main", sha: "0000000" }],
    ["sync_mirror", { owner: "acme", name: "mirrored", ref: "-x" }],
  ];
  const answers = await runTools(steps, folder);
  const text = JSON.stringify(answers);
  assert.ok(!text.includes("OUTSIDE PRIVATE"), "a repository outside was read");
  await matchesRecording("repository tools", answers);
});

test("the hosted tools ask GitHub with the user's token and answer in Saturn's shapes", async () => {
  const folder = await repository_("hosted", "https://github.com/acme/site.git");
  github.requests.length = 0;
  github.state.head = "sha-one";
  github.state.conclusion = "failure";
  const number = { ...site, number: 7 };
  const steps = [
    ["get_repository", site],
    ["list_repositories", { owner: "dev", filter: "OTHER" }],
    ["list_repositories", { owner: "someone", pageSize: 1, pageToken: "3" }],
    ["list_repositories", {}],
    ["list_namespaces", {}],
    ["list_namespaces", { pageSize: 1, pageToken: "2" }],
    ["create_repository", { name: "fresh" }],
    ["create_repository", { name: "team", owner: "acme", defaultBranch: "trunk" }],
    ["create_repository", {}],
    ["create_repository", { name: "x/../../user/keys" }],
    ["create_repository", { name: "fine", owner: "../orgs" }],
    ["list_pull_requests", site],
    ["list_pull_requests", { ...site, state: "all", sortBy: "updated", direction: "asc", base: "main", head: "feature", author: "OTHER", pageSize: 2 }],
    ["list_pull_requests", { ...site, state: "strange", head: "someone:branch" }],
    ["pull_request_read", number],
    ["pull_request_read", { ...number, view: "files" }],
    ["pull_request_read", { ...number, view: "commits", pageSize: 1 }],
    ["pull_request_read", { ...number, view: "reviews" }],
    ["pull_request_read", { ...number, view: "comments" }],
    ["pull_request_read", { ...number, view: "threads" }],
    ["pull_request_read", { ...number, view: "threads", threadIds: ["T2"], pageToken: "CURSOR" }],
    ["pull_request_read", { ...site, number: 99 }],
    ["pull_request_read", { ...site, number: -1 }],
    ["pull_request_read", { ...site, number: 1.5 }],
    ["checks_read", number],
    ["checks_read", { ...site, target: { number: 7 } }],
    ["checks_read", { ...site, target: { sha: "passing" } }],
    ["checks_read", { ...site, sha: "nothing" }],
    ["checks_read", { ...site, ref: "many", pageSize: 1 }],
    ["checks_read", { ...site, target: { checkRunId: "11" } }],
    ["checks_read", { ...site, target: { checkSuiteId: "5" } }],
    ["checks_read", site],
    ["create_pull_request", { ...site, title: "T", head: "feature", base: "main", body: "B", draft: true }],
    ["create_pull_request", { ...site, title: "T", head: "feature" }],
    ["create_pull_request", { ...site, title: "T", head: "feature", parentPullNumber: 3 }],
    ["create_pull_request", { ...site, title: "T", head: "refused", base: "main" }],
    ["update_pull_request", { ...number, title: "New", body: "Text", state: "closed" }],
    ["update_pull_request", number],
    ["update_pull_request", { ...number, draft: true }],
    ["update_pull_request", { ...number, draft: false }],
    ["update_pull_request_base", { ...number, base: "develop" }],
    ["update_pull_request_base", { ...number, parentPullNumber: 3 }],
    ["update_pull_request_base", number],
    ["merge_pull_request", number],
    ["merge_pull_request", { ...number, expectedHeadSha: "abc", mergeMethod: "squash" }],
    ["merge_pull_request", { ...number, expectedHeadSha: "abc", mergeMethod: "rebase" }],
    ["create_pull_request_review", { ...number, event: "approve", body: "Nice" }],
    ["create_pull_request_review", { ...number, event: "request_changes" }],
    ["create_pull_request_review", { ...number, event: "whatever" }],
    ["update_pull_request_review", { ...number, reviewId: "3", body: "Edited" }],
    ["dismiss_pull_request_review", { ...number, reviewId: "3", message: "Stale" }],
    ["create_pull_request_comment", { ...number, body: "Hello" }],
    ["create_pull_request_inline_comment", { ...number, body: "Here", anchor: { path: "src/a.ts", startLine: 3 } }],
    ["create_pull_request_inline_comment", { ...number, body: "Range", anchor: { kind: "range", path: "./src/a.ts", startLine: 3, endLine: 5, side: "left" } }],
    ["create_pull_request_inline_comment", { ...number, body: "File", anchor: { kind: "file", path: "src/a.ts" } }],
    ["create_pull_request_inline_comment", { ...number, body: "Out", anchor: { path: "../x" } }],
    ["reply_pull_request_review_thread", { ...number, threadId: "9", body: "Reply" }],
    ["reply_pull_request_review_thread", { ...number, threadId: "T1", body: "Reply by node" }],
    ["reply_pull_request_review_thread", { ...number, threadId: "T9", body: "None" }],
    ["update_pull_request_review_thread", { ...number, threadId: "T1", resolved: true }],
    ["update_pull_request_review_thread", { ...number, threadId: "T1", resolved: false }],
    ["update_pull_request_comment", { ...number, commentId: "44", body: "Edit" }],
    ["update_pull_request_comment", { ...number, commentId: "45", body: "Edit inline" }],
    ["update_pull_request_comment", { ...number, commentId: "46", body: "Gone" }],
    ["update_pull_request_labels", { ...number, labels: ["a", "b"] }],
    ["create_label", { ...site, label: "new", color: "#ff0000", description: "A label" }],
    ["create_label", { ...site, label: "plain" }],
    ["request_pull_request_reviewers", { ...number, users: ["rev"], groups: ["core"] }],
    ["remove_pull_request_reviewers", { ...number, users: ["rev"] }],
  ];
  const answers = await runTools(steps, folder);
  assert.ok(github.requests.every((request) => request.authorization === `Bearer ${TOKEN}`));
  await matchesRecording("hosted tools", answers);
  await matchesRecording("requests GitHub got", github.requests);
});

test("a tool that changes GitHub waits for approval in review mode, and a denied one reaches nothing", async () => {
  const folder = await repository_("approving", "https://github.com/acme/site.git");
  const queue = [toolCall("create_pull_request_comment", { ...site, number: 7, body: "Hello" })];
  const { connection } = await model((body) => (body.tools?.length ? queue.shift() : undefined) ?? "done");
  const agent = await api("POST", "/agents", { name: "Careful", modelConnectionId: connection.id, autonomy: "review", mcpConnectionIds: ["general-skills", "origin"] });
  const project = await api("POST", "/projects", { path: folder, grant: true });
  const thread = await api("POST", `/agents/${agent.id}/threads`, { title: "Careful", projectId: project.id });
  github.requests.length = 0;
  const started = await api("POST", `/agents/${agent.id}/runs`, { input: "go", threadId: thread.id });
  const waiting = await until("the approval", () => api("GET", `/runs/${started.id}`), (run) => run.status === "waiting_approval");
  assert.deepEqual(waiting.actions.map((action) => [action.toolId, action.status]), [["create_pull_request_comment", "waiting_approval"]]);
  assert.equal(github.requests.length, 0, "nothing was asked before the approval");
  await api("POST", `/runs/${started.id}/actions/${waiting.actions[0].id}/decision`, { allow: false });
  const ended = await until("the run", () => api("GET", `/runs/${started.id}`), (run) => !["queued", "running", "waiting_approval"].includes(run.status));
  assert.equal(ended.actions[0].status, "denied");
  assert.equal(github.requests.length, 0, "a denied comment was not posted");
});

/** A project with a chat on its own branch; pushes go to a local bare repository, though `origin` reads as GitHub. */
async function chatOnBranch(name, reply) {
  const folder = await repository_(name, "https://github.com/acme/site.git");
  const bare = path.join(scratch, `${name}.git`);
  git(scratch, "init", "-q", "--bare", "-b", "main", bare);
  git(folder, "config", `url.file://${bare}.pushInsteadOf`, "https://github.com/acme/site.git");
  git(folder, "push", "-q", "origin", "main");
  const { connection, requests } = await model(reply);
  const agent = await api("POST", "/agents", { name: "Fixer", modelConnectionId: connection.id, autonomy: "bypass" });
  const project = await api("POST", "/projects", { path: folder, grant: true });
  const thread = await api("POST", `/agents/${agent.id}/threads`, { title: "Add a feature", projectId: project.id });
  const worktree = await api("POST", `/threads/${thread.id}/worktree`);
  return { folder, bare, agent, project, thread, worktree, requests };
}

const threadOf = async (setup) => (await api("GET", `/agents/${setup.agent.id}/threads`)).find((item) => item.id === setup.thread.id);
const stopped = (run) => !["queued", "running", "waiting_approval"].includes(run.status);
const runEnds = (id) => until("the run ends", () => api("GET", `/runs/${id}`), stopped);

test("a pull request from a chat's branch: pending work is committed and pushed, and the last summary is its description", async () => {
  const setup = await chatOnBranch("opening", () => "Done.\n\n## Summary\nAdded feature.ts.");
  const started = await api("POST", `/agents/${setup.agent.id}/runs`, { input: "go", threadId: setup.thread.id });
  await runEnds(started.id);
  await writeFile(path.join(setup.worktree.path, "feature.ts"), "export const feature = true;\n");
  github.requests.length = 0;

  const opened = await call(runtime, "POST", `/threads/${setup.thread.id}/pull-request`, {});
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  assert.deepEqual(opened.body, { url: "https://github.com/acme/site/pull/7", number: 7, branch: setup.worktree.branch });
  assert.equal(git(setup.bare, "rev-parse", "--verify", `refs/heads/${opened.body.branch}`).length, 40, "the branch was pushed");
  assert.equal(git(setup.worktree.path, "status", "--porcelain"), "", "pending work was committed first");
  assert.equal(git(setup.bare, "log", "--format=%s %an", "-1", opened.body.branch), "Saturn: Add a feature Saturn");
  const create = github.requests.find((request) => request.method === "POST");
  assert.equal(create.url, "/repos/acme/site/pulls");
  assert.deepEqual(create.body, { title: "Add a feature", head: opened.body.branch, base: "main", body: "Added feature.ts.", draft: false });

  const thread = await threadOf(setup);
  assert.equal(thread.pullRequest.number, 7);
  assert.equal(thread.pullRequest.repository, "acme/site");
  assert.equal(thread.pullRequest.branch, opened.body.branch);
  assert.equal(thread.pullRequest.watching, true);
  assert.equal(thread.pullRequest.state, "open");
  assert.equal(thread.pullRequest.checks, "pending");
  assert.equal(thread.pullRequest.fixRounds, 0);
  assert.deepEqual(thread.pullRequest.feedback, []);

  // With a given title and body; and GitHub's refusal reaches the user with its message.
  const titled = await api("POST", `/threads/${setup.thread.id}/pull-request`, { title: "My title", body: "My body" });
  assert.equal(titled.number, 7);
  assert.equal(github.requests.at(-1).body.title, "My title");
  assert.equal(github.requests.at(-1).body.body, "My body");

  // No worktree, no origin on GitHub.
  const plain = await api("POST", `/agents/${setup.agent.id}/threads`, { title: "Plain", projectId: setup.project.id });
  const none = await call(runtime, "POST", `/threads/${plain.id}/pull-request`, {});
  assert.equal(none.status, 404);
  assert.match(none.body.error, /no worktree branch/);
  assert.equal((await call(runtime, "POST", "/threads/thread_missing/pull-request", {})).status, 404);

  const elsewhere = path.join(scratch, "gitlab-project");
  await repository_("gitlab-project", "https://gitlab.com/acme/site.git");
  const other = await api("POST", "/projects", { path: elsewhere, grant: true });
  const otherThread = await api("POST", `/agents/${setup.agent.id}/threads`, { title: "Other", projectId: other.id });
  await api("POST", `/threads/${otherThread.id}/worktree`);
  const refused = await call(runtime, "POST", `/threads/${otherThread.id}/pull-request`, {});
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /is not a GitHub repository/);
});

test("a followed pull request: failing checks go to the agent with their logs, the fix is pushed, comments wait for the user", async () => {
  github.state.head = "sha-one";
  github.state.conclusion = "failure";
  github.state.merged = false;
  const asks = [];
  const setup = await chatOnBranch("following", (request) => {
    const asked = request.messages.filter((item) => item.role === "user").at(-1)?.content ?? "";
    const acted = request.messages.some((item) => item.role === "tool" || item.tool_calls?.length);
    if (!acted && /checks failed/.test(asked)) {
      asks.push(asked);
      return toolCall("code", { command: `echo fixed-${asks.length} > fix.txt` });
    }
    return "done";
  });
  await writeFile(path.join(setup.worktree.path, "feature.ts"), "export const feature = true;\n");
  await api("POST", `/threads/${setup.thread.id}/pull-request`, {});
  const check = () => api("POST", `/threads/${setup.thread.id}/pull-request/check`);
  const noFixRun = () => until("the fix is pushed", () => threadOf(setup), (thread) => thread.pullRequest.fixRunId === undefined);

  // First look: failing check, so an automatic turn with the log tail and annotations; two new pieces of feedback.
  const first = await check();
  assert.equal(first.state, "open");
  assert.equal(first.checks, "failure");
  assert.equal(first.head, "sha-one");
  assert.deepEqual(first.failed, [{ name: "test", url: "https://github.com/acme/site/runs/11" }]);
  assert.equal(first.fixRounds, 1);
  assert.equal(first.handledHead, "sha-one");
  assert.deepEqual(first.feedback.map((item) => [item.id, item.author, item.body, item.path ?? "", item.line ?? 0, item.at]), [
    ["comment:501", "rev", "Please add a changelog entry.", "", 0, "2026-01-01T01:00:00Z"],
    ["thread:T1:1", "rev", "Off by one here.", "src/a.ts", 3, "2026-01-01T01:05:00Z"],
  ]);
  assert.deepEqual(first.seenFeedback, ["comment:501", "thread:T1:1"]);
  const fix = await api("GET", `/runs/${first.fixRunId}`);
  assert.equal(fix.automatic, true);
  assert.match(fix.input, /checks failed on pull request #7 \(test\)/);
  assert.match(fix.input, /### test \(https:\/\/github\.com\/acme\/site\/runs\/11\)\nsrc\/a\.ts:3 failure: expected 2, got 3\n```\nnpm test\nFAIL src\/a\.test\.ts: expected 2, got 3\n```/);
  assert.ok(!fix.input.includes("2026-10-21T00:00"), "log timestamps are dropped");

  // The fix round ends: its change is committed and pushed.
  await runEnds(first.fixRunId);
  const pushed = await noFixRun();
  assert.equal(git(setup.bare, "log", "--format=%s", "-1", setup.worktree.branch), "Saturn: fix the checks on #7 (round 1)");
  assert.equal(git(setup.bare, "show", `${setup.worktree.branch}:fix.txt`), "fixed-1");
  assert.equal(pushed.pullRequest.checks, "pending");
  assert.equal(pushed.pullRequest.head, git(setup.bare, "rev-parse", setup.worktree.branch));

  // The same head again: no second round, and comments already seen are not added twice.
  const again = await check();
  assert.equal(again.fixRounds, 1);
  assert.equal(again.feedback.length, 2);
  assert.equal(again.fixRunId, undefined);

  // The user sends one comment: one message to the agent, the rest wait; its changes (none here) push nothing.
  const none = await call(runtime, "POST", `/threads/${setup.thread.id}/pull-request/feedback/send`, { ids: ["nothing"] });
  assert.equal(none.status, 409);
  assert.match(none.body.error, /No review comments to send/);
  const sent = await api("POST", `/threads/${setup.thread.id}/pull-request/feedback/send`, { ids: ["thread:T1:1"] });
  assert.equal(sent.sent, 1);
  const review = await api("GET", `/runs/${sent.runId}`);
  assert.match(review.input, /Review comments on pull request #7:\n\n- rev on `src\/a\.ts:3`: Off by one here\.\n\nAddress them in this branch/);
  await runEnds(sent.runId);
  await until("the review turn is done", () => threadOf(setup), (thread) => thread.pullRequest.pushRunId === undefined);
  assert.deepEqual((await threadOf(setup)).pullRequest.feedback.map((item) => item.id), ["comment:501"]);
  const dismissed = await api("POST", `/threads/${setup.thread.id}/pull-request/feedback/dismiss`, {});
  assert.deepEqual(dismissed.feedback, []);

  // Each new head that fails gets a round, up to two; then it is left to the user.
  github.state.head = "sha-two";
  const second = await check();
  assert.equal(second.fixRounds, 2);
  await runEnds(second.fixRunId);
  await noFixRun();
  assert.equal(git(setup.bare, "show", `${setup.worktree.branch}:fix.txt`), "fixed-2");
  github.state.head = "sha-three";
  const third = await check();
  assert.equal(third.fixRounds, 2);
  assert.equal(third.handledHead, "sha-three");
  assert.equal(third.fixRunId, undefined);
  assert.equal(asks.length, 2);

  // Green; following can stop and resume; a merged one is no longer followed.
  github.state.conclusion = "success";
  const green = await check();
  assert.equal(green.checks, "success");
  assert.deepEqual(green.failed, []);
  assert.equal((await api("POST", `/threads/${setup.thread.id}/pull-request/watch`, { watching: false })).watching, false);
  assert.equal((await api("POST", `/threads/${setup.thread.id}/pull-request/watch`, {})).watching, true);
  await until("the look that resuming starts", () => threadOf(setup), (thread) => thread.pullRequest.lastCheckedAt);
  github.state.merged = true;
  const merged = await until("the merged state", check, (watch) => watch.state === "merged");
  assert.equal(merged.watching, false);
  assert.ok(!Number.isNaN(Date.parse(merged.lastCheckedAt)));
});

test("a chat with no pull request says so", async () => {
  const { connection } = await model(() => "done");
  const agent = await api("POST", "/agents", { name: "None", modelConnectionId: connection.id });
  const thread = await api("POST", `/agents/${agent.id}/threads`, { title: "None" });
  for (const route of ["check", "watch", "feedback/send", "feedback/dismiss"]) {
    const answer = await call(runtime, "POST", `/threads/${thread.id}/pull-request/${route}`, {});
    assert.equal(answer.status, 404, route);
    assert.match(answer.body.error, /no pull request/, route);
  }
  assert.equal((await call(runtime, "POST", "/threads/thread_missing/pull-request/check", {})).status, 404);
});

test("without a GitHub token the tools and the follow-up say what to do", async () => {
  const quiet = await fakeGitHub();
  // No gh on this PATH, so the developer's own token is never looked at.
  const env = { SATURN_GITHUB_API: quiet.url, GH_TOKEN: "", GITHUB_TOKEN: "", PATH: path.join(scratch, "no-tools") };
  const first = await startRuntime({ env, keepData: true });
  let second;
  try {
    const queue = [toolCall("get_repository", site)];
    const { connection } = await model((body) => (body.tools?.length ? queue.shift() : undefined) ?? "done", first);
    const agent = await api("POST", "/agents", { name: "NoToken", modelConnectionId: connection.id, autonomy: "bypass", mcpConnectionIds: ["general-skills", "origin"] }, first);
    const thread = await api("POST", `/agents/${agent.id}/threads`, { title: "NoToken" }, first);
    const started = await api("POST", `/agents/${agent.id}/runs`, { input: "go", threadId: thread.id }, first);
    const run = await until("the run", () => api("GET", `/runs/${started.id}`, undefined, first), stopped);
    assert.equal(run.actions[0].status, "failed");
    assert.match(run.actions[0].reason, /GitHub access is needed for this\. Set GH_TOKEN, run `gh auth login`, or install GitHub in Customizations with a token\./);
    await first.stop();

    // The follow-up of a pull request opened earlier, on a computer that has since lost the token.
    const stateFile = path.join(first.dataDir, "state.json");
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    state.threads.find((item) => item.id === thread.id).pullRequest = { number: 1, url: "https://github.com/acme/site/pull/1", repository: "acme/site", branch: "b", watching: true, state: "open", checks: "pending", fixRounds: 0, feedback: [], seenFeedback: [], openedAt: "2026-01-01T00:00:00.000Z" };
    await writeFile(stateFile, JSON.stringify(state));
    second = await startRuntime({ env, dataDir: first.dataDir });
    const watch = await api("POST", `/threads/${thread.id}/pull-request/check`, undefined, second);
    assert.match(watch.error, /No GitHub token: sign in with `gh auth login`, set GH_TOKEN, or install GitHub under Customizations\./);
    assert.ok(!Number.isNaN(Date.parse(watch.lastCheckedAt)));
    assert.equal(watch.state, "open");
    assert.equal(quiet.requests.length, 0);
  } finally {
    await (second ?? first).stop();
  }
});
