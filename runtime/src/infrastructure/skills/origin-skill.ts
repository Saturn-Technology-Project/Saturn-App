import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { launchEnv } from "../launch-env.js";

const execFileAsync = promisify(execFile);

/**
 * Origin tools backed by real git and GitHub.
 * - Repository content (files, trees, grep, branches, commits, diffs) comes from a local git checkout:
 *   the workspace repo when its `origin` remote is the requested owner/name, otherwise a blobless clone
 *   kept under <dataDir>/origin/<owner>/<name> (made on first use, refreshed by sync_mirror).
 * - Hosted features (pull requests, reviews, comments, labels, reviewers, checks, repositories) go to the
 *   GitHub API with the user's own token: GH_TOKEN / GITHUB_TOKEN, `gh auth token`, or the GitHub token
 *   saved by installing GitHub in Customizations.
 * git always runs with an argument list (never a shell), so tool arguments cannot inject commands.
 */

export type OriginContext = {
  /** The workspace checkout; defaults to SATURN_ORIGIN_REPO, then the runtime's working directory. */
  repoDir?: string;
  /** Reads secrets the runtime stores, for the GitHub token saved by Customizations. */
  secret?: (id: string) => string | undefined;
  /** For tests: where the GitHub API lives. */
  apiBase?: string;
  token?: string;
};

type Args = Record<string, unknown>;
type Repo = { owner: string; name: string };

const MAX_OUTPUT = 200_000;
const str = (value: unknown, fallback = "") => (typeof value === "string" && value.trim() ? value.trim() : fallback);
const num = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const page = (args: Args) => Math.max(1, Number.parseInt(str(args.pageToken, "1"), 10) || 1);
const pageSize = (args: Args, fallback = 30) => Math.min(100, Math.max(1, num(args.pageSize, fallback)));

/**
 * Refs and SHAs the model passes to git. git runs without a shell, so the risks left are a value that
 * reads as an option ("--upload-pack=…"), whitespace/control characters, and ":" (ref:path addressing).
 */
function safeRef(value: string, label = "ref"): string {
  if (!value || value.startsWith("-") || /[\s\0:]/.test(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`Invalid ${label}: ${value || "(empty)"}`);
  }
  return value;
}

