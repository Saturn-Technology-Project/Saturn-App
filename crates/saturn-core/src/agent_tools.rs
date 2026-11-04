//! The tools an agent has for automations, widget templates, customizations, legacy workflows and plugins. Automations and
//! plugins go through the kernel, so they get the same checks and scheduling as their pages in the app. What they write in
//! the workspace stays there: a cloned repository can bring links that lead elsewhere.
use std::path::{Path, PathBuf};
use std::sync::Arc;

use jiff::tz::TimeZone;
use regex::Regex;
use saturn_domain::js;
use saturn_domain::schedule::{cron_to_trigger, trigger_to_cron};
use saturn_domain::skills::workspace::Workspace;
use saturn_tools::file::inside_workspace;
use serde_json::{Value, json};

use crate::automations::valid_time_zone;
use crate::records::text;
use crate::{CoreError, Kernel};

/// Starter snippets for a widget, by type.
const WIDGET_TEMPLATES: &str = include_str!("widget-templates.json");

/// A failure as the tool's result says it.
fn said(error: CoreError) -> String {
    error.message
}

/// `String(args[name] || fallback)`.
fn or_default(args: &Value, name: &str, fallback: &str) -> String {
    if js::truthy(args.get(name)) {
        js::text(args.get(name))
    } else {
        fallback.to_owned()
    }
}

/// A name made of what a folder may safely be called.
fn plain_name(args: &Value, fallback: &str) -> String {
    or_default(args, "name", fallback)
        .to_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '_' | '-')
            {
                character
            } else {
                '-'
            }
        })
        .collect()
}

/// A path under the workspace to write to, which no symbolic link can lead out of it.
async fn writable(workspace: &Path, parts: &[&str]) -> Result<PathBuf, String> {
    tokio::fs::create_dir_all(workspace)
        .await
        .map_err(|error| error.to_string())?;
    let relative: PathBuf = parts.iter().collect();
    inside_workspace(&Workspace::new(workspace), &relative.to_string_lossy()).await
}

/// Writes a file, with the folders it needs.
async fn write(target: &Path, content: &[u8]) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    tokio::fs::write(target, content)
        .await
        .map_err(|error| error.to_string())
}

/// Copies a folder, leaving links behind: a plugin carries its own files, not ones from elsewhere on the computer.
async fn copy_without_links(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut pending = vec![(from.to_path_buf(), to.to_path_buf())];
    while let Some((source, target)) = pending.pop() {
        tokio::fs::create_dir_all(&target).await?;
        let mut entries = tokio::fs::read_dir(&source).await?;
        while let Some(entry) = entries.next_entry().await? {
            let kind = entry.file_type().await?;
            let into = target.join(entry.file_name());
            if kind.is_dir() {
                pending.push((entry.path(), into));
            } else if kind.is_file() {
                tokio::fs::copy(entry.path(), into).await?;
            }
        }
    }
    Ok(())
}

