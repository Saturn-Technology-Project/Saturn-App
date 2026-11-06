//! The GitHub tools; `contract/github.test.mjs` drives them against a fake GitHub.
//! Repository content (files, trees, grep, branches, commits, diffs) comes from a local git checkout: the workspace repo when
//! its `origin` remote is the requested owner/name, otherwise a blobless clone kept under <data>/origin/<owner>/<name> (made
//! on first use, refreshed by sync_mirror). Hosted features go to the GitHub API with the user's own token. git always runs
//! with an argument list (never a shell), so tool arguments cannot inject commands.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;

use base64::Engine;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use regex::Regex;
use reqwest::Method;
use saturn_domain::js;
use saturn_telemetry::network::{SendNoted, client_builder};
use saturn_tools::shell::process_env;
use serde_json::{Map, Value, json};
use tokio::process::Command;

use crate::Kernel;

const MAX_OUTPUT: usize = 200_000;
const API_TIMEOUT: Duration = Duration::from_secs(300);
const JSON_ACCEPT: &str = "application/vnd.github+json";
const FAILED_CONCLUSIONS: [&str; 4] = ["failure", "timed_out", "cancelled", "action_required"];

type Failure = String;
type Answer = Result<Value, Failure>;

/// A tool's text argument, trimmed; empty when it is missing or not text.
fn string_of(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).map_or("", js::trim)
}

fn arg<'a>(args: &'a Value, key: &str) -> &'a str {
    string_of(args.get(key))
}

/// A tool's number argument, if it is one.
fn number_of(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

/// `String(value)`, for ids that come as numbers.
fn id_of(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(other) => js::text(Some(other)),
    }
}

fn page(args: &Value) -> i64 {
    let digits: String = arg(args, "pageToken")
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse::<i64>().unwrap_or(1).max(1)
}

fn page_size(args: &Value, fallback: f64) -> i64 {
    number_of(args.get("pageSize"))
        .unwrap_or(fallback)
        .clamp(1.0, 100.0) as i64
}

/// What `encodeURIComponent` leaves as it is, besides letters and digits.
const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// `encodeURIComponent`.
fn encode(text: &str) -> String {
    utf8_percent_encode(text, URI_COMPONENT).to_string()
}

/// Refs and SHAs the model passes to git. git runs without a shell, so the risks left are a value that reads as an option
/// ("--upload-pack=…"), whitespace or control characters, and ":" (ref:path addressing).
fn safe_ref(value: &str, label: &str) -> Result<String, Failure> {
    let unsafe_character = |character: char| {
        js::is_space(character) || character == ':' || character.is_ascii_control()
    };
    if value.is_empty() || value.starts_with('-') || value.chars().any(unsafe_character) {
        let shown = if value.is_empty() { "(empty)" } else { value };
        return Err(format!("Invalid {label}: {shown}"));
    }
    Ok(value.to_owned())
}

/// `path.posix.normalize`.
fn normalize(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." if parts.last().is_some_and(|last| *last != "..") => {
                parts.pop();
            }
            ".." if absolute => {}
            other => parts.push(other),
        }
    }
    let joined = parts.join("/");
    if absolute {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".to_owned()
    } else {
        joined
    }
}

/// Repository-relative paths only: no absolute paths and no climbing out with "..".
fn safe_path(value: &str) -> Result<String, Failure> {
    let normalized = normalize(&value.replace('\\', "/"));
    if normalized.starts_with('/') || normalized == ".." || normalized.starts_with("../") {
        return Err(format!("Path must be inside the repository: {value}"));
    }
    Ok(if normalized == "." {
        String::new()
    } else {
        normalized
    })
}

/// These become a folder under the data directory, an argument to git and part of an API route, so a name must be only a name.
fn plain_name(value: &str) -> Result<String, Failure> {
    static NAME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.][A-Za-z0-9_.-]*$").expect("a valid pattern"));
    if !NAME.is_match(value) || value.chars().all(|character| character == '.') {
        return Err(format!("Not a repository owner or name: {value}"));
    }
    Ok(value.to_owned())
}

/// The asked lines of a text.
fn slice_lines(text: &str, args: &Value) -> Value {
    let lines: Vec<&str> = text.split('\n').collect();
    let total = lines.len() as i64;
    let start = number_of(args.get("startLine")).unwrap_or(1.0).max(1.0) as i64;
    let end = number_of(args.get("endLine"))
        .map_or(total, |end| end as i64)
        .min(total);
    let from = (start - 1).min(total) as usize;
    let to = end.max(0) as usize;
    let selected = if from < to {
        lines[from..to].join("\n")
    } else {
        String::new()
    };
    json!({ "text": selected, "startLine": start, "endLine": end, "totalLines": total })
}

/// The owner and name of a GitHub remote address.
fn parse_github_remote(url: &str) -> Option<(String, String)> {
    static REMOTE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)(?:^|[/@])github\.com[:/]([^/]+)/([^/]+?)(?:\.git)?/?$")
            .expect("a valid pattern")
    });
    let found = REMOTE.captures(js::trim(url))?;
    Some((found[1].to_owned(), found[2].to_owned()))
}

/// The value at a path of keys, when it is there.
fn at<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in keys {
        current = current.get(*key)?;
    }
    Some(current)
}

/// An object of the fields that have values, as a field set to undefined is left out of JSON.
fn fields(items: &[(&str, Option<&Value>)]) -> Value {
    let mut object = Map::new();
    for (key, value) in items {
        if let Some(value) = value {
            object.insert((*key).to_owned(), (*value).clone());
        }
    }
    Value::Object(object)
}

fn items(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}

fn truthy(value: Option<&Value>) -> bool {
    js::truthy(value)
}

/// A pull request in Saturn's shape.
fn pull(pr: &Value) -> Value {
    let merged = truthy(pr.get("merged_at"));
    let merged_state = json!("merged");
    let mut summary = fields(&[
        ("number", pr.get("number")),
        ("title", pr.get("title")),
        (
            "state",
            if merged {
                Some(&merged_state)
            } else {
                pr.get("state")
            },
        ),
        ("draft", pr.get("draft")),
        ("author", at(pr, &["user", "login"])),
        ("head", at(pr, &["head", "ref"])),
        ("headSha", at(pr, &["head", "sha"])),
        ("base", at(pr, &["base", "ref"])),
        ("createdAt", pr.get("created_at")),
        ("updatedAt", pr.get("updated_at")),
        ("closedAt", pr.get("closed_at")),
        ("mergedAt", pr.get("merged_at")),
        ("url", pr.get("html_url")),
        ("body", pr.get("body")),
    ]);
    let names = |list: &Value, key: &str| -> Value {
        Value::Array(
            items(list)
                .iter()
                .filter_map(|item| item.get(key).cloned())
                .collect(),
        )
    };
    if truthy(pr.get("labels")) {
        summary["labels"] = names(&pr["labels"], "name");
    }
    if truthy(pr.get("requested_reviewers")) {
        summary["requestedReviewers"] = names(&pr["requested_reviewers"], "login");
    }
    if !items(pr.get("requested_teams").unwrap_or(&Value::Null)).is_empty() {
        summary["requestedTeams"] = names(&pr["requested_teams"], "slug");
    }
    if let Some(mergeable) = pr.get("mergeable") {
        summary["mergeable"] = mergeable.clone();
        if let Some(state) = pr.get("mergeable_state") {
            summary["mergeableState"] = state.clone();
        }
    }
    summary
}

fn numstat(output: &str) -> Value {
    Value::Array(
        output
            .split('\n')
            .filter(|line| !line.is_empty())
            .map(|line| {
                let mut parts = line.split('\t');
                let count = |part: Option<&str>| match part {
                    Some("-") | None => Value::Null,
                    Some(number) => json!(number.parse::<i64>().unwrap_or(0)),
                };
                let additions = count(parts.next());
                let deletions = count(parts.next());
                json!({ "path": parts.next().unwrap_or(""), "additions": additions, "deletions": deletions })
            })
            .collect(),
    )
}

/// One tool's run: where the workspace is, and the token, looked up once.
pub(crate) struct Origin<'a> {
    kernel: &'a Kernel,
    repo_dir: Option<PathBuf>,
    token: tokio::sync::OnceCell<Option<String>>,
}

/// git failed, with what it said.
fn git_failure(stderr: &str, fallback: &str) -> Failure {
    let text = js::trim(if stderr.is_empty() { fallback } else { stderr });
    let lines: Vec<&str> = text.split('\n').collect();
    lines[lines.len().saturating_sub(3)..].join(" ")
}