/** Repository-relative paths only: no absolute paths and no climbing out with "..". */
function safePath(value: string): string {
  const normalized = path.posix.normalize(value.replace(/\\/g, "/")).replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Path must be inside the repository: ${value}`);
  }
  return normalized === "." ? "" : normalized;
}

function sliceLines(text: string, args: Args) {
  const lines = text.split("\n");
  const start = Math.max(1, num(args.startLine, 1));
  const end = Math.min(lines.length, num(args.endLine, lines.length));
  return { text: lines.slice(start - 1, end).join("\n"), startLine: start, endLine: end, totalLines: lines.length };
}

function parseGitHubRemote(url: string): Repo | null {
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match ? { owner: match[1], name: match[2] } : null;
}

export class OriginSkill {
  private readonly dataDir: string;
  private readonly context: OriginContext;
  private tokenCache: string | null | undefined;

  constructor(dataDir: string, context: OriginContext = {}) {
    this.dataDir = dataDir;
    this.context = context;
  }

  async run(toolId: string, args: Args, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new Error("Operation aborted");
    switch (toolId) {
      // Repository content: local git
      case "get_file_contents":
        return this.getFileContents(args, signal);
      case "get_git_tree":
        return this.getGitTree(args, signal);
      case "grep_contents":
        return this.grepContents(args, signal);
      case "list_branches":
        return this.listBranches(args, signal);
      case "list_commits":
        return this.listCommits(args, signal);
      case "commit_read":
        return this.commitRead(args, signal);
      case "compare_commits":
        return this.compareCommits(args, signal);
      case "sync_mirror":
        return this.syncMirror(args, signal);

      // Hosting: GitHub
      case "get_repository":
        return this.getRepository(args, signal);
      case "list_repositories":
        return this.listRepositories(args, signal);
      case "list_namespaces":
        return this.listNamespaces(args, signal);
      case "create_repository":
        return this.createRepository(args, signal);
      case "list_pull_requests":
        return this.listPullRequests(args, signal);
      case "pull_request_read":
        return this.pullRequestRead(args, signal);
      case "checks_read":
        return this.checksRead(args, signal);
      // Not offered to agents: the pull request follow-up reads a failed check's log tail with it.
      case "check_run_log":
        return this.checkRunLog(args, signal);
      case "create_pull_request":
        return this.createPullRequest(args, signal);
      case "update_pull_request":
        return this.updatePullRequest(args, signal);
      case "update_pull_request_base":
        return this.updatePullRequestBase(args, signal);
      case "merge_pull_request":
        return this.mergePullRequest(args, signal);
      case "create_pull_request_review":
        return this.createReview(args, signal);
      case "update_pull_request_review":
        return this.updateReview(args, signal);
      case "dismiss_pull_request_review":
        return this.dismissReview(args, signal);
      case "create_pull_request_comment":
        return this.createComment(args, signal);
      case "create_pull_request_inline_comment":
        return this.createInlineComment(args, signal);
      case "reply_pull_request_review_thread":
        return this.replyThread(args, signal);
      case "update_pull_request_review_thread":
        return this.updateThread(args, signal);
      case "update_pull_request_comment":
        return this.updateComment(args, signal);
      case "update_pull_request_labels":
        return this.updateLabels(args, signal);
      case "create_label":
        return this.createLabel(args, signal);
      case "request_pull_request_reviewers":
        return this.reviewers(args, "POST", signal);
      case "remove_pull_request_reviewers":
        return this.reviewers(args, "DELETE", signal);
      default:
        throw new Error(`Unknown origin tool: ${toolId}`);
    }
  }

  // ---------------------------------------------------------------------------
  // git
  // ---------------------------------------------------------------------------

  private async git(cwd: string, args: string[], signal?: AbortSignal, allowExit1 = false): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, signal, env: { ...launchEnv(), GIT_TERMINAL_PROMPT: "0" } });
      return stdout;
    } catch (error) {
      const failed = error as { code?: number | string; stderr?: string; stdout?: string; message?: string };
      // git grep exits 1 when nothing matched.
      if (allowExit1 && failed.code === 1) return failed.stdout ?? "";
      if (failed.code === "ENOENT") throw new Error("git is not installed or not on PATH");
      throw new Error((failed.stderr || failed.message || "git failed").trim().split("\n").slice(-3).join(" "));
    }
  }

  private repoOf(args: Args): Repo {
    const owner = str(args.owner);
    const name = str(args.name);
    if (!owner || !name) throw new Error("owner and name are required");
    return { owner, name };
  }

  /** The local checkout for owner/name: the workspace repo if it is that repo, else a mirror clone made on demand. */
  private async checkout(repo: Repo, signal?: AbortSignal): Promise<string> {
    const workspace = this.context.repoDir ?? process.env.SATURN_ORIGIN_REPO ?? process.cwd();
    try {
      const top = (await this.git(workspace, ["rev-parse", "--show-toplevel"], signal)).trim();
      const remote = (await this.git(top, ["remote", "get-url", "origin"], signal).catch(() => "")).trim();
      const parsed = parseGitHubRemote(remote);
      const local = repo.owner.toLowerCase() === "local" && repo.name.toLowerCase() === path.basename(top).toLowerCase();
      if (local || (parsed && parsed.owner.toLowerCase() === repo.owner.toLowerCase() && parsed.name.toLowerCase() === repo.name.toLowerCase())) {
        return top;
      }
    } catch {
      // The workspace is not a git repository; fall through to a mirror.
    }
    if (repo.owner.toLowerCase() === "local") throw new Error(`No local repository named ${repo.name}`);
    const mirror = path.join(this.dataDir, "origin", repo.owner, repo.name);
    try {
      await fs.access(path.join(mirror, ".git"));
      return mirror;
    } catch {
      await fs.mkdir(path.dirname(mirror), { recursive: true });
      await this.git(path.dirname(mirror), [...(await this.authConfig()), "clone", "--filter=blob:none", "--no-checkout", `https://github.com/${repo.owner}/${repo.name}.git`, repo.name], signal);
      return mirror;
    }
  }

  /** Lets git reach private GitHub repos with the same token, without putting it in a URL or on disk. */
  private async authConfig(): Promise<string[]> {
    const token = await this.token();
    if (!token) return [];
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    return ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
  }

  private async defaultRef(dir: string, signal?: AbortSignal): Promise<string> {
    const head = (await this.git(dir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], signal).catch(() => "")).trim();
    if (head) return head;
    return (await this.git(dir, ["rev-parse", "--abbrev-ref", "HEAD"], signal).catch(() => "HEAD")).trim() || "HEAD";
  }

  private async getFileContents(args: Args, signal?: AbortSignal) {
    const dir = await this.checkout(this.repoOf(args), signal);
    const ref = safeRef(str(args.ref) || (await this.defaultRef(dir, signal)));
    const file = safePath(str(args.path));
    const type = (await this.git(dir, ["cat-file", "-t", `${ref}:${file}`], signal).catch(() => "")).trim();
    if (!type) throw new Error(`${file || "/"} does not exist at ${ref}`);
    if (type === "tree") {
      const listing = await this.git(dir, ["ls-tree", "--long", ref, "--", file ? `${file}/` : "."], signal);
      return {
        type: "dir",
        ref,
        path: file,
        entries: listing.split("\n").filter(Boolean).map((line) => {
          const [meta, entryPath] = line.split("\t");
          const [, kind, sha, size] = meta.split(/\s+/);
          return { path: entryPath, name: path.posix.basename(entryPath), type: kind === "tree" ? "dir" : "file", sha, size: size === "-" ? undefined : Number(size) };
        }),
      };
    }
    const sha = (await this.git(dir, ["rev-parse", `${ref}:${file}`], signal)).trim();
    const content = await this.git(dir, ["show", `${ref}:${file}`], signal);
    if (content.includes("\0")) return { type: "file", ref, path: file, sha, binary: true, size: content.length };
    const sliced = sliceLines(content, args);
    return { type: "file", ref, path: file, sha, content: sliced.text, startLine: sliced.startLine, endLine: sliced.endLine, totalLines: sliced.totalLines };
  }

  private async getGitTree(args: Args, signal?: AbortSignal) {
    const dir = await this.checkout(this.repoOf(args), signal);
    const ref = safeRef(str(args.sha) || (await this.defaultRef(dir, signal)), "sha");
    const listing = await this.git(dir, ["ls-tree", ...(args.recursive === false ? [] : ["-r"]), "--long", ref], signal);
    const tree = listing.split("\n").filter(Boolean).map((line) => {
      const [meta, entryPath] = line.split("\t");
      const [mode, kind, sha, size] = meta.split(/\s+/);
      return { path: entryPath, mode, type: kind, sha, size: size === "-" ? undefined : Number(size) };
    });
    const truncated = tree.length > 5000;
    return { sha: ref, tree: tree.slice(0, 5000), count: tree.length, truncated };
  }

  private async grepContents(args: Args, signal?: AbortSignal) {
    const dir = await this.checkout(this.repoOf(args), signal);
    const query = str(args.query);
    if (!query) throw new Error("query is required");
    const ref = safeRef(str(args.ref) || (await this.defaultRef(dir, signal)));
    const flags = ["grep", "-n", "-I", "--no-color", "--full-name"];
    if (args.literal) flags.push("-F");
    if (args.caseInsensitive) flags.push("-i");
    if (args.wholeWord) flags.push("-w");
    if (num(args.contextBefore, 0) > 0) flags.push("-B", String(Math.min(20, num(args.contextBefore, 0))));
    if (num(args.contextAfter, 0) > 0) flags.push("-A", String(Math.min(20, num(args.contextAfter, 0))));
    const pathspecs = [
      ...(str(args.filterPath) ? [safePath(str(args.filterPath))] : []),
      ...(Array.isArray(args.includes) ? args.includes.map((item) => `:(glob)${String(item)}`) : []),
      ...(Array.isArray(args.excludes) ? args.excludes.map((item) => `:(exclude,glob)${String(item)}`) : []),
    ];
    const output = await this.git(dir, [...flags, "-e", query, ref, "--", ...pathspecs], signal, true);
    const max = Math.min(500, num(args.maxResults, 100));
    const matches = output.split("\n").filter((line) => line && line !== "--").map((line) => {
      // "<ref>:<path>:<line>:<text>" for matches, "<ref>:<path>-<line>-<text>" for context lines.
      const rest = line.startsWith(`${ref}:`) ? line.slice(ref.length + 1) : line;
      const match = /^(.*?)([:-])(\d+)\2(.*)$/.exec(rest);
      return match ? { path: match[1], line: Number(match[3]), text: match[4], context: match[2] === "-" } : { path: "", line: 0, text: rest, context: true };
    });
    const hits = matches.filter((item) => !item.context);
    return { ref, query, matches: matches.slice(0, max), totalMatches: hits.length, truncated: matches.length > max };
  }

  private async listBranches(args: Args, signal?: AbortSignal) {
    const dir = await this.checkout(this.repoOf(args), signal);
    const output = await this.git(dir, ["for-each-ref", "--format=%(refname)%09%(objectname)%09%(committerdate:iso-strict)", "refs/heads", "refs/remotes/origin"], signal);
    const seen = new Map<string, { name: string; sha: string; updatedAt: string }>();
    for (const line of output.split("\n").filter(Boolean)) {
      const [ref, sha, updatedAt] = line.split("\t");
      const name = ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/origin\//, "");
      if (name === "HEAD") continue;
      if (!seen.has(name)) seen.set(name, { name, sha, updatedAt });
    }
    const prefix = str(args.prefix);
    const all = [...seen.values()].filter((branch) => !prefix || branch.name.startsWith(prefix));
    const size = pageSize(args);
    const at = page(args);
    const items = all.slice((at - 1) * size, at * size);
    return { branches: items, totalCount: all.length, nextPageToken: at * size < all.length ? String(at + 1) : null };
  }

  private async listCommits(args: Args, signal?: AbortSignal) {
    const dir = await this.checkout(this.repoOf(args), signal);
    const ref = safeRef(str(args.ref) || (await this.defaultRef(dir, signal)));
    const size = pageSize(args, 20);
    const at = page(args);
    const filters: string[] = [];
    for (const email of Array.isArray(args.authorEmails) ? args.authorEmails : []) filters.push(`--author=${String(email)}`);
    for (const email of Array.isArray(args.committerEmails) ? args.committerEmails : []) filters.push(`--committer=${String(email)}`);
    if (str(args.since)) filters.push(`--since=${str(args.since)}`);
    if (str(args.until)) filters.push(`--until=${str(args.until)}`);
    const output = await this.git(dir, ["log", `--max-count=${size + 1}`, `--skip=${(at - 1) * size}`, "--format=%H%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%P", ...filters, ref, "--"], signal);
    const commits = output.split("\n").filter(Boolean).map((line) => {
      const [sha, message, name, email, date, parents] = line.split("\x1f");
      return { sha, message, author: { name, email }, date, parents: parents ? parents.split(" ") : [] };
    });
    return { ref, commits: commits.slice(0, size), nextPageToken: commits.length > size ? String(at + 1) : null };
  }

  private async commitRead(args: Args, signal?: AbortSignal) {
    const dir = await this.checkout(this.repoOf(args), signal);
    const sha = safeRef(str(args.sha), "sha");
    const view = str(args.view, "metadata");
    const meta = await this.git(dir, ["show", "-s", "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%cI%x1f%P%x1f%B", sha], signal);
    const [full, author, email, date, committer, committedAt, parents, body] = meta.split("\x1f");
    const metadata = { sha: full.trim(), author: { name: author, email }, date, committer: { name: committer, date: committedAt }, parents: parents ? parents.split(" ") : [], message: (body ?? "").trim() };
    if (view === "files") {
      const stat = await this.git(dir, ["show", "--format=", "--numstat", "--find-renames", sha], signal);
      const files = stat.split("\n").filter(Boolean).map((line) => {
        const [added, removed, file] = line.split("\t");
        return { path: file, additions: added === "-" ? null : Number(added), deletions: removed === "-" ? null : Number(removed) };
      });
      return { ...metadata, files };
    }
    if (view === "patch") {
      const patch = await this.git(dir, ["show", "--format=", "--patch", "--find-renames", sha], signal);
      const sliced = sliceLines(patch.slice(0, MAX_OUTPUT), args);
      return { ...metadata, patch: sliced.text, startLine: sliced.startLine, endLine: sliced.endLine, totalLines: sliced.totalLines };
    }
    return metadata;
  }

  private async compareCommits(args: Args, signal?: AbortSignal) {
    const dir = await this.checkout(this.repoOf(args), signal);
    const base = safeRef(str(args.base), "base");
    const head = safeRef(str(args.head), "head");
    const mergeBase = (await this.git(dir, ["merge-base", base, head], signal).catch(() => "")).trim();
    const counts = (await this.git(dir, ["rev-list", "--left-right", "--count", `${base}...${head}`], signal)).trim().split(/\s+/).map(Number);
    const log = await this.git(dir, ["log", "--format=%H%x1f%s%x1f%an%x1f%aI", "--max-count=250", `${base}..${head}`], signal);
    const stat = await this.git(dir, ["diff", "--numstat", "--find-renames", `${base}...${head}`], signal);
    return {
      base,
      head,
      mergeBase: mergeBase || null,
      behindBy: counts[0] ?? 0,
      aheadBy: counts[1] ?? 0,
      commits: log.split("\n").filter(Boolean).map((line) => {
        const [sha, message, author, date] = line.split("\x1f");
        return { sha, message, author, date };
      }),
      files: stat.split("\n").filter(Boolean).map((line) => {
        const [added, removed, file] = line.split("\t");
        return { path: file, additions: added === "-" ? null : Number(added), deletions: removed === "-" ? null : Number(removed) };
      }),
    };
  }

  private async syncMirror(args: Args, signal?: AbortSignal) {
    const dir = await this.checkout(this.repoOf(args), signal);
    const ref = safeRef(str(args.ref));
    await this.git(dir, [...(await this.authConfig()), "fetch", "--prune", "origin", ref], signal);
    const fetched = (await this.git(dir, ["rev-parse", "FETCH_HEAD"], signal)).trim();
    const expected = str(args.sha);
    if (expected && !fetched.startsWith(expected)) throw new Error(`${ref} is at ${fetched}, not ${expected}`);
    return { synced: true, ref, sha: fetched, checkout: dir };
  }

  // ---------------------------------------------------------------------------
  // GitHub
  // ---------------------------------------------------------------------------

  /** The user's own GitHub token, from the environment, the gh CLI, or the GitHub install in Customizations. */
  private async token(): Promise<string | null> {
    if (this.tokenCache !== undefined) return this.tokenCache;
    let token = this.context.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? this.context.secret?.("mcp:mkt-github:token") ?? null;
    if (!token) {
      try {
        token = (await execFileAsync("gh", ["auth", "token"], { timeout: 5000 })).stdout.trim() || null;
      } catch {
        token = null;
      }
    }
    this.tokenCache = token;
    return token;
  }

  private async api<T = Record<string, unknown>>(method: string, route: string, body?: unknown, signal?: AbortSignal, accept = "application/vnd.github+json"): Promise<T> {
    const token = await this.token();
    if (!token) {
      throw new Error("GitHub access is needed for this. Set GH_TOKEN, run `gh auth login`, or install GitHub in Customizations with a token.");
    }
    const response = await fetch(`${this.context.apiBase ?? "https://api.github.com"}${route}`, {
      method,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Saturn-Origin",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (response.status === 204) return {} as T;
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        const parsed = JSON.parse(text) as { message?: string; errors?: { message?: string }[] };
        message = [parsed.message, ...(parsed.errors ?? []).map((item) => item.message)].filter(Boolean).join(": ");
      } catch {
        // Not JSON; keep the text.
      }
      throw new Error(`GitHub ${response.status}: ${message.slice(0, 400)}`);
    }
    return (accept.includes("json") ? JSON.parse(text) : text) as T;
  }

  private async graphql<T = Record<string, unknown>>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const result = await this.api<{ data?: T; errors?: { message: string }[] }>("POST", "/graphql", { query, variables }, signal);
    if (result.errors?.length) throw new Error(`GitHub: ${result.errors.map((item) => item.message).join("; ")}`);
    return result.data as T;
  }

  private repoRoute(args: Args): string {
    const { owner, name } = this.repoOf(args);
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }

  private pullNumber(args: Args): number {
    const number = num(args.number, Number.NaN);
    if (!Number.isInteger(number) || number <= 0) throw new Error("number must be a pull request number");
    return number;
  }

  private pull(pr: Record<string, any>) {
    return {
      number: pr.number,
      title: pr.title,
      state: pr.merged_at ? "merged" : pr.state,
      draft: pr.draft,
      author: pr.user?.login,
      head: pr.head?.ref,
      headSha: pr.head?.sha,
      base: pr.base?.ref,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      closedAt: pr.closed_at,
      mergedAt: pr.merged_at,
      url: pr.html_url,
      ...(pr.body !== undefined ? { body: pr.body } : {}),
      ...(pr.labels ? { labels: pr.labels.map((label: { name: string }) => label.name) } : {}),
      ...(pr.requested_reviewers ? { requestedReviewers: pr.requested_reviewers.map((user: { login: string }) => user.login) } : {}),
      ...(pr.requested_teams?.length ? { requestedTeams: pr.requested_teams.map((team: { slug: string }) => team.slug) } : {}),
      ...(pr.mergeable !== undefined ? { mergeable: pr.mergeable, mergeableState: pr.mergeable_state } : {}),
    };
  }

  private async getRepository(args: Args, signal?: AbortSignal) {
    const repo = await this.api<Record<string, any>>("GET", this.repoRoute(args), undefined, signal);
    return {
      owner: repo.owner?.login,
      name: repo.name,
      description: repo.description,
      defaultBranch: repo.default_branch,
      visibility: repo.visibility,
      archived: repo.archived,
      cloneUrl: repo.clone_url,
      url: repo.html_url,
      createdAt: repo.created_at,
      updatedAt: repo.pushed_at,
    };
  }

  private async listRepositories(args: Args, signal?: AbortSignal) {
    const owner = str(args.owner);
    if (!owner) throw new Error("owner is required");
    const size = pageSize(args);
    const at = page(args);
    const me = await this.api<{ login: string }>("GET", "/user", undefined, signal);
    const route = me.login.toLowerCase() === owner.toLowerCase()
      ? `/user/repos?affiliation=owner&sort=updated&per_page=${size}&page=${at}`
      : `/users/${encodeURIComponent(owner)}/repos?sort=updated&per_page=${size}&page=${at}`;
    const repos = await this.api<Record<string, any>[]>("GET", route, undefined, signal);
    const filter = str(args.filter).toLowerCase();
    return {
      repositories: repos
        .filter((repo) => !filter || String(repo.name).toLowerCase().includes(filter))
        .map((repo) => ({ owner: repo.owner?.login, name: repo.name, visibility: repo.visibility, defaultBranch: repo.default_branch, updatedAt: repo.pushed_at, url: repo.html_url })),
      nextPageToken: repos.length === size ? String(at + 1) : null,
    };
  }

  private async listNamespaces(args: Args, signal?: AbortSignal) {
    const size = pageSize(args);
    const at = page(args);
    const me = await this.api<{ login: string; name?: string }>("GET", "/user", undefined, signal);
    const orgs = await this.api<{ login: string; description?: string }[]>("GET", `/user/orgs?per_page=${size}&page=${at}`, undefined, signal);
    return {
      namespaces: [
        ...(at === 1 ? [{ slug: me.login, name: me.name || me.login, type: "user" }] : []),
        ...orgs.map((org) => ({ slug: org.login, name: org.login, type: "organization" })),
      ],
      nextPageToken: orgs.length === size ? String(at + 1) : null,
    };
  }

  private async createRepository(args: Args, signal?: AbortSignal) {
    const name = str(args.name);
    if (!name) throw new Error("name is required");
    const me = await this.api<{ login: string }>("GET", "/user", undefined, signal);
    const owner = str(args.owner, me.login);
    const route = owner.toLowerCase() === me.login.toLowerCase() ? "/user/repos" : `/orgs/${encodeURIComponent(owner)}/repos`;
    // Private by default: an agent should not publish a repository on its own.
    const repo = await this.api<Record<string, any>>("POST", route, { name, private: true, auto_init: true }, signal);
    const defaultBranch = str(args.defaultBranch);
    if (defaultBranch && defaultBranch !== repo.default_branch) {
      await this.api("POST", `/repos/${owner}/${name}/branches/${repo.default_branch}/rename`, { new_name: defaultBranch }, signal);
    }
    return { owner: repo.owner?.login, name: repo.name, visibility: repo.visibility, defaultBranch: defaultBranch || repo.default_branch, cloneUrl: repo.clone_url, url: repo.html_url };
  }

  private async listPullRequests(args: Args, signal?: AbortSignal) {
    const size = pageSize(args);
    const at = page(args);
    const query = new URLSearchParams({
      state: ["open", "closed", "all"].includes(str(args.state)) ? str(args.state) : "open",
      sort: str(args.sortBy) === "updated" ? "updated" : "created",
      direction: str(args.direction) === "asc" ? "asc" : "desc",
      per_page: String(size),
      page: String(at),
    });
    if (str(args.base)) query.set("base", str(args.base));
    if (str(args.head)) query.set("head", str(args.head).includes(":") ? str(args.head) : `${this.repoOf(args).owner}:${str(args.head)}`);
    const pulls = await this.api<Record<string, any>[]>("GET", `${this.repoRoute(args)}/pulls?${query}`, undefined, signal);
    const author = str(args.author).toLowerCase();
    return {
      pullRequests: pulls.filter((pr) => !author || String(pr.user?.login).toLowerCase() === author).map((pr) => {
        const { body: _body, ...summary } = this.pull(pr);
        return summary;
      }),
      nextPageToken: pulls.length === size ? String(at + 1) : null,
    };
  }

  private async pullRequestRead(args: Args, signal?: AbortSignal) {
    const route = `${this.repoRoute(args)}/pulls/${this.pullNumber(args)}`;
    const view = str(args.view, "summary");
    const size = pageSize(args);
    const at = page(args);
    const paging = `per_page=${size}&page=${at}`;
    const next = (items: unknown[]) => (items.length === size ? String(at + 1) : null);
    if (view === "files") {
      const files = await this.api<Record<string, any>[]>("GET", `${route}/files?${paging}`, undefined, signal);
      return { files: files.map((file) => ({ path: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, previousPath: file.previous_filename, patch: file.patch })), nextPageToken: next(files) };
    }
    if (view === "commits") {
      const commits = await this.api<Record<string, any>[]>("GET", `${route}/commits?${paging}`, undefined, signal);
      return { commits: commits.map((commit) => ({ sha: commit.sha, message: commit.commit?.message, author: commit.commit?.author?.name, date: commit.commit?.author?.date })), nextPageToken: next(commits) };
    }
    if (view === "reviews") {
      const reviews = await this.api<Record<string, any>[]>("GET", `${route}/reviews?${paging}`, undefined, signal);
      return { reviews: reviews.map((review) => ({ id: String(review.id), author: review.user?.login, state: review.state, body: review.body, submittedAt: review.submitted_at, commitId: review.commit_id })), nextPageToken: next(reviews) };
    }
    if (view === "comments") {
      const { owner, name } = this.repoOf(args);
      const comments = await this.api<Record<string, any>[]>("GET", `/repos/${owner}/${name}/issues/${this.pullNumber(args)}/comments?${paging}`, undefined, signal);
      return { comments: comments.map((comment) => ({ id: String(comment.id), author: comment.user?.login, body: comment.body, createdAt: comment.created_at, updatedAt: comment.updated_at })), nextPageToken: next(comments) };
    }
    if (view === "threads") {
      const { owner, name } = this.repoOf(args);
      const data = await this.graphql<{ repository: { pullRequest: { reviewThreads: { nodes: Record<string, any>[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } } }>(
        `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:50,after:$after){nodes{id isResolved isOutdated path line startLine diffSide comments(first:50){nodes{databaseId author{login} body createdAt}}} pageInfo{hasNextPage endCursor}}}}}`,
        { owner, name, number: this.pullNumber(args), after: args.pageToken && !/^\d+$/.test(String(args.pageToken)) ? String(args.pageToken) : null },
        signal,
      );
      const threads = data.repository.pullRequest.reviewThreads;
      const wanted = Array.isArray(args.threadIds) ? new Set(args.threadIds.map(String)) : null;
      return {
        threads: threads.nodes.filter((thread) => !wanted || wanted.has(thread.id)).map((thread) => ({
          id: thread.id,
          resolved: thread.isResolved,
          outdated: thread.isOutdated,
          path: thread.path,
          line: thread.line,
          startLine: thread.startLine,
          side: thread.diffSide,
          comments: thread.comments.nodes.map((comment: Record<string, any>) => ({ id: String(comment.databaseId), author: comment.author?.login, body: comment.body, createdAt: comment.createdAt })),
        })),
        nextPageToken: threads.pageInfo.hasNextPage ? threads.pageInfo.endCursor : null,
      };
    }
    return { pullRequest: this.pull(await this.api<Record<string, any>>("GET", route, undefined, signal)) };
  }

  private async checksRead(args: Args, signal?: AbortSignal) {
    const target = (args.target && typeof args.target === "object" ? args.target : {}) as Record<string, unknown>;
    const base = this.repoRoute(args);
    const size = pageSize(args);
    const at = page(args);
    if (str(target.checkRunId)) {
      const run = await this.api<Record<string, any>>("GET", `${base}/check-runs/${encodeURIComponent(str(target.checkRunId))}`, undefined, signal);
      return { checkRun: { id: String(run.id), name: run.name, status: run.status, conclusion: run.conclusion, url: run.html_url, output: run.output?.summary } };
    }
    let sha = str(target.sha) || str(args.sha) || str(args.ref);
    const number = num(target.number, num(args.number, Number.NaN));
    if (!sha && Number.isInteger(number)) {
      sha = (await this.api<Record<string, any>>("GET", `${base}/pulls/${number}`, undefined, signal)).head?.sha;
    }
    if (!sha && !str(target.checkSuiteId)) throw new Error("Give a pull request number, a sha, a check suite id or a check run id");
    const route = str(target.checkSuiteId)
      ? `${base}/check-suites/${encodeURIComponent(str(target.checkSuiteId))}/check-runs`
      : `${base}/commits/${encodeURIComponent(sha)}/check-runs`;
    const result = await this.api<{ total_count: number; check_runs: Record<string, any>[] }>("GET", `${route}?per_page=${size}&page=${at}`, undefined, signal);
    const runs = result.check_runs.map((run) => ({ id: String(run.id), name: run.name, status: run.status, conclusion: run.conclusion, startedAt: run.started_at, completedAt: run.completed_at, url: run.html_url }));
    const more = at * size < result.total_count;
    const rollup = more
      ? undefined
      : runs.some((run) => run.status !== "completed")
        ? "pending"
        : runs.some((run) => ["failure", "timed_out", "cancelled", "action_required"].includes(String(run.conclusion)))
          ? "failure"
          : runs.length
            ? "success"
            : "none";
    return { sha: sha || null, checkRuns: runs, totalCount: result.total_count, ...(rollup ? { rollup } : {}), nextPageToken: more ? String(at + 1) : null };
  }

  /**
   * The end of a failed check's output: the GitHub Actions job log when the check is an Actions job (its check run id
   * is the job id), else the check's own summary and text, plus its annotations.
   */
  private async checkRunLog(args: Args, signal?: AbortSignal) {
    const base = this.repoRoute(args);
    const id = encodeURIComponent(str(args.checkRunId));
    const limit = Math.min(20_000, Math.max(500, num(args.limit, 4000)));
    const run = await this.api<Record<string, any>>("GET", `${base}/check-runs/${id}`, undefined, signal);
    let log = "";
    try {
      log = await this.api<string>("GET", `${base}/actions/jobs/${id}/logs`, undefined, signal, "application/vnd.github.v3.raw");
    } catch {
      log = [run.output?.summary, run.output?.text].filter(Boolean).join("\n\n");
    }
    const annotations = await this.api<Record<string, any>[]>("GET", `${base}/check-runs/${id}/annotations?per_page=20`, undefined, signal).catch(() => []);
    // Timestamps at the start of each Actions log line only take room.
    const text = String(log).replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /gm, "");
    return {
      name: run.name,
      conclusion: run.conclusion,
      url: run.html_url,
      annotations: annotations.map((item) => `${item.path}:${item.start_line} ${item.annotation_level}: ${item.message}`).slice(0, 20),
      log: text.length > limit ? `…${text.slice(-limit)}` : text,
    };
  }

  private async parentHead(args: Args, signal?: AbortSignal): Promise<string | undefined> {
    const parent = num(args.parentPullNumber, Number.NaN);
    if (!Number.isInteger(parent)) return undefined;
    return (await this.api<Record<string, any>>("GET", `${this.repoRoute(args)}/pulls/${parent}`, undefined, signal)).head?.ref;
  }

  private async createPullRequest(args: Args, signal?: AbortSignal) {
    const base = (await this.parentHead(args, signal)) ?? (str(args.base) || (await this.api<Record<string, any>>("GET", this.repoRoute(args), undefined, signal)).default_branch);
    const pr = await this.api<Record<string, any>>("POST", `${this.repoRoute(args)}/pulls`, {
      title: str(args.title),
      head: str(args.head),
      base,
      body: typeof args.body === "string" ? args.body : undefined,
      draft: args.draft === true,
    }, signal);
    return { pullRequest: this.pull(pr) };
  }

  private async updatePullRequest(args: Args, signal?: AbortSignal) {
    const route = `${this.repoRoute(args)}/pulls/${this.pullNumber(args)}`;
    const patch: Record<string, unknown> = {};
    if (typeof args.title === "string") patch.title = args.title;
    if (typeof args.body === "string") patch.body = args.body;
    if (args.state === "open" || args.state === "closed") patch.state = args.state;
    let pr = Object.keys(patch).length
      ? await this.api<Record<string, any>>("PATCH", route, patch, signal)
      : await this.api<Record<string, any>>("GET", route, undefined, signal);
    if (typeof args.draft === "boolean" && args.draft !== pr.draft) {
      // Draft state is only changeable through GraphQL.
      const mutation = args.draft
        ? "mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{isDraft}}}"
        : "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}";
      await this.graphql(mutation, { id: pr.node_id }, signal);
      pr = await this.api<Record<string, any>>("GET", route, undefined, signal);
    }
    return { pullRequest: this.pull(pr) };
  }

  private async updatePullRequestBase(args: Args, signal?: AbortSignal) {
    const base = (await this.parentHead(args, signal)) ?? str(args.base);
    if (!base) throw new Error("Give base or parentPullNumber");
    const pr = await this.api<Record<string, any>>("PATCH", `${this.repoRoute(args)}/pulls/${this.pullNumber(args)}`, { base }, signal);
    return { pullRequest: this.pull(pr) };
  }

  private async mergePullRequest(args: Args, signal?: AbortSignal) {
    const expected = str(args.expectedHeadSha);
    if (!expected) throw new Error("expectedHeadSha is required, so a branch that moved is never merged by mistake");
    const result = await this.api<Record<string, any>>("PUT", `${this.repoRoute(args)}/pulls/${this.pullNumber(args)}/merge`, {
      sha: expected,
      merge_method: str(args.mergeMethod) === "squash" ? "squash" : "merge",
    }, signal);
    return { merged: result.merged === true, sha: result.sha, message: result.message };
  }

  private async createReview(args: Args, signal?: AbortSignal) {
    const event = str(args.event).toUpperCase();
    const mapped = event === "APPROVE" ? "APPROVE" : event === "REQUEST_CHANGES" ? "REQUEST_CHANGES" : "COMMENT";
    const review = await this.api<Record<string, any>>("POST", `${this.repoRoute(args)}/pulls/${this.pullNumber(args)}/reviews`, {
      event: mapped,
      ...(typeof args.body === "string" ? { body: args.body } : {}),
    }, signal);
    return { review: { id: String(review.id), state: review.state, body: review.body, url: review.html_url } };
  }

  private async updateReview(args: Args, signal?: AbortSignal) {
    const review = await this.api<Record<string, any>>("PUT", `${this.repoRoute(args)}/pulls/${this.pullNumber(args)}/reviews/${encodeURIComponent(str(args.reviewId))}`, { body: str(args.body) }, signal);
    return { review: { id: String(review.id), state: review.state, body: review.body } };
  }

  private async dismissReview(args: Args, signal?: AbortSignal) {
    const review = await this.api<Record<string, any>>("PUT", `${this.repoRoute(args)}/pulls/${this.pullNumber(args)}/reviews/${encodeURIComponent(str(args.reviewId))}/dismissals`, { message: str(args.message), event: "DISMISS" }, signal);
    return { review: { id: String(review.id), state: review.state } };
  }

  private async createComment(args: Args, signal?: AbortSignal) {
    const comment = await this.api<Record<string, any>>("POST", `${this.repoRoute(args)}/issues/${this.pullNumber(args)}/comments`, { body: str(args.body) }, signal);
    return { comment: { id: String(comment.id), body: comment.body, url: comment.html_url } };
  }

  private async createInlineComment(args: Args, signal?: AbortSignal) {
    const anchor = (args.anchor && typeof args.anchor === "object" ? args.anchor : {}) as Record<string, unknown>;
    const route = `${this.repoRoute(args)}/pulls/${this.pullNumber(args)}`;
    const pr = await this.api<Record<string, any>>("GET", route, undefined, signal);
    const kind = str(anchor.kind, "line");
    const side = str(anchor.side, "right").toUpperCase() === "LEFT" ? "LEFT" : "RIGHT";
    const body: Record<string, unknown> = { body: str(args.body), commit_id: pr.head?.sha, path: safePath(str(anchor.path)) };
    if (kind === "file") body.subject_type = "file";
    else if (kind === "range") Object.assign(body, { start_line: num(anchor.startLine, 1), start_side: side, line: num(anchor.endLine, num(anchor.startLine, 1)), side });
    else Object.assign(body, { line: num(anchor.startLine, 1), side });
    const comment = await this.api<Record<string, any>>("POST", `${route}/comments`, body, signal);
    return { inlineComment: { id: String(comment.id), path: comment.path, line: comment.line, side: comment.side, url: comment.html_url } };
  }

  /** threadId is the id of the thread's first review comment (as returned by the threads view). */
  private async replyThread(args: Args, signal?: AbortSignal) {
    let commentId = str(args.threadId);
    if (!/^\d+$/.test(commentId)) {
      const data = await this.graphql<{ node: { comments: { nodes: { databaseId: number }[] } } }>(
        "query($id:ID!){node(id:$id){... on PullRequestReviewThread{comments(first:1){nodes{databaseId}}}}}",
        { id: commentId },
        signal,
      );
      commentId = String(data.node?.comments?.nodes?.[0]?.databaseId ?? "");
      if (!commentId) throw new Error(`Review thread ${args.threadId} not found`);
    }
    const reply = await this.api<Record<string, any>>("POST", `${this.repoRoute(args)}/pulls/${this.pullNumber(args)}/comments/${commentId}/replies`, { body: str(args.body) }, signal);
    return { reply: { id: String(reply.id), body: reply.body, url: reply.html_url } };
  }

  private async updateThread(args: Args, signal?: AbortSignal) {
    const mutation = args.resolved === true
      ? "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}"
      : "mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}";
    const data = await this.graphql<Record<string, { thread: { id: string; isResolved: boolean } }>>(mutation, { id: str(args.threadId) }, signal);
    const thread = Object.values(data)[0]?.thread;
    return { threadId: thread?.id ?? str(args.threadId), resolved: thread?.isResolved ?? args.resolved === true };
  }

  private async updateComment(args: Args, signal?: AbortSignal) {
    const id = encodeURIComponent(str(args.commentId));
    const body = { body: str(args.body) };
    try {
      const comment = await this.api<Record<string, any>>("PATCH", `${this.repoRoute(args)}/issues/comments/${id}`, body, signal);
      return { comment: { id: String(comment.id), body: comment.body } };
    } catch (error) {
      if (!String(error).includes("GitHub 404")) throw error;
      // Not a conversation comment: try it as an inline review comment.
      const comment = await this.api<Record<string, any>>("PATCH", `${this.repoRoute(args)}/pulls/comments/${id}`, body, signal);
      return { comment: { id: String(comment.id), body: comment.body } };
    }
  }

  private async updateLabels(args: Args, signal?: AbortSignal) {
    const labels = Array.isArray(args.labels) ? args.labels.map(String) : [];
    const result = await this.api<{ name: string }[]>("PUT", `${this.repoRoute(args)}/issues/${this.pullNumber(args)}/labels`, { labels }, signal);
    return { labels: result.map((label) => label.name) };
  }

  private async createLabel(args: Args, signal?: AbortSignal) {
    const label = await this.api<Record<string, any>>("POST", `${this.repoRoute(args)}/labels`, {
      name: str(args.label),
      ...(str(args.color) ? { color: str(args.color).replace(/^#/, "") } : {}),
      ...(typeof args.description === "string" ? { description: args.description } : {}),
    }, signal);
    return { label: { name: label.name, color: label.color, description: label.description }, created: true };
  }

  private async reviewers(args: Args, method: "POST" | "DELETE", signal?: AbortSignal) {
    const users = Array.isArray(args.users) ? args.users.map(String) : [];
    const teams = Array.isArray(args.groups) ? args.groups.map(String) : [];
    const pr = await this.api<Record<string, any>>(method, `${this.repoRoute(args)}/pulls/${this.pullNumber(args)}/requested_reviewers`, { reviewers: users, team_reviewers: teams }, signal);
    const after = method === "DELETE" ? await this.api<Record<string, any>>("GET", `${this.repoRoute(args)}/pulls/${this.pullNumber(args)}`, undefined, signal) : pr;
    return {
      requestedReviewers: (after.requested_reviewers ?? []).map((user: { login: string }) => user.login),
      requestedTeams: (after.requested_teams ?? []).map((team: { slug: string }) => team.slug),
    };
  }
}
