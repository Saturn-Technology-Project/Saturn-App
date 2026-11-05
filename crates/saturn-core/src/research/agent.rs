//! What a research assistant can do with a project's records, on any backend. What stays with the person (verdicts, labels,
//! modes, lifting a lock, merging a task) has no tool here, and `docs/research-contract.md` says so.
use std::sync::Arc;
use std::time::{Duration, Instant};

use saturn_domain::js;
use saturn_domain::research::{agent_change, agent_record};
use saturn_domain::skill_files::parse_skill;
use serde_json::{Value, json};

use super::skills::{bundled_skill, bundled_skills};
use crate::records::{strings, text};
use crate::skill_files::{list_skills, load_skill};
use crate::{CoreError, Kernel};

/// The longest answer handed to a model, in characters. Anything longer is paged or read in parts.
const LONGEST_ANSWER: usize = 60_000;
/// The most sample lines one read returns: a model reads a few closely, and the summary for the rest.
const SAMPLES_READ: u64 = 50;
/// The longest one wait holds a turn. A longer run is waited for again.
const LONGEST_WAIT: u64 = 600;
/// How often a wait looks at the run.
const WAIT_STEP: Duration = Duration::from_secs(2);
/// Resource readings an answer carries: the newest ones say where a run stands.
const READINGS_SHOWN: usize = 5;

/// The message of a runtime error, which is what the model is told.
fn said(error: CoreError) -> String {
    error.message
}

/// An answer short enough to hand to a model.
fn fitted(answer: Value) -> Value {
    let whole = answer.to_string();
    if js::length(&whole) <= LONGEST_ANSWER {
        return answer;
    }
    json!({
        "clipped": true,
        "note": "This answer was too long and was cut. Read a smaller part: a cursor and limit, one record, or the summary.",
        "text": js::prefix(&whole, LONGEST_ANSWER),
    })
}

/// Whether a research run is still going.
fn is_active(status: &str) -> bool {
    matches!(status, "starting" | "running" | "stopping")
}

/// The newest of a run's resource readings.
fn newest_readings(mut resources: Value) -> Value {
    if let Some(points) = resources.get_mut("points").and_then(Value::as_array_mut) {
        let skipped = points.len().saturating_sub(READINGS_SHOWN);
        points.drain(..skipped);
    }
    resources
}

/// A field a request must name.
fn needed<'a>(arguments: &'a Value, key: &str) -> Result<&'a str, String> {
    let value = text(arguments, key);
    if value.is_empty() {
        Err(format!("This needs \"{key}\"."))
    } else {
        Ok(value)
    }
}

impl Kernel {
    /// Runs one of the research tools for a turn in a project's chat.
    pub(crate) async fn research_agent_tool(
        self: &Arc<Self>,
        tool: &str,
        arguments: &Value,
        run: &Value,
    ) -> Result<Value, String> {
        if tool == "research_skill" {
            return self.research_skill(arguments, run).await;
        }
        let project = self.thread_project(run).ok_or(
            "This chat is not in a project. Research records belong to a project: open the chat from one.",
        )?;
        let answer = match tool {
            "research_read" => self.research_read(&project, arguments).await,
            "research_wait" => self.research_wait(&project, arguments, run).await,
            "research_write" => self.research_write(&project, arguments).await,
            "research_run" => self.research_run_action(&project, arguments, run).await,
            "research_environment_action" => {
                self.research_environment_action(&project, arguments).await
            }
            "research_inspect" => self.research_inspect(&project, arguments).await,
            _ => Err(format!("Unknown research tool: {tool}")),
        }?;
        Ok(fitted(answer))
    }

    /// The list of skills, or one skill's instructions. A project's or the user's skill of the same name comes first.
    async fn research_skill(&self, arguments: &Value, run: &Value) -> Result<Value, String> {
        let workdir = self.workdir_of_run(run).map_err(said)?;
        let user_dir = self.store.root().join("skills");
        let plugins = self.enabled_plugin_folders();
        let name = js::trim(text(arguments, "name"));
        if !name.is_empty() {
            if let Some(found) = load_skill(workdir.as_deref(), &user_dir, &plugins, name).await {
                return Ok(found);
            }
            let (file, _) = bundled_skill(name).ok_or_else(|| {
                format!("No skill named \"{name}\". Call research_skill with no name to list them.")
            })?;
            let parsed = parse_skill(file, name);
            return Ok(
                json!({ "name": parsed.name, "description": parsed.description, "instructions": parsed.body }),
            );
        }
        let mut skills: Vec<Value> = list_skills(workdir.as_deref(), &user_dir, &plugins)
            .await
            .into_iter()
            .map(|skill| json!({ "name": skill.name, "description": skill.description, "source": skill.source }))
            .collect();
        for (skill, file) in bundled_skills() {
            if !skills
                .iter()
                .any(|item| text(item, "name").eq_ignore_ascii_case(skill))
            {
                let parsed = parse_skill(file, skill);
                skills.push(json!({ "name": parsed.name, "description": parsed.description, "source": "saturn" }));
            }
        }
        Ok(json!({ "skills": skills, "startWith": "research-autopilot" }))
    }

