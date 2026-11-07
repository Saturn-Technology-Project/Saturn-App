//! Reads sealed results for paired analysis, then saves selected evidence independently of scores and labels.
use std::collections::{BTreeSet, HashSet};

use saturn_domain::research::{compare_versions, comparison::paired, sample_identity, sha256_hex};
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;

use crate::records::text;
use crate::{CoreError, Kernel};

const MAX_BYTES: u64 = 64 * 1024 * 1024;

/// One side of a comparison, with a single explicit or unambiguous model selected.
struct Side {
    rows: Vec<Value>,
    run: Value,
    version: Value,
}

impl Kernel {
    /// Loads only a run's sealed bytes, rejecting changed contents and ambiguous model identities.
    async fn comparison_side(&self, project: &str, side: &Value) -> Result<Side, CoreError> {
        let run = self.research_run(project, text(side, "runId")).await?;
        if saturn_domain::research::run_is_active(text(&run, "status")) {
            return Err(CoreError::new(
                409,
                "Compare completed or interrupted results, not a changing run.",
            ));
        }
        let version = self
            .research_record(project, "versions", text(&run, "versionId"))
            .await?;
        let path = self
            .records_folder(project)
            .await?
            .join("runs")
            .join(text(&run, "id"))
            .join("samples.jsonl");
        let end = run.get("samplesSize").and_then(Value::as_u64).unwrap_or(0);
        if end > MAX_BYTES {
            return Err(CoreError::new(
                413,
                "A paired comparison reads at most 64 MiB per side. Export a smaller evaluation slice.",
            ));
        }
        let mut bytes = Vec::new();
        tokio::fs::File::open(path)
            .await?
            .take(end)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() as u64 != end
            || run
                .get("samplesSha256")
                .and_then(Value::as_str)
                .is_some_and(|hash| hash != sha256_hex(&bytes))
        {
            return Err(CoreError::new(
                409,
                "The sealed samples changed. They cannot stand for this run's original results.",
            ));
        }
        let selected = side
            .get("modelId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let rows = tokio::task::spawn_blocking(move || -> Result<Vec<Value>, CoreError> {
            let mut rows = Vec::new();
            let mut models = BTreeSet::new();
            let mut seen = HashSet::new();
            for line in bytes
                .split(|byte| *byte == b'\n')
                .filter(|line| !line.is_empty())
            {
                let row: Value = serde_json::from_slice(line).map_err(|_| {
                    CoreError::new(
                        422,
                        "A source has malformed samples; review its protocol errors first.",
                    )
                })?;
                let identity =
                    sample_identity(&row).map_err(|message| CoreError::new(422, message))?;
                if !seen.insert(identity) {
                    return Err(CoreError::new(
                        422,
                        "The source repeats a sample, trial and model.",
                    ));
                }
                if rows.len() >= 100_000 {
                    return Err(CoreError::new(
                        413,
                        "Compare at most 100,000 samples per side.",
                    ));
                }
                let model = row.get("modelId").and_then(Value::as_str).unwrap_or("");
                models.insert(model.to_owned());
                if selected.as_deref().is_none_or(|selected| selected == model) {
                    rows.push(row);
                }
            }
            if selected.is_none() && models.len() > 1 {
                return Err(CoreError::new(
                    400,
                    "This run has several models; select modelId for this side.",
                ));
            }
            Ok(rows)
        })
        .await
        .map_err(|error| CoreError::new(500, error.to_string()))??;
        Ok(Side { rows, run, version })
    }

    /// Computes a paired delta, its prompt-level uncertainty and category slices; saves all regressions when asked.
    pub async fn research_paired_comparison(
        &self,
        project: &str,
        request: &Value,
    ) -> Result<Value, CoreError> {
        let scorer = text(request, "scorer");
        if scorer.is_empty() {
            return Err(CoreError::new(400, "Name the numeric scorer to compare."));
        }
        let only = request.get("only").and_then(Value::as_str).unwrap_or("all");
        if !matches!(
            only,
            "all"
                | "improved"
                | "regressed"
                | "unchanged"
                | "excluded"
                | "missing_left"
                | "missing_right"
        ) {
            return Err(CoreError::new(400, "Unknown comparison filter."));
        }
        let left = self.comparison_side(project, &request["left"]).await?;
        let right = self.comparison_side(project, &request["right"]).await?;
        let mut comparison = compare_versions(&left.version, &right.version);
        // An imported result only describes its evaluation, with no data or scorer files behind it, so a matching
        // description is not enough to compare: no interval is drawn from it.
        if [&left.version, &right.version]
            .iter()
            .any(|version| version["imported"] == true)
        {
            comparison["result"] = json!("unknown");
            if let Some(missing) = comparison["missing"].as_array_mut() {
                missing.push(json!(
                    "verified data and scorer files (an imported result only describes them)"
                ));
            }
        }
        // A run whose inputs changed while it ran no longer stands for its version: what it measured is unknown.
        let changed: Vec<String> = [&left.run, &right.run]
            .iter()
            .flat_map(|run| inputs_changed(run))
            .collect();
        if !changed.is_empty() {
            comparison["result"] = json!("not_comparable");
            if let Some(differs) = comparison["differs"].as_array_mut() {
                differs.push(json!(changed_inputs_text(&changed)));
            }
        }
        let inference = comparison["result"] == "comparable";
        let higher = request
            .get("higherIsBetter")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let slice = request
            .get("sliceField")
            .and_then(Value::as_str)
            .unwrap_or("category")
            .to_owned();
        let scorer_owned = scorer.to_owned();
        let mut result = tokio::task::spawn_blocking(move || {
            paired(
                &left.rows,
                &right.rows,
                &scorer_owned,
                higher,
                &slice,
                inference,
            )
        })
        .await
        .map_err(|error| CoreError::new(500, error.to_string()))?;
        result["comparison"] = comparison;
        result["note"] = json!(
            "Delta is right minus left. Mean delta weights each sample ID equally after averaging its trials. The conservative 95% paired t interval assumes independent sample IDs and approximately normal prompt means; it is not uncertainty across training seeds, has no multiple-comparison correction, and is omitted for unknown/different evaluation conditions or fewer than two sample IDs. Slice names come from the left sample when present."
        );
        let all = result["items"].as_array().cloned().unwrap_or_default();
        let in_slice = |row: &&Value| {
            request
                .get("slice")
                .and_then(Value::as_str)
                .is_none_or(|name| row["slice"] == name)
        };
        if request.get("save").and_then(Value::as_bool) == Some(true) {
            let members: Vec<Value> = all.iter().filter(in_slice).filter(|row| row["change"] == "regressed").map(|row| json!({ "sampleId": row["sampleId"], "trial": row["trial"], "delta": row["delta"], "slice": row["slice"], "change": row["change"] })).collect();
            let mut settings = request.clone();
            for key in ["save", "title", "cursor", "only"] {
                if let Some(map) = settings.as_object_mut() {
                    map.remove(key);
                }
            }
            result["saved"] = self.research_create(project, "counterexample_sets", &json!({
                "title": request.get("title").and_then(Value::as_str).unwrap_or("Regressions"), "request": settings, "members": members,
                "summary": result["summary"], "comparison": result["comparison"],
                "sourceDigests": [left.run.get("samplesSha256"), right.run.get("samplesSha256")], "note": result["note"]
            })).await?;
        }
        let visible: Vec<Value> = all
            .iter()
            .filter(in_slice)
            .filter(|row| only == "all" || row["change"] == only)
            .cloned()
            .collect();
        let cursor = request.get("cursor").and_then(Value::as_u64).unwrap_or(0) as usize;
        let end = cursor.saturating_add(200).min(visible.len());
        result["items"] = json!(visible.get(cursor..end).unwrap_or(&[]));
        result["total"] = json!(visible.len());
        result["next"] = if end < visible.len() {
            json!(end)
        } else {
            Value::Null
        };
        Ok(result)
    }
}

/// What differs about a run whose inputs changed while it ran, in the words a comparison lists.
pub(super) fn changed_inputs_text(changed: &[String]) -> String {
    format!("inputs, changed during the run ({})", changed.join(", "))
}

/// The inputs a run reports as changed while it ran, by path.
pub(super) fn inputs_changed(run: &Value) -> Vec<String> {
    run.get("inputsChanged")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
