//! Analysis outputs are immutable, bounded snapshots or explicit references; previews never execute their contents.
use std::path::{Path, PathBuf};

use base64::{Engine, engine::general_purpose::STANDARD};
use saturn_domain::new_id;
use saturn_domain::research::{new_record, sha256_hex};
use saturn_domain::skills::workspace::Workspace;
use saturn_domain::time::{iso_time, now_millis};
use saturn_tools::file::inside_workspace;
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;

use super::{pretty, read_folder, write_whole};
use crate::records::text;
use crate::{CoreError, Kernel};

const SNAPSHOT_LIMIT: u64 = 16 * 1024 * 1024;

/// A validated artifact is fully prepared before a manifest creates any records.
struct Prepared {
    fields: Value,
    bytes: Option<Vec<u8>>,
}

/// Recognizes image signatures rather than trusting a file extension or user-provided MIME type.
fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}

/// External references are descriptive only and must not carry access tokens or passwords.
fn reference_uri(value: &str) -> Result<(), CoreError> {
    let url = url::Url::parse(value)
        .map_err(|_| CoreError::new(400, "Name an absolute external artifact URI."))?;
    if !["https", "s3", "hf", "ssh"].contains(&url.scheme())
        || url.host_str().is_none()
        || url.password().is_some()
        || (!url.username().is_empty() && url.scheme() != "ssh")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(CoreError::new(
            400,
            "Use an https, s3, hf or ssh reference without passwords, tokens, query strings or fragments.",
        ));
    }
    Ok(())
}

impl Kernel {
    /// Validates an output in a project file or a run's output directory, and captures the exact bytes once.
    async fn prepare_artifact(
        &self,
        project: &str,
        request: &Value,
        run_root: Option<&Path>,
    ) -> Result<Prepared, CoreError> {
        let kind = text(request, "kind");
        if !["figure", "json", "notebook", "reference"].contains(&kind) {
            return Err(CoreError::new(
                400,
                "kind must be figure, json, notebook or reference.",
            ));
        }
        if request
            .get("metadata")
            .is_some_and(|value| value.to_string().len() > 64 * 1024)
        {
            return Err(CoreError::new(
                413,
                "Artifact metadata is limited to 64 KiB.",
            ));
        }
        if let Some(run) = request.get("runId").and_then(Value::as_str) {
            self.research_run(project, run).await?;
        }
        if let Some(session) = request.get("inspectionId").and_then(Value::as_str) {
            self.research_record(project, "inspection_sessions", session)
                .await?;
        }
        let mut fields = json!({ "title": request.get("title").and_then(Value::as_str).unwrap_or_else(|| if text(request, "path").is_empty() { text(request, "uri") } else { text(request, "path") }),
            "kind": kind, "metadata": request.get("metadata"), "runId": request.get("runId"), "inspectionId": request.get("inspectionId") });
        if kind == "reference" && !text(request, "uri").is_empty() {
            reference_uri(text(request, "uri"))?;
            fields["uri"] = request["uri"].clone();
            fields["packaged"] = json!(false);
            fields["hashVerified"] = json!(false);
            fields["sha256"] = request.get("sha256").cloned().unwrap_or(Value::Null);
            return Ok(Prepared {
                fields,
                bytes: None,
            });
        }
        let (path, relative) = if let Some(root) = run_root {
            let workspace = Workspace::new(root);
            let path = inside_workspace(&workspace, text(request, "path"))
                .await
                .map_err(|message| CoreError::new(403, message))?;
            let relative = workspace.relative(&path);
            (path, relative)
        } else {
            self.source_path(project, text(request, "path"), None)
                .await?
        };
        let source_path = if run_root.is_some() {
            format!(
                ".saturn/research/runs/{}/{}",
                text(request, "runId"),
                relative
            )
        } else {
            relative.clone()
        };
        fields["sourcePath"] = json!(source_path);
        fields["relativeSource"] = json!(relative);
        fields["sourceScope"] = json!(if run_root.is_some() { "run" } else { "project" });
        let remote_run = if run_root.is_some() && !tokio::fs::try_exists(&path).await? {
            let run = self.research_run(project, text(request, "runId")).await?;
            run.get("remote").is_some().then_some(run)
        } else {
            None
        };
        if let Some(run) = &remote_run {
            let mut uri = url::Url::parse(&format!("ssh://{}", text(&run["remote"], "host")))
                .map_err(|_| CoreError::new(400, "Invalid remote artifact target."))?;
            uri.set_path(&format!(
                "{}/.saturn/remote-jobs/{}/{}",
                text(&run["remote"], "workdir").trim_end_matches('/'),
                text(run, "id"),
                text(&fields, "relativeSource")
            ));
            fields["uri"] = json!(uri.as_str());
            fields["sourceScope"] = json!("remote");
        }
        if kind == "reference" {
            if remote_run.is_some() {
                fields["sha256"] = request.get("sha256").cloned().unwrap_or(Value::Null);
                fields["size"] = request.get("size").cloned().unwrap_or(Value::Null);
                fields["hashVerified"] = json!(false);
            } else {
                let (hash, size) = super::freeze::hash_file(&path).await?;
                fields["sha256"] = json!(hash);
                fields["size"] = json!(size);
                fields["hashVerified"] = json!(true);
            }
            fields["packaged"] = json!(false);
            return Ok(Prepared {
                fields,
                bytes: None,
            });
        }
        let bytes = if let Some(run) = &remote_run {
            super::remote::artifact_bytes(run, text(&fields, "relativeSource")).await?
        } else {
            let mut bytes = Vec::new();
            tokio::fs::File::open(&path)
                .await?
                .take(SNAPSHOT_LIMIT + 1)
                .read_to_end(&mut bytes)
                .await?;
            bytes
        };
        if bytes.len() as u64 > SNAPSHOT_LIMIT {
            return Err(CoreError::new(
                413,
                "Snapshot artifacts are limited to 16 MiB. Register larger stores as references.",
            ));
        }
        let mime = if kind == "figure" {
            image_type(&bytes).ok_or_else(|| {
                CoreError::new(415, "Only PNG, JPEG and WebP figures can be previewed.")
            })?
        } else {
            let value: Value = serde_json::from_slice(&bytes)
                .map_err(|_| CoreError::new(415, "This output is not valid JSON."))?;
            if kind == "notebook" && !(value["nbformat"] == 4 && value["cells"].is_array()) {
                return Err(CoreError::new(
                    415,
                    "A notebook artifact must be an nbformat 4 document.",
                ));
            }
            "application/json"
        };
        fields["mime"] = json!(mime);
        fields["sha256"] = json!(sha256_hex(&bytes));
        fields["size"] = json!(bytes.len());
        fields["packaged"] = json!(true);
        fields["hashVerified"] = json!(true);
        Ok(Prepared {
            fields,
            bytes: Some(bytes),
        })
    }

