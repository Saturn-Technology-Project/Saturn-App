//! A person's labels on a run's samples, kept apart from its scores, and one sample across runs.
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, PoisonError};
use std::time::SystemTime;

use saturn_domain::research::{
    MAX_SAMPLE_LINE, SCHEMA_VERSION, compare_versions, is_id, labels_agree, sample_identity,
};
use saturn_domain::time::{iso_time, now_millis};
use serde_json::{Value, json};

use super::{pretty, read_record, write_whole};
use crate::records::text;
use crate::{CoreError, Kernel};

/// Calls `visit` with each valid sample a sealed or running file holds, without holding the file in memory.
pub(super) fn each_sample(
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

/// The most sealed runs whose digests are kept. Going past it starts over, which only costs reading them again.
const MOST_DIGESTS: usize = 64;

/// What a run's samples add up to, in one pass: what its summary says, and each scorer's word to compare labels with.
#[derive(Debug)]
pub struct RunDigest {
    /// The file as it was when read: a changed file does not answer from here.
    stamp: (u64, Option<SystemTime>, Option<u64>),
    models: Vec<Value>,
    scorer_words: Vec<(String, String)>,
}

/// Reads a samples file through once.
fn digest_samples(
    path: &Path,
    end: Option<u64>,
    stamp: (u64, Option<SystemTime>, Option<u64>),
) -> std::io::Result<RunDigest> {
    let mut models: BTreeMap<String, ModelTally> = BTreeMap::new();
    let mut scorer_words = Vec::new();
    each_sample(path, end, |value, identity| {
        models
            .entry(text(value, "modelId").to_owned())
            .or_default()
            .add(value);
        if let Some(word) = value.get("scorerLabel").and_then(Value::as_str)
            && !word.trim().is_empty()
        {
            scorer_words.push((identity.to_owned(), word.to_owned()));
        }
    })?;
    let models = models
        .into_iter()
        .map(|(model, tally)| tally.into_json(&model))
        .collect();
    Ok(RunDigest {
        stamp,
        models,
        scorer_words,
    })
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
        let aliases = self.research_label_aliases(project, &found).await?;
        // With nothing labeled there is nothing to compare, so the samples need no reading.
        let digest = if labels.as_object().is_some_and(|labels| !labels.is_empty()) {
            Some(self.run_digest(path, end).await?)
        } else {
            None
        };
        let (labels, agreement) = agreement_with_scorer(digest.as_deref(), labels, &aliases);
        Ok(json!({ "runId": run, "labels": labels, "agreement": agreement }))
    }

    /// A run's digest. A sealed run's file does not change, so it is read once; a running one's is read each time.
    async fn run_digest(
        &self,
        path: PathBuf,
        end: Option<u64>,
    ) -> Result<Arc<RunDigest>, CoreError> {
        let stamp_of = |path: &Path| {
            std::fs::metadata(path).map_or((0, None, end), |file| {
                (file.len(), file.modified().ok(), end)
            })
        };
        let remembered = |kernel: &Self, stamp: &(u64, Option<SystemTime>, Option<u64>)| {
            kernel
                .run_digests
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(&path)
                .filter(|digest| digest.stamp == *stamp)
                .cloned()
        };
        let sealed = end.is_some();
        let _digesting = if sealed {
            if let Some(found) = remembered(self, &stamp_of(&path)) {
                return Ok(found);
            }
            let held = self.digesting.lock().await;
            if let Some(found) = remembered(self, &stamp_of(&path)) {
                return Ok(found);
            }
            Some(held)
        } else {
            None
        };
        let stamp = stamp_of(&path);
        let reading = path.clone();
        let digest = Arc::new(
            tokio::task::spawn_blocking(move || digest_samples(&reading, end, stamp))
                .await
                .map_err(|error| CoreError::new(500, error.to_string()))??,
        );
        if sealed {
            let mut digests = self
                .run_digests
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if digests.len() >= MOST_DIGESTS {
                digests.clear();
            }
            digests.insert(path, Arc::clone(&digest));
        }
        Ok(digest)
    }

    /// The experiment's current annotation vocabulary; it changes the comparison of labels, never the scorer's output.
    pub(super) async fn research_label_aliases(
        &self,
        project: &str,
        run: &Value,
    ) -> Result<Value, CoreError> {
        let records = self.records_folder(project).await?;
        let experiment = text(run, "experimentId");
        if !is_id(experiment) {
            return Ok(json!({}));
        }
        let record = read_record(
            &records
                .join("experiments")
                .join(format!("{experiment}.json")),
        )
        .await
        .map_err(|reason| super::cannot_use(experiment, &reason))?;
        Ok(record
            .and_then(|record| record.get("labelAliases").cloned())
            .unwrap_or_else(|| json!({})))
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
        let models = self.run_digest(path, end).await?.models.clone();
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
    /// Tokens the program reported under `usage`, added up: in, out, and how many samples said.
    tokens: (u64, u64, u64),
    /// The most device memory the program reported holding, in bytes.
    device_memory_peak: Option<u64>,
}

impl ModelTally {
    /// Counts one sample. A sample with an infrastructure error has no score worth averaging, even if it wrote one.
    fn add(&mut self, sample: &Value) {
        self.samples += 1;
        if let Some(usage) = sample.get("usage").and_then(Value::as_object) {
            let count = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
            self.tokens.0 += count("inputTokens");
            self.tokens.1 += count("outputTokens");
            if usage.contains_key("inputTokens") || usage.contains_key("outputTokens") {
                self.tokens.2 += 1;
            }
            if let Some(held) = usage.get("deviceMemoryBytes").and_then(Value::as_u64) {
                self.device_memory_peak =
                    Some(self.device_memory_peak.map_or(held, |peak| peak.max(held)));
            }
        }
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
            "tokens": { "input": self.tokens.0, "output": self.tokens.1, "samplesReporting": self.tokens.2 },
            "deviceMemoryPeakBytes": self.device_memory_peak,
        })
    }
}

/// A run's labels file, or an empty one.
pub(super) async fn read_labels(records: &Path, run: &str) -> Result<Value, CoreError> {
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
    digest: Option<&RunDigest>,
    mut labels: Value,
    aliases: &Value,
) -> (Value, Value) {
    let labeled = labels.as_object().map_or(0, |labels| labels.len());
    for entry in labels
        .as_object_mut()
        .into_iter()
        .flat_map(|labels| labels.values_mut())
    {
        if let Some(fields) = entry.as_object_mut() {
            fields.insert("agreesWithScorer".to_owned(), Value::Null);
        }
    }
    let mut compared = 0;
    let mut agreed = 0;
    for (identity, scored) in digest.map_or(&[][..], |digest| &digest.scorer_words) {
        if let Some(entry) = labels.get_mut(identity)
            && entry.is_object()
        {
            compared += 1;
            let same = labels_agree(text(entry, "label"), scored, aliases);
            entry["agreesWithScorer"] = json!(same);
            if same {
                agreed += 1;
            }
        }
    }
    (
        labels,
        json!({ "labeled": labeled, "compared": compared, "agreed": agreed }),
    )
}
