//! Looking inside a model on one sample: activations read through the unembedding, one layer patched in from another
//! model, and one layer read through a sparse autoencoder. The work is done by a Python helper in the project's own environment, and the answer is saved with
//! the run. `docs/research-contract.md` says the shapes.
use std::path::{Path, PathBuf};
use std::process::Stdio;

use saturn_domain::research::{SCHEMA_VERSION, is_id, sha256_hex};
use saturn_domain::time::{iso_time, now_millis};
use serde_json::{Value, json};

use super::labels::each_sample;
use super::{pretty, read_record, write_whole};
use crate::records::text;
use crate::{CoreError, Kernel};

/// The helper that reads and patches a model. It goes to the interpreter on standard input.
const HELPER: &str = include_str!("inside.py");
/// What prompts of the person's own are looked at with. It goes after the helper's functions, without its start, and apart
/// from it so that this does not mark results of the helper as made by an earlier one.
const PROMPTS_HELPER: &str = include_str!("inside_prompts.py");
/// What sparse-autoencoder features are read with, composed the same way, so that neither marks the other's results.
const FEATURES_HELPER: &str = include_str!("inside_features.py");
/// The longest prompt a request may carry, in characters. The helper limits its tokens.
const MAX_PROMPT: usize = 4000;
/// The folder in a run's directory where its answers are kept.
const FOLDER: &str = "inside";
/// How many samples one sweep takes, so one helper process stays minutes, not hours.
const MAX_SWEEP: usize = 32;

/// The model a request is about: `modelId`, or an intervention's `targetModelId`.
fn asked_model(request: &Value) -> Option<&str> {
    request
        .get("modelId")
        .or_else(|| request.get("targetModelId"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

/// The helper's functions without its start, for what is composed with them.
fn helper_functions() -> &'static str {
    HELPER.split("\nif __name__").next().unwrap_or(HELPER)
}

/// The whole program for prompts of the person's own.
fn prompts_helper() -> String {
    format!("{}\n{PROMPTS_HELPER}", helper_functions())
}

/// The whole program for sparse-autoencoder features.
fn features_helper() -> String {
    format!("{}\n{FEATURES_HELPER}", helper_functions())
}

/// The program that answers an inspection of a given action.
fn inspection_helper(action: &str) -> String {
    if action == "features" {
        features_helper()
    } else {
        prompts_helper()
    }
}

/// A required text of a request, with its length checked.
fn prompt_field<'a>(request: &'a Value, name: &str) -> Result<&'a str, CoreError> {
    let value = text(request, name);
    if value.trim().is_empty() {
        return Err(CoreError::new(400, format!("This names \"{name}\".")));
    }
    if value.chars().count() > MAX_PROMPT {
        return Err(CoreError::new(
            400,
            format!("\"{name}\" is longer than {MAX_PROMPT} characters."),
        ));
    }
    Ok(value)
}

/// Which SAE a request names: a release of SAELens and an id in it, or a folder of the project's or the person's own.
fn asked_sae(request: &Value) -> Result<Value, CoreError> {
    let (release, id, path) = (
        text(request, "saeRelease"),
        text(request, "saeId"),
        text(request, "saePath"),
    );
    if !path.is_empty() {
        if !release.is_empty() || !id.is_empty() {
            return Err(CoreError::new(
                400,
                "This names an SAE twice: a saeRelease and saeId, or a saePath, not both.",
            ));
        }
        return Ok(json!({ "path": prompt_field(request, "saePath")? }));
    }
    if release.is_empty() || id.is_empty() {
        return Err(CoreError::new(
            400,
            "This names an SAE: a saeRelease and saeId, or a saePath.",
        ));
    }
    Ok(json!({
        "release": prompt_field(request, "saeRelease")?,
        "id": prompt_field(request, "saeId")?,
    }))
}