/// The files of a folder, with whether each is a real file and not a link. No folder is no files.
async fn listing(folder: &Path) -> Vec<(String, std::fs::FileType)> {
    let mut found = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(folder).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            if let Ok(kind) = entry.file_type().await {
                found.push((entry.file_name().to_string_lossy().into_owned(), kind));
            }
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

impl Kernel {
    /// Runs one of these tools for `agent_id`, in `workspace`.
    pub async fn run_agent_tool(
        self: &Arc<Self>,
        tool: &str,
        args: &Value,
        agent_id: &str,
        workspace: &Path,
    ) -> Result<Value, String> {
        match tool {
            "automation_list" => Ok(self.automation_list(args)),
            "automation_create" => self.automation_create(args, agent_id).await,
            "automation_trigger" => self.automation_trigger(args).await,
            "automation_toggle" => self.automation_toggle(args).await,
            "automation_delete" => {
                let id = js::text(args.get("automationId"));
                self.delete_automation(&id).await.map_err(said)?;
                Ok(
                    json!({ "success": true, "automationId": id, "message": format!("Automation {id} deleted.") }),
                )
            }
            "generative_ui_template" => Ok(widget_template(args)),
            "customizations_list" => Ok(customizations_list(args, workspace).await),
            "customizations_create_skill" => create_skill(args, workspace).await,
            "customizations_create_rule" => create_rule(args, workspace).await,
            "workflows_scan" => Ok(workflows_scan(workspace).await),
            "workflows_migrate" => workflows_migrate(args, workspace).await,
            "plugins_list" => {
                let all = self.list_plugins().await;
                let plugins: Vec<Value> =
                    if args.get("includeDisabled") == Some(&Value::Bool(false)) {
                        all.into_iter()
                            .filter(|plugin| js::truthy(plugin.get("enabled")))
                            .collect()
                    } else {
                        all
                    };
                Ok(json!({ "total": plugins.len(), "plugins": plugins }))
            }
            "plugins_bundle" => plugins_bundle(args, workspace).await,
            "plugins_toggle" => {
                let name = js::text(args.get("pluginName"));
                let enabled = js::truthy(args.get("enabled"));
                self.set_plugin_enabled(&name, enabled)
                    .await
                    .map_err(said)?;
                let state = if enabled { "on" } else { "off" };
                Ok(
                    json!({ "success": true, "pluginName": name, "enabled": enabled, "message": format!("Plugin \"{name}\" is now {state}.") }),
                )
            }
            _ => Err(format!("Unknown Antigravity skill tool: {tool}")),
        }
    }

    fn automation_list(&self, args: &Value) -> Value {
        let automations = self.list_automations();
        let filter = or_default(args, "filter", "all");
        let shown: Vec<Value> = automations
            .iter()
            .filter(|item| {
                let enabled = js::truthy(item.get("enabled"));
                match filter.as_str() {
                    "enabled" => enabled,
                    "disabled" => !enabled,
                    _ => true,
                }
            })
            .map(describe)
            .collect();
        json!({ "total": automations.len(), "filter": filter, "automations": shown })
    }

    async fn automation_create(&self, args: &Value, agent_id: &str) -> Result<Value, String> {
        let agent = if js::truthy(args.get("agentId")) {
            js::text(args.get("agentId"))
        } else {
            agent_id.to_owned()
        };
        let cron = js::text(args.get("cron"));
        let (trigger, zone) = cron_to_trigger(&cron, |zone| {
            valid_time_zone(Some(&json!(zone))).map_err(said)
        })?;
        let zone =
            zone.unwrap_or_else(|| TimeZone::system().iana_name().unwrap_or("UTC").to_owned());
        let created = self
            .create_automation(&json!({
                "name": js::text(args.get("name")),
                "prompt": js::text(args.get("prompt")),
                "agentId": agent,
                "trigger": trigger,
                "timeZone": zone,
                "enabled": args.get("enabled") != Some(&Value::Bool(false)),
            }))
            .await
            .map_err(said)?;
        let next = created["nextRun"].as_str().unwrap_or("when enabled");
        Ok(json!({
            "success": true,
            "automation": describe(&created),
            "message": format!("Automation \"{}\" created; next run {next} ({}).", text(&created, "name"), text(&created, "timeZone")),
        }))
    }

    async fn automation_trigger(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let ran = self
            .run_automation(&js::text(args.get("automationId")))
            .await
            .map_err(said)?;
        let name = text(&ran, "name");
        let error = ran.get("lastError").filter(|error| js::truthy(Some(error)));
        Ok(json!({
            "success": error.is_none(),
            "automationId": ran["id"],
            "status": if error.is_some() { "failed" } else { "started" },
            "runId": ran.get("lastRunId").cloned().unwrap_or(Value::Null),
            "error": error.cloned().unwrap_or(Value::Null),
            "message": match error {
                Some(error) => format!("Automation \"{name}\" could not start: {}", js::text(Some(error))),
                None => format!("Automation \"{name}\" started a run."),
            },
        }))
    }

    async fn automation_toggle(&self, args: &Value) -> Result<Value, String> {
        let id = js::text(args.get("automationId"));
        let updated = self
            .update_automation(&id, &json!({ "enabled": js::truthy(args.get("enabled")) }))
            .await
            .map_err(said)?;
        let enabled = js::truthy(updated.get("enabled"));
        Ok(json!({
            "success": true,
            "automationId": updated["id"],
            "enabled": enabled,
            "nextRun": updated.get("nextRun").cloned().unwrap_or(Value::Null),
            "message": format!("Automation \"{}\" is now {}.", text(&updated, "name"), if enabled { "enabled" } else { "disabled" }),
        }))
    }
}

/// An automation as the tools show it.
fn describe(item: &Value) -> Value {
    let or_null = |name: &str| item.get(name).cloned().unwrap_or(Value::Null);
    json!({
        "id": item["id"],
        "name": item["name"],
        "prompt": item["prompt"],
        "cron": format!("CRON_TZ={} {}", text(item, "timeZone"), trigger_to_cron(&item["trigger"])),
        "timeZone": item["timeZone"],
        "enabled": item["enabled"],
        "agentId": item["agentId"],
        "agentName": item["agentName"],
        "nextRun": or_null("nextRun"),
        "lastRunAt": or_null("lastRunAt"),
        "lastError": or_null("lastError"),
    })
}

/// A starter snippet for a widget; an unknown type gets the empty one.
fn widget_template(args: &Value) -> Value {
    let templates: Value =
        serde_json::from_str(WIDGET_TEMPLATES).expect("the templates are valid JSON");
    let asked = js::text(args.get("type"));
    match templates.get(&asked) {
        Some(template) => json!({ "type": asked, "template": template }),
        None => json!({ "type": "empty_boilerplate", "template": templates["empty_boilerplate"] }),
    }
}

async fn customizations_list(args: &Value, workspace: &Path) -> Value {
    let skills_folder = workspace.join(".agents").join("skills");
    let rules_folder = workspace.join(".agents").join("rules");
    let mut skills = Vec::new();
    for (name, kind) in listing(&skills_folder).await {
        let file = skills_folder.join(&name).join("SKILL.md");
        if kind.is_dir() && file.exists() {
            skills.push(json!({ "name": name, "path": file.to_string_lossy() }));
        }
    }
    let rules: Vec<Value> = listing(&rules_folder)
        .await
        .into_iter()
        .filter(|(name, _)| name.ends_with(".md"))
        .map(
            |(name, _)| json!({ "path": rules_folder.join(&name).to_string_lossy(), "name": name }),
        )
        .collect();
    json!({
        "scope": or_default(args, "scope", "all"),
        "workspace": workspace.to_string_lossy(),
        "discovered": { "skillsCount": skills.len(), "skills": skills, "rulesCount": rules.len(), "rules": rules },
    })
}

async fn create_skill(args: &Value, workspace: &Path) -> Result<Value, String> {
    let name = plain_name(args, "custom-skill");
    // One line: anything further would end the description and be read as more of the skill's header.
    let breaks = Regex::new(r"\s*\n\s*").expect("a valid pattern");
    let description = or_default(args, "description", "");
    let description = breaks.replace_all(&description, " ");
    let instructions = or_default(args, "instructions", "");
    let target = writable(workspace, &[".agents", "skills", &name, "SKILL.md"]).await?;
    let content = format!(
        "---\nname: {name}\ndescription: >-\n  {description}\n---\n\n# {name}\n\n{instructions}\n"
    );
    write(&target, content.as_bytes()).await?;
    Ok(json!({
        "success": true,
        "name": name,
        "path": target.to_string_lossy(),
        "message": format!("Created on-demand skill \"{name}\" under .agents/skills/{name}/SKILL.md"),
    }))
}

async fn create_rule(args: &Value, workspace: &Path) -> Result<Value, String> {
    let raw = or_default(args, "name", "rule");
    if raw.contains(['/', '\\']) || raw.starts_with('.') {
        return Err(format!("A rule's name is a plain file name, not {raw}"));
    }
    let name = if raw.ends_with(".md") {
        raw
    } else {
        format!("{raw}.md")
    };
    let target = writable(workspace, &[".agents", "rules", &name]).await?;
    write(&target, or_default(args, "content", "").as_bytes()).await?;
    Ok(json!({
        "success": true,
        "name": name,
        "path": target.to_string_lossy(),
        "message": format!("Created rule \"{name}\" under .agents/rules/{name}"),
    }))
}

async fn workflows_scan(workspace: &Path) -> Value {
    let mut workflows = Vec::new();
    for folder in [
        workspace.join(".agents").join("workflows"),
        workspace.join("_agents").join("workflows"),
    ] {
        for (file, _) in listing(&folder).await {
            if let Some(name) = file.strip_suffix(".md") {
                workflows
                    .push(json!({ "name": name, "path": folder.join(&file).to_string_lossy() }));
            }
        }
    }
    json!({
        "total": workflows.len(),
        "recommendation": if workflows.is_empty() {
            "No legacy workflows found in workspace."
        } else {
            "Legacy workflows found. Use workflows_migrate to convert them into modern .agents/skills/<name>/SKILL.md format."
        },
        "workflows": workflows,
    })
}

async fn workflows_migrate(args: &Value, workspace: &Path) -> Result<Value, String> {
    let wanted = or_default(args, "workflowName", "*");
    let archive = args.get("archiveOld") != Some(&Value::Bool(false));
    let folder = workspace.join(".agents").join("workflows");
    let mut migrated = Vec::new();
    // No folder means nothing to migrate; anything going wrong after that is said, not reported as success.
    for (file, kind) in listing(&folder).await {
        // A link is not a workflow of this project: it could bring in a file from elsewhere on the computer.
        let Some(name) = file.strip_suffix(".md").filter(|_| kind.is_file()) else {
            continue;
        };
        if wanted != "*" && wanted != name {
            continue;
        }
        let source = folder.join(&file);
        let bytes = tokio::fs::read(&source)
            .await
            .map_err(|error| error.to_string())?;
        let content = String::from_utf8_lossy(&bytes);
        let target = writable(workspace, &[".agents", "skills", name, "SKILL.md"]).await?;
        let converted = if content.starts_with("---") {
            content.into_owned()
        } else {
            format!(
                "---\nname: {name}\ndescription: Migrated from legacy workflow {name}\n---\n\n{content}\n"
            )
        };
        write(&target, converted.as_bytes()).await?;
        migrated.push(name.to_owned());
        if archive {
            let archived = writable(workspace, &[".agents", "workflows", "archive", &file]).await?;
            if let Some(parent) = archived.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|error| error.to_string())?;
            }
            tokio::fs::rename(&source, &archived)
                .await
                .map_err(|error| error.to_string())?;
        }
    }
    let mut answer =
        json!({ "success": true, "migratedCount": migrated.len(), "migrated": migrated });
    if archive {
        answer["archiveLocation"] = json!(".agents/workflows/archive/");
    }
    Ok(answer)
}

