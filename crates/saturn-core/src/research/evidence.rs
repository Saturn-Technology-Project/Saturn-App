//! A run's evidence, in `runs/<id>/evidence.json`, kept apart from its status in `run.json`: what the version
//! expected, what Saturn observed while running it, and what the program reported about itself. Nothing reported is
//! filled in from what was expected, and each of the three verdicts says how far it goes.
use std::path::Path;

use saturn_domain::time::{iso_time, now_millis};
use serde_json::{Map, Value, json};

use super::{pretty, write_whole};
use crate::records::text;

/// The evidence file in a run's folder.
pub(super) const EVIDENCE: &str = "evidence.json";
/// What a run's program may write about itself, one JSON object per line.
pub(super) const REPORT: &str = "report.jsonl";
/// The longest report Saturn reads; a longer one is read up to here and marked cut short.
const REPORT_LIMIT: u64 = 1024 * 1024;
/// What every evidence file says about what hashes can and cannot show.
pub(super) const LIMITS: &str = "A hash confirms which content a file had. It does not show that the program used that content, or that the scorer or the conclusion is right.";

/// What the version expected, in brief.
fn expected(version: &Value) -> Value {
    let pick = |field: &str| version.get(field).cloned().unwrap_or(Value::Null);
    json!({
        "versionId": pick("id"),
        "fingerprint": pick("fingerprint"),
        "command": pick("command"),
        "cwd": pick("cwd"),
        "commit": version.pointer("/git/commit").cloned().unwrap_or(Value::Null),
        "inputs": pick("inputs"),
        "models": pick("models"),
        "seeds": pick("seeds"),
        "resumeFrom": pick("resumeFrom"),
    })
}

/// The evidence a run starts with: expected and observed, and nothing reported yet.
pub(super) fn starting(version: &Value, snapshot: &Value, seeds: &[String]) -> Value {
    json!({
        "schemaVersion": 1,
        "limits": LIMITS,
        "expected": expected(version),
        "observed": {
            "executor": "local",
            "platform": format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
            "command": text(version, "command"),
            "cwd": text(version, "cwd"),
            "seedsPassed": seeds,
            "snapshot": snapshot,
            "startedAt": iso_time(now_millis()),
        },
        "reported": unreported(),
        "outputs": Value::Null,
        "verdicts": {
            "execution": "running",
            "inputs": inputs_verdict(snapshot, None),
            "outputs": "pending",
        },
    })
}

/// Evidence for a run refused before it started, with why.
pub(super) fn refused(version: &Value, reason: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "limits": LIMITS,
        "expected": expected(version),
        "observed": { "executor": "local", "refusedAt": iso_time(now_millis()), "refused": reason },
        "reported": unreported(),
        "outputs": Value::Null,
        "verdicts": { "execution": "not started", "inputs": "changed", "outputs": "none" },
    })
}

/// Nothing the program has said: every field unknown.
fn unreported() -> Value {
    json!({ "seed": null, "models": [], "config": null, "resume": null, "lines": 0, "problems": [] })
}

/// What the program reported in its report file. A line it did not write stays unknown.
pub(super) async fn read_report(directory: &Path) -> Value {
    use tokio::io::AsyncReadExt;
    let mut reported = unreported();
    let Ok(file) = tokio::fs::File::open(directory.join(REPORT)).await else {
        return reported;
    };
    let mut content = String::new();
    let mut reader = file.take(REPORT_LIMIT + 1);
    if reader.read_to_string(&mut content).await.is_err() {
        reported["problems"] = json!(["The report is not UTF-8 text."]);
        return reported;
    }
    let mut problems = Vec::new();
    if content.len() as u64 > REPORT_LIMIT {
        problems.push("The report is longer than 1 MiB; only its start was read.".to_owned());
        content.truncate(REPORT_LIMIT as usize);
    }
    let mut models = Vec::new();
    let mut lines = 0;
    for (number, line) in content.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(Value::Object(item)) = serde_json::from_str::<Value>(line) else {
            problems.push(format!("Line {} is not a JSON object.", number + 1));
            continue;
        };
        lines += 1;
        let mut item: Map<String, Value> = item;
        let kind = item
            .remove("kind")
            .and_then(|kind| kind.as_str().map(str::to_owned))
            .unwrap_or_default();
        match kind.as_str() {
            "seed" => reported["seed"] = Value::Object(item),
            "model" => models.push(Value::Object(item)),
            "config" => reported["config"] = Value::Object(item),
            "resume" => reported["resume"] = Value::Object(item),
            other => problems.push(format!(
                "Line {} has an unknown kind \"{other}\".",
                number + 1
            )),
        }
    }
    reported["models"] = json!(models);
    reported["lines"] = json!(lines);
    reported["problems"] = json!(problems);
    reported
}