/// What a request for features asks the helper, once it is known to make sense, without the weights.
fn features_question(request: &Value, model: &str) -> Result<Value, CoreError> {
    let layer = request
        .get("layer")
        .and_then(Value::as_u64)
        .ok_or_else(|| CoreError::new(400, "This names a \"layer\", a whole number."))?;
    let (expected, alternative) = (text(request, "expected"), text(request, "alternative"));
    if expected.is_empty() != alternative.is_empty() {
        return Err(CoreError::new(
            400,
            "A margin takes two words: name both expected and alternative, or neither.",
        ));
    }
    if !expected.is_empty() {
        prompt_field(request, "expected")?;
        prompt_field(request, "alternative")?;
        if expected == alternative {
            return Err(CoreError::new(
                400,
                "The expected word and its alternative are the same.",
            ));
        }
    }
    let ablate = match request.get("ablate") {
        None | Some(Value::Null) => None,
        Some(feature) => Some(feature.as_u64().ok_or_else(|| {
            CoreError::new(400, "\"ablate\" names a feature by its whole number.")
        })?),
    };
    if ablate.is_some() && expected.is_empty() {
        return Err(CoreError::new(
            400,
            "Ablating a feature is read by the margin between two words: name expected and alternative.",
        ));
    }
    Ok(json!({
        "action": "features",
        "modelId": model,
        "prompt": prompt_field(request, "prompt")?,
        "layer": layer,
        "sae": asked_sae(request)?,
        "expected": Some(expected).filter(|word| !word.is_empty()),
        "alternative": Some(alternative).filter(|word| !word.is_empty()),
        "ablate": ablate,
    }))
}