    /// Saves validated artifacts; their content-addressed data is independent of mutable originals.
    async fn save_artifacts(
        &self,
        project: &str,
        prepared: Vec<Prepared>,
    ) -> Result<Value, CoreError> {
        let records = self.records_for_writing(project).await?;
        let lock = self.records_lock(&records);
        let _writing = lock.lock().await;
        let folder = Self::collection_folder(&records, "artifacts").await?;
        let data = Self::collection_folder(&records, "artifact_data").await?;
        tokio::fs::create_dir_all(&folder).await?;
        tokio::fs::create_dir_all(&data).await?;
        let (mut existing, _) = read_folder(&folder).await?;
        let mut items = Vec::new();
        for item in prepared {
            let key = saturn_domain::research::fingerprint(&item.fields);
            if let Some(record) = existing.iter().find(|record| record["fingerprint"] == key) {
                items.push(record.clone());
                continue;
            }
            if let Some(bytes) = item.bytes {
                write_whole(&data.join(text(&item.fields, "sha256")), &bytes).await?;
            }
            let id = new_id("artifact")?;
            let mut value = new_record("artifacts", &item.fields, &id, &iso_time(now_millis()))
                .map_err(|message| CoreError::new(400, message))?;
            value["fingerprint"] = json!(key);
            write_whole(&folder.join(format!("{id}.json")), &pretty(&value)?).await?;
            existing.push(value.clone());
            items.push(value);
        }
        self.research_changed();
        Ok(json!({ "items": items }))
    }

    /// Registers a user-selected project output or an external reference, without running or fetching it.
    pub async fn research_artifact_register(
        &self,
        project: &str,
        request: &Value,
    ) -> Result<Value, CoreError> {
        let prepared = self.prepare_artifact(project, request, None).await?;
        Ok(self.save_artifacts(project, vec![prepared]).await?["items"][0].clone())
    }