impl<'a> Origin<'a> {
    pub(crate) fn new(kernel: &'a Kernel, repo_dir: Option<PathBuf>) -> Self {
        Self {
            kernel,
            repo_dir,
            token: tokio::sync::OnceCell::new(),
        }
    }

    /// Runs one of the tools.
    pub(crate) async fn run(&self, tool: &str, args: &Value) -> Answer {
        match tool {
            // Repository content: local git
            "get_file_contents" => self.get_file_contents(args).await,
            "get_git_tree" => self.get_git_tree(args).await,
            "grep_contents" => self.grep_contents(args).await,
            "list_branches" => self.list_branches(args).await,
            "list_commits" => self.list_commits(args).await,
            "commit_read" => self.commit_read(args).await,
            "compare_commits" => self.compare_commits(args).await,
            "sync_mirror" => self.sync_mirror(args).await,
            // Hosting: GitHub
            "get_repository" => self.get_repository(args).await,
            "list_repositories" => self.list_repositories(args).await,
            "list_namespaces" => self.list_namespaces(args).await,
            "create_repository" => self.create_repository(args).await,
            "list_pull_requests" => self.list_pull_requests(args).await,
            "pull_request_read" => self.pull_request_read(args).await,
            "checks_read" => self.checks_read(args).await,
            // Not offered to agents: the pull request follow-up reads a failed check's log tail with it.
            "check_run_log" => self.check_run_log(args).await,
            "create_pull_request" => self.create_pull_request(args).await,
            "update_pull_request" => self.update_pull_request(args).await,
            "update_pull_request_base" => self.update_pull_request_base(args).await,
            "merge_pull_request" => self.merge_pull_request(args).await,
            "create_pull_request_review" => self.create_review(args).await,
            "update_pull_request_review" => self.update_review(args).await,
            "dismiss_pull_request_review" => self.dismiss_review(args).await,
            "create_pull_request_comment" => self.create_comment(args).await,
            "create_pull_request_inline_comment" => self.create_inline_comment(args).await,
            "reply_pull_request_review_thread" => self.reply_thread(args).await,
            "update_pull_request_review_thread" => self.update_thread(args).await,
            "update_pull_request_comment" => self.update_comment(args).await,
            "update_pull_request_labels" => self.update_labels(args).await,
            "create_label" => self.create_label(args).await,
            "request_pull_request_reviewers" => self.reviewers(args, Method::POST).await,
            "remove_pull_request_reviewers" => self.reviewers(args, Method::DELETE).await,
            _ => Err(format!("Unknown origin tool: {tool}")),
        }
    }

    // git

