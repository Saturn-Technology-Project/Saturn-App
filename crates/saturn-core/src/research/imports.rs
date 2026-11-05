//! Existing results enter as new, non-executable records. Their source is read once and never changed.
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Cursor, Seek, SeekFrom};

use saturn_domain::new_id;
use saturn_domain::research::{new_record, sample_identity, sha256_hex};
use saturn_domain::time::{iso_time, now_millis};
use serde_json::{Map, Value, json};
use tokio::io::AsyncReadExt;

use super::tables::{Item, Rows, Shape, read_header, skip_byte_order_mark};
use super::{pretty, write_whole};
use crate::records::text;
use crate::{CoreError, Kernel};

/// Bounds on a single import, before its decoded rows are kept in memory.
const IMPORT_BYTES: u64 = 64 * 1024 * 1024;
const IMPORT_ROWS: usize = 100_000;

/// Validates a completed metrics stream, separately from evaluation samples and without keeping its events in memory.
pub(super) fn metric_output(path: &std::path::Path) -> std::io::Result<(u64, bool)> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((0, true)),
        Err(error) => return Err(error),
    };
    let mut reader = BufReader::new(file);
    let mut count = 0;
    let mut line = Vec::new();
    loop {
        line.clear();
        let read =
            std::io::Read::take(&mut reader, 1024 * 1024 + 1).read_until(b'\n', &mut line)?;
        if read == 0 {
            return Ok((count, true));
        }
        let valid = read <= 1024 * 1024
            && line.last() == Some(&b'\n')
            && serde_json::from_slice::<Value>(&line).is_ok_and(|value| {
                value["schemaVersion"] == 1
                    && value["step"].is_u64()
                    && value["values"].as_object().is_some_and(|values| {
                        !values.is_empty()
                            && values
                                .values()
                                .all(|number| number.as_f64().is_some_and(f64::is_finite))
                    })
            });
        if !valid {
            return Ok((count, false));
        }
        count += 1;
    }
}

/// A validated import, ready either to preview or to save.
struct Imported {
    samples: Vec<Value>,
    metrics: Vec<Value>,
    provenance: Value,
}

/// A readable error in a source file, without echoing its contents.
fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(422, message)
}

/// A column mapping, with the protocol's own name as its default.
fn column<'a>(request: &'a Value, name: &'a str) -> &'a str {
    request
        .get("columns")
        .and_then(|columns| columns.get(name))
        .and_then(Value::as_str)
        .unwrap_or(name)
}

/// Makes one protocol sample while keeping the original row's other metadata.
fn sample(row: Value, index: usize, request: &Value) -> Result<Value, CoreError> {
    let mut fields = row
        .as_object()
        .cloned()
        .ok_or_else(|| invalid("Each result must be an object."))?;
    for key in [
        "sampleId",
        "input",
        "output",
        "expected",
        "alternative",
        "modelId",
        "trial",
        "scorerLabel",
        "category",
    ] {
        if let Some(value) = row.get(column(request, key)) {
            fields.insert(key.to_owned(), value.clone());
        }
    }
    if let Some(id) = fields.get("sampleId").and_then(Value::as_i64) {
        fields.insert("sampleId".to_owned(), json!(id.to_string()));
    }
    if let Some(trial) = fields.get("trial").and_then(Value::as_str) {
        let trial = trial
            .parse::<u64>()
            .map_err(|_| invalid("trial must be a non-negative integer."))?;
        fields.insert("trial".to_owned(), json!(trial));
    }
    if !fields.contains_key("sampleId") {
        fields.insert("sampleId".to_owned(), json!(format!("row-{}", index + 1)));
        fields.insert("identityGenerated".to_owned(), json!(true));
    }
    if let Some(model) = request
        .get("modelId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        fields.insert("modelId".to_owned(), json!(model));
    }
    if row
        .get("scores")
        .is_some_and(|scores| !scores.is_null() && !scores.is_object())
    {
        return Err(invalid(
            "scores must be an object; use scoreColumns for CSV numbers.",
        ));
    }
    let mut scores = row
        .get("scores")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(columns) = request.get("scoreColumns").and_then(Value::as_array) {
        for name in columns {
            let name = name
                .as_str()
                .filter(|name| !name.is_empty())
                .ok_or_else(|| invalid("scoreColumns must name columns."))?;
            let raw = row
                .get(name)
                .ok_or_else(|| invalid(format!("A result has no score column {name}.")))?;
            let number = raw
                .as_f64()
                .or_else(|| raw.as_str()?.parse::<f64>().ok())
                .filter(|value| value.is_finite())
                .ok_or_else(|| {
                    invalid(format!(
                        "The score column {name} must contain finite numbers."
                    ))
                })?;
            scores.insert(name.to_owned(), json!(number));
        }
    }
    fields.insert("scores".to_owned(), Value::Object(scores));
    fields.insert("schemaVersion".to_owned(), json!(1));
    let value = Value::Object(fields);
    sample_identity(&value).map_err(invalid)?;
    Ok(value)
}

