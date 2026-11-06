//! Deleting an experiment: it moves, with its versions, runs and labels, into the records' `trash` folder, where it
//! can be found again by hand. Nothing is erased, and nothing that another record still refers to is moved.
use std::path::Path;

use saturn_domain::research::is_id;
use saturn_domain::time::{iso_time, now_millis};
use serde_json::{Value, json};

use super::{pretty, read_folder, write_whole};
use crate::records::text;
use crate::{CoreError, Kernel, locked};

/// The folder in the records that deleted experiments move to.
const TRASH: &str = "trash";
/// The kinds of record that may refer to an experiment, its versions or its runs.
const REFERRING: [&str; 8] = [
    "questions",
    "hypotheses",
    "models",
    "findings",
    "counterexamples",
    "counterexample_sets",
    "inspection_sessions",
    "artifacts",
];

/// Whether an experiment only describes results brought in from elsewhere: nothing was run or frozen here.
fn imported_only(experiment: &Value, versions: &[Value]) -> bool {
    experiment["imported"] == true
        && versions
            .iter()
            .all(|version| version["imported"] == true || version["archived"] == true)
}

impl Kernel {
    /// Moves an experiment, its versions, its runs and their labels into the records' trash. `expected` is the
    /// experiment's revision as the caller read it. An agent may delete only an imported experiment: one it ran or
    /// froze here holds locks and results that are the person's to give up.
    pub async fn research_delete_experiment(
        &self,
        project: &str,
        id: &str,
        expected: Option<u64>,
        by_agent: bool,
    ) -> Result<Value, CoreError> {
        if !is_id(id) || !id.starts_with("experiment_") {
            return Err(CoreError::new(404, "No such experiment"));
        }
        let records = self.records_for_writing(project).await?;
        let lock = self.records_lock(&records);
        let _writing = lock.lock().await;
        let experiment = self.research_record(project, "experiments", id).await?;
        if let Some(expected) = expected {
            let revision = experiment["revision"].as_u64().unwrap_or(0);
            if revision != expected {
                return Err(CoreError::new(
                    409,
                    format!(
                        "This experiment has changed (it is at revision {revision}). Reload it and try again."
                    ),
                ));
            }
        }
        let (all_versions, _) = read_folder(&records.join("versions")).await?;
        let versions: Vec<Value> = all_versions
            .into_iter()
            .filter(|version| text(version, "experimentId") == id)
            .collect();
        if by_agent && !imported_only(&experiment, &versions) {
            return Err(CoreError::new(
                403,
                "Only an imported experiment can be deleted from here. One that was frozen or run in this project is the person's to delete, in Experiments.",
            ));
        }
        let version_ids: Vec<&str> = versions.iter().map(|version| text(version, "id")).collect();
        let (all_runs, _) = super::runs::read_runs(&records).await?;
        let runs: Vec<Value> = all_runs
            .into_iter()
            .filter(|run| {
                text(run, "experimentId") == id || version_ids.contains(&text(run, "versionId"))
            })
            .collect();
        let going = {
            let active = locked(&self.research.active);
            runs.iter().any(|run| {
                saturn_domain::research::run_is_active(text(run, "status"))
                    || active.contains_key(text(run, "id"))
            })
        };
        if going {
            return Err(CoreError::new(
                409,
                "A run of this experiment is still going. Stop it first.",
            ));
        }

        // Anything else that names the experiment, a version or a run keeps it where it is.
        let mut names: Vec<&str> = vec![id];
        names.extend(version_ids.iter().copied());
        names.extend(runs.iter().map(|run| text(run, "id")));
        let mut referring = Vec::new();
        for collection in REFERRING {
            let (items, _) = read_folder(&records.join(collection)).await?;
            for item in items {
                let written = item.to_string();
                if names.iter().any(|name| written.contains(name)) {
                    referring.push(format!("{} ({collection})", text(&item, "id")));
                }
            }
        }
        if !referring.is_empty() {
            return Err(CoreError::new(
                409,
                format!(
                    "Other records still refer to this experiment or its runs: {}. Change or remove those first.",
                    referring.join(", ")
                ),
            ));
        }

        let stamp = iso_time(now_millis()).replace([':', '.'], "-");
        let folder = records.join(TRASH).join(format!("{stamp}-{id}"));
        let mut moves: Vec<(std::path::PathBuf, String)> = vec![(
            records.join("experiments").join(format!("{id}.json")),
            format!("experiments/{id}.json"),
        )];
        for version in &version_ids {
            moves.push((
                records.join("versions").join(format!("{version}.json")),
                format!("versions/{version}.json"),
            ));
        }
        for run in &runs {
            let run = text(run, "id");
            moves.push((records.join("runs").join(run), format!("runs/{run}")));
            moves.push((
                records.join("labels").join(format!("{run}.json")),
                format!("labels/{run}.json"),
            ));
        }
        let mut moved = Vec::new();
        for (from, to) in moves {
            if tokio::fs::symlink_metadata(&from).await.is_err() {
                continue;
            }
            let target = folder.join(&to);
            if let Some(parent) = target.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            tokio::fs::rename(&from, &target).await?;
            moved.push(to);
        }
        let note = json!({
            "deletedAt": iso_time(now_millis()),
            "by": if by_agent { "assistant" } else { "person" },
            "experiment": { "id": id, "title": experiment["title"] },
            "moved": moved,
            "restore": "Move these files back to the same places under .saturn/research to restore the experiment.",
        });
        write_whole(&folder.join("deleted.json"), &pretty(&note)?).await?;
        self.research_changed();
        Ok(json!({
            "deleted": id,
            "versions": version_ids,
            "runs": runs.iter().map(|run| text(run, "id")).collect::<Vec<_>>(),
            "trash": Path::new(".saturn/research").join(TRASH).join(folder.file_name().unwrap_or_default()),
        }))
    }
}