/// What a request about prompts asks the helper, once it is known to make sense, without the weights.
fn prompts_question(request: &Value) -> Result<Value, CoreError> {
    let model = prompt_field(request, "modelId")?;
    match text(request, "action") {
        "compare" => {
            let other = prompt_field(request, "otherModelId")?;
            if model == other {
                return Err(CoreError::new(400, "Comparing takes two different models."));
            }
            Ok(json!({
                "action": "compare",
                "modelId": model,
                "otherModelId": other,
                "input": prompt_field(request, "input")?,
                "expected": request.get("expected").and_then(Value::as_str).filter(|word| !word.is_empty()),
            }))
        }
        "prompts" => {
            let (clean, corrupted) = (
                prompt_field(request, "clean")?,
                prompt_field(request, "corrupted")?,
            );
            if clean == corrupted {
                return Err(CoreError::new(400, "The two prompts are the same."));
            }
            let (expected, alternative) = (
                prompt_field(request, "expected")?,
                prompt_field(request, "alternative")?,
            );
            if expected == alternative {
                return Err(CoreError::new(
                    400,
                    "The expected word and its alternative are the same.",
                ));
            }
            Ok(json!({
                "action": "prompts",
                "modelId": model,
                "clean": clean,
                "corrupted": corrupted,
                "expected": expected,
                "alternative": alternative,
                "layers": request.get("layers"),
            }))
        }
        "features" => features_question(request, model),
        other => Err(CoreError::new(
            400,
            format!("There is nothing to do called \"{other}\"."),
        )),
    }
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

/// The files in an SAE's folder by name, size and time, so that an SAE trained again under the same path is asked about
/// afresh rather than answered from what the old one said.
async fn sae_files(folder: &Path, asked: &str) -> Result<Value, CoreError> {
    let missing = || CoreError::new(422, format!("There is no SAE folder at {asked}."));
    let mut entries = tokio::fs::read_dir(folder).await.map_err(|_| missing())?;
    let mut files = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let details = tokio::fs::metadata(entry.path()).await?;
        if details.is_file() {
            let changed = details
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|since| since.as_millis() as u64);
            files.push((
                entry.file_name().to_string_lossy().into_owned(),
                details.len(),
                changed,
            ));
        }
    }
    files.sort();
    Ok(json!(files))
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
        if run["archived"] == true {
            return Err(CoreError::new(
                409,
                "This is archived evidence. Create a local inspection session to compute new results.",
            ));
        }
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
        // The raw residual stream can be kept as a file in the project, for probes and directions to be trained on. It
        // goes where the request says, inside the project and outside Saturn's records, so a run can declare it as data.
        let save = match request.get("save").and_then(Value::as_str).map(str::trim) {
            Some(path) if !path.is_empty() => {
                let wanted = if path.to_lowercase().ends_with(".npz") {
                    path.to_owned()
                } else {
                    format!("{path}.npz")
                };
                let (absolute, relative) = self.source_path(project, &wanted, None).await?;
                // A reading makes a new file: it never replaces one, and a locked input (a frozen version's data or
                // scorer, or what the policy names) is as closed to it as to a file tool.
                if tokio::fs::symlink_metadata(&absolute).await.is_ok() {
                    return Err(CoreError::new(
                        409,
                        format!(
                            "{relative} already exists. A saved reading never replaces a file; name a new path."
                        ),
                    ));
                }
                if self
                    .research_locked_paths(project)
                    .await?
                    .iter()
                    .any(|locked| locked == &relative)
                {
                    return Err(CoreError::new(
                        403,
                        format!(
                            "{relative} is locked for this experiment. Ask the person to release it, or name another path."
                        ),
                    ));
                }
                ask["save"] = json!(absolute.to_string_lossy());
                Some((absolute, relative))
            }
            _ => None,
        };

        let source = self.research_source(project, None)?;
        let working_folder = source.join(text(&version, "cwd"));
        let mut command = self.interpreter_command(
            project,
            &python,
            &["-".to_owned(), ask.to_string()],
            &working_folder,
        )?;
        let output = command
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
        answer["helperSha256"] = json!(sha256_hex(HELPER.as_bytes()));
        answer["schemaVersion"] = json!(SCHEMA_VERSION);
        if let Some((absolute, relative)) = save {
            answer["saved"] = match super::freeze::hash_file(&absolute).await {
                Ok((sha256, size)) => {
                    json!({ "path": relative, "format": "npz", "sha256": sha256, "size": size, "note": "One array per layer, `layer_<n>`, of shape tokens × hidden, with `tokens`; `patched_layer_<n>` when a layer was patched. Declare it in an experiment's inputs.data to train on it in a run." })
                }
                Err(_) => {
                    json!({ "path": relative, "missing": true, "note": "The helper wrote no file there." })
                }
            };
        }
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

    /// Looks at prompts of the person's own rather than a run's samples: two models read on one prompt, a clean prompt
    /// patched into a corrupted one at every layer and position, or one layer read through a sparse autoencoder. The run
    /// says which Python and weights; the answer is saved with it, and given again without running when asked the same thing.
    pub async fn research_inspection(
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
        if !is_id(run_id) {
            return Err(CoreError::new(404, "No such run"));
        }
        let mut ask = prompts_question(request)?;
        let version = self.inspection_basis(project, run_id).await?;
        if version["archived"] == true {
            return Err(CoreError::new(
                409,
                "This is an archived context. Start a new inspection session with local models and Python.",
            ));
        }
        self.model_weights(project, &version, text(&ask, "modelId"))
            .await?;
        if text(&ask, "action") == "compare" {
            self.model_weights(project, &version, text(&ask, "otherModelId"))
                .await?;
        }
        if let Some(path) = ask.pointer("/sae/path").and_then(Value::as_str) {
            let path = path.to_owned();
            let folder = self
                .research_source(project, None)?
                .join(text(&version, "cwd"))
                .join(&path);
            ask["sae"]["files"] = sae_files(&folder, &path).await?;
        }
        let helper = inspection_helper(text(&ask, "action"));
        let helper_sha = sha256_hex(helper.as_bytes());
        let key = sha256_hex(
            json!({ "helper": helper_sha, "ask": ask })
                .to_string()
                .as_bytes(),
        );
        let file = self
            .inspection_folder(project, run_id)
            .await?
            .join(format!("inspect-{}.json", &key[..16]));
        if let Some(saved) = read_record(&file)
            .await
            .map_err(|reason| CoreError::new(422, reason))?
        {
            return Ok(saved);
        }
        let python = if let Some(python) = version.get("python").and_then(Value::as_str) {
            python.to_owned()
        } else {
            match super::environment::python_of(text(&version, "command")) {
                Some(python) => python.to_owned(),
                None => self.research_python(project).await?,
            }
        };
        ask["target"] = self
            .model_weights(project, &version, text(&ask, "modelId"))
            .await?;
        if text(&ask, "action") == "compare" {
            ask["other"] = self
                .model_weights(project, &version, text(&ask, "otherModelId"))
                .await?;
        }
        let mut answer = self
            .run_helper(project, &version, &python, &ask, &helper)
            .await?;
        // A reason it cannot be answered yet, such as a package to install: nothing to keep.
        if let Some(reason) = answer.get("refused").and_then(Value::as_str) {
            return Err(CoreError::new(422, reason));
        }
        answer["action"] = ask["action"].clone();
        answer["helperSha256"] = json!(helper_sha);
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

    /// Everything saved under a run's `inside/`: single readings and sweeps, newest first, whole. `current` says whether
    /// the helper that made one is this runtime's, since a corrected helper leaves earlier results in place.
    pub async fn research_inside_list(&self, project: &str, run: &str) -> Result<Value, CoreError> {
        if !is_id(run) {
            return Err(CoreError::new(404, "No such run"));
        }
        let folder = self.inspection_folder(project, run).await?;
        let helper = sha256_hex(HELPER.as_bytes());
        let prompts = sha256_hex(prompts_helper().as_bytes());
        let features = sha256_hex(features_helper().as_bytes());
        let mut items = Vec::new();
        let mut entries = match tokio::fs::read_dir(&folder).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(json!({ "runId": run, "items": [] }));
            }
            Err(error) => return Err(error.into()),
        };
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".json") {
                continue;
            }
            if let Ok(Some(mut saved)) = read_record(&entry.path()).await {
                let inspection = name.starts_with("inspect-");
                saved["kind"] = if inspection {
                    saved["action"].clone()
                } else if name.starts_with("sweep-") {
                    json!("sweep")
                } else {
                    json!("reading")
                };
                let made_by = if !inspection {
                    &helper
                } else if text(&saved, "action") == "features" {
                    &features
                } else {
                    &prompts
                };
                saved["current"] = json!(text(&saved, "helperSha256") == made_by);
                items.push(saved);
            }
        }
        items.sort_by(|left, right| text(right, "recordedAt").cmp(text(left, "recordedAt")));
        Ok(json!({ "runId": run, "items": items }))
    }

    /// Patches every layer in turn, from one model into another, on several samples of a run, in one helper process.
    /// Saved with the run like a single reading.
    pub async fn research_sweep(&self, project: &str, request: &Value) -> Result<Value, CoreError> {
        if cfg!(windows) {
            return Err(CoreError::new(
                501,
                "Looking inside a model is not supported on Windows yet.",
            ));
        }
        let run_id = text(request, "runId");
        let sample_ids: Vec<&str> = request
            .get("sampleIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        if sample_ids.is_empty() || sample_ids.len() > MAX_SWEEP {
            return Err(CoreError::new(
                400,
                format!("A sweep names 1 to {MAX_SWEEP} sampleIds."),
            ));
        }
        let (source_id, target_id) = (
            text(request, "sourceModelId"),
            text(request, "targetModelId"),
        );
        if source_id.is_empty() || target_id.is_empty() {
            return Err(CoreError::new(
                400,
                "A sweep names a sourceModelId and a targetModelId.",
            ));
        }
        let key = sha256_hex(
            json!({ "sweep": sample_ids, "source": source_id, "target": target_id, "layers": request.get("layers"), "helperSha256": sha256_hex(HELPER.as_bytes()) })
                .to_string()
                .as_bytes(),
        );
        let records = self.records_folder(project).await?;
        if !is_id(run_id) {
            return Err(CoreError::new(404, "No such run"));
        }
        let file = records
            .join("runs")
            .join(run_id)
            .join(FOLDER)
            .join(format!("sweep-{}.json", &key[..16]));
        if let Some(saved) = read_record(&file)
            .await
            .map_err(|reason| CoreError::new(422, reason))?
        {
            return Ok(saved);
        }
        let run = self.research_run(project, run_id).await?;
        if run["archived"] == true {
            return Err(CoreError::new(
                409,
                "This is archived evidence. Create a local inspection session to compute new results.",
            ));
        }
        let version = self
            .research_record(project, "versions", text(&run, "versionId"))
            .await?;
        let python = match super::environment::python_of(text(&version, "command")) {
            Some(python) => python.to_owned(),
            None => self.research_python(project).await?,
        };
        let mut samples = Vec::new();
        for sample_id in &sample_ids {
            let line = self
                .inside_sample(
                    project,
                    &run,
                    &json!({ "sampleId": sample_id, "modelId": target_id }),
                )
                .await?;
            if !line.get("input").is_some_and(Value::is_string) {
                return Err(CoreError::new(
                    422,
                    format!("Sample {sample_id}'s input is not text."),
                ));
            }
            samples.push(json!({ "sampleId": sample_id, "input": line.get("input"), "expected": line.get("expected"), "alternative": line.get("alternative") }));
        }
        let ask = json!({
            "sampleId": sample_ids[0],
            "modelId": target_id,
            "target": self.model_weights(project, &version, target_id).await?,
            "sweep": {
                "modelId": source_id,
                "source": self.model_weights(project, &version, source_id).await?,
                "layers": request.get("layers"),
                "samples": samples,
            },
        });
        let mut answer = self
            .run_helper(project, &version, &python, &ask, HELPER)
            .await?;
        answer["helperSha256"] = json!(sha256_hex(HELPER.as_bytes()));
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

    /// Runs the helper with a request in the version's folder and reads its answer, or says how it failed.
    async fn run_helper(
        &self,
        project: &str,
        version: &Value,
        python: &str,
        ask: &Value,
        helper: &str,
    ) -> Result<Value, CoreError> {
        let source = self.research_source(project, None)?;
        let working_folder = source.join(text(version, "cwd"));
        let mut command = self.interpreter_command(
            project,
            python,
            &["-".to_owned(), ask.to_string()],
            &working_folder,
        )?;
        let child = command
            .current_dir(&working_folder)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| CoreError::new(422, format!("{python} could not start: {error}")))?;
        let output = feed(child, helper).await?;
        if !output.status.success() {
            let log = String::from_utf8_lossy(&output.stderr);
            let tail: Vec<&str> = log.lines().rev().take(12).collect();
            return Err(CoreError::new(
                422,
                format!(
                    "The helper ended with {}.\n{}",
                    output.status,
                    tail.into_iter().rev().collect::<Vec<_>>().join("\n")
                ),
            ));
        }
        serde_json::from_slice(&output.stdout).map_err(|error| {
            CoreError::new(
                422,
                format!("The helper's answer could not be read: {error}"),
            )
        })
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
        if version["kind"] == "inspection" {
            return Err(CoreError::new(
                422,
                "This model is not in the session snapshot. Start a new session to include it.",
            ));
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
                "helperSha256": sha256_hex(HELPER.as_bytes()),
                "sampleId": request.get("sampleId"),
                "modelId": asked_model(request),
                "sourceModelId": request.get("sourceModelId"),
                "layer": request.get("layer"),
                "save": request.get("save"),
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