    async fn git_with(
        &self,
        cwd: &Path,
        args: &[&str],
        allow_exit_one: bool,
        token: Option<&str>,
    ) -> Result<String, Failure> {
        let mut command = Command::new("git");
        command
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .envs(process_env())
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::null())
            .kill_on_drop(true);
        if let Some(token) = token {
            // Lets git reach private GitHub repos with the same token, without putting it in a URL, on disk or in the
            // process list.
            let basic =
                base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
            command
                .env("GIT_CONFIG_COUNT", "1")
                .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader")
                .env(
                    "GIT_CONFIG_VALUE_0",
                    format!("AUTHORIZATION: basic {basic}"),
                );
        }
        let output = command.output().await.map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "git is not installed or not on PATH".to_owned()
            } else {
                error.to_string()
            }
        })?;
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        if output.status.success() {
            return Ok(stdout);
        }
        // git grep exits 1 when nothing matched.
        if allow_exit_one && output.status.code() == Some(1) {
            return Ok(stdout);
        }
        Err(git_failure(
            &String::from_utf8_lossy(&output.stderr),
            "git failed",
        ))
    }

    async fn git(&self, cwd: &Path, args: &[&str]) -> Result<String, Failure> {
        self.git_with(cwd, args, false, None).await
    }

    fn repo_of(args: &Value) -> Result<(String, String), Failure> {
        let (owner, name) = (arg(args, "owner"), arg(args, "name"));
        if owner.is_empty() || name.is_empty() {
            return Err("owner and name are required".to_owned());
        }
        Ok((plain_name(owner)?, plain_name(name)?))
    }

    /// The local checkout for owner/name: the workspace repo if it is that repo, else a mirror clone made on demand.
    async fn checkout(&self, args: &Value) -> Result<PathBuf, Failure> {
        let (owner, name) = Self::repo_of(args)?;
        let workspace = self
            .repo_dir
            .clone()
            .or_else(|| std::env::var_os("SATURN_ORIGIN_REPO").map(PathBuf::from))
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."));
        if let Ok(top) = self
            .git(&workspace, &["rev-parse", "--show-toplevel"])
            .await
        {
            let top = PathBuf::from(js::trim(&top));
            let remote = self
                .git(&top, &["remote", "get-url", "origin"])
                .await
                .unwrap_or_default();
            let parsed = parse_github_remote(js::trim(&remote));
            let folder = top
                .file_name()
                .map(|name| name.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            let local = owner.eq_ignore_ascii_case("local") && name.to_lowercase() == folder;
            let same = parsed.is_some_and(|(remote_owner, remote_name)| {
                remote_owner.eq_ignore_ascii_case(&owner) && remote_name.eq_ignore_ascii_case(&name)
            });
            if local || same {
                return Ok(top);
            }
        }
        if owner.eq_ignore_ascii_case("local") {
            return Err(format!("No local repository named {name}"));
        }
        let parent = self.kernel.store.root().join("origin").join(&owner);
        let mirror = parent.join(&name);
        if !mirror.join(".git").exists() {
            tokio::fs::create_dir_all(&parent)
                .await
                .map_err(|error| error.to_string())?;
            let address = format!("https://github.com/{owner}/{name}.git");
            let token = self.token().await;
            self.git_with(
                &parent,
                &[
                    "clone",
                    "--filter=blob:none",
                    "--no-checkout",
                    &address,
                    &name,
                ],
                false,
                token.as_deref(),
            )
            .await?;
        }
        Ok(mirror)
    }

    async fn default_ref(&self, dir: &Path) -> String {
        let head = self
            .git(
                dir,
                &[
                    "symbolic-ref",
                    "--quiet",
                    "--short",
                    "refs/remotes/origin/HEAD",
                ],
            )
            .await
            .unwrap_or_default();
        if !js::trim(&head).is_empty() {
            return js::trim(&head).to_owned();
        }
        let current = self
            .git(dir, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .unwrap_or_else(|_| "HEAD".to_owned());
        let current = js::trim(&current);
        if current.is_empty() { "HEAD" } else { current }.to_owned()
    }

    /// The ref asked for under `key`, or the default one, checked.
    async fn ref_or_default(
        &self,
        dir: &Path,
        args: &Value,
        key: &str,
        label: &str,
    ) -> Result<String, Failure> {
        let given = arg(args, key);
        if given.is_empty() {
            safe_ref(&self.default_ref(dir).await, label)
        } else {
            safe_ref(given, label)
        }
    }

    async fn get_file_contents(&self, args: &Value) -> Answer {
        let dir = self.checkout(args).await?;
        let reference = self.ref_or_default(&dir, args, "ref", "ref").await?;
        let file = safe_path(arg(args, "path"))?;
        let address = format!("{reference}:{file}");
        let kind = self
            .git(&dir, &["cat-file", "-t", &address])
            .await
            .unwrap_or_default();
        let kind = js::trim(&kind);
        if kind.is_empty() {
            let shown = if file.is_empty() { "/" } else { &file };
            return Err(format!("{shown} does not exist at {reference}"));
        }
        if kind == "tree" {
            let scope = if file.is_empty() {
                ".".to_owned()
            } else {
                format!("{file}/")
            };
            let listing = self
                .git(&dir, &["ls-tree", "--long", &reference, "--", &scope])
                .await?;
            let entries: Vec<Value> = listing
                .split('\n')
                .filter(|line| !line.is_empty())
                .map(|line| {
                    let (meta, entry) = line.split_once('\t').unwrap_or((line, ""));
                    let parts: Vec<&str> = meta.split_whitespace().collect();
                    let mut item = json!({
                        "path": entry,
                        "name": entry.rsplit('/').next().unwrap_or(entry),
                        "type": if parts.get(1) == Some(&"tree") { "dir" } else { "file" },
                        "sha": parts.get(2),
                    });
                    if let Some(size) = parts.get(3).filter(|size| **size != "-") {
                        item["size"] = json!(size.parse::<i64>().unwrap_or(0));
                    }
                    item
                })
                .collect();
            return Ok(
                json!({ "type": "dir", "ref": reference, "path": file, "entries": entries }),
            );
        }
        let sha = self.git(&dir, &["rev-parse", &address]).await?;
        let sha = js::trim(&sha);
        let content = self.git(&dir, &["show", &address]).await?;
        if content.contains('\0') {
            return Ok(
                json!({ "type": "file", "ref": reference, "path": file, "sha": sha, "binary": true, "size": js::length(&content) }),
            );
        }
        let sliced = slice_lines(&content, args);
        Ok(
            json!({ "type": "file", "ref": reference, "path": file, "sha": sha, "content": sliced["text"], "startLine": sliced["startLine"], "endLine": sliced["endLine"], "totalLines": sliced["totalLines"] }),
        )
    }

    async fn get_git_tree(&self, args: &Value) -> Answer {
        let dir = self.checkout(args).await?;
        let reference = self.ref_or_default(&dir, args, "sha", "sha").await?;
        let mut command = vec!["ls-tree"];
        if args.get("recursive") != Some(&Value::Bool(false)) {
            command.push("-r");
        }
        command.extend(["--long", &reference]);
        let listing = self.git(&dir, &command).await?;
        let tree: Vec<Value> = listing
            .split('\n')
            .filter(|line| !line.is_empty())
            .map(|line| {
                let (meta, entry) = line.split_once('\t').unwrap_or((line, ""));
                let parts: Vec<&str> = meta.split_whitespace().collect();
                let mut item = json!({ "path": entry, "mode": parts.first(), "type": parts.get(1), "sha": parts.get(2) });
                if let Some(size) = parts.get(3).filter(|size| **size != "-") {
                    item["size"] = json!(size.parse::<i64>().unwrap_or(0));
                }
                item
            })
            .collect();
        let count = tree.len();
        Ok(
            json!({ "sha": reference, "tree": tree.into_iter().take(5000).collect::<Vec<_>>(), "count": count, "truncated": count > 5000 }),
        )
    }

    async fn grep_contents(&self, args: &Value) -> Answer {
        let dir = self.checkout(args).await?;
        let query = arg(args, "query");
        if query.is_empty() {
            return Err("query is required".to_owned());
        }
        let reference = self.ref_or_default(&dir, args, "ref", "ref").await?;
        let mut command: Vec<String> = ["grep", "-n", "-I", "--no-color", "--full-name"]
            .map(str::to_owned)
            .to_vec();
        for (key, flag) in [
            ("literal", "-F"),
            ("caseInsensitive", "-i"),
            ("wholeWord", "-w"),
        ] {
            if truthy(args.get(key)) {
                command.push(flag.to_owned());
            }
        }
        for (key, flag) in [("contextBefore", "-B"), ("contextAfter", "-A")] {
            let lines = number_of(args.get(key)).unwrap_or(0.0);
            if lines > 0.0 {
                command.push(flag.to_owned());
                command.push(lines.min(20.0).to_string());
            }
        }
        command.extend([
            "-e".to_owned(),
            query.to_owned(),
            reference.clone(),
            "--".to_owned(),
        ]);
        if !arg(args, "filterPath").is_empty() {
            command.push(safe_path(arg(args, "filterPath"))?);
        }
        for item in items(args.get("includes").unwrap_or(&Value::Null)) {
            command.push(format!(":(glob){}", js::text(Some(item))));
        }
        for item in items(args.get("excludes").unwrap_or(&Value::Null)) {
            command.push(format!(":(exclude,glob){}", js::text(Some(item))));
        }
        let command: Vec<&str> = command.iter().map(String::as_str).collect();
        let output = self.git_with(&dir, &command, true, None).await?;
        let max = number_of(args.get("maxResults"))
            .unwrap_or(100.0)
            .clamp(0.0, 500.0) as usize;
        let prefix = format!("{reference}:");
        let matches: Vec<(Value, bool)> = output
            .split('\n')
            .filter(|line| !line.is_empty() && *line != "--")
            .map(|line| {
                // "<ref>:<path>:<line>:<text>" for matches, "<ref>:<path>-<line>-<text>" for context lines.
                let rest = line.strip_prefix(&prefix).unwrap_or(line);
                match grep_line(rest) {
                    Some((path, number, text, context)) => (
                        json!({ "path": path, "line": number, "text": text, "context": context }),
                        context,
                    ),
                    None => (
                        json!({ "path": "", "line": 0, "text": rest, "context": true }),
                        true,
                    ),
                }
            })
            .collect();
        let total = matches.iter().filter(|(_, context)| !context).count();
        let truncated = matches.len() > max;
        let shown: Vec<Value> = matches
            .into_iter()
            .take(max)
            .map(|(item, _)| item)
            .collect();
        Ok(
            json!({ "ref": reference, "query": query, "matches": shown, "totalMatches": total, "truncated": truncated }),
        )
    }

    async fn list_branches(&self, args: &Value) -> Answer {
        let dir = self.checkout(args).await?;
        let output = self
            .git(
                &dir,
                &[
                    "for-each-ref",
                    "--format=%(refname)%09%(objectname)%09%(committerdate:iso-strict)",
                    "refs/heads",
                    "refs/remotes/origin",
                ],
            )
            .await?;
        let mut seen: Vec<(String, Value)> = Vec::new();
        for line in output.split('\n').filter(|line| !line.is_empty()) {
            let parts: Vec<&str> = line.split('\t').collect();
            let reference = parts.first().copied().unwrap_or("");
            let name = reference
                .strip_prefix("refs/heads/")
                .or_else(|| reference.strip_prefix("refs/remotes/origin/"))
                .unwrap_or(reference);
            if name != "HEAD" && !seen.iter().any(|(known, _)| known == name) {
                seen.push((
                    name.to_owned(),
                    json!({ "name": name, "sha": parts.get(1), "updatedAt": parts.get(2) }),
                ));
            }
        }
        let prefix = arg(args, "prefix");
        let all: Vec<Value> = seen
            .into_iter()
            .filter(|(name, _)| prefix.is_empty() || name.starts_with(prefix))
            .map(|(_, branch)| branch)
            .collect();
        let (size, at) = (page_size(args, 30.0), page(args));
        let count = all.len() as i64;
        let shown: Vec<Value> = all
            .into_iter()
            .skip(((at - 1) * size) as usize)
            .take(size as usize)
            .collect();
        let next = if at * size < count {
            json!((at + 1).to_string())
        } else {
            Value::Null
        };
        Ok(json!({ "branches": shown, "totalCount": count, "nextPageToken": next }))
    }

    async fn list_commits(&self, args: &Value) -> Answer {
        let dir = self.checkout(args).await?;
        let reference = self.ref_or_default(&dir, args, "ref", "ref").await?;
        let (size, at) = (page_size(args, 20.0), page(args));
        let mut command = vec![
            "log".to_owned(),
            format!("--max-count={}", size + 1),
            format!("--skip={}", (at - 1) * size),
            "--format=%H%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%P".to_owned(),
        ];
        for email in items(args.get("authorEmails").unwrap_or(&Value::Null)) {
            command.push(format!("--author={}", js::text(Some(email))));
        }
        for email in items(args.get("committerEmails").unwrap_or(&Value::Null)) {
            command.push(format!("--committer={}", js::text(Some(email))));
        }
        if !arg(args, "since").is_empty() {
            command.push(format!("--since={}", arg(args, "since")));
        }
        if !arg(args, "until").is_empty() {
            command.push(format!("--until={}", arg(args, "until")));
        }
        command.extend([reference.clone(), "--".to_owned()]);
        let command: Vec<&str> = command.iter().map(String::as_str).collect();
        let output = self.git(&dir, &command).await?;
        let mut commits: Vec<Value> = output
            .split('\n')
            .filter(|line| !line.is_empty())
            .map(|line| {
                let parts: Vec<&str> = line.split('\u{1f}').collect();
                let part = |index: usize| parts.get(index).copied().unwrap_or("");
                json!({
                    "sha": part(0),
                    "message": part(1),
                    "author": { "name": part(2), "email": part(3) },
                    "date": part(4),
                    "parents": parents_of(part(5)),
                })
            })
            .collect();
        let more = commits.len() as i64 > size;
        commits.truncate(size as usize);
        let next = if more {
            json!((at + 1).to_string())
        } else {
            Value::Null
        };
        Ok(json!({ "ref": reference, "commits": commits, "nextPageToken": next }))
    }

    async fn commit_read(&self, args: &Value) -> Answer {
        let dir = self.checkout(args).await?;
        let sha = safe_ref(arg(args, "sha"), "sha")?;
        let meta = self
            .git(
                &dir,
                &[
                    "show",
                    "-s",
                    "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%cI%x1f%P%x1f%B",
                    &sha,
                ],
            )
            .await?;
        let parts: Vec<&str> = meta.split('\u{1f}').collect();
        let part = |index: usize| parts.get(index).copied().unwrap_or("");
        let mut metadata = json!({
            "sha": js::trim(part(0)),
            "author": { "name": part(1), "email": part(2) },
            "date": part(3),
            "committer": { "name": part(4), "date": part(5) },
            "parents": parents_of(part(6)),
            "message": js::trim(part(7)),
        });
        match arg(args, "view") {
            "files" => {
                let stat = self
                    .git(
                        &dir,
                        &["show", "--format=", "--numstat", "--find-renames", &sha],
                    )
                    .await?;
                metadata["files"] = numstat(&stat);
            }
            "patch" => {
                let patch = self
                    .git(
                        &dir,
                        &["show", "--format=", "--patch", "--find-renames", &sha],
                    )
                    .await?;
                let sliced = slice_lines(js::prefix(&patch, MAX_OUTPUT), args);
                metadata["patch"] = sliced["text"].clone();
                metadata["startLine"] = sliced["startLine"].clone();
                metadata["endLine"] = sliced["endLine"].clone();
                metadata["totalLines"] = sliced["totalLines"].clone();
            }
            _ => {}
        }
        Ok(metadata)
    }

    async fn compare_commits(&self, args: &Value) -> Answer {
        let dir = self.checkout(args).await?;
        let base = safe_ref(arg(args, "base"), "base")?;
        let head = safe_ref(arg(args, "head"), "head")?;
        let merge_base = self
            .git(&dir, &["merge-base", &base, &head])
            .await
            .unwrap_or_default();
        let merge_base = js::trim(&merge_base);
        let counts = self
            .git(
                &dir,
                &[
                    "rev-list",
                    "--left-right",
                    "--count",
                    &format!("{base}...{head}"),
                ],
            )
            .await?;
        let counts: Vec<i64> = counts
            .split_whitespace()
            .map(|count| count.parse().unwrap_or(0))
            .collect();
        let log = self
            .git(
                &dir,
                &[
                    "log",
                    "--format=%H%x1f%s%x1f%an%x1f%aI",
                    "--max-count=250",
                    &format!("{base}..{head}"),
                ],
            )
            .await?;
        let stat = self
            .git(
                &dir,
                &[
                    "diff",
                    "--numstat",
                    "--find-renames",
                    &format!("{base}...{head}"),
                ],
            )
            .await?;
        let commits: Vec<Value> = log
            .split('\n')
            .filter(|line| !line.is_empty())
            .map(|line| {
                let parts: Vec<&str> = line.split('\u{1f}').collect();
                json!({ "sha": parts.first(), "message": parts.get(1), "author": parts.get(2), "date": parts.get(3) })
            })
            .collect();
        Ok(json!({
            "base": base,
            "head": head,
            "mergeBase": if merge_base.is_empty() { Value::Null } else { json!(merge_base) },
            "behindBy": counts.first().copied().unwrap_or(0),
            "aheadBy": counts.get(1).copied().unwrap_or(0),
            "commits": commits,
            "files": numstat(&stat),
        }))
    }

    async fn sync_mirror(&self, args: &Value) -> Answer {
        let dir = self.checkout(args).await?;
        let reference = safe_ref(arg(args, "ref"), "ref")?;
        let token = self.token().await;
        self.git_with(
            &dir,
            &["fetch", "--prune", "origin", &reference],
            false,
            token.as_deref(),
        )
        .await?;
        let fetched = self.git(&dir, &["rev-parse", "FETCH_HEAD"]).await?;
        let fetched = js::trim(&fetched);
        let expected = arg(args, "sha");
        if !expected.is_empty() && !fetched.starts_with(expected) {
            return Err(format!("{reference} is at {fetched}, not {expected}"));
        }
        Ok(
            json!({ "synced": true, "ref": reference, "sha": fetched, "checkout": dir.to_string_lossy() }),
        )
    }

    // GitHub

    /// The user's own GitHub token, from the environment, the GitHub install in Customizations, or the gh CLI.
    async fn token(&self) -> Option<String> {
        self.token
            .get_or_init(|| async {
                let set = |name: &str| std::env::var(name).ok().filter(|token| !token.is_empty());
                if let Some(token) = set("GH_TOKEN").or_else(|| set("GITHUB_TOKEN")).or_else(|| {
                    self.kernel
                        .store
                        .secret("mcp:mkt-github:token")
                        .filter(|token| !token.is_empty())
                }) {
                    return Some(token);
                }
                let mut command = Command::new("gh");
                command
                    .args(["auth", "token"])
                    .stdin(Stdio::null())
                    .kill_on_drop(true);
                let output = tokio::time::timeout(Duration::from_secs(5), command.output())
                    .await
                    .ok()?
                    .ok()?;
                let token = String::from_utf8_lossy(&output.stdout);
                let token = js::trim(&token);
                (output.status.success() && !token.is_empty()).then(|| token.to_owned())
            })
            .await
            .clone()
    }

    async fn request(
        &self,
        method: Method,
        route: &str,
        body: Option<&Value>,
        accept: &str,
    ) -> Result<String, Failure> {
        let Some(token) = self.token().await else {
            return Err("GitHub access is needed for this. Set GH_TOKEN, run `gh auth login`, or install GitHub in Customizations with a token.".to_owned());
        };
        let base = std::env::var("SATURN_GITHUB_API")
            .ok()
            .filter(|base| !base.is_empty())
            .unwrap_or_else(|| "https://api.github.com".to_owned());
        let client = client_builder()
            .timeout(API_TIMEOUT)
            .build()
            .map_err(|error| error.to_string())?;
        let mut request = client
            .request(method, format!("{base}{route}"))
            .header("Accept", accept)
            .bearer_auth(token)
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", "Saturn-Origin");
        if let Some(body) = body {
            request = request
                .header("Content-Type", "application/json")
                .body(body.to_string());
        }
        let response = request
            .send_noted()
            .await
            .map_err(|error| format!("Could not reach GitHub: {}", error.without_url()))?;
        let status = response.status();
        if status.as_u16() == 204 {
            return Ok("{}".to_owned());
        }
        let text = response
            .text()
            .await
            .map_err(|error| format!("Could not reach GitHub: {}", error.without_url()))?;
        if !status.is_success() {
            let message = serde_json::from_str::<Value>(&text).map_or_else(
                |_| text.clone(),
                |parsed| {
                    let mut parts: Vec<String> = Vec::new();
                    if truthy(parsed.get("message")) {
                        parts.push(js::text(parsed.get("message")));
                    }
                    for item in items(parsed.get("errors").unwrap_or(&Value::Null)) {
                        if truthy(item.get("message")) {
                            parts.push(js::text(item.get("message")));
                        }
                    }
                    parts.join(": ")
                },
            );
            return Err(format!(
                "GitHub {}: {}",
                status.as_u16(),
                js::prefix(&message, 400)
            ));
        }
        Ok(text)
    }

    async fn api(&self, method: Method, route: &str, body: Option<&Value>) -> Answer {
        let text = self.request(method, route, body, JSON_ACCEPT).await?;
        serde_json::from_str(&text)
            .map_err(|error| format!("GitHub's answer could not be read: {error}"))
    }

    async fn get(&self, route: &str) -> Answer {
        self.api(Method::GET, route, None).await
    }

    async fn graphql(&self, query: &str, variables: Value) -> Answer {
        let result = self
            .api(
                Method::POST,
                "/graphql",
                Some(&json!({ "query": query, "variables": variables })),
            )
            .await?;
        let errors = items(result.get("errors").unwrap_or(&Value::Null));
        if !errors.is_empty() {
            let messages: Vec<String> = errors
                .iter()
                .map(|item| js::text(item.get("message")))
                .collect();
            return Err(format!("GitHub: {}", messages.join("; ")));
        }
        Ok(result.get("data").cloned().unwrap_or(Value::Null))
    }

    fn repo_route(args: &Value) -> Result<String, Failure> {
        let (owner, name) = Self::repo_of(args)?;
        Ok(format!("/repos/{}/{}", encode(&owner), encode(&name)))
    }

    fn pull_number(args: &Value) -> Result<i64, Failure> {
        match number_of(args.get("number")) {
            Some(number) if number.fract() == 0.0 && number > 0.0 => Ok(number as i64),
            _ => Err("number must be a pull request number".to_owned()),
        }
    }

    async fn get_repository(&self, args: &Value) -> Answer {
        let repo = self.get(&Self::repo_route(args)?).await?;
        Ok(fields(&[
            ("owner", at(&repo, &["owner", "login"])),
            ("name", repo.get("name")),
            ("description", repo.get("description")),
            ("defaultBranch", repo.get("default_branch")),
            ("visibility", repo.get("visibility")),
            ("archived", repo.get("archived")),
            ("cloneUrl", repo.get("clone_url")),
            ("url", repo.get("html_url")),
            ("createdAt", repo.get("created_at")),
            ("updatedAt", repo.get("pushed_at")),
        ]))
    }

    async fn list_repositories(&self, args: &Value) -> Answer {
        let owner = arg(args, "owner");
        if owner.is_empty() {
            return Err("owner is required".to_owned());
        }
        let (size, at_page) = (page_size(args, 30.0), page(args));
        let me = self.get("/user").await?;
        let route = if js::text(me.get("login")).to_lowercase() == owner.to_lowercase() {
            format!("/user/repos?affiliation=owner&sort=updated&per_page={size}&page={at_page}")
        } else {
            format!(
                "/users/{}/repos?sort=updated&per_page={size}&page={at_page}",
                encode(owner)
            )
        };
        let repos = self.get(&route).await?;
        let filter = arg(args, "filter").to_lowercase();
        let shown: Vec<Value> = items(&repos)
            .iter()
            .filter(|repo| {
                filter.is_empty() || js::text(repo.get("name")).to_lowercase().contains(&filter)
            })
            .map(|repo| {
                fields(&[
                    ("owner", at(repo, &["owner", "login"])),
                    ("name", repo.get("name")),
                    ("visibility", repo.get("visibility")),
                    ("defaultBranch", repo.get("default_branch")),
                    ("updatedAt", repo.get("pushed_at")),
                    ("url", repo.get("html_url")),
                ])
            })
            .collect();
        Ok(
            json!({ "repositories": shown, "nextPageToken": next_page(items(&repos).len(), size, at_page) }),
        )
    }

    async fn list_namespaces(&self, args: &Value) -> Answer {
        let (size, at_page) = (page_size(args, 30.0), page(args));
        let me = self.get("/user").await?;
        let orgs = self
            .get(&format!("/user/orgs?per_page={size}&page={at_page}"))
            .await?;
        let mut namespaces = Vec::new();
        if at_page == 1 {
            let login = me.get("login").cloned().unwrap_or(Value::Null);
            let name = if truthy(me.get("name")) {
                me["name"].clone()
            } else {
                login.clone()
            };
            namespaces.push(json!({ "slug": login, "name": name, "type": "user" }));
        }
        for org in items(&orgs) {
            namespaces.push(json!({ "slug": org.get("login"), "name": org.get("login"), "type": "organization" }));
        }
        Ok(
            json!({ "namespaces": namespaces, "nextPageToken": next_page(items(&orgs).len(), size, at_page) }),
        )
    }

    async fn create_repository(&self, args: &Value) -> Answer {
        let name = arg(args, "name");
        if name.is_empty() {
            return Err("name is required".to_owned());
        }
        let name = plain_name(name)?;
        let me = self.get("/user").await?;
        let login = js::text(me.get("login"));
        let owner = plain_name(if arg(args, "owner").is_empty() {
            &login
        } else {
            arg(args, "owner")
        })?;
        let route = if owner.eq_ignore_ascii_case(&login) {
            "/user/repos".to_owned()
        } else {
            format!("/orgs/{}/repos", encode(&owner))
        };
        // Private by default: an agent should not publish a repository on its own.
        let repo = self
            .api(
                Method::POST,
                &route,
                Some(&json!({ "name": name, "private": true, "auto_init": true })),
            )
            .await?;
        let wanted = arg(args, "defaultBranch");
        let current = js::text(repo.get("default_branch"));
        if !wanted.is_empty() && wanted != current {
            self.api(
                Method::POST,
                &format!("/repos/{owner}/{name}/branches/{current}/rename"),
                Some(&json!({ "new_name": wanted })),
            )
            .await?;
        }
        let branch = if wanted.is_empty() {
            repo.get("default_branch").cloned()
        } else {
            Some(json!(wanted))
        };
        Ok(fields(&[
            ("owner", at(&repo, &["owner", "login"])),
            ("name", repo.get("name")),
            ("visibility", repo.get("visibility")),
            ("defaultBranch", branch.as_ref()),
            ("cloneUrl", repo.get("clone_url")),
            ("url", repo.get("html_url")),
        ]))
    }

    async fn list_pull_requests(&self, args: &Value) -> Answer {
        let (size, at_page) = (page_size(args, 30.0), page(args));
        let (owner, _) = Self::repo_of(args)?;
        let state = arg(args, "state");
        let query = {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            query
                .append_pair(
                    "state",
                    if ["open", "closed", "all"].contains(&state) {
                        state
                    } else {
                        "open"
                    },
                )
                .append_pair(
                    "sort",
                    if arg(args, "sortBy") == "updated" {
                        "updated"
                    } else {
                        "created"
                    },
                )
                .append_pair(
                    "direction",
                    if arg(args, "direction") == "asc" {
                        "asc"
                    } else {
                        "desc"
                    },
                )
                .append_pair("per_page", &size.to_string())
                .append_pair("page", &at_page.to_string());
            if !arg(args, "base").is_empty() {
                query.append_pair("base", arg(args, "base"));
            }
            let head = arg(args, "head");
            if !head.is_empty() {
                let qualified = if head.contains(':') {
                    head.to_owned()
                } else {
                    format!("{owner}:{head}")
                };
                query.append_pair("head", &qualified);
            }
            query.finish()
        };
        let pulls = self
            .get(&format!("{}/pulls?{query}", Self::repo_route(args)?))
            .await?;
        let author = arg(args, "author").to_lowercase();
        let shown: Vec<Value> = items(&pulls)
            .iter()
            .filter(|pr| {
                author.is_empty() || js::text(at(pr, &["user", "login"])).to_lowercase() == author
            })
            .map(|pr| {
                let mut summary = pull(pr);
                if let Some(object) = summary.as_object_mut() {
                    object.remove("body");
                }
                summary
            })
            .collect();
        Ok(
            json!({ "pullRequests": shown, "nextPageToken": next_page(items(&pulls).len(), size, at_page) }),
        )
    }

    async fn pull_request_read(&self, args: &Value) -> Answer {
        let number = Self::pull_number(args)?;
        let route = format!("{}/pulls/{number}", Self::repo_route(args)?);
        let (size, at_page) = (page_size(args, 30.0), page(args));
        let paging = format!("per_page={size}&page={at_page}");
        match arg(args, "view") {
            "files" => {
                let files = self.get(&format!("{route}/files?{paging}")).await?;
                let shown: Vec<Value> = items(&files)
                    .iter()
                    .map(|file| {
                        fields(&[
                            ("path", file.get("filename")),
                            ("status", file.get("status")),
                            ("additions", file.get("additions")),
                            ("deletions", file.get("deletions")),
                            ("previousPath", file.get("previous_filename")),
                            ("patch", file.get("patch")),
                        ])
                    })
                    .collect();
                Ok(
                    json!({ "files": shown, "nextPageToken": next_page(items(&files).len(), size, at_page) }),
                )
            }
            "commits" => {
                let commits = self.get(&format!("{route}/commits?{paging}")).await?;
                let shown: Vec<Value> = items(&commits)
                    .iter()
                    .map(|commit| {
                        fields(&[
                            ("sha", commit.get("sha")),
                            ("message", at(commit, &["commit", "message"])),
                            ("author", at(commit, &["commit", "author", "name"])),
                            ("date", at(commit, &["commit", "author", "date"])),
                        ])
                    })
                    .collect();
                Ok(
                    json!({ "commits": shown, "nextPageToken": next_page(items(&commits).len(), size, at_page) }),
                )
            }
            "reviews" => {
                let reviews = self.get(&format!("{route}/reviews?{paging}")).await?;
                let shown: Vec<Value> = items(&reviews)
                    .iter()
                    .map(|review| {
                        let id = json!(id_of(review.get("id")));
                        fields(&[
                            ("id", Some(&id)),
                            ("author", at(review, &["user", "login"])),
                            ("state", review.get("state")),
                            ("body", review.get("body")),
                            ("submittedAt", review.get("submitted_at")),
                            ("commitId", review.get("commit_id")),
                        ])
                    })
                    .collect();
                Ok(
                    json!({ "reviews": shown, "nextPageToken": next_page(items(&reviews).len(), size, at_page) }),
                )
            }
            "comments" => {
                let (owner, name) = Self::repo_of(args)?;
                let comments = self
                    .get(&format!(
                        "/repos/{owner}/{name}/issues/{number}/comments?{paging}"
                    ))
                    .await?;
                let shown: Vec<Value> = items(&comments)
                    .iter()
                    .map(|comment| {
                        let id = json!(id_of(comment.get("id")));
                        fields(&[
                            ("id", Some(&id)),
                            ("author", at(comment, &["user", "login"])),
                            ("body", comment.get("body")),
                            ("createdAt", comment.get("created_at")),
                            ("updatedAt", comment.get("updated_at")),
                        ])
                    })
                    .collect();
                Ok(
                    json!({ "comments": shown, "nextPageToken": next_page(items(&comments).len(), size, at_page) }),
                )
            }
            "threads" => self.read_threads(args, number).await,
            _ => Ok(json!({ "pullRequest": pull(&self.get(&route).await?) })),
        }
    }

    async fn read_threads(&self, args: &Value, number: i64) -> Answer {
        let (owner, name) = Self::repo_of(args)?;
        let token = args
            .get("pageToken")
            .map(|token| js::text(Some(token)))
            .unwrap_or_default();
        let after = if token.is_empty() || token.chars().all(|character| character.is_ascii_digit())
        {
            Value::Null
        } else {
            json!(token)
        };
        let data = self
            .graphql(
                "query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:50,after:$after){nodes{id isResolved isOutdated path line startLine diffSide comments(first:50){nodes{databaseId author{login} body createdAt}}} pageInfo{hasNextPage endCursor}}}}}",
                json!({ "owner": owner, "name": name, "number": number, "after": after }),
            )
            .await?;
        let threads =
            at(&data, &["repository", "pullRequest", "reviewThreads"]).unwrap_or(&Value::Null);
        let wanted: Option<Vec<String>> = args
            .get("threadIds")
            .and_then(Value::as_array)
            .map(|ids| ids.iter().map(|id| js::text(Some(id))).collect());
        let shown: Vec<Value> = items(threads.get("nodes").unwrap_or(&Value::Null))
            .iter()
            .filter(|thread| {
                wanted
                    .as_ref()
                    .is_none_or(|wanted| wanted.contains(&js::text(thread.get("id"))))
            })
            .map(|thread| {
                let comments: Vec<Value> =
                    items(at(thread, &["comments", "nodes"]).unwrap_or(&Value::Null))
                        .iter()
                        .map(|comment| {
                            let id = json!(id_of(comment.get("databaseId")));
                            fields(&[
                                ("id", Some(&id)),
                                ("author", at(comment, &["author", "login"])),
                                ("body", comment.get("body")),
                                ("createdAt", comment.get("createdAt")),
                            ])
                        })
                        .collect();
                let comments = Value::Array(comments);
                fields(&[
                    ("id", thread.get("id")),
                    ("resolved", thread.get("isResolved")),
                    ("outdated", thread.get("isOutdated")),
                    ("path", thread.get("path")),
                    ("line", thread.get("line")),
                    ("startLine", thread.get("startLine")),
                    ("side", thread.get("diffSide")),
                    ("comments", Some(&comments)),
                ])
            })
            .collect();
        let next = if truthy(at(threads, &["pageInfo", "hasNextPage"])) {
            at(threads, &["pageInfo", "endCursor"])
                .cloned()
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        Ok(json!({ "threads": shown, "nextPageToken": next }))
    }

    async fn checks_read(&self, args: &Value) -> Answer {
        let empty = Value::Null;
        let target = args
            .get("target")
            .filter(|target| target.is_object())
            .unwrap_or(&empty);
        let base = Self::repo_route(args)?;
        let (size, at_page) = (page_size(args, 30.0), page(args));
        let run_id = arg(target, "checkRunId");
        if !run_id.is_empty() {
            let run = self
                .get(&format!("{base}/check-runs/{}", encode(run_id)))
                .await?;
            let id = json!(id_of(run.get("id")));
            let check = fields(&[
                ("id", Some(&id)),
                ("name", run.get("name")),
                ("status", run.get("status")),
                ("conclusion", run.get("conclusion")),
                ("url", run.get("html_url")),
                ("output", at(&run, &["output", "summary"])),
            ]);
            return Ok(json!({ "checkRun": check }));
        }
        let mut sha = [arg(target, "sha"), arg(args, "sha"), arg(args, "ref")]
            .into_iter()
            .find(|sha| !sha.is_empty())
            .unwrap_or("")
            .to_owned();
        let number = number_of(target.get("number")).or_else(|| number_of(args.get("number")));
        if let Some(number) = number.filter(|number| sha.is_empty() && number.fract() == 0.0) {
            let pr = self.get(&format!("{base}/pulls/{number}")).await?;
            sha = js::text(at(&pr, &["head", "sha"]));
        }
        let suite = arg(target, "checkSuiteId");
        if sha.is_empty() && suite.is_empty() {
            return Err(
                "Give a pull request number, a sha, a check suite id or a check run id".to_owned(),
            );
        }
        let route = if suite.is_empty() {
            format!("{base}/commits/{}/check-runs", encode(&sha))
        } else {
            format!("{base}/check-suites/{}/check-runs", encode(suite))
        };
        let result = self
            .get(&format!("{route}?per_page={size}&page={at_page}"))
            .await?;
        let runs: Vec<Value> = items(result.get("check_runs").unwrap_or(&Value::Null))
            .iter()
            .map(|run| {
                let id = json!(id_of(run.get("id")));
                fields(&[
                    ("id", Some(&id)),
                    ("name", run.get("name")),
                    ("status", run.get("status")),
                    ("conclusion", run.get("conclusion")),
                    ("startedAt", run.get("started_at")),
                    ("completedAt", run.get("completed_at")),
                    ("url", run.get("html_url")),
                ])
            })
            .collect();
        let total = result
            .get("total_count")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let more = at_page * size < total;
        let mut answer = json!({
            "sha": if sha.is_empty() { Value::Null } else { json!(sha) },
            "checkRuns": runs,
            "totalCount": result.get("total_count"),
        });
        if !more {
            answer["rollup"] = json!(if runs
                .iter()
                .any(|run| js::text(run.get("status")) != "completed")
            {
                "pending"
            } else if runs
                .iter()
                .any(|run| FAILED_CONCLUSIONS.contains(&js::text(run.get("conclusion")).as_str()))
            {
                "failure"
            } else if runs.is_empty() {
                "none"
            } else {
                "success"
            });
        }
        answer["nextPageToken"] = if more {
            json!((at_page + 1).to_string())
        } else {
            Value::Null
        };
        Ok(answer)
    }

    /// The end of a failed check's output: the GitHub Actions job log when the check is an Actions job (its check run id is
    /// the job id), else the check's own summary and text, plus its annotations.
    async fn check_run_log(&self, args: &Value) -> Answer {
        static TIMESTAMP: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"(?m)^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z ").expect("a valid pattern")
        });
        let base = Self::repo_route(args)?;
        let id = encode(arg(args, "checkRunId"));
        let limit = number_of(args.get("limit"))
            .unwrap_or(4000.0)
            .clamp(500.0, 20_000.0) as usize;
        let run = self.get(&format!("{base}/check-runs/{id}")).await?;
        let log = match self
            .request(
                Method::GET,
                &format!("{base}/actions/jobs/{id}/logs"),
                None,
                "application/vnd.github.v3.raw",
            )
            .await
        {
            Ok(log) => log,
            Err(_) => [
                at(&run, &["output", "summary"]),
                at(&run, &["output", "text"]),
            ]
            .into_iter()
            .filter(|part| truthy(*part))
            .map(|part| js::text(part))
            .collect::<Vec<_>>()
            .join("\n\n"),
        };
        let annotations = self
            .get(&format!("{base}/check-runs/{id}/annotations?per_page=20"))
            .await
            .unwrap_or(Value::Null);
        let shown: Vec<String> = items(&annotations)
            .iter()
            .take(20)
            .map(|item| {
                format!(
                    "{}:{} {}: {}",
                    js::text(item.get("path")),
                    js::text(item.get("start_line")),
                    js::text(item.get("annotation_level")),
                    js::text(item.get("message"))
                )
            })
            .collect();
        // Timestamps at the start of each Actions log line only take room.
        let text = TIMESTAMP.replace_all(&log, "");
        let tail = if js::length(&text) > limit {
            format!("…{}", js::suffix(&text, limit))
        } else {
            text.into_owned()
        };
        let shown = json!(shown);
        let tail = json!(tail);
        Ok(fields(&[
            ("name", run.get("name")),
            ("conclusion", run.get("conclusion")),
            ("url", run.get("html_url")),
            ("annotations", Some(&shown)),
            ("log", Some(&tail)),
        ]))
    }

    async fn parent_head(&self, args: &Value) -> Result<Option<String>, Failure> {
        let Some(parent) =
            number_of(args.get("parentPullNumber")).filter(|parent| parent.fract() == 0.0)
        else {
            return Ok(None);
        };
        let pr = self
            .get(&format!("{}/pulls/{parent}", Self::repo_route(args)?))
            .await?;
        Ok(at(&pr, &["head", "ref"]).map(|head| js::text(Some(head))))
    }

    async fn create_pull_request(&self, args: &Value) -> Answer {
        let route = Self::repo_route(args)?;
        let base = match self.parent_head(args).await? {
            Some(head) => head,
            None if !arg(args, "base").is_empty() => arg(args, "base").to_owned(),
            None => js::text(self.get(&route).await?.get("default_branch")),
        };
        let mut body = json!({
            "title": arg(args, "title"),
            "head": arg(args, "head"),
            "base": base,
            "draft": args.get("draft") == Some(&Value::Bool(true)),
        });
        if let Some(text) = args.get("body").filter(|text| text.is_string()) {
            body["body"] = text.clone();
        }
        let pr = self
            .api(Method::POST, &format!("{route}/pulls"), Some(&body))
            .await?;
        Ok(json!({ "pullRequest": pull(&pr) }))
    }

    async fn update_pull_request(&self, args: &Value) -> Answer {
        let route = format!(
            "{}/pulls/{}",
            Self::repo_route(args)?,
            Self::pull_number(args)?
        );
        let mut patch = Map::new();
        for key in ["title", "body"] {
            if let Some(text) = args.get(key).filter(|text| text.is_string()) {
                patch.insert(key.to_owned(), text.clone());
            }
        }
        if let Some(state) = args
            .get("state")
            .filter(|state| *state == "open" || *state == "closed")
        {
            patch.insert("state".to_owned(), state.clone());
        }
        let mut pr = if patch.is_empty() {
            self.get(&route).await?
        } else {
            self.api(Method::PATCH, &route, Some(&Value::Object(patch)))
                .await?
        };
        if let Some(draft) = args.get("draft").and_then(Value::as_bool)
            && pr.get("draft").and_then(Value::as_bool) != Some(draft)
        {
            // Draft state is only changeable through GraphQL.
            let mutation = if draft {
                "mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{isDraft}}}"
            } else {
                "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}"
            };
            self.graphql(mutation, json!({ "id": pr.get("node_id") }))
                .await?;
            pr = self.get(&route).await?;
        }
        Ok(json!({ "pullRequest": pull(&pr) }))
    }

    async fn update_pull_request_base(&self, args: &Value) -> Answer {
        let base = match self.parent_head(args).await? {
            Some(head) => head,
            None => arg(args, "base").to_owned(),
        };
        if base.is_empty() {
            return Err("Give base or parentPullNumber".to_owned());
        }
        let route = format!(
            "{}/pulls/{}",
            Self::repo_route(args)?,
            Self::pull_number(args)?
        );
        let pr = self
            .api(Method::PATCH, &route, Some(&json!({ "base": base })))
            .await?;
        Ok(json!({ "pullRequest": pull(&pr) }))
    }

    async fn merge_pull_request(&self, args: &Value) -> Answer {
        let expected = arg(args, "expectedHeadSha");
        if expected.is_empty() {
            return Err(
                "expectedHeadSha is required, so a branch that moved is never merged by mistake"
                    .to_owned(),
            );
        }
        let route = format!(
            "{}/pulls/{}/merge",
            Self::repo_route(args)?,
            Self::pull_number(args)?
        );
        let method = if arg(args, "mergeMethod") == "squash" {
            "squash"
        } else {
            "merge"
        };
        let result = self
            .api(
                Method::PUT,
                &route,
                Some(&json!({ "sha": expected, "merge_method": method })),
            )
            .await?;
        let merged = json!(result.get("merged") == Some(&Value::Bool(true)));
        Ok(fields(&[
            ("merged", Some(&merged)),
            ("sha", result.get("sha")),
            ("message", result.get("message")),
        ]))
    }

    async fn create_review(&self, args: &Value) -> Answer {
        let event = arg(args, "event").to_uppercase();
        let mapped = if event == "APPROVE" || event == "REQUEST_CHANGES" {
            event.as_str()
        } else {
            "COMMENT"
        };
        let mut body = json!({ "event": mapped });
        if let Some(text) = args.get("body").filter(|text| text.is_string()) {
            body["body"] = text.clone();
        }
        let route = format!(
            "{}/pulls/{}/reviews",
            Self::repo_route(args)?,
            Self::pull_number(args)?
        );
        let review = self.api(Method::POST, &route, Some(&body)).await?;
        let id = json!(id_of(review.get("id")));
        let shown = fields(&[
            ("id", Some(&id)),
            ("state", review.get("state")),
            ("body", review.get("body")),
            ("url", review.get("html_url")),
        ]);
        Ok(json!({ "review": shown }))
    }

    async fn update_review(&self, args: &Value) -> Answer {
        let route = format!(
            "{}/pulls/{}/reviews/{}",
            Self::repo_route(args)?,
            Self::pull_number(args)?,
            encode(arg(args, "reviewId"))
        );
        let review = self
            .api(
                Method::PUT,
                &route,
                Some(&json!({ "body": arg(args, "body") })),
            )
            .await?;
        let id = json!(id_of(review.get("id")));
        let shown = fields(&[
            ("id", Some(&id)),
            ("state", review.get("state")),
            ("body", review.get("body")),
        ]);
        Ok(json!({ "review": shown }))
    }

    async fn dismiss_review(&self, args: &Value) -> Answer {
        let route = format!(
            "{}/pulls/{}/reviews/{}/dismissals",
            Self::repo_route(args)?,
            Self::pull_number(args)?,
            encode(arg(args, "reviewId"))
        );
        let review = self
            .api(
                Method::PUT,
                &route,
                Some(&json!({ "message": arg(args, "message"), "event": "DISMISS" })),
            )
            .await?;
        let id = json!(id_of(review.get("id")));
        let shown = fields(&[("id", Some(&id)), ("state", review.get("state"))]);
        Ok(json!({ "review": shown }))
    }

    async fn create_comment(&self, args: &Value) -> Answer {
        let route = format!(
            "{}/issues/{}/comments",
            Self::repo_route(args)?,
            Self::pull_number(args)?
        );
        let comment = self
            .api(
                Method::POST,
                &route,
                Some(&json!({ "body": arg(args, "body") })),
            )
            .await?;
        let id = json!(id_of(comment.get("id")));
        let shown = fields(&[
            ("id", Some(&id)),
            ("body", comment.get("body")),
            ("url", comment.get("html_url")),
        ]);
        Ok(json!({ "comment": shown }))
    }

    async fn create_inline_comment(&self, args: &Value) -> Answer {
        let empty = Value::Null;
        let anchor = args
            .get("anchor")
            .filter(|anchor| anchor.is_object())
            .unwrap_or(&empty);
        let route = format!(
            "{}/pulls/{}",
            Self::repo_route(args)?,
            Self::pull_number(args)?
        );
        let pr = self.get(&route).await?;
        let kind = if arg(anchor, "kind").is_empty() {
            "line"
        } else {
            arg(anchor, "kind")
        };
        let side = if arg(anchor, "side").eq_ignore_ascii_case("left") {
            "LEFT"
        } else {
            "RIGHT"
        };
        let start = number_of(anchor.get("startLine")).unwrap_or(1.0);
        let mut body = fields(&[("commit_id", at(&pr, &["head", "sha"]))]);
        body["body"] = json!(arg(args, "body"));
        body["path"] = json!(safe_path(arg(anchor, "path"))?);
        match kind {
            "file" => body["subject_type"] = json!("file"),
            "range" => {
                body["start_line"] = number_value(start);
                body["start_side"] = json!(side);
                body["line"] = number_value(number_of(anchor.get("endLine")).unwrap_or(start));
                body["side"] = json!(side);
            }
            _ => {
                body["line"] = number_value(start);
                body["side"] = json!(side);
            }
        }
        let comment = self
            .api(Method::POST, &format!("{route}/comments"), Some(&body))
            .await?;
        let id = json!(id_of(comment.get("id")));
        let shown = fields(&[
            ("id", Some(&id)),
            ("path", comment.get("path")),
            ("line", comment.get("line")),
            ("side", comment.get("side")),
            ("url", comment.get("html_url")),
        ]);
        Ok(json!({ "inlineComment": shown }))
    }

    /// threadId is the id of the thread's first review comment (as returned by the threads view).
    async fn reply_thread(&self, args: &Value) -> Answer {
        let given = arg(args, "threadId");
        let mut comment_id = given.to_owned();
        if given.is_empty() || !given.chars().all(|character| character.is_ascii_digit()) {
            let data = self
                .graphql(
                    "query($id:ID!){node(id:$id){... on PullRequestReviewThread{comments(first:1){nodes{databaseId}}}}}",
                    json!({ "id": given }),
                )
                .await?;
            comment_id = at(&data, &["node", "comments", "nodes"])
                .and_then(|nodes| nodes.get(0))
                .and_then(|node| node.get("databaseId"))
                .map(|id| js::text(Some(id)))
                .unwrap_or_default();
            if comment_id.is_empty() {
                return Err(format!(
                    "Review thread {} not found",
                    js::text(args.get("threadId"))
                ));
            }
        }
        let route = format!(
            "{}/pulls/{}/comments/{comment_id}/replies",
            Self::repo_route(args)?,
            Self::pull_number(args)?
        );
        let reply = self
            .api(
                Method::POST,
                &route,
                Some(&json!({ "body": arg(args, "body") })),
            )
            .await?;
        let id = json!(id_of(reply.get("id")));
        let shown = fields(&[
            ("id", Some(&id)),
            ("body", reply.get("body")),
            ("url", reply.get("html_url")),
        ]);
        Ok(json!({ "reply": shown }))
    }

    async fn update_thread(&self, args: &Value) -> Answer {
        let resolved = args.get("resolved") == Some(&Value::Bool(true));
        let mutation = if resolved {
            "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}"
        } else {
            "mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}"
        };
        let given = arg(args, "threadId");
        let data = self.graphql(mutation, json!({ "id": given })).await?;
        let thread = data
            .as_object()
            .and_then(|object| object.values().next())
            .and_then(|value| value.get("thread"));
        let id = thread
            .and_then(|thread| thread.get("id"))
            .cloned()
            .unwrap_or_else(|| json!(given));
        let state = thread
            .and_then(|thread| thread.get("isResolved"))
            .cloned()
            .unwrap_or_else(|| json!(resolved));
        Ok(json!({ "threadId": id, "resolved": state }))
    }

    async fn update_comment(&self, args: &Value) -> Answer {
        let id = encode(arg(args, "commentId"));
        let body = json!({ "body": arg(args, "body") });
        let base = Self::repo_route(args)?;
        let comment = match self
            .api(
                Method::PATCH,
                &format!("{base}/issues/comments/{id}"),
                Some(&body),
            )
            .await
        {
            Ok(comment) => comment,
            // Not a conversation comment: try it as an inline review comment.
            Err(error) if error.contains("GitHub 404") => {
                self.api(
                    Method::PATCH,
                    &format!("{base}/pulls/comments/{id}"),
                    Some(&body),
                )
                .await?
            }
            Err(error) => return Err(error),
        };
        let id = json!(id_of(comment.get("id")));
        let shown = fields(&[("id", Some(&id)), ("body", comment.get("body"))]);
        Ok(json!({ "comment": shown }))
    }

    async fn update_labels(&self, args: &Value) -> Answer {
        let labels: Vec<String> = items(args.get("labels").unwrap_or(&Value::Null))
            .iter()
            .map(|label| js::text(Some(label)))
            .collect();
        let route = format!(
            "{}/issues/{}/labels",
            Self::repo_route(args)?,
            Self::pull_number(args)?
        );
        let result = self
            .api(Method::PUT, &route, Some(&json!({ "labels": labels })))
            .await?;
        let names: Vec<&Value> = items(&result)
            .iter()
            .filter_map(|label| label.get("name"))
            .collect();
        Ok(json!({ "labels": names }))
    }

    async fn create_label(&self, args: &Value) -> Answer {
        let mut body = json!({ "name": arg(args, "label") });
        if !arg(args, "color").is_empty() {
            body["color"] = json!(arg(args, "color").trim_start_matches('#'));
        }
        if let Some(text) = args.get("description").filter(|text| text.is_string()) {
            body["description"] = text.clone();
        }
        let label = self
            .api(
                Method::POST,
                &format!("{}/labels", Self::repo_route(args)?),
                Some(&body),
            )
            .await?;
        let shown = fields(&[
            ("name", label.get("name")),
            ("color", label.get("color")),
            ("description", label.get("description")),
        ]);
        Ok(json!({ "label": shown, "created": true }))
    }

    async fn reviewers(&self, args: &Value, method: Method) -> Answer {
        let names = |key: &str| -> Vec<String> {
            items(args.get(key).unwrap_or(&Value::Null))
                .iter()
                .map(|name| js::text(Some(name)))
                .collect()
        };
        let route = format!(
            "{}/pulls/{}",
            Self::repo_route(args)?,
            Self::pull_number(args)?
        );
        let removing = method == Method::DELETE;
        let answer = self
            .api(
                method,
                &format!("{route}/requested_reviewers"),
                Some(&json!({ "reviewers": names("users"), "team_reviewers": names("groups") })),
            )
            .await?;
        let after = if removing {
            self.get(&route).await?
        } else {
            answer
        };
        let list = |key: &str, field: &str| -> Value {
            Value::Array(
                items(after.get(key).unwrap_or(&Value::Null))
                    .iter()
                    .filter_map(|item| item.get(field).cloned())
                    .collect(),
            )
        };
        Ok(
            json!({ "requestedReviewers": list("requested_reviewers", "login"), "requestedTeams": list("requested_teams", "slug") }),
        )
    }
}

