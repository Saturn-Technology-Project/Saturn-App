//! An exploratory session pins its environment and model references without fabricating a scored experiment run.
use std::path::PathBuf;

use saturn_domain::new_id;
use saturn_domain::research::new_record;
use saturn_domain::time::{iso_time, now_millis};
use serde_json::{Value, json};

use super::{is_link, pretty, write_whole};
use crate::records::text;
use crate::{CoreError, Kernel};

impl Kernel {
    /// Captures the current Python and model records; a later model or environment edit cannot move this session.
    pub async fn research_inspection_session(
        &self,
        project: &str,
        request: &Value,
    ) -> Result<Value, CoreError> {
        let ids = request
            .get("modelIds")
            .and_then(Value::as_array)
            .filter(|ids| !ids.is_empty() && ids.len() <= 32)
            .ok_or_else(|| CoreError::new(400, "Select 1 to 32 project models."))?;
        let python = self.research_python(project).await?;
        let environment = self.research_environment(project).await?;
        let (working, cwd) = self
            .source_path(
                project,
                request.get("cwd").and_then(Value::as_str).unwrap_or("."),
                None,
            )
            .await?;
        if !working.is_dir() {
            return Err(CoreError::new(
                400,
                "The inspection working directory is not a folder.",
            ));
        }
        let mut models = Vec::new();
        for id in ids {
            let id = id
                .as_str()
                .ok_or_else(|| CoreError::new(400, "modelIds lists model identifiers."))?;
            let model = self.research_record(project, "models", id).await?;
            models.push(json!({ "modelId": id, "source": model["source"], "weightsRevision": model["weightsRevision"], "floating": model["floating"], "name": model["name"] }));
        }
        let id = new_id("inspection")?;
        let value = new_record("inspection_sessions", &json!({ "title": request.get("title").and_then(Value::as_str).unwrap_or("Exploration"), "kind": "inspection", "python": python, "cwd": cwd, "models": models,
            "environment": { "lockFiles": environment["lockFiles"], "report": environment["report"], "checkedAt": environment["checkedAt"] },
            "note": "Exploration, not a scored evaluation. Model references and Python path are snapshots; floating weights and changes to the installed environment are not made reproducible by a session." }), &id, &iso_time(now_millis())).map_err(|message| CoreError::new(400, message))?;
        let records = self.records_for_writing(project).await?;
        let folder = Self::collection_folder(&records, "inspection_sessions").await?;
        tokio::fs::create_dir_all(&folder).await?;
        write_whole(&folder.join(format!("{id}.json")), &pretty(&value)?).await?;
        self.research_changed();
        Ok(value)
    }

    /// Resolves a real run's frozen version or a standalone session; neither is silently substituted for the other.
    pub(super) async fn inspection_basis(
        &self,
        project: &str,
        id: &str,
    ) -> Result<Value, CoreError> {
        if id.starts_with("inspection_") {
            return self
                .research_record(project, "inspection_sessions", id)
                .await;
        }
        let run = self.research_run(project, id).await?;
        let mut version = self
            .research_record(project, "versions", text(&run, "versionId"))
            .await?;
        if run["archived"] == true {
            version["archived"] = json!(true);
        }
        Ok(version)
    }

    /// Standalone sessions have their own evidence directory, outside the scored run namespace.
    pub(super) async fn inspection_folder(
        &self,
        project: &str,
        id: &str,
    ) -> Result<PathBuf, CoreError> {
        if id.starts_with("inspection_") {
            self.inspection_basis(project, id).await?;
        }
        let records = self.records_folder(project).await?;
        let collection = if id.starts_with("inspection_") {
            "inspection_sessions"
        } else {
            "runs"
        };
        let root = Self::collection_folder(&records, collection)
            .await?
            .join(id);
        let folder = root.join("inside");
        if is_link(&root).await || is_link(&folder).await {
            return Err(CoreError::new(
                403,
                "Inspection evidence cannot be a symbolic link.",
            ));
        }
        Ok(folder)
    }
}
