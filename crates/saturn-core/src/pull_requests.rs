//! Following a pull request after Saturn opened it from a chat's worktree, matching
//! `runtime/src/application/pull-requests.ts`: every CHECK_EVERY (and on request) it reads the pull request's state, its head's
//! checks, and its comments and unresolved review threads, with the user's GitHub token. When the checks fail on a head it has
//! not handled, it hands the failing checks' log tails to the chat's agent as an automatic turn in the same worktree, at most
//! MAX_FIX_ROUNDS times, and when that turn ends with changes it commits and pushes them. New comments are kept as feedback the
//! user can send to the agent with one click (they come from other people, so nothing is sent on its own).
use std::sync::Arc;
use std::time::Duration;

use saturn_domain::js;
use saturn_domain::time::{iso_time, now_millis};
use serde_json::{Value, json};

use crate::origin::Origin;
use crate::records::{by_id_mut, text};
use crate::runs::StartOptions;
use crate::{CoreError, Kernel, locked, log};

const CHECK_EVERY: Duration = Duration::from_secs(120);
pub const MAX_FIX_ROUNDS: i64 = 2;
const LOG_LIMIT: i64 = 3500;
const MAX_FAILED_LOGS: usize = 3;
const FAILED: [&str; 4] = ["failure", "timed_out", "cancelled", "action_required"];
const BUSY: [&str; 4] = ["running", "queued", "waiting_approval", "sleeping"];

fn no_pull_request() -> CoreError {
    CoreError::new(404, "This chat has no pull request")
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().map(|item| js::text(Some(item))).collect())
        .unwrap_or_default()
}

/// One piece of feedback, by `value`'s comment.
fn feedback_item(id: String, comment: &Value, extra: Option<(&Value, &Value)>) -> Value {
    let mut item = json!({
        "id": id,
        "author": comment.get("author").and_then(Value::as_str).unwrap_or("someone"),
        "body": js::trim(&js::text(comment.get("body"))),
        "at": js::text(comment.get("createdAt")),
    });
    if let Some((path, line)) = extra {
        if js::truthy(Some(path)) {
            item["path"] = path.clone();
        }
        if js::truthy(Some(line)) {
            item["line"] = line.clone();
        }
    }
    item
}

impl Kernel {
    /// Starts the regular look at every followed pull request.
    pub fn start_pull_requests(self: &Arc<Self>) {
        let kernel = Arc::clone(self);
        tokio::spawn(async move {
            let mut timer = tokio::time::interval(CHECK_EVERY);
            timer.tick().await;
            loop {
                timer.tick().await;
                let watched: Vec<String> = kernel.store.read(|state| {
                    state
                        .threads
                        .iter()
                        .filter(|thread| {
                            thread
                                .get("pullRequest")
                                .and_then(|watch| watch.get("watching"))
                                == Some(&Value::Bool(true))
                        })
                        .map(|thread| text(thread, "id").to_owned())
                        .collect()
                });
                for thread in watched {
                    kernel.check_pull_request(&thread).await.ok();
                }
            }
        });
    }

    /// Changes the chat's pull request record, and gives it as it now is.
    async fn save_watch(
        &self,
        thread_id: &str,
        change: impl FnOnce(&mut Value) + Send + 'static,
    ) -> Result<Option<Value>, CoreError> {
        let id = thread_id.to_owned();
        Ok(self
            .store
            .update(move |state| {
                let watch = by_id_mut(&mut state.threads, &id)?.get_mut("pullRequest")?;
                if !watch.is_object() {
                    return None;
                }
                change(watch);
                Some(watch.clone())
            })
            .await?)
    }

    fn watch_of(&self, thread_id: &str) -> Result<(Value, Value), CoreError> {
        let thread = self
            .store
            .read(|state| {
                state
                    .threads
                    .iter()
                    .find(|thread| text(thread, "id") == thread_id)
                    .cloned()
            })
            .ok_or_else(|| CoreError::new(404, "Chat not found"))?;
        let watch = thread
            .get("pullRequest")
            .filter(|watch| watch.is_object())
            .cloned()
            .ok_or_else(no_pull_request)?;
        Ok((thread, watch))
    }