/// A Trainer logging event, separated from evaluation samples.
fn metric(row: &Value) -> Result<Value, CoreError> {
    let step = row
        .get("step")
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid("Each metric event needs a non-negative integer step."))?;
    let values: Map<String, Value> = row
        .as_object()
        .ok_or_else(|| invalid("A metric event must be an object."))?
        .iter()
        .filter(|(key, value)| key.as_str() != "step" && value.as_f64().is_some_and(f64::is_finite))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    if values.is_empty() {
        return Err(invalid(
            "Each metric event needs at least one numeric value.",
        ));
    }
    Ok(json!({ "schemaVersion": 1, "step": step, "values": values }))
}

/// Decodes JSONL, a JSON array, CSV/TSV, or a Transformers Trainer state, without running code.
fn decode(bytes: &[u8], path: &str, request: &Value) -> Result<Imported, CoreError> {
    let format = request
        .get("format")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            if path.ends_with(".csv") {
                "csv"
            } else if path.ends_with(".tsv") {
                "tsv"
            } else if path.ends_with(".json") {
                "json"
            } else {
                "jsonl"
            }
        });
    let mut rows = Vec::new();
    if format == "trainer" {
        let state: Value =
            serde_json::from_slice(bytes).map_err(|_| invalid("The Trainer state is not JSON."))?;
        rows = state
            .get("log_history")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| invalid("A Trainer state needs log_history."))?;
    } else {
        let shape = match format {
            "csv" => Shape::Delimited(b','),
            "tsv" => Shape::Delimited(b'\t'),
            "json" => Shape::JsonArray,
            "jsonl" => Shape::Lines,
            _ => {
                return Err(CoreError::new(
                    400,
                    "format must be jsonl, json, csv, tsv or trainer.",
                ));
            }
        };
        let mut reader = BufReader::new(Cursor::new(bytes));
        let mut offset = skip_byte_order_mark(&mut reader)?;
        let columns = if let Shape::Delimited(separator) = shape {
            let (columns, used) = read_header(&mut reader, separator)?;
            offset += used;
            columns
        } else {
            Vec::new()
        };
        let mut reading = Rows::new(reader, shape, offset, columns, false);
        while let Some((_, item)) = reading.next_item()? {
            if rows.len() >= IMPORT_ROWS {
                return Err(CoreError::new(
                    413,
                    "Import at most 100,000 rows at a time.",
                ));
            }
            match item {
                Item::Row(row) => rows.push(row),
                _ => {
                    return Err(invalid(format!(
                        "Row {} could not be read; nothing was imported.",
                        rows.len() + 1
                    )));
                }
            }
        }
    }
    if rows.is_empty() || rows.len() > IMPORT_ROWS {
        return Err(invalid("Import between 1 and 100,000 rows."));
    }
    let mut samples = Vec::new();
    let mut metrics = Vec::new();
    let mut seen = HashSet::new();
    for (index, row) in rows.into_iter().enumerate() {
        if format == "trainer" {
            metrics.push(metric(&row)?);
        } else {
            let value = sample(row, index, request)?;
            if !seen.insert(sample_identity(&value).map_err(invalid)?) {
                return Err(invalid(
                    "A sample, trial and model appeared twice; nothing was imported.",
                ));
            }
            samples.push(value);
        }
    }
    let generated = samples
        .iter()
        .any(|row| row.get("identityGenerated") == Some(&json!(true)));
    Ok(Imported {
        samples,
        metrics,
        provenance: json!({
            "kind": "imported", "path": path, "format": format, "sha256": sha256_hex(bytes), "size": bytes.len(),
            "identity": if generated { "row_number" } else { "source" },
            "note": "Source results, not a verified execution. Unstated evaluation, model and environment details remain unknown."
        }),
    })
}

/// Writes protocol lines with a final newline.
pub(super) fn json_lines(rows: &[Value]) -> Result<Vec<u8>, CoreError> {
    let mut bytes = Vec::new();
    for row in rows {
        serde_json::to_writer(&mut bytes, row)
            .map_err(|error| CoreError::new(500, error.to_string()))?;
        bytes.push(b'\n');
    }
    Ok(bytes)
}

