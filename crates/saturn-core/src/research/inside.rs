//! Looking inside a model on one sample: activations read through the unembedding, and one layer patched in from
//! another model. The work is done by a Python helper in the project's own environment, and the answer is saved with
//! the run. `docs/research-contract.md` says the shapes.
use std::path::PathBuf;
use std::process::Stdio;

use saturn_domain::research::{SCHEMA_VERSION, is_id, sha256_hex};
use saturn_domain::time::{iso_time, now_millis};
use saturn_tools::launch_env;
use serde_json::{Value, json};
use tokio::process::Command;

use super::labels::each_sample;
use super::{pretty, read_record, write_whole};
use crate::records::text;
use crate::{CoreError, Kernel};

/// The helper that reads and patches a model. It goes to the interpreter on standard input.
const HELPER: &str = include_str!("inside.py");
/// The folder in a run's directory where its answers are kept.
const FOLDER: &str = "inside";

/// The model a request is about: `modelId`, or an intervention's `targetModelId`.
fn asked_model(request: &Value) -> Option<&str> {
    request
        .get("modelId")
        .or_else(|| request.get("targetModelId"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

/// The weights a model record names, as the helper loads them.
fn weights_of(model: &Value) -> Value {
    json!({ "source": text(model, "source"), "revision": model.get("weightsRevision") })
}

/// The weights a version names for a model. A version pins what the experiment bound; a model it did not bind is
/// looked up in the project's models, where its revision may still float.
fn weights(version: &Value, model_id: &str) -> Option<Value> {
    version
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|model| text(model, "modelId") == model_id)
        .map(weights_of)
}

impl Kernel {
    /// What was saved for a request, if anything.
    pub async fn research_inside_saved(
        &self,
        project: &str,
        run: &str,
        request: &Value,
    ) -> Result<Value, CoreError> {
        let (directory, _) = self.inside_place(project, run, request).await?;
        read_record(&directory)
            .await
            .map_err(|reason| CoreError::new(422, reason))?
            .ok_or_else(|| CoreError::new(404, "Nothing has been recorded for this sample yet."))
    }

    /// Reads a model's activations on a sample, and patches a layer in from another model when asked, in the project's
    /// Python. The answer is saved with the run and given again without running when asked the same thing.
    pub async fn research_look_inside(
        &self,
        project: &str,
        run_id: &str,
        request: &Value,
    ) -> Result<Value, CoreError> {
        if cfg!(windows) {
            return Err(CoreError::new(
                501,
                "Looking inside a model is not supported on Windows yet.",
            ));
        }
        let (file, key) = self.inside_place(project, run_id, request).await?;
        if let Some(saved) = read_record(&file)
            .await
            .map_err(|reason| CoreError::new(422, reason))?
        {
            return Ok(saved);
        }
        let run = self.research_run(project, run_id).await?;
        let version = self
            .research_record(project, "versions", text(&run, "versionId"))
            .await?;
        // The Python the experiment itself runs with, so the model loads in the same environment.
        let python = match super::environment::python_of(text(&version, "command")) {
            Some(python) => python.to_owned(),
            None => self.research_python(project).await?,
        };
        let sample = self.inside_sample(project, &run, request).await?;
        let model_id = asked_model(request)
            .map(str::to_owned)
            .or_else(|| {
                sample
                    .get("modelId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .ok_or_else(|| {
                CoreError::new(
                    422,
                    "The sample names no model, so there is nothing to load.",
                )
            })?;
        let mut ask = json!({
            "sampleId": text(&sample, "sampleId"),
            "modelId": model_id,
            "input": sample.get("input"),
            "expected": sample.get("expected"),
            "target": self.model_weights(project, &version, &model_id).await?,
        });
        if let Some(layer) = request.get("layer").and_then(Value::as_u64) {
            let source_id = text(request, "sourceModelId");
            ask["patch"] = json!({ "layer": layer, "modelId": source_id, "source": self.model_weights(project, &version, source_id).await? });
        }
        if !ask["input"].is_string() {
            return Err(CoreError::new(
                422,
                "The sample's input is not text, so the model cannot be run on it.",
            ));
        }

        let source = self.research_source(project, None)?;
        let working_folder = source.join(text(&version, "cwd"));
        let mut command = Command::new(&python);
        launch_env(&mut command);
        for (name, _) in std::env::vars_os() {
            if name.to_string_lossy().starts_with("SATURN_") {
                command.env_remove(&name);
            }
        }
        let output = command
            .args(["-", &ask.to_string()])
            .current_dir(&working_folder)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| CoreError::new(422, format!("{python} could not start: {error}")))?;
        let output = feed(output, HELPER).await?;
        let log = String::from_utf8_lossy(&output.stderr);
        if !output.status.success() {
            let tail: String = log
                .lines()
                .rev()
                .take(12)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n");
            return Err(CoreError::new(
                422,
                format!("The helper ended with {}.\n{tail}", output.status),
            ));
        }
        let mut answer: Value = serde_json::from_slice(&output.stdout).map_err(|error| {
            CoreError::new(
                422,
                format!("The helper's answer could not be read: {error}"),
            )
        })?;
        answer["schemaVersion"] = json!(SCHEMA_VERSION);
        answer["request"] = request.clone();
        answer["key"] = json!(key);
        answer["recordedAt"] = json!(iso_time(now_millis()));
        if let Some(parent) = file.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        write_whole(&file, &pretty(&answer)?).await?;
        self.research_changed();
        Ok(answer)
    }

    /// Where a model's weights are: as the version pinned them, else as the project's model record says.
    async fn model_weights(
        &self,
        project: &str,
        version: &Value,
        model_id: &str,
    ) -> Result<Value, CoreError> {
        if let Some(found) = weights(version, model_id) {
            return Ok(found);
        }
        if !is_id(model_id) {
            return Err(CoreError::new(422, "The request names no model."));
        }
        let model = self
            .research_record(project, "models", model_id)
            .await
            .map_err(|_| CoreError::new(422, format!("No model {model_id} is recorded in this project, so there is nothing to load.")))?;
        Ok(weights_of(&model))
    }

    /// Where a request's answer lives in the run's folder, and the key that names it.
    async fn inside_place(
        &self,
        project: &str,
        run: &str,
        request: &Value,
    ) -> Result<(PathBuf, String), CoreError> {
        if !is_id(run) {
            return Err(CoreError::new(404, "No such run"));
        }
        let records = self.records_folder(project).await?;
        let key = sha256_hex(
            json!({
                "sampleId": request.get("sampleId"),
                "modelId": asked_model(request),
                "sourceModelId": request.get("sourceModelId"),
                "layer": request.get("layer"),
            })
            .to_string()
            .as_bytes(),
        );
        let file = records
            .join("runs")
            .join(run)
            .join(FOLDER)
            .join(format!("{}.json", &key[..16]));
        Ok((file, key))
    }

    /// The sample line a request names, from the run's samples file.
    async fn inside_sample(
        &self,
        project: &str,
        run: &Value,
        request: &Value,
    ) -> Result<Value, CoreError> {
        let records = self.records_folder(project).await?;
        let path = records
            .join("runs")
            .join(text(run, "id"))
            .join("samples.jsonl");
        let end = run.get("samplesSize").and_then(Value::as_u64);
        let wanted = text(request, "sampleId").to_owned();
        let model = asked_model(request).map(str::to_owned);
        if wanted.is_empty() {
            return Err(CoreError::new(400, "A request names a \"sampleId\"."));
        }
        let found = tokio::task::spawn_blocking(move || {
            let mut found = None;
            each_sample(&path, end, |value, _| {
                let same_model = model
                    .as_deref()
                    .is_none_or(|id| value.get("modelId").and_then(Value::as_str) == Some(id));
                if found.is_none() && text(value, "sampleId") == wanted && same_model {
                    found = Some(value.clone());
                }
            })?;
            Ok::<_, std::io::Error>(found)
        })
        .await
        .map_err(|error| CoreError::new(500, error.to_string()))??;
        found.ok_or_else(|| CoreError::new(404, "The run has no such sample."))
    }
}

/// Writes the helper to the process and waits for everything it says.
async fn feed(
    mut child: tokio::process::Child,
    helper: &str,
) -> Result<std::process::Output, CoreError> {
    if let Some(mut stdin) = child.stdin.take() {
        tokio::io::AsyncWriteExt::write_all(&mut stdin, helper.as_bytes()).await?;
        drop(stdin);
    }
    Ok(child.wait_with_output().await?)
}