    /// Starts following a pull request just opened from the chat.
    pub(crate) async fn follow_pull_request(
        &self,
        thread_id: &str,
        number: i64,
        url: &str,
        repository: &str,
        branch: &str,
    ) -> Result<(), CoreError> {
        let id = thread_id.to_owned();
        let watch = json!({
            "number": number, "url": url, "repository": repository, "branch": branch,
            "watching": true, "state": "open", "checks": "pending", "fixRounds": 0,
            "feedback": [], "seenFeedback": [], "openedAt": iso_time(now_millis()),
        });
        self.store
            .update(move |state| {
                if let Some(thread) = by_id_mut(&mut state.threads, &id) {
                    thread["pullRequest"] = watch;
                }
            })
            .await?;
        log(
            "worktrees",
            "info",
            &format!("Following pull request #{number} ({repository}): checks and comments"),
        );
        Ok(())
    }

    /// Stops or resumes following; resuming looks right away.
    pub async fn set_watching_pull_request(
        self: &Arc<Self>,
        thread_id: &str,
        watching: bool,
    ) -> Result<Value, CoreError> {
        let watch = self
            .save_watch(thread_id, move |item| item["watching"] = json!(watching))
            .await?
            .ok_or_else(no_pull_request)?;
        if watching {
            let kernel = Arc::clone(self);
            let id = thread_id.to_owned();
            tokio::spawn(async move { kernel.check_pull_request(&id).await });
        }
        Ok(watch)
    }

    /// A tool of the watched repository, with the owner and name it is on.
    async fn watched_tool(
        &self,
        origin: &Origin<'_>,
        tool: &str,
        watch: &Value,
        mut args: Value,
    ) -> Result<Value, String> {
        let repository = text(watch, "repository");
        let (owner, name) = repository.split_once('/').unwrap_or((repository, ""));
        args["owner"] = json!(owner);
        args["name"] = json!(name);
        origin.run(tool, &args).await
    }

    /// One look at the pull request: state, checks, comments; a CI fix round when the checks newly fail.
    pub async fn check_pull_request(self: &Arc<Self>, thread_id: &str) -> Result<Value, CoreError> {
        let (_, watch) = self.watch_of(thread_id)?;
        if !locked(&self.checking_pull_requests).insert(thread_id.to_owned()) {
            return Ok(watch);
        }
        let answer = self.look_at_pull_request(thread_id, &watch).await;
        locked(&self.checking_pull_requests).remove(thread_id);
        answer
    }

    async fn look_at_pull_request(
        self: &Arc<Self>,
        thread_id: &str,
        watch: &Value,
    ) -> Result<Value, CoreError> {
        let origin = Origin::new(self, None);
        match self.read_pull_request(&origin, thread_id, watch).await {
            Ok(next) => Ok(next),
            Err(message) => {
                let error = if message.to_lowercase().contains("token")
                    || message.contains("GitHub access")
                {
                    "No GitHub token: sign in with `gh auth login`, set GH_TOKEN, or install GitHub under Customizations.".to_owned()
                } else {
                    js::prefix(&message, 300).to_owned()
                };
                let saved = self
                    .save_watch(thread_id, move |item| {
                        item["error"] = json!(error);
                        item["lastCheckedAt"] = json!(iso_time(now_millis()));
                    })
                    .await?;
                Ok(saved.unwrap_or_else(|| watch.clone()))
            }
        }
    }

