//! What a run is checked for when it ends: whether it measured as much as the last completed run its version compares
//! with, since a stated evaluation can go stale while the program changes.
use std::collections::BTreeMap;
use std::path::Path;

use saturn_domain::research::compare_versions;
use serde_json::Value;

use super::labels::each_sample;
use crate::Kernel;
use crate::records::text;

impl Kernel {
    /// The most samples any one model got in a run's file, and a warning when the last completed comparable run of the
    /// same experiment got a different number: two whole runs that "measured the same way" should measure as much. A run
    /// that failed or was stopped says nothing about how much the evaluation holds.
    pub(super) async fn drift_check(
        &self,
        project: &str,
        version: &Value,
        directory: &Path,
    ) -> (u64, Vec<String>) {
        let path = directory.join("samples.jsonl");
        let per_model = tokio::task::spawn_blocking(move || {
            let mut counts: BTreeMap<String, u64> = BTreeMap::new();
            let _ = each_sample(&path, None, |value, _| {
                *counts.entry(text(value, "modelId").to_owned()).or_default() += 1;
            });
            counts.values().copied().max().unwrap_or(0)
        })
        .await
        .unwrap_or(0);
        let mut warnings = Vec::new();
        if per_model == 0 {
            return (per_model, warnings);
        }
        let runs = self
            .research_runs(project)
            .await
            .ok()
            .and_then(|list| list.get("items").cloned())
            .and_then(|items| items.as_array().cloned())
            .unwrap_or_default();
        let experiment = text(version, "experimentId");
        let mut earlier = Vec::new();
        for run in runs.iter().rev() {
            if text(run, "experimentId") != experiment || text(run, "status") != "completed" {
                continue;
            }
            let Some(before) = run.get("samplesPerModel").and_then(Value::as_u64) else {
                continue;
            };
            if before == 0 {
                continue;
            }
            let other = if text(run, "versionId") == text(version, "id") {
                Some(version.clone())
            } else {
                self.research_record(project, "versions", text(run, "versionId"))
                    .await
                    .ok()
            };
            let Some(other) = other else { continue };
            let comparison = compare_versions(&other, version);
            if text(&comparison, "result") == "comparable" {
                earlier.push((text(run, "id").to_owned(), before));
                break;
            }
        }
        if let Some((run_id, before)) = earlier.first()
            && *before != per_model
        {
            warnings.push(format!(
                "Measured {per_model} samples per model where {run_id}, whose version compares as the same evaluation, measured {before}. Say what changed in the evaluation (its sample set, for one) before comparing them."
            ));
        }
        (per_model, warnings)
    }
}
