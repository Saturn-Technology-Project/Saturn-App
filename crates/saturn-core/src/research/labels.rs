//! A person's labels on a run's samples, kept apart from its scores, and one sample across runs.
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use saturn_domain::research::{
    MAX_SAMPLE_LINE, SCHEMA_VERSION, compare_versions, is_id, sample_identity,
};
use saturn_domain::time::{iso_time, now_millis};
use serde_json::{Value, json};

use super::{pretty, read_record, write_whole};
use crate::records::text;
use crate::{CoreError, Kernel};

/// Calls `visit` with each valid sample a sealed or running file holds, without holding the file in memory.
fn each_sample(
    path: &Path,
    end: Option<u64>,
    mut visit: impl FnMut(&Value, &str),
) -> std::io::Result<()> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let end = end.unwrap_or(file.metadata()?.len());
    let mut reader = BufReader::new(file);
    let mut offset = 0;
    let mut line = Vec::new();
    while offset < end {
        line.clear();
        let room = (end - offset).min(MAX_SAMPLE_LINE + 1);
        let read = (&mut reader).take(room).read_until(b'\n', &mut line)? as u64;
        if read == 0 || line.last() != Some(&b'\n') {
            return Ok(());
        }
        offset += read;
        if let Ok(value) = serde_json::from_slice::<Value>(&line)
            && let Ok(identity) = sample_identity(&value)
        {
            visit(&value, &identity);
        }
    }
    Ok(())
}

/// The identity a label request names, the same way a sample line would.
fn requested_identity(request: &Value) -> Result<String, CoreError> {
    let line = json!({
        "schemaVersion": 1,
        "sampleId": request.get("sampleId"),
        "trial": request.get("trial").cloned().unwrap_or_else(|| json!(0)),
        "modelId": request.get("modelId"),
    });
    sample_identity(&line).map_err(|message| CoreError::new(400, message))
}

impl Kernel {
    /// A run's labels and how far they agree with its scorer.
    pub async fn research_labels(&self, project: &str, run: &str) -> Result<Value, CoreError> {
        let found = self.research_run(project, run).await?;
        let records = self.records_folder(project).await?;
        let saved = read_labels(&records, run).await?;
        let labels = saved.get("labels").cloned().unwrap_or_else(|| json!({}));
        let path = records.join("runs").join(run).join("samples.jsonl");
        let end = found.get("samplesSize").and_then(Value::as_u64);
        let wanted = labels.clone();
        let agreement =
            tokio::task::spawn_blocking(move || agreement_with_scorer(&path, end, &wanted))
                .await
                .map_err(|error| CoreError::new(500, error.to_string()))??;
        Ok(json!({ "runId": run, "labels": labels, "agreement": agreement }))
    }

    /// Saves a person's label on one sample. It never touches the sample's score.
    pub async fn research_set_label(
        &self,
        project: &str,
        run: &str,
        request: &Value,
    ) -> Result<Value, CoreError> {
        let label = text(request, "label");
        if label.trim().is_empty() {
            return Err(CoreError::new(400, "A label needs its \"label\"."));
        }
        let identity = requested_identity(request)?;
        self.research_run(project, run).await?;
        let records = self.records_for_writing(project).await?;
        let folder = records.join("labels");
        if super::is_link(&folder).await {
            return Err(CoreError::new(
                409,
                "The labels folder is a symbolic link, which Saturn does not follow.",
            ));
        }
        tokio::fs::create_dir_all(&folder).await?;
        let lock = self.records_lock(&records);
        let _writing = lock.lock().await;
        let mut saved = read_labels(&records, run).await?;
        saved["labels"][&identity] = json!({
            "sampleId": request.get("sampleId"),
            "trial": request.get("trial").cloned().unwrap_or_else(|| json!(0)),
            "modelId": request.get("modelId"),
            "label": label,
            "note": request.get("note"),
            "updatedAt": iso_time(now_millis()),
        });
        write_whole(&folder.join(format!("{run}.json")), &pretty(&saved)?).await?;
        self.research_changed();
        Ok(saved["labels"][&identity].clone())
    }