    /// What can be read about a project's research.
    async fn research_read(&self, project: &str, arguments: &Value) -> Result<Value, String> {
        let run = || needed(arguments, "run");
        match needed(arguments, "what")? {
            "status" => self.research_status(project).await,
            "list" => self
                .research_list(project, needed(arguments, "collection")?)
                .await
                .map_err(said),
            "record" => self
                .research_record(
                    project,
                    needed(arguments, "collection")?,
                    needed(arguments, "id")?,
                )
                .await
                .map_err(said),
            "runs" => self.research_runs(project).await.map_err(said),
            "run" => self.research_run(project, run()?).await.map_err(said),
            "summary" => self.research_summary(project, run()?).await.map_err(said),
            "samples" => {
                let cursor = arguments.get("cursor").and_then(Value::as_u64).unwrap_or(0);
                let limit = arguments
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(10)
                    .clamp(1, SAMPLES_READ) as usize;
                let only = Some(text(arguments, "only")).filter(|only| !only.is_empty());
                self.research_samples(project, run()?, cursor, Some(limit), only)
                    .await
                    .map_err(said)
            }
            "log" => {
                let stream = match text(arguments, "stream") {
                    "" => "stdout",
                    stream => stream,
                };
                self.research_run_log(project, run()?, stream)
                    .await
                    .map_err(said)
            }
            "resources" => self
                .research_resources(project, run()?)
                .await
                .map(newest_readings)
                .map_err(said),
            "labels" => self.research_labels(project, run()?).await.map_err(said),
            "compare" => self
                .research_compare(
                    project,
                    needed(arguments, "left")?,
                    needed(arguments, "right")?,
                )
                .await
                .map_err(said),
            "sample_across" => {
                let runs = strings(arguments, "runs");
                let runs: Vec<&str> = runs.iter().map(String::as_str).collect();
                self.research_sample_across(project, needed(arguments, "sample")?, &runs)
                    .await
                    .map_err(said)
            }
            "events" => self.research_events(project).await.map_err(said),
            "environment" => self.research_environment(project).await.map_err(said),
            "policy" => self.research_policy(project).await.map_err(said),
            "inside_list" => self
                .research_inside_list(project, run()?)
                .await
                .map_err(said),
            "inside" => {
                let request = json!({ "sampleId": text(arguments, "sample"), "modelId": arguments.get("model") });
                self.research_inside_saved(project, run()?, &request)
                    .await
                    .map_err(said)
            }
            other => Err(format!("Nothing to read called \"{other}\".")),
        }
    }

    /// Where a project's research stands, in one answer: what is open and what has happened.
    async fn research_status(&self, project: &str) -> Result<Value, String> {
        let items = async |collection: &str| -> Result<Vec<Value>, String> {
            let list = self
                .research_list(project, collection)
                .await
                .map_err(said)?;
            Ok(list
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default())
        };
        let brief = |item: &Value, keys: &[&str]| {
            let mut kept = json!({ "id": text(item, "id") });
            for key in keys {
                if let Some(value) = item.get(*key) {
                    kept[*key] = value.clone();
                }
            }
            kept
        };
        let list = |records: Vec<Value>, keys: &[&str]| -> Vec<Value> {
            records.iter().map(|item| brief(item, keys)).collect()
        };
        let runs = self.research_runs(project).await.map_err(said)?;
        let runs: Vec<Value> = runs
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let events = self.research_events(project).await.map_err(said)?;
        Ok(json!({
            "questions": list(items("questions").await?, &["title", "revision"]),
            "hypotheses": list(items("hypotheses").await?, &["title", "verdict", "questionId"]),
            "experiments": list(items("experiments").await?, &["title", "command", "hypothesisId", "revision"]),
            "versions": list(items("versions").await?, &["experimentId", "number"]),
            "models": list(items("models").await?, &["name", "source", "weightsRevision", "floating", "parentId"]),
            "runs": list(runs, &["versionId", "experimentId", "status", "samples", "error", "warnings", "inputsChanged"]),
            "findings": list(items("findings").await?, &["kind", "text", "runIds"]),
            "events": events.get("items").and_then(Value::as_array).map_or(0, Vec::len),
        }))
    }