/// Packages a plugin folder in the workspace (plugins/<name>): plugin.json, and copies of the named skills from
/// .agents/skills. The user installs it from Settings → Plugins (or shares the folder).
async fn plugins_bundle(args: &Value, workspace: &Path) -> Result<Value, String> {
    let name = plain_name(args, "custom-plugin");
    let description = if js::truthy(args.get("description")) {
        js::text(args.get("description"))
    } else {
        or_default(args, "displayName", "")
    };
    let manifest = json!({ "name": name, "description": description, "version": "0.1.0" });
    let file = writable(workspace, &["plugins", &name, "plugin.json"]).await?;
    let pretty = serde_json::to_string_pretty(&manifest).map_err(|error| error.to_string())?;
    write(&file, pretty.as_bytes()).await?;
    let plain_skill = Regex::new(r"(?i)^[a-z0-9][a-z0-9_-]*$").expect("a valid pattern");
    let mut copied = Vec::new();
    for skill in args["skills"].as_array().map_or(&[][..], Vec::as_slice) {
        let skill = js::text(Some(skill));
        if !plain_skill.is_match(&skill) {
            continue;
        }
        let from = workspace.join(".agents").join("skills").join(&skill);
        // Not a skill of this workspace: skipped.
        let is_folder = tokio::fs::symlink_metadata(&from)
            .await
            .is_ok_and(|info| info.is_dir());
        if !is_folder {
            continue;
        }
        let to = writable(workspace, &["plugins", &name, "skills", &skill]).await?;
        if copy_without_links(&from, &to).await.is_ok() {
            copied.push(skill);
        }
    }
    let with = match copied.len() {
        0 => String::new(),
        1 => " with 1 skill".to_owned(),
        count => format!(" with {count} skills"),
    };
    Ok(json!({
        "success": true,
        "plugin": manifest,
        "path": file.parent().unwrap_or(workspace).to_string_lossy(),
        "skills": copied,
        "message": format!("Packaged the plugin \"{name}\" in plugins/{name}{with}. Install it from Settings → Plugins with that folder."),
    }))
}
