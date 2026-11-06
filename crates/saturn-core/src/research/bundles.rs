//! Portable research evidence: whitelisted files with hashes, explicit external dependencies, and no execution authority.
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use base64::{Engine, engine::general_purpose::STANDARD};
use saturn_domain::research::{
    id_prefix, is_id, new_record, sample_identity, sha256_hex, unusable,
};
use saturn_domain::time::{iso_time, now_millis};
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;

use super::{is_link, pretty, read_folder, write_whole};
use crate::records::text;
use crate::{CoreError, Kernel};

const COLLECTIONS: [&str; 10] = [
    "questions",
    "hypotheses",
    "experiments",
    "versions",
    "models",
    "findings",
    "counterexamples",
    "counterexample_sets",
    "inspection_sessions",
    "artifacts",
];
const STREAMS: [&str; 10] = [
    "samples.jsonl",
    "metrics.jsonl",
    "artifacts.jsonl",
    "resources.jsonl",
    "stdout.log",
    "stderr.log",
    "run.json",
    "evidence.json",
    "report.jsonl",
    "snapshot.json",
];
const MAX_DATA: usize = 64 * 1024 * 1024;
const MAX_BUNDLE: u64 = 96 * 1024 * 1024;
const MAX_FILES: usize = 5000;
const FORMAT: &str = "saturn.research.bundle";
const NOTE: &str = "An evidence archive, not a guarantee of reproducibility. External weights, datasets, scorers and environments are listed, not downloaded or restored. Imported execution contexts are read-only archives; running research again requires a new local version or inspection session.";

/// A manifest entry decoded and validated before any destination file is touched.
struct Entry {
    path: String,
    bytes: Vec<u8>,
}

/// A hash used as a file name cannot name a path.
fn hash_name(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// The only extractable namespaces are research records and their evidence, never configuration or control files.
fn permitted(path: &str) -> bool {
    let parts: Vec<_> = path.split('/').collect();
    if path.contains('\\')
        || parts
            .iter()
            .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return false;
    }
    let record = |collection: &str, file: &str| {
        file.strip_suffix(".json").is_some_and(|id| {
            is_id(id)
                && id_prefix(collection).is_some_and(|prefix| id.starts_with(&format!("{prefix}_")))
        })
    };
    match parts.as_slice() {
        [collection, file] if COLLECTIONS.contains(collection) => record(collection, file),
        ["labels", file] => file
            .strip_suffix(".json")
            .is_some_and(|id| is_id(id) && id.starts_with("run_")),
        ["objects" | "artifact_data", hash] => hash_name(hash),
        ["runs", id, file] => is_id(id) && id.starts_with("run_") && STREAMS.contains(file),
        ["runs" | "inspection_sessions", id, "inside", file] => {
            is_id(id)
                && file.strip_suffix(".json").is_some_and(|stem| {
                    !stem.is_empty()
                        && stem.len() <= 128
                        && stem
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
                })
        }
        _ => false,
    }
}

/// Refuses every existing symlink component, including a collection directory, before reading or linking a file.
async fn destination(root: &Path, relative: &str) -> Result<PathBuf, CoreError> {
    if !permitted(relative) {
        return Err(CoreError::new(
            403,
            "This bundle path is not research evidence.",
        ));
    }
    let mut path = root.to_owned();
    for part in relative.split('/') {
        path.push(part);
        if is_link(&path).await {
            return Err(CoreError::new(
                403,
                "Research bundles never follow symbolic links.",
            ));
        }
    }
    Ok(path)
}

/// Reads a bounded snapshot rather than a changing source's eventual full size.
async fn bounded(path: &Path, limit: u64) -> Result<Vec<u8>, CoreError> {
    let mut bytes = Vec::new();
    tokio::fs::File::open(path)
        .await?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() as u64 > limit {
        return Err(CoreError::new(
            413,
            "The research bundle exceeds its size limit.",
        ));
    }
    Ok(bytes)
}

/// Escapes user/model content for static HTML, including titles and observations.
fn escaped(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Markdown fields are text, never injected links or raw HTML.
fn markdown(value: &str) -> String {
    let mut output = escaped(value);
    for character in ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '|'] {
        output = output.replace(character, &format!("\\{character}"));
    }
    output
}