fn number_value(number: f64) -> Value {
    if number.fract() == 0.0 {
        json!(number as i64)
    } else {
        json!(number)
    }
}

fn next_page(found: usize, size: i64, at_page: i64) -> Value {
    if found as i64 == size {
        json!((at_page + 1).to_string())
    } else {
        Value::Null
    }
}

fn parents_of(text: &str) -> Value {
    if text.is_empty() {
        json!([])
    } else {
        json!(text.split(' ').collect::<Vec<_>>())
    }
}

/// A `git grep` line without its ref: the path, the line number, the text, and whether it is only context. The separator
/// (":" for a match, "-" for context) is the first one that has a number and the same separator after it.
fn grep_line(rest: &str) -> Option<(&str, i64, &str, bool)> {
    for (index, separator) in rest.char_indices() {
        if separator != ':' && separator != '-' {
            continue;
        }
        let after = &rest[index + 1..];
        let digits = after.bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 && after[digits..].starts_with(separator) {
            let number = after[..digits].parse().ok()?;
            return Some((
                &rest[..index],
                number,
                &after[digits + 1..],
                separator == '-',
            ));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_component_is_encoded_as_encode_uri_component_does() {
        assert_eq!(encode("a/b c?d&e=f"), "a%2Fb%20c%3Fd%26e%3Df");
        assert_eq!(encode("keep-_.!~*'()AZaz09"), "keep-_.!~*'()AZaz09");
        assert_eq!(encode("é日\u{1F600}"), "%C3%A9%E6%97%A5%F0%9F%98%80");
    }

    #[test]
    fn a_grep_line_splits_at_its_first_numbered_separator() {
        assert_eq!(
            grep_line("a/b.ts:3:x:4:y"),
            Some(("a/b.ts", 3, "x:4:y", false))
        );
        assert_eq!(grep_line("a-b.ts-3-x"), Some(("a-b.ts", 3, "x", true)));
        assert_eq!(grep_line("no numbers"), None);
    }

    #[test]
    fn paths_stay_inside_the_repository() {
        assert_eq!(safe_path("./src//a.ts").unwrap(), "src/a.ts");
        assert_eq!(safe_path("src/../a.ts").unwrap(), "a.ts");
        assert_eq!(safe_path("src\\a.ts").unwrap(), "src/a.ts");
        assert_eq!(safe_path("").unwrap(), "");
        for outside in ["../a", "..", "/etc/passwd", "a/../../b"] {
            assert!(safe_path(outside).is_err(), "{outside}");
        }
    }

    #[test]
    fn a_name_is_only_a_name() {
        assert!(plain_name("acme-site.v2_x").is_ok());
        for bad in ["..", "...", "a/b", "../x", "-x", "--upload-pack=y", ""] {
            assert!(plain_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_github_remote_is_read_only_from_github() {
        let acme = Some(("acme".to_owned(), "widgets".to_owned()));
        assert_eq!(
            parse_github_remote("https://github.com/acme/widgets.git"),
            acme
        );
        assert_eq!(parse_github_remote("git@github.com:acme/widgets.git"), acme);
        assert_eq!(
            parse_github_remote("ssh://git@github.com/acme/widgets"),
            acme
        );
        assert_eq!(
            parse_github_remote("https://notgithub.com/acme/widgets.git"),
            None
        );
        assert_eq!(
            parse_github_remote("https://gitlab.com/acme/widgets.git"),
            None
        );
    }
}