    /// Holds the turn until a run ends, or for as long as it was told, or until the turn is stopped.
    async fn research_wait(
        &self,
        project: &str,
        arguments: &Value,
        turn: &Value,
    ) -> Result<Value, String> {
        let id = needed(arguments, "run")?;
        let seconds = arguments
            .get("seconds")
            .and_then(Value::as_u64)
            .unwrap_or(LONGEST_WAIT)
            .clamp(1, LONGEST_WAIT);
        let deadline = Instant::now() + Duration::from_secs(seconds);
        let turn_id = text(turn, "id");
        let run = loop {
            let run = self.research_run(project, id).await.map_err(said)?;
            let stopped = self.find_run(turn_id).is_none_or(|current| {
                matches!(
                    text(&current, "status"),
                    "cancelled" | "failed" | "completed"
                )
            });
            if !is_active(text(&run, "status")) || stopped || Instant::now() >= deadline {
                break run;
            }
            tokio::time::sleep(WAIT_STEP).await;
        };
        let ended = !is_active(text(&run, "status"));
        let mut answer = json!({ "run": run, "ended": ended });
        if ended {
            answer["summary"] = self
                .research_summary(project, id)
                .await
                .unwrap_or(Value::Null);
        } else {
            answer["resources"] = self
                .research_resources(project, id)
                .await
                .map(newest_readings)
                .unwrap_or(Value::Null);
        }
        Ok(answer)
    }

    /// Makes or changes a record, under the rules for what an agent may write.
    async fn research_write(&self, project: &str, arguments: &Value) -> Result<Value, String> {
        let collection = needed(arguments, "collection")?;
        let fields = arguments
            .get("fields")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let id = text(arguments, "id");
        if id.is_empty() {
            let record = agent_record(collection, &fields)?;
            return self
                .research_create(project, collection, &record)
                .await
                .map_err(said);
        }
        let current = self
            .research_record(project, collection, id)
            .await
            .map_err(said)?;
        let mut changes = agent_change(collection, &current, &fields)?;
        changes["expectedRevision"] = arguments
            .get("expectedRevision")
            .cloned()
            .ok_or("A change needs the \"expectedRevision\" of the record you read.")?;
        self.research_update(project, collection, id, &changes)
            .await
            .map_err(said)
    }

    /// Freezes an experiment, or starts or stops a run, from the folder the chat works in.
    async fn research_run_action(
        self: &Arc<Self>,
        project: &str,
        arguments: &Value,
        turn: &Value,
    ) -> Result<Value, String> {
        let thread = Some(text(turn, "threadId")).filter(|thread| !thread.is_empty());
        match needed(arguments, "action")? {
            "freeze" => {
                let (version, new) = self
                    .research_freeze(project, needed(arguments, "experiment")?, thread)
                    .await
                    .map_err(said)?;
                // Freezing ends lifted locks, which changes the policy: that is this call, not something unexplained.
                self.research_forget_baseline(turn);
                Ok(json!({ "version": version, "new": new }))
            }
            "start" => {
                let version = needed(arguments, "version")?;
                // The same attempt of the same version in one turn starts once, however often the call is repeated.
                let attempt = arguments
                    .get("attempt")
                    .and_then(Value::as_u64)
                    .unwrap_or(1);
                let client = format!("assistant-{}-{version}-{attempt}", text(turn, "id"));
                let (run, new) = self
                    .research_start_run(project, version, &client, thread)
                    .await
                    .map_err(said)?;
                Ok(json!({ "run": run, "new": new }))
            }
            "stop" => self
                .research_stop_run(project, needed(arguments, "run")?)
                .await
                .map_err(said),
            other => Err(format!("research_run has no action \"{other}\".")),
        }
    }

    /// Sets up the project's Python.
    async fn research_environment_action(
        self: &Arc<Self>,
        project: &str,
        arguments: &Value,
    ) -> Result<Value, String> {
        match needed(arguments, "action")? {
            "set" => self.research_set_environment(project, arguments).await,
            "check" => self.research_check_environment(project).await,
            "create" => self.research_create_environment(project, arguments).await,
            "install" => self.research_install_packages(project, arguments).await,
            "stop" => self.research_stop_environment_job(project).await,
            other => {
                return Err(format!(
                    "research_environment_action has no action \"{other}\"."
                ));
            }
        }
        .map_err(said)
    }

    /// Reads a model's activations on a sample, patches a layer in from another model, or sweeps the layers.
    async fn research_inspect(&self, project: &str, arguments: &Value) -> Result<Value, String> {
        let run = needed(arguments, "runId")?;
        match needed(arguments, "action")? {
            "activations" => self.research_look_inside(project, run, arguments).await,
            "patch" => {
                if arguments.get("layer").and_then(Value::as_u64).is_none() {
                    return Err("A patch names a \"layer\".".to_owned());
                }
                self.research_look_inside(project, run, arguments).await
            }
            "sweep" => self.research_sweep(project, arguments).await,
            other => return Err(format!("research_inspect has no action \"{other}\".")),
        }
        .map_err(said)
    }
}