/// Builds a static report from recorded claims and evidence identities, without inventing any conclusion.
fn report(
    records: &BTreeMap<String, Vec<Value>>,
    files: &[Value],
    external: &[Value],
    missing: &[Value],
) -> Value {
    let mut md = format!(
        "# Saturn research evidence\n\n{NOTE}\n\n{} packaged files; {} external references; {} unavailable saved files.\n\n",
        files.len(),
        external.len(),
        missing.len()
    );
    let mut html = format!(
        "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>Saturn research evidence</title><style>body{{font:15px/1.6 system-ui,sans-serif;max-width:1000px;margin:36px auto;padding:0 24px;color:#222}}section{{margin:28px 0}}pre,code{{overflow-wrap:anywhere;white-space:pre-wrap}}li{{margin:8px 0}}small{{color:#555}}</style><h1>Saturn research evidence</h1><p>{}</p><p>{} packaged files; {} external references; {} unavailable saved files.</p>",
        escaped(NOTE),
        files.len(),
        external.len(),
        missing.len()
    );
    for (collection, title) in [
        ("questions", "Questions"),
        ("hypotheses", "Hypotheses and recorded verdicts"),
        ("experiments", "Experiments"),
        ("runs", "Runs and recorded counts"),
        ("models", "Model references"),
        ("findings", "Recorded observations and conclusions"),
        ("counterexample_sets", "Saved regression cohorts"),
        ("inspection_sessions", "Exploratory sessions"),
        ("artifacts", "Analysis outputs"),
    ] {
        let items = records.get(collection).cloned().unwrap_or_default();
        if items.is_empty() {
            continue;
        }
        md.push_str(&format!("## {title}\n\n"));
        html.push_str(&format!("<section><h2>{title}</h2><ul>"));
        for item in items {
            let label = item
                .get("title")
                .or_else(|| item.get("text"))
                .or_else(|| item.get("name"))
                .or_else(|| item.get("source"))
                .and_then(Value::as_str)
                .unwrap_or("Recorded item");
            let details = if collection == "hypotheses" {
                format!("Verdict: {}", text(&item, "verdict"))
            } else if collection == "findings" {
                format!(
                    "Kind: {}; runs: {}; inspections: {}",
                    text(&item, "kind"),
                    item.get("runIds").unwrap_or(&Value::Null),
                    item.get("inspectionIds").unwrap_or(&Value::Null)
                )
            } else if collection == "runs" {
                format!(
                    "Status: {}; samples: {}; version: {}; errors: {}; sample SHA-256: {}",
                    text(&item, "status"),
                    item.get("samples").unwrap_or(&Value::Null),
                    text(&item, "versionId"),
                    item.get("errors").unwrap_or(&Value::Null),
                    text(&item, "samplesSha256")
                )
            } else if collection == "counterexample_sets" {
                format!(
                    "Recorded comparison summary: {}",
                    item.get("summary").unwrap_or(&Value::Null)
                )
            } else {
                format!(
                    "{}",
                    item.get("weightsRevision")
                        .or_else(|| item.get("sha256"))
                        .unwrap_or(&Value::Null)
                )
            };
            md.push_str(&format!(
                "- {} — {}. {}\n",
                markdown(label),
                markdown(text(&item, "id")),
                markdown(&details)
            ));
            html.push_str(&format!(
                "<li><strong>{}</strong><br><small>{} · {}</small></li>",
                escaped(label),
                escaped(text(&item, "id")),
                escaped(&details)
            ));
        }
        md.push('\n');
        html.push_str("</ul></section>");
    }
    md.push_str("## Evidence files\n\n");
    html.push_str("<section><h2>Evidence files</h2><ul>");
    for file in files {
        let description = format!(
            "{} · {} bytes · SHA-256 {}",
            text(file, "path"),
            file["size"],
            text(file, "sha256")
        );
        md.push_str(&format!("- {}\n", markdown(&description)));
        html.push_str(&format!("<li><code>{}</code></li>", escaped(&description)));
    }
    html.push_str("</ul></section>");
    for (title, values) in [
        ("External dependencies (not packaged)", external),
        ("Unavailable saved evidence", missing),
    ] {
        if values.is_empty() {
            continue;
        }
        md.push_str(&format!("\n## {title}\n\n"));
        html.push_str(&format!("<section><h2>{title}</h2><ul>"));
        for value in values {
            let value = value.to_string();
            md.push_str(&format!("- {}\n", markdown(&value)));
            html.push_str(&format!("<li><code>{}</code></li>", escaped(&value)));
        }
        html.push_str("</ul></section>");
    }
    html.push_str("</html>");
    json!({ "markdown": md, "html": html })
}

