//! A chat's AI involvement and locks on files. This is a workflow constraint, not a security boundary: `docs/research-contract.md`
//! says what each backend can and cannot enforce.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use saturn_domain::policies::is_read_only_call;
use saturn_domain::research::{
    PolicyVerdict, SCHEMA_VERSION, check_policy, policy_verdict, sha256_hex,
};
use saturn_domain::skills::patch::{FileChange, parse_patch};
use saturn_domain::time::{iso_time, now_millis};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;

use super::{RECORDS, is_link, pretty, read_folder, read_record, write_whole};
use crate::records::text;
use crate::{CoreError, Kernel, locked};

/// A file's size and time, by path. Cheap enough to take around every tool call, even over large data.
pub(super) type Signatures = BTreeMap<String, Option<(u64, i128)>>;
/// Runs followed at once; older ones are forgotten and start again from what is there.
const BASELINES_KEPT: usize = 256;

/// A policy that has never been saved.
fn no_policy() -> Value {
    json!({ "schemaVersion": SCHEMA_VERSION, "revision": 0, "locked": [], "released": [] })
}

/// What a tool call writes, from the folder it works in. Unknown tools and failed parses write nothing here.
fn write_targets(tool: &str, arguments: &Value) -> Vec<String> {
    if tool != "files" {
        return Vec::new();
    }
    match text(arguments, "action") {
        "write" => vec![text(arguments, "path").to_owned()],
        "patch" => {
            let patch = match text(arguments, "patch") {
                "" => text(arguments, "content"),
                patch => patch,
            };
            parse_patch(patch)
                .unwrap_or_default()
                .into_iter()
                .flat_map(|change| match change {
                    FileChange::Add { path, .. } | FileChange::Delete { path } => vec![path],
                    FileChange::Update { path, move_to, .. } => {
                        std::iter::once(path).chain(move_to).collect()
                    }
                })
                .collect()
        }
        _ => Vec::new(),
    }
}

/// The path of a target from a root, through links where it exists. Nothing if it is outside the root.
async fn relative_in(root: &Path, requested: &str) -> Option<String> {
    let real_root = tokio::fs::canonicalize(root)
        .await
        .unwrap_or_else(|_| root.to_path_buf());
    let joined = root.join(requested);
    let normal = saturn_domain::skills::workspace::Workspace::new(root)
        .resolve(requested)
        .ok();
    let real = tokio::fs::canonicalize(&joined).await.ok();
    let found = real
        .as_deref()
        .and_then(|path| path.strip_prefix(&real_root).ok().map(Path::to_path_buf))
        .or_else(|| {
            normal.as_deref().and_then(|path| {
                path.strip_prefix(root)
                    .or_else(|_| path.strip_prefix(&real_root))
                    .ok()
                    .map(Path::to_path_buf)
            })
        })?;
    Some(found.to_string_lossy().replace('\\', "/"))
}

impl Kernel {
    /// A project's policy, or the empty one.
    pub async fn research_policy(&self, project: &str) -> Result<Value, CoreError> {
        let records = self.records_folder(project).await?;
        Ok(read_record(&records.join("policy.json"))
            .await
            .map_err(|reason| super::cannot_use("policy", &reason))?
            .unwrap_or_else(no_policy))
    }

    /// Replaces a project's policy, if it is still at the revision the change was based on.
    pub async fn research_set_policy(
        &self,
        project: &str,
        request: &Value,
    ) -> Result<Value, CoreError> {
        let expected = request
            .get("expectedRevision")
            .and_then(Value::as_u64)
            .ok_or_else(|| CoreError::new(400, "A change needs its \"expectedRevision\""))?;
        check_policy(request).map_err(|message| CoreError::new(400, message))?;
        let records = self.records_for_writing(project).await?;
        let lock = self.records_lock(&records);
        let _writing = lock.lock().await;
        let path = records.join("policy.json");
        let current = read_record(&path)
            .await
            .map_err(|reason| super::cannot_use("policy", &reason))?
            .unwrap_or_else(no_policy);
        let revision = current.get("revision").and_then(Value::as_u64).unwrap_or(0);
        if revision != expected {
            return Err(CoreError::new(
                409,
                "The policy has changed. Reload it and try again.",
            ));
        }
        let next = json!({
            "schemaVersion": SCHEMA_VERSION,
            "revision": revision + 1,
            "locked": request.get("locked").cloned().unwrap_or_else(|| json!([])),
            "released": request.get("released").cloned().unwrap_or_else(|| json!([])),
            "updatedAt": iso_time(now_millis()),
        });
        write_whole(&path, &pretty(&next)?).await?;
        self.research_changed();
        Ok(next)
    }