    /// Imports a program's manifest only after every entry has been validated; repeat imports are idempotent.
    pub async fn research_artifact_manifest(
        &self,
        project: &str,
        run_id: &str,
    ) -> Result<Value, CoreError> {
        self.research_run(project, run_id).await?;
        let root = self
            .records_folder(project)
            .await?
            .join("runs")
            .join(run_id);
        if super::is_link(&root).await {
            return Err(CoreError::new(
                403,
                "The run's output directory cannot be a symbolic link.",
            ));
        }
        let manifest = root.join("artifacts.jsonl");
        if super::is_link(&manifest).await {
            return Err(CoreError::new(
                403,
                "An artifact manifest cannot be a symbolic link.",
            ));
        }
        let mut bytes = Vec::new();
        tokio::fs::File::open(manifest)
            .await?
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > 1024 * 1024 {
            return Err(CoreError::new(
                413,
                "Artifact manifests are limited to 1 MiB.",
            ));
        }
        let mut prepared = Vec::new();
        for line in bytes
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
        {
            if prepared.len() >= 100 {
                return Err(CoreError::new(413, "Import at most 100 artifacts at once."));
            }
            let mut request: Value = serde_json::from_slice(line)
                .map_err(|_| CoreError::new(422, "The artifact manifest contains invalid JSON."))?;
            if !request.is_object() {
                return Err(CoreError::new(
                    422,
                    "Each artifact manifest entry must be an object.",
                ));
            }
            request["runId"] = json!(run_id);
            prepared.push(
                self.prepare_artifact(project, &request, Some(&root))
                    .await?,
            );
        }
        self.save_artifacts(project, prepared).await
    }

    /// A verified immutable snapshot, never an HTML document or a source file that has since changed.
    pub async fn research_artifact_content(
        &self,
        project: &str,
        id: &str,
    ) -> Result<Value, CoreError> {
        let record = self.research_record(project, "artifacts", id).await?;
        if record["packaged"] != true {
            return Err(CoreError::new(
                404,
                "This artifact is a reference; its contents are not packaged.",
            ));
        }
        let hash = text(&record, "sha256");
        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(CoreError::new(422, "Invalid artifact content hash."));
        }
        let path = Self::collection_folder(&self.records_folder(project).await?, "artifact_data")
            .await?
            .join(hash);
        if super::is_link(&path).await {
            return Err(CoreError::new(
                403,
                "Artifact data cannot be a symbolic link.",
            ));
        }
        let mut bytes = Vec::new();
        tokio::fs::File::open(&path)
            .await?
            .take(SNAPSHOT_LIMIT + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() as u64 > SNAPSHOT_LIMIT || sha256_hex(&bytes) != hash {
            return Err(CoreError::new(
                409,
                "The stored artifact does not match its recorded hash.",
            ));
        }
        if record["kind"] == "figure" && image_type(&bytes) != record["mime"].as_str() {
            return Err(CoreError::new(415, "Invalid figure content."));
        }
        if record["sourceScope"] == "run" && !saturn_domain::research::is_id(text(&record, "runId"))
        {
            return Err(CoreError::new(422, "Invalid artifact run reference."));
        }
        let source: Option<PathBuf> = if record["sourceScope"] == "run" {
            let root = self
                .records_folder(project)
                .await?
                .join("runs")
                .join(text(&record, "runId"));
            if super::is_link(&root).await {
                None
            } else {
                inside_workspace(&Workspace::new(&root), text(&record, "relativeSource"))
                    .await
                    .ok()
            }
        } else {
            self.source_path(project, text(&record, "sourcePath"), None)
                .await
                .ok()
                .map(|(path, _)| path)
        };
        // A snapshot fetched from a remote host has no source here to compare with, so nothing is said either way.
        let changed = if record["sourceScope"] == "remote" {
            Value::Null
        } else {
            json!(match source {
                Some(path) => super::freeze::hash_file(&path)
                    .await
                    .map_or(true, |(current, _)| current != hash),
                None => true,
            })
        };
        Ok(
            json!({ "data": STANDARD.encode(bytes), "encoding": "base64", "mime": record["mime"], "sha256": hash, "sourceChanged": changed }),
        )
    }
}