/// Parses and validates the complete archive, not just the files currently visible in the UI.
fn decode(bytes: &[u8]) -> Result<(Value, Vec<Entry>), CoreError> {
    let mut bundle: Value = serde_json::from_slice(bytes)
        .map_err(|_| CoreError::new(422, "This is not a JSON research bundle."))?;
    if bundle["format"] != FORMAT || bundle["schemaVersion"] != 1 {
        return Err(CoreError::new(422, "Unsupported research bundle format."));
    }
    for field in ["external", "unavailable"] {
        if bundle.get(field).is_none() {
            bundle[field] = json!([]);
        }
        if !bundle[field]
            .as_array()
            .is_some_and(|items| items.len() <= MAX_FILES)
        {
            return Err(CoreError::new(422, "Invalid external dependency manifest."));
        }
    }
    let files = bundle
        .get("files")
        .and_then(Value::as_array)
        .filter(|files| !files.is_empty() && files.len() <= MAX_FILES)
        .ok_or_else(|| CoreError::new(422, "A bundle needs 1 to 5,000 evidence files."))?;
    let mut entries = Vec::new();
    let mut seen = BTreeSet::new();
    let mut total = 0;
    for file in files {
        let path = text(file, "path");
        if file["encoding"] != "base64" {
            return Err(CoreError::new(
                422,
                "Bundle files must use base64 encoding.",
            ));
        }
        if !permitted(path) {
            return Err(CoreError::new(
                403,
                "This bundle contains a path outside research evidence.",
            ));
        }
        if !seen.insert(path.to_owned()) {
            return Err(CoreError::new(422, "A bundle path is repeated."));
        }
        let data = STANDARD
            .decode(text(file, "data"))
            .map_err(|_| CoreError::new(422, "Invalid bundle data encoding."))?;
        total += data.len();
        if total > MAX_DATA {
            return Err(CoreError::new(
                413,
                "Decoded research evidence exceeds 64 MiB.",
            ));
        }
        if file["size"].as_u64() != Some(data.len() as u64)
            || text(file, "sha256") != sha256_hex(&data)
        {
            return Err(CoreError::new(
                422,
                "Bundle evidence does not match its size or hash.",
            ));
        }
        let parts: Vec<_> = path.split('/').collect();
        if parts.len() == 2 && COLLECTIONS.contains(&parts[0])
            || parts.len() == 3 && parts[0] == "runs" && parts[2] == "run.json"
        {
            let record: Value = serde_json::from_slice(&data)
                .map_err(|_| CoreError::new(422, "A bundled record is not JSON."))?;
            if let Some(reason) = unusable(&record) {
                return Err(CoreError::new(422, reason));
            }
            let id = if parts[0] == "runs" {
                parts[1]
            } else {
                parts[1].strip_suffix(".json").unwrap_or("")
            };
            if text(&record, "id") != id {
                return Err(CoreError::new(
                    422,
                    "A record's ID disagrees with its bundle path.",
                ));
            }
            if COLLECTIONS.contains(&parts[0]) {
                new_record(parts[0], &record, id, text(&record, "createdAt"))
                    .map_err(|reason| CoreError::new(422, reason))?;
            }
        }
        if matches!(parts[0], "objects" | "artifact_data") && parts[1] != sha256_hex(&data) {
            return Err(CoreError::new(
                422,
                "A content-addressed object is corrupt.",
            ));
        }
        entries.push(Entry {
            path: path.to_owned(),
            bytes: data,
        });
    }
    Ok((bundle, entries))
}