/// How far the inputs were verified: all controlled and unchanged, some uncontrolled, changed, or not checked.
pub(super) fn inputs_verdict(snapshot: &Value, closed: Option<&Value>) -> &'static str {
    if snapshot.get("files").is_none() {
        return "unverified";
    }
    if let Some(closed) = closed {
        if closed["checked"] != true {
            return "unverified";
        }
        if closed["changed"]
            .as_array()
            .is_some_and(|changed| !changed.is_empty())
        {
            return "changed";
        }
    }
    let uncontrolled = snapshot["uncontrolled"]
        .as_array()
        .is_some_and(|items| !items.is_empty());
    let linked = snapshot["inputs"]
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item["how"] == "linked"));
    if uncontrolled || linked {
        "partial"
    } else {
        "verified"
    }
}

/// Whether the outputs are whole and sealed, for a run with this status.
fn outputs_verdict(status: &str, run: &Value) -> &'static str {
    if run.get("samplesSha256").is_none() {
        return "none";
    }
    if status == "completed" {
        "sealed"
    } else {
        "incomplete"
    }
}

/// Completes the evidence when the run has ended, however it ended.
pub(super) async fn finish(directory: &Path, run: &Value, closed: Option<&Value>) {
    let file = directory.join(EVIDENCE);
    let Ok(Some(mut evidence)) = super::read_record(&file).await else {
        return;
    };
    let status = text(run, "status").to_owned();
    if let Some(closed) = closed {
        evidence["observed"]["afterRun"] = closed.clone();
    }
    evidence["observed"]["endedAt"] = json!(iso_time(now_millis()));
    evidence["observed"]["exitCode"] = run.get("exitCode").cloned().unwrap_or(Value::Null);
    evidence["reported"] = read_report(directory).await;
    evidence["outputs"] = json!({
        "samplesSha256": run.get("samplesSha256").cloned().unwrap_or(Value::Null),
        "samplesSize": run.get("samplesSize").cloned().unwrap_or(Value::Null),
        "samples": run.get("samples").cloned().unwrap_or(Value::Null),
    });
    let inputs = inputs_verdict(&evidence["observed"]["snapshot"], closed);
    evidence["verdicts"] = json!({
        "execution": status,
        "inputs": inputs,
        "outputs": outputs_verdict(&status, run),
    });
    if let Ok(text) = pretty(&evidence) {
        let _ = write_whole(&file, &text).await;
    }
}

impl crate::Kernel {
    /// A run's evidence, with whether its sealed samples still match. A run from before evidence was kept has none.
    pub async fn research_run_evidence(
        &self,
        project: &str,
        id: &str,
    ) -> Result<Value, crate::CoreError> {
        let run = self.research_run(project, id).await?;
        let records = self.records_folder(project).await?;
        let file = records.join("runs").join(id).join(EVIDENCE);
        let Some(mut evidence) = super::read_record(&file)
            .await
            .map_err(|reason| super::cannot_use(id, &reason))?
        else {
            return Ok(json!({ "recorded": false, "limits": LIMITS }));
        };
        evidence["recorded"] = json!(true);
        if run["sealIntact"] == false {
            evidence["verdicts"]["outputs"] = json!("changed");
        }
        Ok(evidence)
    }
}

/// Writes a run's evidence file.
pub(super) async fn write(directory: &Path, evidence: &Value) -> Result<(), crate::CoreError> {
    write_whole(&directory.join(EVIDENCE), &pretty(evidence)?).await
}