    async fn read_pull_request(
        self: &Arc<Self>,
        origin: &Origin<'_>,
        thread_id: &str,
        watch: &Value,
    ) -> Result<Value, String> {
        let number = watch.get("number").cloned().unwrap_or(Value::Null);
        let summary = self
            .watched_tool(
                origin,
                "pull_request_read",
                watch,
                json!({ "number": number, "view": "summary" }),
            )
            .await?;
        let pr = summary.get("pullRequest").unwrap_or(&summary);
        let state = if js::truthy(pr.get("merged"))
            || js::truthy(pr.get("mergedAt"))
            || text(pr, "state") == "merged"
        {
            "merged"
        } else if text(pr, "state") == "closed" {
            "closed"
        } else {
            "open"
        };
        let checks = self
            .watched_tool(origin, "checks_read", watch, json!({ "number": number }))
            .await?;
        let head = [checks.get("sha"), pr.get("headSha")]
            .into_iter()
            .find(|value| js::truthy(*value))
            .map_or_else(String::new, |value| js::text(value));
        let failed: Vec<Value> = checks
            .get("checkRuns")
            .and_then(Value::as_array)
            .map(|runs| {
                runs.iter()
                    .filter(|run| FAILED.contains(&js::text(run.get("conclusion")).as_str()))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let feedback = self.new_feedback(origin, watch).await;
        let count = feedback.len();
        let rollup = checks
            .get("rollup")
            .cloned()
            .unwrap_or_else(|| json!("pending"));
        let listed: Vec<Value> = failed
            .iter()
            .map(
                |run| json!({ "name": js::text(run.get("name")), "url": js::text(run.get("url")) }),
            )
            .collect();
        let saved_head = head.clone();
        let next = self
            .save_watch(thread_id, move |item| {
                item["state"] = json!(state);
                item["head"] = json!(saved_head);
                item["checks"] = rollup;
                item["failed"] = json!(listed);
                item["lastCheckedAt"] = json!(iso_time(now_millis()));
                if let Some(object) = item.as_object_mut() {
                    object.remove("error");
                }
                if !feedback.is_empty() {
                    let ids: Vec<Value> =
                        feedback.iter().map(|entry| entry["id"].clone()).collect();
                    if let Some(known) = item["feedback"].as_array_mut() {
                        known.extend(feedback);
                    }
                    if let Some(seen) = item["seenFeedback"].as_array_mut() {
                        seen.extend(ids);
                    }
                }
                if state != "open" {
                    item["watching"] = json!(false);
                }
            })
            .await
            .map_err(|error| error.message)?;
        let shown = js::text(watch.get("number"));
        if count > 0 {
            let comments = if count == 1 { "comment" } else { "comments" };
            log(
                "worktrees",
                "info",
                &format!("Pull request #{shown}: {count} new {comments}"),
            );
        }
        if state != "open" {
            log(
                "worktrees",
                "info",
                &format!("Pull request #{shown} was {state}; no longer following it"),
            );
        }
        let Some(next) = next else {
            return Ok(watch.clone());
        };
        if state == "open"
            && text(&next, "checks") == "failure"
            && !head.is_empty()
            && text(&next, "handledHead") != head
        {
            let fixed = self
                .fix_round(origin, thread_id, &failed, &head)
                .await
                .map_err(|error| error.message)?;
            return Ok(fixed.unwrap_or(next));
        }
        Ok(next)
    }

    /// Comments and unresolved review threads not seen before.
    async fn new_feedback(&self, origin: &Origin<'_>, watch: &Value) -> Vec<Value> {
        let seen = strings(watch.get("seenFeedback"));
        let number = watch.get("number").cloned().unwrap_or(Value::Null);
        let mut found = Vec::new();
        let comments = self
            .watched_tool(
                origin,
                "pull_request_read",
                watch,
                json!({ "number": number, "view": "comments", "pageSize": 50 }),
            )
            .await
            .unwrap_or(Value::Null);
        for comment in comments
            .get("comments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let id = format!("comment:{}", js::text(comment.get("id")));
            if !seen.contains(&id) && !js::trim(&js::text(comment.get("body"))).is_empty() {
                found.push(feedback_item(id, comment, None));
            }
        }
        let threads = self
            .watched_tool(
                origin,
                "pull_request_read",
                watch,
                json!({ "number": number, "view": "threads" }),
            )
            .await
            .unwrap_or(Value::Null);
        for thread in threads
            .get("threads")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let said = thread.get("comments").and_then(Value::as_array);
            let id = format!(
                "thread:{}:{}",
                js::text(thread.get("id")),
                said.map_or(0, Vec::len)
            );
            let Some(last) = said.and_then(|said| said.last()) else {
                continue;
            };
            if js::truthy(thread.get("resolved"))
                || seen.contains(&id)
                || js::trim(&js::text(last.get("body"))).is_empty()
            {
                continue;
            }
            let none = Value::Null;
            found.push(feedback_item(
                id,
                last,
                Some((
                    thread.get("path").unwrap_or(&none),
                    thread.get("line").unwrap_or(&none),
                )),
            ));
        }
        found
    }

    /// Hands the failing checks to the agent as an automatic turn in the worktree; pushes its changes when it ends.
    async fn fix_round(
        self: &Arc<Self>,
        origin: &Origin<'_>,
        thread_id: &str,
        failed: &[Value],
        head: &str,
    ) -> Result<Option<Value>, CoreError> {
        let (thread, watch) = self.watch_of(thread_id)?;
        let busy = self.store.read(|state| {
            state.runs.iter().any(|run| {
                text(run, "threadId") == thread_id && BUSY.contains(&text(run, "status"))
            })
        });
        if busy {
            return Ok(None);
        }
        let number = js::text(watch.get("number"));
        let rounds = watch.get("fixRounds").and_then(Value::as_i64).unwrap_or(0);
        let handled = head.to_owned();
        if rounds >= MAX_FIX_ROUNDS {
            log(
                "worktrees",
                "warning",
                &format!(
                    "Pull request #{number}: checks still fail after {MAX_FIX_ROUNDS} automatic rounds; leaving it to the user"
                ),
            );
            return self
                .save_watch(thread_id, move |item| item["handledHead"] = json!(handled))
                .await;
        }
        let mut logs = Vec::new();
        for run in failed.iter().take(MAX_FAILED_LOGS) {
            let name = js::text(run.get("name"));
            let url = js::text(run.get("url"));
            let wanted = json!({ "checkRunId": js::text(run.get("id")), "limit": LOG_LIMIT });
            logs.push(
                match self
                    .watched_tool(origin, "check_run_log", &watch, wanted)
                    .await
                {
                    Ok(detail) => {
                        let at = if url.is_empty() {
                            String::new()
                        } else {
                            format!(" ({url})")
                        };
                        let annotations = strings(detail.get("annotations"));
                        let notes = if annotations.is_empty() {
                            String::new()
                        } else {
                            format!("{}\n", annotations.join("\n"))
                        };
                        let tail = js::text(detail.get("log"));
                        let tail = js::trim(&tail);
                        let tail = if tail.is_empty() { "(no log)" } else { tail };
                        format!("### {name}{at}\n{notes}```\n{tail}\n```")
                    }
                    Err(error) => format!("### {name}\n(could not read its log: {error})"),
                },
            );
        }
        let round = rounds + 1;
        let names: Vec<String> = failed.iter().map(|run| js::text(run.get("name"))).collect();
        let input = format!(
            "The checks failed on pull request #{number} ({}). Their output:\n\n{}\n\nFind the cause and fix it here. When you finish, Saturn commits your changes and pushes them to the pull request, and the checks run again. If the failure is not caused by this branch (a flaky test, an outage, missing secrets), say so instead of changing code.",
            names.join(", "),
            logs.join("\n\n"),
        );
        let started = self
            .start_run(
                text(&thread, "agentId"),
                &input,
                Some(thread_id),
                None,
                StartOptions {
                    automatic: true,
                    ..StartOptions::default()
                },
            )
            .await;
        match started {
            Ok(run) => {
                log(
                    "worktrees",
                    "info",
                    &format!(
                        "Pull request #{number}: checks failed; the agent is fixing them (round {round} of {MAX_FIX_ROUNDS})"
                    ),
                );
                let run_id = text(&run, "id").to_owned();
                self.save_watch(thread_id, move |item| {
                    item["handledHead"] = json!(handled);
                    item["fixRounds"] = json!(round);
                    item["fixRunId"] = json!(run_id);
                })
                .await
            }
            Err(error) => {
                let message = format!("Could not start the fix round: {}", error.message);
                self.save_watch(thread_id, move |item| {
                    item["handledHead"] = json!(handled);
                    item["error"] = json!(message);
                })
                .await
            }
        }
    }

    /// Called when a run ends: a finished CI fix round's, or review answer's, changes are committed and pushed.
    pub(crate) async fn pull_request_after_run(&self, run: &Value) -> Result<(), CoreError> {
        let run_id = text(run, "id").to_owned();
        let thread_id = text(run, "threadId").to_owned();
        if thread_id.is_empty() {
            return Ok(());
        }
        let Ok((_, watch)) = self.watch_of(&thread_id) else {
            return Ok(());
        };
        let fixing = text(&watch, "fixRunId") == run_id;
        if !fixing && text(&watch, "pushRunId") != run_id {
            return Ok(());
        }
        let clear = |item: &mut Value| {
            if let Some(object) = item.as_object_mut() {
                object.remove("fixRunId");
                object.remove("pushRunId");
            }
        };
        if text(run, "status") != "completed" {
            self.save_watch(&thread_id, clear).await?;
            return Ok(());
        }
        let number = js::text(watch.get("number"));
        let message = if fixing {
            format!(
                "Saturn: fix the checks on #{number} (round {})",
                js::text(watch.get("fixRounds"))
            )
        } else {
            format!("Saturn: address review comments on #{number}")
        };
        match self.push_worktree(&thread_id, &message).await {
            Ok((committed, head)) => {
                self.save_watch(&thread_id, move |item| {
                    clear(item);
                    if committed {
                        item["checks"] = json!("pending");
                        item["head"] = json!(head);
                    }
                })
                .await?;
                let said = if committed {
                    format!("Pull request #{number}: pushed the fix; the checks run again")
                } else {
                    format!("Pull request #{number}: the agent changed nothing to push")
                };
                log("worktrees", "info", &said);
            }
            Err(error) => {
                let message = format!("Could not push: {}", error.message);
                self.save_watch(&thread_id, move |item| {
                    clear(item);
                    item["error"] = json!(message);
                })
                .await?;
            }
        }
        Ok(())
    }

    /// The user sends review feedback (all of it, or the chosen items) to the agent as the next message.
    pub async fn send_pull_request_feedback(
        self: &Arc<Self>,
        thread_id: &str,
        ids: Option<Vec<String>>,
    ) -> Result<Value, CoreError> {
        let (thread, watch) = self.watch_of(thread_id)?;
        let chosen: Vec<Value> = watch
            .get("feedback")
            .and_then(Value::as_array)
            .map(|feedback| {
                feedback
                    .iter()
                    .filter(|item| {
                        ids.as_ref()
                            .is_none_or(|ids| ids.iter().any(|id| id == text(item, "id")))
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        if chosen.is_empty() {
            return Err(CoreError::new(409, "No review comments to send"));
        }
        let lines: Vec<String> = chosen
            .iter()
            .map(|item| {
                let place = if text(item, "path").is_empty() {
                    String::new()
                } else if js::truthy(item.get("line")) {
                    format!(
                        " on `{}:{}`",
                        text(item, "path"),
                        js::text(item.get("line"))
                    )
                } else {
                    format!(" on `{}`", text(item, "path"))
                };
                format!(
                    "- {}{place}: {}",
                    text(item, "author"),
                    text(item, "body").replace('\n', "\n  ")
                )
            })
            .collect();
        let input = format!(
            "Review comments on pull request #{}:\n\n{}\n\nAddress them in this branch, or say why not. When you finish, Saturn commits your changes and pushes them to the pull request.",
            js::text(watch.get("number")),
            lines.join("\n"),
        );
        let run = self
            .start_run(
                text(&thread, "agentId"),
                &input,
                Some(thread_id),
                None,
                StartOptions::default(),
            )
            .await?;
        let run_id = text(&run, "id").to_owned();
        let sent: Vec<String> = chosen
            .iter()
            .map(|item| text(item, "id").to_owned())
            .collect();
        let count = chosen.len();
        let saved_run = run_id.clone();
        self.save_watch(thread_id, move |item| {
            if let Some(feedback) = item["feedback"].as_array_mut() {
                feedback.retain(|entry| !sent.iter().any(|id| id == text(entry, "id")));
            }
            item["pushRunId"] = json!(saved_run);
        })
        .await?;
        Ok(json!({ "runId": run_id, "sent": count }))
    }

    /// Clears feedback the user decided not to send.
    pub async fn dismiss_pull_request_feedback(
        &self,
        thread_id: &str,
        ids: Option<Vec<String>>,
    ) -> Result<Value, CoreError> {
        self.save_watch(thread_id, move |item| match &ids {
            Some(ids) => {
                if let Some(feedback) = item["feedback"].as_array_mut() {
                    feedback.retain(|entry| !ids.iter().any(|id| id == text(entry, "id")));
                }
            }
            None => item["feedback"] = json!([]),
        })
        .await?
        .ok_or_else(no_pull_request)
    }

    /// Opens a pull request from a chat's worktree branch: commits what is pending, pushes the branch to origin, creates the
    /// pull request on GitHub with the user's token, and follows it from there on.
    pub async fn open_pull_request(
        &self,
        thread_id: &str,
        input: &Value,
    ) -> Result<Value, CoreError> {
        let thread = self
            .store
            .read(|state| {
                state
                    .threads
                    .iter()
                    .find(|thread| text(thread, "id") == thread_id)
                    .cloned()
            })
            .ok_or_else(|| CoreError::new(404, "Chat not found"))?;
        let worktree = thread
            .get("worktree")
            .filter(|worktree| worktree.is_object());
        let folder = self.worktree_path(&thread);
        let (Some(worktree), Some(folder), false) =
            (worktree, folder, text(&thread, "projectId").is_empty())
        else {
            return Err(CoreError::new(
                404,
                "This chat has no worktree branch to open a pull request from",
            ));
        };
        let (branch, base) = (
            text(worktree, "branch").to_owned(),
            text(worktree, "base").to_owned(),
        );
        let remote =
            crate::worktrees::git_or_empty(&folder, &["remote", "get-url", "origin"]).await;
        let Some(repository) = github_repository(&remote) else {
            return Err(CoreError::new(
                409,
                if remote.is_empty() {
                    "The project has no origin remote to push to".to_owned()
                } else {
                    format!("The origin remote ({remote}) is not a GitHub repository")
                },
            ));
        };
        let title = text(&thread, "title").to_owned();
        self.push_worktree(thread_id, &format!("Saturn: {title}"))
            .await?;
        let (owner, name) = repository.split_once('/').unwrap_or((&repository, ""));
        let given = js::trim(text(input, "title"));
        let wanted_title = if given.is_empty() {
            title.as_str()
        } else {
            given
        };
        let body = input
            .get("body")
            .and_then(Value::as_str)
            .map_or_else(|| self.summary_of(thread_id), str::to_owned);
        let origin = Origin::new(self, Some(folder));
        let result = origin
            .run(
                "create_pull_request",
                &json!({ "owner": owner, "name": name, "title": wanted_title, "body": body, "head": branch, "base": base }),
            )
            .await
            .map_err(|error| {
                if error.to_lowercase().contains("token") {
                    CoreError::new(409, "No GitHub token: sign in with `gh auth login`, set GH_TOKEN, or install GitHub under Customizations, then try again.")
                } else {
                    CoreError::new(502, format!("GitHub refused the pull request: {error}"))
                }
            })?;
        let pr = result.get("pullRequest").unwrap_or(&Value::Null);
        let number = pr.get("number").and_then(Value::as_i64).unwrap_or(0);
        let url = js::text(pr.get("url"));
        log(
            "worktrees",
            "info",
            &format!("Opened pull request #{number} from {branch}"),
        );
        // Followed from here on: its checks (a failure goes back to the agent) and its review comments.
        if let Some(followed) = repository_of_pull_url(&url)
            && number != 0
        {
            self.follow_pull_request(thread_id, number, &url, &followed, &branch)
                .await?;
        }
        Ok(json!({ "url": url, "number": number, "branch": branch }))
    }

    /// The "## Summary" of the chat's last reply, for a pull request's description.
    fn summary_of(&self, thread_id: &str) -> String {
        static SUMMARY: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
            regex::Regex::new(r"(?i)\n#{2,3}\s*Summary\s*\n").expect("a valid pattern")
        });
        let output = self.store.read(|state| {
            state
                .runs
                .iter()
                .find(|run| {
                    text(run, "threadId") == thread_id
                        && text(run, "status") == "completed"
                        && !text(run, "output").is_empty()
                })
                .map(|run| text(run, "output").to_owned())
        });
        let Some(output) = output else {
            return String::new();
        };
        let prefixed = format!("\n{output}");
        match SUMMARY.find(&prefixed) {
            Some(found) => js::trim(&prefixed[found.end()..]).to_owned(),
            None => js::prefix(&output, 4000).to_owned(),
        }
    }
}

/// The owner/name of a GitHub remote address.
pub fn github_repository(remote: &str) -> Option<String> {
    static REMOTE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r"(?i)(?:^|[/@])github\.com[/:]([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?$",
        )
        .expect("a valid pattern")
    });
    let found = REMOTE.captures(js::trim(remote))?;
    Some(format!("{}/{}", &found[1], &found[2]))
}

/// The owner/name in a pull request's web address.
fn repository_of_pull_url(url: &str) -> Option<String> {
    static ADDRESS: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"github\.com/([^/]+/[^/]+)/pull/").expect("a valid pattern")
    });
    Some(ADDRESS.captures(url)?[1].to_owned())
}

#[cfg(test)]
mod tests {
    use super::github_repository;

    #[test]
    fn a_github_repository_is_read_from_https_ssh_and_git_remotes() {
        let widgets = Some("acme/widgets".to_owned());
        assert_eq!(
            github_repository("https://github.com/acme/widgets.git"),
            widgets
        );
        assert_eq!(
            github_repository("git@github.com:acme/widgets.git"),
            widgets
        );
        assert_eq!(
            github_repository("ssh://git@github.com/acme/widgets"),
            widgets
        );
        assert_eq!(
            github_repository("https://gitlab.com/acme/widgets.git"),
            None
        );
        assert_eq!(
            github_repository("https://notgithub.com/acme/widgets.git"),
            None
        );
        assert_eq!(github_repository(""), None);
    }
}