/// Archived contexts carry evidence, not permission to execute an imported command or interpreter.
fn archive(entries: &mut [Entry]) -> Result<(), CoreError> {
    let samples: BTreeMap<String, Vec<u8>> = entries
        .iter()
        .filter_map(|entry| {
            entry
                .path
                .strip_suffix("/samples.jsonl")
                .map(|path| (path.to_owned(), entry.bytes.clone()))
        })
        .collect();
    for entry in entries {
        let is_run = entry.path.starts_with("runs/") && entry.path.ends_with("/run.json");
        let is_context = entry.path.starts_with("versions/")
            || entry.path.starts_with("inspection_sessions/") && entry.path.split('/').count() == 2;
        if !is_run && !is_context {
            continue;
        }
        let mut record: Value = serde_json::from_slice(&entry.bytes)
            .map_err(|_| CoreError::new(422, "Invalid execution context."))?;
        record["archived"] = json!(true);
        if is_run {
            if saturn_domain::research::run_is_active(text(&record, "status")) {
                record["status"] = json!("interrupted");
                record["process"] = json!("archived");
                if let Some(bytes) = samples.get(entry.path.strip_suffix("/run.json").unwrap_or(""))
                {
                    let end = bytes
                        .iter()
                        .rposition(|byte| *byte == b'\n')
                        .map_or(0, |index| index + 1);
                    let count = bytes[..end]
                        .split(|byte| *byte == b'\n')
                        .filter(|line| !line.is_empty())
                        .filter(|line| {
                            serde_json::from_slice::<Value>(line)
                                .is_ok_and(|sample| sample_identity(&sample).is_ok())
                        })
                        .count();
                    record["samplesSize"] = json!(end);
                    record["samplesSha256"] = json!(sha256_hex(&bytes[..end]));
                    record["samples"] = json!(count);
                }
            }
            if record.get("remote").is_some() {
                record["remoteConnection"] = json!("archived");
            }
            if let Some(fields) = record.as_object_mut() {
                for key in ["pid", "threadId", "cancelRequested"] {
                    fields.remove(key);
                }
            }
        }
        entry.bytes = pretty(&record)?;
    }
    Ok(())
}

impl Kernel {
    /// Collects this project's research evidence only. Referenced weights/data/environments are never fetched.
    async fn collect_bundle(&self, project: &str) -> Result<Value, CoreError> {
        let root = self.records_folder(project).await?;
        let lock = self.records_lock(&root);
        let _reading = lock.lock().await;
        let mut records = BTreeMap::new();
        let mut paths = BTreeSet::new();
        let mut external = Vec::new();
        let mut missing = Vec::new();
        for collection in COLLECTIONS {
            let folder = Self::collection_folder(&root, collection).await?;
            let (items, problems) = read_folder(&folder).await?;
            if !problems.is_empty() {
                return Err(CoreError::new(
                    422,
                    "A research record is damaged or newer; resolve it before exporting.",
                ));
            }
            for item in &items {
                paths.insert(format!("{collection}/{}.json", text(item, "id")));
            }
            records.insert(collection.to_owned(), items);
        }
        for model in records.get("models").into_iter().flatten() {
            external.push(json!({ "kind": "model_weights", "modelId": model["id"], "source": model["source"], "revision": model["weightsRevision"], "packaged": false }));
        }
        for version in records.get("versions").into_iter().flatten() {
            if !version["git"].is_null() {
                external.push(json!({ "kind": "source_repository", "versionId": version["id"], "git": version["git"], "packaged": false }));
            }
            for input in version["inputs"].as_array().into_iter().flatten() {
                external.push(json!({ "kind": "declared_input", "versionId": version["id"], "input": input, "packaged": false }));
            }
            for file in version["changedFiles"].as_array().into_iter().flatten() {
                if file["saved"] == true {
                    paths.insert(format!("objects/{}", text(file, "sha256")));
                } else if !file["sha256"].is_null() {
                    external.push(json!({ "kind": "uncopied_source", "versionId": version["id"], "file": file, "packaged": false }));
                }
            }
        }
        for artifact in records.get("artifacts").into_iter().flatten() {
            if artifact["packaged"] == true {
                paths.insert(format!("artifact_data/{}", text(artifact, "sha256")));
            } else {
                external.push(json!({ "kind": "artifact_reference", "artifactId": artifact["id"], "uri": artifact.get("uri"), "path": artifact.get("sourcePath"), "sha256": artifact.get("sha256"), "packaged": false }));
            }
        }
        let (runs, problems) = super::runs::read_runs(&root).await?;
        if !problems.is_empty() {
            return Err(CoreError::new(
                422,
                "A run record cannot be read; resolve it before exporting.",
            ));
        }
        for run in &runs {
            let id = text(run, "id");
            for name in STREAMS {
                let path = format!("runs/{id}/{name}");
                let target = destination(&root, &path).await?;
                if tokio::fs::try_exists(target).await? {
                    paths.insert(path);
                }
            }
            let labels = format!("labels/{id}.json");
            if tokio::fs::try_exists(destination(&root, &labels).await?).await? {
                paths.insert(labels);
            }
        }
        records.insert("runs".to_owned(), runs.clone());
        for (namespace, ids) in [
            (
                "runs",
                runs.iter()
                    .map(|run| text(run, "id").to_owned())
                    .collect::<Vec<_>>(),
            ),
            (
                "inspection_sessions",
                records
                    .get("inspection_sessions")
                    .into_iter()
                    .flatten()
                    .map(|session| text(session, "id").to_owned())
                    .collect(),
            ),
        ] {
            for id in ids {
                let folder = root.join(namespace).join(&id).join("inside");
                if is_link(&root.join(namespace).join(&id)).await || is_link(&folder).await {
                    return Err(CoreError::new(403, "Bundle evidence is a symbolic link."));
                }
                if let Ok(mut entries) = tokio::fs::read_dir(folder).await {
                    while let Some(entry) = entries.next_entry().await? {
                        let name = entry.file_name().to_string_lossy().into_owned();
                        if name.ends_with(".json") {
                            paths.insert(format!("{namespace}/{id}/inside/{name}"));
                        }
                    }
                }
            }
        }
        let mut files = Vec::new();
        let mut total = 0;
        if paths.len() > MAX_FILES {
            return Err(CoreError::new(
                413,
                "Export at most 5,000 files per research bundle.",
            ));
        }
        for relative in paths {
            let path = destination(&root, &relative).await?;
            if !tokio::fs::try_exists(&path).await? {
                missing
                    .push(json!({ "path": relative, "reason": "Saved evidence is unavailable" }));
                continue;
            }
            let bytes = bounded(&path, (MAX_DATA - total) as u64).await?;
            total += bytes.len();
            let hash = sha256_hex(&bytes);
            if (relative.starts_with("objects/") || relative.starts_with("artifact_data/"))
                && relative.rsplit('/').next() != Some(hash.as_str())
            {
                return Err(CoreError::new(
                    409,
                    "A saved content-addressed object changed; it cannot stand for its original evidence.",
                ));
            }
            files.push(json!({ "path": relative, "size": bytes.len(), "sha256": hash, "encoding": "base64", "data": STANDARD.encode(&bytes) }));
        }
        let report = report(&records, &files, &external, &missing);
        Ok(
            json!({ "format": FORMAT, "schemaVersion": 1, "createdAt": iso_time(now_millis()), "files": files, "external": external, "unavailable": missing, "report": report, "note": NOTE }),
        )
    }