impl Kernel {
    /// Previews or imports an existing file. Source bytes and provenance are the same snapshot.
    pub async fn research_import(
        &self,
        project: &str,
        request: &Value,
        preview: bool,
    ) -> Result<Value, CoreError> {
        let (path, relative) = self
            .source_path(project, text(request, "path"), None)
            .await?;
        let mut bytes = Vec::new();
        tokio::fs::File::open(&path)
            .await?
            .take(IMPORT_BYTES + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() as u64 > IMPORT_BYTES {
            return Err(CoreError::new(413, "Import at most 64 MiB at a time."));
        }
        let request_owned = request.clone();
        let imported =
            tokio::task::spawn_blocking(move || decode(&bytes, &relative, &request_owned))
                .await
                .map_err(|error| CoreError::new(500, error.to_string()))??;
        if let Some(expected) = request.get("expectedSha256").and_then(Value::as_str)
            && imported.provenance["sha256"] != expected
        {
            return Err(CoreError::new(
                409,
                "The source changed since its preview; preview it again.",
            ));
        }
        if preview {
            return Ok(
                json!({ "samples": imported.samples.len(), "metrics": imported.metrics.len(), "preview": imported.samples.iter().take(5).collect::<Vec<_>>(), "provenance": imported.provenance }),
            );
        }
        let now = iso_time(now_millis());
        let experiment_id = new_id("experiment")?;
        let version_id = new_id("version")?;
        let run_id = new_id("run")?;
        let title = request
            .get("title")
            .and_then(Value::as_str)
            .filter(|title| !title.trim().is_empty())
            .unwrap_or("Imported results");
        let mut models = Vec::new();
        if let Some(id) = request
            .get("modelId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            let model = self.research_record(project, "models", id).await?;
            models.push(json!({ "modelId": id, "role": "base", "source": model["source"], "weightsRevision": model["weightsRevision"], "floating": model["floating"] }));
        }
        let experiment = new_record("experiments", &json!({ "title": title, "inputs": {}, "evaluation": request.get("evaluation"), "models": models }), &experiment_id, &now).map_err(invalid)?;
        let version = json!({ "schemaVersion": 1, "id": version_id, "revision": 1, "createdAt": now, "updatedAt": now,
            "experimentId": experiment_id, "number": 1, "imported": true, "models": models, "inputs": [], "evaluation": request.get("evaluation"), "provenance": imported.provenance });
        let sample_bytes = json_lines(&imported.samples)?;
        let run = json!({ "schemaVersion": 1, "id": run_id, "revision": 1, "createdAt": now, "updatedAt": now, "endedAt": now,
            "experimentId": experiment_id, "versionId": version_id, "status": "completed", "kind": if imported.metrics.is_empty() { "evaluation" } else { "training" },
            "imported": true, "samples": imported.samples.len(), "samplesSize": sample_bytes.len(), "samplesSha256": sha256_hex(&sample_bytes), "provenance": imported.provenance });
        let records = self.records_for_writing(project).await?;
        let lock = self.records_lock(&records);
        let _writing = lock.lock().await;
        for collection in ["experiments", "versions", "runs"] {
            tokio::fs::create_dir_all(Self::collection_folder(&records, collection).await?).await?;
        }
        let directory = records.join("runs").join(&run_id);
        tokio::fs::create_dir(&directory).await?;
        write_whole(&directory.join("samples.jsonl"), &sample_bytes).await?;
        write_whole(
            &directory.join("metrics.jsonl"),
            &json_lines(&imported.metrics)?,
        )
        .await?;
        write_whole(
            &records
                .join("experiments")
                .join(format!("{experiment_id}.json")),
            &pretty(&experiment)?,
        )
        .await?;
        write_whole(
            &records.join("versions").join(format!("{version_id}.json")),
            &pretty(&version)?,
        )
        .await?;
        write_whole(&directory.join("run.json"), &pretty(&run)?).await?;
        self.research_changed();
        Ok(json!({ "experiment": experiment, "version": version, "run": run }))
    }

    /// A bounded page of metric events, using byte offsets, and never reading a live partial line.
    pub async fn research_metrics(
        &self,
        project: &str,
        run: &str,
        cursor: u64,
    ) -> Result<Value, CoreError> {
        self.research_run(project, run).await?;
        let path = self
            .records_folder(project)
            .await?
            .join("runs")
            .join(run)
            .join("metrics.jsonl");
        tokio::task::spawn_blocking(move || {
            let file = match std::fs::File::open(path) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(json!({ "items": [], "next": null }));
                }
                Err(error) => return Err(error.into()),
            };
            let mut reader = BufReader::new(file);
            reader.seek(SeekFrom::Start(cursor))?;
            let mut position = cursor;
            let mut items = Vec::new();
            let mut line = Vec::new();
            for _ in 0..200 {
                line.clear();
                let count = std::io::Read::take(&mut reader, 1024 * 1024 + 1)
                    .read_until(b'\n', &mut line)?;
                if count == 0 || line.last() != Some(&b'\n') {
                    break;
                }
                if count > 1024 * 1024 {
                    return Err(invalid("A metric event is too large."));
                }
                let value: Value = serde_json::from_slice(&line)
                    .map_err(|_| invalid("A metric event is not JSON."))?;
                if value.get("step").and_then(Value::as_u64).is_none()
                    || !value
                        .get("values")
                        .and_then(Value::as_object)
                        .is_some_and(|values| {
                            !values.is_empty()
                                && values
                                    .values()
                                    .all(|value| value.as_f64().is_some_and(f64::is_finite))
                        })
                {
                    return Err(invalid(
                        "Metric events need step and finite numeric values.",
                    ));
                }
                position += count as u64;
                items.push(value);
            }
            let next = (items.len() == 200).then_some(position);
            Ok(json!({ "items": items, "next": next }))
        })
        .await
        .map_err(|error| CoreError::new(500, error.to_string()))?
    }
}