    /// What has been recorded about agents and protected files, newest last.
    pub async fn research_events(&self, project: &str) -> Result<Value, CoreError> {
        let records = self.records_folder(project).await?;
        let text = match tokio::fs::read_to_string(records.join("events.jsonl")).await {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(error.into()),
        };
        let items: Vec<Value> = text
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        Ok(json!({ "items": items }))
    }

    /// The project and folders a run's tools work in, if it is in a project whose records can be used.
    async fn run_scope(&self, run: &Value) -> Option<(String, PathBuf, PathBuf)> {
        let project = self.thread_project(run)?;
        let root = self.workdir_of_run(run).ok().flatten()?;
        let records = self.records_folder(&project).await.ok()?;
        Some((project, root, records))
    }

    /// Paths locked for agents: those the policy names, and the data and scorers of each experiment's newest version.
    async fn locked_paths(&self, records: &Path, policy: &Value) -> Vec<String> {
        let released = crate::records::strings(policy, "released");
        let mut paths = crate::records::strings(policy, "locked");
        let Ok((versions, _)) = read_folder(&records.join("versions")).await else {
            return paths;
        };
        let mut newest: BTreeMap<&str, &Value> = BTreeMap::new();
        for version in &versions {
            let number = |item: &Value| item.get("number").and_then(Value::as_u64).unwrap_or(0);
            let experiment = text(version, "experimentId");
            if newest
                .get(experiment)
                .is_none_or(|held| number(held) < number(version))
            {
                newest.insert(experiment, version);
            }
        }
        for version in newest.values() {
            for input in version
                .get("inputs")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if matches!(text(input, "role"), "data" | "scorer") {
                    paths.push(text(input, "path").to_owned());
                }
            }
        }
        // A released lock stays lifted until the next version, which locks what it uses again.
        paths.retain(|path| !released.iter().any(|lifted| lifted == path));
        paths
    }

    /// Locks the user lifted are over once a new version is frozen: it locks what it uses.
    pub(super) async fn research_clear_released(&self, records: &Path) -> Result<(), CoreError> {
        let path = records.join("policy.json");
        let Some(mut policy) = read_record(&path).await.ok().flatten() else {
            return Ok(());
        };
        if policy
            .get("released")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
        {
            return Ok(());
        }
        policy["released"] = json!([]);
        policy["revision"] = json!(policy.get("revision").and_then(Value::as_u64).unwrap_or(0) + 1);
        policy["updatedAt"] = json!(iso_time(now_millis()));
        write_whole(&path, &pretty(&policy)?).await?;
        self.research_changed();
        Ok(())
    }

    /// What the policy says about an agent writing these paths: the first refusal, or whether any needs the user.
    async fn verdict_on(
        &self,
        run: &Value,
        targets: &[String],
    ) -> Option<(PolicyVerdict, String, u64)> {
        if targets.is_empty() {
            return None;
        }
        let (_, root, records) = self.run_scope(run).await?;
        let policy = read_record(&records.join("policy.json"))
            .await
            .ok()
            .flatten()
            .unwrap_or_else(no_policy);
        let locks = self.locked_paths(&records, &policy).await;
        let chat_mode = self.chat_mode_of(run);
        let revision = policy.get("revision").and_then(Value::as_u64).unwrap_or(0);
        let mut pair = None;
        for target in targets {
            let Some(relative) = relative_in(&root, target).await else {
                continue;
            };
            match policy_verdict(&locks, &relative, chat_mode.as_deref()) {
                PolicyVerdict::Allowed => {}
                PolicyVerdict::NeedsApproval => pair = Some(relative),
                refused => return Some((refused, relative, revision)),
            }
        }
        pair.map(|relative| (PolicyVerdict::NeedsApproval, relative, revision))
    }

    /// Why an agent may not make this tool call, recorded as a confirmed violation.
    pub(crate) async fn research_refusal(
        &self,
        run: &Value,
        tool: &str,
        arguments: &Value,
        action_id: &str,
    ) -> Option<String> {
        let targets = write_targets(tool, arguments);
        self.refusal_for(run, tool, &targets, action_id).await
    }

    /// Why an agent's program may not write this file, recorded as a confirmed violation.
    pub(crate) async fn research_refusal_for_file(
        &self,
        run: &Value,
        tool: &str,
        file: &str,
        action_id: &str,
    ) -> Option<String> {
        self.refusal_for(run, tool, &[file.to_owned()], action_id)
            .await
    }

    async fn refusal_for(
        &self,
        run: &Value,
        tool: &str,
        targets: &[String],
        action_id: &str,
    ) -> Option<String> {
        let (verdict, path, _) = self.verdict_on(run, targets).await?;
        let reason = match verdict {
            PolicyVerdict::Manual => format!(
                "This chat is in Manual mode, so {path} stays as it is: the user writes the code. Suggest the change in words instead."
            ),
            PolicyVerdict::Locked => format!(
                "{path} is locked for this experiment. Changing it needs the user, and makes a new version."
            ),
            PolicyVerdict::Records => {
                format!("{path} is one of Saturn's research records, which agents do not change.")
            }
            PolicyVerdict::NeedsApproval | PolicyVerdict::Allowed => return None,
        };
        self.note_research_event(run, json!({
            "kind": "refused", "path": path, "tool": tool, "actionId": action_id, "reason": reason,
        }))
        .await;
        Some(reason)
    }

    /// The mode of the chat a run belongs to, as it is now: a change while a call waits applies to that call.
    pub(crate) fn chat_mode_of(&self, run: &Value) -> Option<String> {
        let thread = self.find_thread(text(run, "threadId"))?;
        thread
            .get("chatMode")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    /// Why this call must wait for the user even with approvals off: a Pair chat asks about anything that changes something.
    pub(crate) async fn research_needs_approval(
        &self,
        run: &Value,
        tool: &str,
        arguments: &Value,
    ) -> Option<String> {
        let targets = write_targets(tool, arguments);
        match self.verdict_on(run, &targets).await {
            Some((PolicyVerdict::NeedsApproval, path, _)) => Some(format!(
                "This chat is in Pair mode: changes to {path} need your approval"
            )),
            // A refused file is refused when the call runs.
            Some(_) => None,
            None => {
                if self.chat_mode_of(run).as_deref() != Some("pair") {
                    return None;
                }
                let agent = self.get_agent(text(run, "agentId")).ok()?;
                let category = self
                    .store
                    .read(|state| crate::tool_runs::tool_category(state, &agent, tool));
                let arguments = arguments.as_object().cloned().unwrap_or_default();
                (!is_read_only_call(tool, &arguments, category.as_deref()))
                    .then(|| format!("This chat is in Pair mode: {tool} needs your approval"))
            }
        }
    }

    /// The same for a file a program writes.
    pub(crate) async fn research_file_needs_approval(&self, run: &Value, file: &str) -> bool {
        matches!(
            self.verdict_on(run, &[file.to_owned()]).await,
            Some((PolicyVerdict::NeedsApproval, _, _))
        )
    }

    /// A change the user accepted in a Pair chat: what it was, and under which policy.
    pub(crate) async fn research_note_assisted(
        &self,
        run: &Value,
        tool: &str,
        arguments: &Value,
        action_id: &str,
    ) {
        let targets = write_targets(tool, arguments);
        let Some((PolicyVerdict::NeedsApproval, path, revision)) =
            self.verdict_on(run, &targets).await
        else {
            return;
        };
        let change = match text(arguments, "action") {
            "patch" => text(arguments, "patch"),
            _ => text(arguments, "content"),
        };
        let digest = sha256_hex(change.as_bytes());
        if let Some((_, _, records)) = self.run_scope(run).await {
            let objects = records.join("objects");
            if !is_link(&objects).await && tokio::fs::create_dir_all(&objects).await.is_ok() {
                let _ = write_whole(&objects.join(&digest), change.as_bytes()).await;
            }
        }
        self.note_research_event(
            run,
            json!({
                "kind": "assisted", "path": path, "tool": tool, "actionId": action_id,
                "changeSha256": digest, "policyRevision": revision,
            }),
        )
        .await;
    }

    /// Adds a line to the project's record of what happened to protected files.
    async fn note_research_event(&self, run: &Value, mut event: Value) {
        let Some((_, _, records)) = self.run_scope(run).await else {
            return;
        };
        event["runId"] = json!(text(run, "id"));
        event["at"] = json!(iso_time(now_millis()));
        let Ok(line) = serde_json::to_string(&event) else {
            return;
        };
        let lock = self.records_lock(&records);
        let _writing = lock.lock().await;
        if tokio::fs::create_dir_all(&records).await.is_err() {
            return;
        }
        let path = records.join("events.jsonl");
        if is_link(&path).await {
            return;
        }
        let opened = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await;
        if let Ok(mut file) = opened {
            let _ = file.write_all(format!("{line}\n").as_bytes()).await;
            self.research_changed();
        }
    }

    /// The size and time of everything protected in a run's folder: locked files, the policy, the verdicts
    /// and the frozen versions.
    async fn protected_signatures(&self, run: &Value) -> Option<Signatures> {
        let (_, root, records) = self.run_scope(run).await?;
        let policy = read_record(&records.join("policy.json"))
            .await
            .ok()
            .flatten()
            .unwrap_or_else(no_policy);
        let mut files: Vec<(String, PathBuf)> = self
            .locked_paths(&records, &policy)
            .await
            .into_iter()
            .map(|path| (path.clone(), root.join(path)))
            .collect();
        files.push((
            format!("{RECORDS}/policy.json"),
            records.join("policy.json"),
        ));
        for folder in ["hypotheses", "versions"] {
            if let Ok(mut entries) = tokio::fs::read_dir(records.join(folder)).await {
                while let Ok(Some(entry)) = entries.next_entry().await {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    files.push((format!("{RECORDS}/{folder}/{name}"), entry.path()));
                }
            }
        }
        let mut signatures = Signatures::new();
        for (name, path) in files {
            let info = tokio::fs::symlink_metadata(&path).await.ok();
            let signature = info.map(|info| {
                let modified = info
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |since| since.as_nanos() as i128);
                (info.len(), modified)
            });
            signatures.insert(name, signature);
        }
        Some(signatures)
    }

    /// Starts following a run's protected files, unless they already are.
    pub(crate) async fn research_watch_run(&self, run: &Value) {
        let id = text(run, "id").to_owned();
        if locked(&self.research.baselines).contains_key(&id) {
            return;
        }
        if let Some(signatures) = self.protected_signatures(run).await {
            let mut baselines = locked(&self.research.baselines);
            if baselines.len() >= BASELINES_KEPT {
                baselines.clear();
            }
            baselines.entry(id).or_insert(signatures);
        }
    }

    /// Forgets what a run's protected files looked like, after a change the run made through Saturn itself.
    pub(super) fn research_forget_baseline(&self, run: &Value) {
        locked(&self.research.baselines).remove(text(run, "id"));
    }

    /// Records what changed among a run's protected files since it was last looked at. Who changed them is not known:
    /// the user may have edited one, so this says only that it changed.
    pub(crate) async fn research_check_run(&self, run: &Value, tool: &str) {
        let id = text(run, "id");
        let Some(now) = self.protected_signatures(run).await else {
            return;
        };
        let changed: Vec<String> = {
            let mut baselines = locked(&self.research.baselines);
            let Some(before) = baselines.get(id) else {
                baselines.insert(id.to_owned(), now);
                return;
            };
            let changed = now
                .iter()
                .filter(|(path, signature)| {
                    before.get(*path).is_some_and(|held| held != *signature)
                })
                .map(|(path, _)| path.clone())
                .collect();
            baselines.insert(id.to_owned(), now);
            changed
        };
        if !changed.is_empty() {
            self.note_research_event(
                run,
                json!({
                    "kind": "integrity_changed", "paths": changed, "afterTool": tool,
                }),
            )
            .await;
        }
    }
}