    /// Exports a complete project research archive and static, escaped Markdown/HTML reports; never replaces files.
    pub async fn research_bundle_export(
        &self,
        project: &str,
        request: &Value,
    ) -> Result<Value, CoreError> {
        let bundle = self.collect_bundle(project).await?;
        if bundle["files"].as_array().is_none_or(Vec::is_empty) {
            return Err(CoreError::new(
                422,
                "This project has no research evidence to export.",
            ));
        }
        let bytes = pretty(&bundle)?;
        if bytes.len() as u64 > MAX_BUNDLE {
            return Err(CoreError::new(413, "The serialized bundle exceeds 96 MiB."));
        }
        let default = format!(
            "exports/research-{}.saturn.json",
            saturn_domain::random_hex(8)?
        );
        let path = request
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or(&default);
        let base = path.strip_suffix(".json").unwrap_or(path);
        let md_path = format!("{base}.md");
        let html_path = format!("{base}.html");
        let targets = [path, md_path.as_str(), html_path.as_str()];
        for name in targets {
            let (target, _) = self.source_path(project, name, None).await?;
            if tokio::fs::try_exists(target).await? {
                return Err(CoreError::new(
                    409,
                    "An export file already exists. Choose a new path.",
                ));
            }
        }
        // writeSource's revision check makes a concurrent creation a conflict instead of overwriting it.
        self.research_source_write(
            project,
            path,
            std::str::from_utf8(&bytes).map_err(|_| CoreError::new(500, "Invalid bundle text."))?,
            None,
            None,
        )
        .await?;
        self.research_source_write(
            project,
            &md_path,
            text(&bundle["report"], "markdown"),
            None,
            None,
        )
        .await?;
        self.research_source_write(
            project,
            &html_path,
            text(&bundle["report"], "html"),
            None,
            None,
        )
        .await?;
        Ok(
            json!({ "path": path, "markdownPath": md_path, "htmlPath": html_path, "files": bundle["files"].as_array().map_or(0, Vec::len), "external": bundle["external"], "unavailable": bundle["unavailable"], "sha256": sha256_hex(&bytes), "note": NOTE }),
        )
    }