    /// What a run's samples add up to for each model: how many, how many errors of each kind, and each score's mean.
    /// Only number and true-or-false scores have a mean; text scores are counted.
    pub async fn research_summary(&self, project: &str, run: &str) -> Result<Value, CoreError> {
        let found = self.research_run(project, run).await?;
        let records = self.records_folder(project).await?;
        let path = records.join("runs").join(run).join("samples.jsonl");
        let end = found.get("samplesSize").and_then(Value::as_u64);
        let models = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<Value>> {
            let mut models: BTreeMap<String, ModelTally> = BTreeMap::new();
            each_sample(&path, end, |value, _| {
                models
                    .entry(text(value, "modelId").to_owned())
                    .or_default()
                    .add(value);
            })?;
            Ok(models
                .into_iter()
                .map(|(model, tally)| tally.into_json(&model))
                .collect())
        })
        .await
        .map_err(|error| CoreError::new(500, error.to_string()))??;
        Ok(
            json!({ "runId": run, "versionId": text(&found, "versionId"), "status": text(&found, "status"), "models": models }),
        )
    }

    /// One sample in several runs, each with whether its evaluation compares to the first run's.
    pub async fn research_sample_across(
        &self,
        project: &str,
        sample: &str,
        runs: &[&str],
    ) -> Result<Value, CoreError> {
        let records = self.records_folder(project).await?;
        let mut rows = Vec::new();
        let mut first_version: Option<Value> = None;
        for run_id in runs {
            let run = self.research_run(project, run_id).await?;
            let version = self
                .research_record(project, "versions", text(&run, "versionId"))
                .await?;
            let comparison = match &first_version {
                None => json!({ "result": "comparable", "differs": [], "missing": [] }),
                Some(first) => compare_versions(first, &version),
            };
            if first_version.is_none() {
                first_version = Some(version.clone());
            }
            let path = records.join("runs").join(run_id).join("samples.jsonl");
            let end = run.get("samplesSize").and_then(Value::as_u64);
            let wanted = sample.to_owned();
            let matched = tokio::task::spawn_blocking(move || {
                let mut matched = Vec::new();
                each_sample(&path, end, |value, _| {
                    if text(value, "sampleId") == wanted {
                        matched.push(value.clone());
                    }
                })?;
                Ok::<_, std::io::Error>(matched)
            })
            .await
            .map_err(|error| CoreError::new(500, error.to_string()))??;
            rows.push(json!({
                "runId": run_id,
                "versionId": text(&run, "versionId"),
                "status": text(&run, "status"),
                "models": version.get("models"),
                "comparison": comparison,
                "samples": matched,
            }));
        }
        Ok(json!({ "sampleId": sample, "rows": rows }))
    }
}

/// What one model's samples in a run add up to.
#[derive(Default)]
struct ModelTally {
    samples: u64,
    errors: BTreeMap<String, u64>,
    scores: BTreeMap<String, (f64, u64, u64)>,
}

impl ModelTally {
    /// Counts one sample. A sample with an infrastructure error has no score worth averaging, even if it wrote one.
    fn add(&mut self, sample: &Value) {
        self.samples += 1;
        let error = sample.pointer("/error/kind").and_then(Value::as_str);
        if let Some(kind) = error {
            *self.errors.entry(kind.to_owned()).or_default() += 1;
        }
        if error == Some("infrastructure") {
            return;
        }
        for (name, score) in sample
            .get("scores")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            let entry = self.scores.entry(name.clone()).or_default();
            let number = score
                .as_f64()
                .or_else(|| score.as_bool().map(|yes| f64::from(u8::from(yes))));
            match number {
                Some(number) if number.is_finite() => {
                    entry.0 += number;
                    entry.1 += 1;
                }
                _ => entry.2 += 1,
            }
        }
    }

    fn into_json(self, model: &str) -> Value {
        let scores: serde_json::Map<String, Value> = self
            .scores
            .into_iter()
            .map(|(name, (sum, count, other))| {
                let mean = (count > 0).then(|| sum / count as f64);
                (
                    name,
                    json!({ "mean": mean, "count": count, "notNumbers": other }),
                )
            })
            .collect();
        json!({
            "modelId": (!model.is_empty()).then_some(model),
            "samples": self.samples,
            "errors": self.errors,
            "scores": scores,
        })
    }
}

/// A run's labels file, or an empty one.
async fn read_labels(records: &Path, run: &str) -> Result<Value, CoreError> {
    if !is_id(run) {
        return Err(CoreError::new(404, "No such run"));
    }
    let path = records.join("labels").join(format!("{run}.json"));
    let saved = read_record(&path)
        .await
        .map_err(|reason| super::cannot_use(run, &reason))?;
    Ok(saved
        .unwrap_or_else(|| json!({ "schemaVersion": SCHEMA_VERSION, "runId": run, "labels": {} })))
}

/// How many labels can be compared with a scorer's own label, and how many agree. A sample without a `scorerLabel`,
/// or a label on a sample this run does not hold, is not counted as agreeing or disagreeing.
fn agreement_with_scorer(
    path: &Path,
    end: Option<u64>,
    labels: &Value,
) -> Result<Value, CoreError> {
    let wanted: HashMap<&String, &str> = labels
        .as_object()
        .into_iter()
        .flatten()
        .map(|(identity, entry)| (identity, text(entry, "label")))
        .collect();
    let mut compared = 0;
    let mut agreed = 0;
    each_sample(path, end, |value, identity| {
        if let Some(label) = wanted.get(&identity.to_owned())
            && let Some(scored) = value.get("scorerLabel").and_then(Value::as_str)
        {
            compared += 1;
            if *label == scored {
                agreed += 1;
            }
        }
    })?;
    Ok(json!({ "labeled": wanted.len(), "compared": compared, "agreed": agreed }))
}