    /// Previews or imports a bundle. All payloads, paths, collisions and symlinks are checked before publication.
    pub async fn research_bundle_import(
        &self,
        project: &str,
        request: &Value,
        preview: bool,
    ) -> Result<Value, CoreError> {
        let (source, _) = self
            .source_path(project, text(request, "path"), None)
            .await?;
        let bytes = bounded(&source, MAX_BUNDLE).await?;
        let hash = sha256_hex(&bytes);
        if request
            .get("expectedSha256")
            .and_then(Value::as_str)
            .is_some_and(|expected| expected != hash)
        {
            return Err(CoreError::new(409, "The bundle changed after preview."));
        }
        let (bundle, mut entries) = tokio::task::spawn_blocking(move || decode(&bytes))
            .await
            .map_err(|error| CoreError::new(500, error.to_string()))??;
        let active = entries
            .iter()
            .filter(|entry| entry.path.starts_with("runs/") && entry.path.ends_with("/run.json"))
            .filter(|entry| {
                serde_json::from_slice::<Value>(&entry.bytes)
                    .is_ok_and(|run| saturn_domain::research::run_is_active(text(&run, "status")))
            })
            .count();
        let info = json!({ "sha256": hash, "files": entries.len(), "activeRuns": active, "external": bundle["external"], "unavailable": bundle["unavailable"], "note": NOTE });
        if preview {
            return Ok(info);
        }
        archive(&mut entries)?;
        let root = self.records_for_writing(project).await?;
        let lock = self.records_lock(&root);
        let _writing = lock.lock().await;
        // Evidence for a run this project already has may come only with that same run: a bundle cannot attach its labels,
        // metrics or inspections to someone else's run.
        let carried: std::collections::HashSet<String> = entries
            .iter()
            .filter_map(|entry| {
                entry
                    .path
                    .strip_prefix("runs/")?
                    .strip_suffix("/run.json")
                    .map(str::to_owned)
            })
            .collect();
        for entry in &entries {
            let run = entry
                .path
                .strip_prefix("runs/")
                .and_then(|rest| rest.split('/').next())
                .or_else(|| entry.path.strip_prefix("labels/")?.strip_suffix(".json"));
            if let Some(run) = run
                && !carried.contains(run)
                && tokio::fs::try_exists(root.join("runs").join(run).join("run.json")).await?
            {
                return Err(CoreError::new(
                    409,
                    format!(
                        "{} belongs to {run}, a run this project already has, and the bundle does not carry that run. Nothing was imported.",
                        entry.path
                    ),
                ));
            }
        }
        let mut planned = Vec::new();
        let mut reused = 0;
        for entry in entries {
            let target = destination(&root, &entry.path).await?;
            if tokio::fs::try_exists(&target).await? {
                let current = bounded(&target, MAX_DATA as u64).await?;
                if current == entry.bytes
                    || serde_json::from_slice::<Value>(&current)
                        .ok()
                        .zip(serde_json::from_slice::<Value>(&entry.bytes).ok())
                        .is_some_and(|(a, b)| a == b)
                {
                    reused += 1;
                    continue;
                }
                return Err(CoreError::new(
                    409,
                    format!(
                        "Research evidence already exists at {} with different contents. Import into a new project; nothing was overwritten.",
                        entry.path
                    ),
                ));
            }
            planned.push(entry);
        }
        let stage = root.join(format!(".import-{}", saturn_domain::random_hex(8)?));
        tokio::fs::create_dir(&stage).await?;
        let mut linked: Vec<(PathBuf, String)> = Vec::new();
        let result: Result<(), CoreError> = async {
            for entry in &planned {
                let path = stage.join(&entry.path);
                if let Some(parent) = path.parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }
                write_whole(&path, &entry.bytes).await?;
            }
            for entry in &planned {
                let target = destination(&root, &entry.path).await?;
                if let Some(parent) = target.parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }
                tokio::fs::hard_link(stage.join(&entry.path), &target)
                    .await
                    .map_err(|error| {
                        CoreError::new(
                            409,
                            format!(
                                "Could not publish an evidence file without overwriting: {error}"
                            ),
                        )
                    })?;
                linked.push((target, sha256_hex(&entry.bytes)));
            }
            Ok(())
        }
        .await;
        if result.is_err() {
            for (path, expected) in &linked {
                if super::freeze::hash_file(path)
                    .await
                    .is_ok_and(|(hash, _)| hash == *expected)
                {
                    let _ = tokio::fs::remove_file(path).await;
                }
            }
        }
        let _ = tokio::fs::remove_dir_all(&stage).await;
        result?;
        self.research_changed();
        Ok(
            json!({ "imported": planned.len(), "reused": reused, "activeRunsArchived": active, "sha256": hash, "note": NOTE }),
        )
    }
}
