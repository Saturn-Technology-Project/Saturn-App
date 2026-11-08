//! Plugins: a folder that bundles skills, prompt commands, hooks and MCP servers, installed once and turned on or off as a unit.
//! The layout is Claude Code's, so its plugins install as they are. Plugins are copied (a local folder) or cloned (a git URL, no
//! hooks or submodules run) into `<data>/plugins`. Installing runs nothing: the plugin's hooks wait for the user's approval of
//! that exact set, and its local MCP servers are added as connections that wait for the usual per-command approval. Symbolic
//! links are left behind, since one could lead to a file elsewhere on the computer.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use saturn_domain::hooks::{Hook, from_claude_hooks, hook_from, hooks_fingerprint};
use saturn_domain::js;
use saturn_domain::time::{iso_time, now_millis};
use serde_json::{Value, json};
use tokio::process::Command;

use crate::permissions::read_json;
use crate::records::{by_id_mut, text};
use crate::{CoreError, Kernel, log};

const CLONE_TIMEOUT: Duration = Duration::from_secs(120);

/// Whether a name can be a plugin's folder.
fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_' || *byte == b'-'
        })
}

/// A plugin folder's manifest: plugin.json, or Claude Code's .claude-plugin/plugin.json.
async fn read_manifest(folder: &Path) -> Option<Value> {
    match read_json(&folder.join("plugin.json")).await {
        Some(found) => Some(found),
        None => read_json(&folder.join(".claude-plugin/plugin.json")).await,
    }
}

/// The plugin's hooks: Saturn's list or Claude Code's event map, from hooks/hooks.json or the manifest.
async fn plugin_hooks(folder: &Path, manifest: &Value) -> Vec<Hook> {
    let file = read_json(&folder.join("hooks/hooks.json"))
        .await
        .and_then(|json| json.get("hooks").filter(|hooks| !hooks.is_null()).cloned());
    let value = file.or_else(|| manifest.get("hooks").cloned());
    if let Some(list) = value.as_ref().and_then(Value::as_array) {
        return list.iter().filter_map(hook_from).collect();
    }
    let root = folder.to_string_lossy();
    from_claude_hooks(value.as_ref())
        .into_iter()
        .map(|hook| Hook {
            command: hook.command.replace("${CLAUDE_PLUGIN_ROOT}", &root),
            ..hook
        })
        .collect()
}

/// One MCP server a plugin brings.
struct PluginServer {
    name: String,
    command: Option<Value>,
    url: Option<String>,
}

/// The plugin's MCP servers: `mcpServers` in .mcp.json or the manifest, as Claude Code writes them.
async fn plugin_servers(folder: &Path, manifest: &Value) -> Vec<PluginServer> {
    let file = read_json(&folder.join(".mcp.json"))
        .await
        .and_then(|json| json.get("mcpServers").cloned());
    let map = file
        .or_else(|| manifest.get("mcpServers").cloned())
        .unwrap_or_else(|| json!({}));
    let root = folder.to_string_lossy().into_owned();
    let expand = |value: &str| value.replace("${CLAUDE_PLUGIN_ROOT}", &root);
    let mut servers = Vec::new();
    for (name, spec) in map.as_object().into_iter().flatten() {
        if let Some(program) = spec.get("command").and_then(Value::as_str) {
            let args: Vec<String> = spec
                .get("args")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(expand)
                .collect();
            let mut env = serde_json::Map::new();
            for (key, value) in spec
                .get("env")
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
            {
                if let Some(value) = value.as_str() {
                    env.insert(key.clone(), expand(value).into());
                }
            }
            servers.push(PluginServer {
                name: name.clone(),
                command: Some(json!({ "program": expand(program), "args": args, "env": env })),
                url: None,
            });
        } else if let Some(url) = spec.get("url").and_then(Value::as_str) {
            servers.push(PluginServer {
                name: name.clone(),
                command: None,
                url: Some(url.to_owned()),
            });
        }
    }
    servers
}

/// The names in a folder that `pick` keeps, sorted.
async fn names_in(folder: &Path, pick: impl Fn(&str, bool) -> Option<String>) -> Vec<String> {
    let mut names = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(folder).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let is_folder = entry.file_type().await.is_ok_and(|kind| kind.is_dir());
            if let Some(name) = pick(&entry.file_name().to_string_lossy(), is_folder) {
                names.push(name);
            }
        }
    }
    names.sort();
    names
}

/// Copies a folder without its `.git` and `node_modules`, and without any symbolic link.
async fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut pending = vec![(from.to_path_buf(), to.to_path_buf())];
    while let Some((source, target)) = pending.pop() {
        tokio::fs::create_dir_all(&target).await?;
        let mut entries = tokio::fs::read_dir(&source).await?;
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name();
            if name == ".git" || name == "node_modules" {
                continue;
            }
            let kind = entry.file_type().await?;
            if kind.is_dir() {
                pending.push((entry.path(), target.join(&name)));
            } else if kind.is_file() {
                tokio::fs::copy(entry.path(), target.join(&name)).await?;
            }
        }
    }
    Ok(())
}

impl Kernel {
    fn plugins_dir(&self) -> PathBuf {
        self.store.root().join("plugins")
    }

    fn plugin_records(&self) -> Vec<Value> {
        self.store.read(|state| {
            state
                .settings
                .get("plugins")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
    }

    /// The folders of the plugins that are on: where skills and commands are read from.
    pub fn enabled_plugin_folders(&self) -> Vec<PathBuf> {
        self.plugin_records()
            .iter()
            .filter(|record| record.get("enabled") == Some(&Value::Bool(true)))
            .map(|record| self.plugins_dir().join(text(record, "name")))
            .collect()
    }

    fn find_plugin(&self, name: &str) -> Result<Value, CoreError> {
        self.plugin_records()
            .into_iter()
            .find(|record| text(record, "name") == name)
            .ok_or_else(|| CoreError::new(404, format!("No plugin named {name}")))
    }

    async fn plugin_view(&self, record: &Value) -> Value {
        let name = text(record, "name");
        let folder = self.plugins_dir().join(name);
        let manifest = read_manifest(&folder).await.unwrap_or_else(|| json!({}));
        let hooks = plugin_hooks(&folder, &manifest).await;
        let print = (!hooks.is_empty()).then(|| hooks_fingerprint(&hooks));
        let servers = plugin_servers(&folder, &manifest).await;
        let mut view = record.clone();
        view["description"] = manifest
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into();
        view["path"] = folder.to_string_lossy().into_owned().into();
        view["skills"] = names_in(&folder.join("skills"), |name, is_folder| {
            is_folder.then(|| name.to_owned())
        })
        .await
        .into();
        view["commands"] = names_in(&folder.join("commands"), |name, is_folder| {
            if is_folder {
                None
            } else {
                name.strip_suffix(".md").map(str::to_owned)
            }
        })
        .await
        .into();
        view["hooks"] = json!(hooks);
        view["hooksApproved"] = print
            .as_deref()
            .is_some_and(|print| text(record, "approvedHooks") == print)
            .into();
        if let Some(print) = print {
            view["hooksFingerprint"] = print.into();
        }
        let listed: Vec<Value> = servers
            .iter()
            .map(|server| {
                let shown = format!("{name}: {}", server.name);
                let id = self.store.read(|state| state.mcp.iter().find(|item| text(item, "pluginName") == name && text(item, "name") == shown).map(|item| text(item, "id").to_owned()));
                let mut item = json!({ "name": server.name, "kind": if server.command.is_some() { "command" } else { "url" } });
                if let Some(id) = id {
                    item["id"] = id.into();
                }
                item
            })
            .collect();
        view["mcpServers"] = listed.into();
        view
    }

    pub async fn list_plugins(&self) -> Vec<Value> {
        let mut views = Vec::new();
        for record in self.plugin_records() {
            views.push(self.plugin_view(&record).await);
        }
        views
    }

    /// Installs from a local folder (copied) or a git URL (cloned shallowly, with no hooks and no submodules).
    pub async fn install_plugin(&self, source: &str) -> Result<Value, CoreError> {
        let from = js::trim(source);
        if from.is_empty() {
            return Err(CoreError::new(400, "Give a folder or a git URL"));
        }
        tokio::fs::create_dir_all(self.plugins_dir()).await?;
        let staging =
            self.plugins_dir()
                .join(format!(".staging-{}-{}", now_millis(), std::process::id()));
        let outcome = self.install_from_staging(from, &staging).await;
        let _ = tokio::fs::remove_dir_all(&staging).await;
        outcome
    }

    async fn install_from_staging(&self, from: &str, staging: &Path) -> Result<Value, CoreError> {
        let failed = |error: &dyn std::fmt::Display| {
            CoreError::new(
                400,
                format!(
                    "Could not install the plugin: {}",
                    error.to_string().lines().next().unwrap_or("")
                ),
            )
        };
        if ["https://", "git@", "ssh://"]
            .iter()
            .any(|scheme| from.starts_with(scheme))
        {
            let cloned = {
                let mut command = Command::new("git");
                saturn_tools::no_window(&mut command);
                command
                    .args([
                        "-c",
                        "core.hooksPath=/dev/null",
                        "-c",
                        "protocol.file.allow=never",
                        "clone",
                        "--depth",
                        "1",
                        "--no-recurse-submodules",
                        "--",
                        from,
                    ])
                    .arg(staging)
                    .env("GIT_TERMINAL_PROMPT", "0")
                    .stdin(Stdio::null())
                    .kill_on_drop(true);
                tokio::time::timeout(CLONE_TIMEOUT, command.output())
                    .await
                    .map_err(|_| {
                        CoreError::new(400, "Could not install the plugin: the clone took too long")
                    })?
                    .map_err(|error| failed(&error))?
            };
            if !cloned.status.success() {
                return Err(failed(&String::from_utf8_lossy(&cloned.stderr)));
            }
        } else if Path::new(from).is_absolute()
            && tokio::fs::metadata(from)
                .await
                .is_ok_and(|info| info.is_dir())
        {
            copy_tree(Path::new(from), staging)
                .await
                .map_err(|error| failed(&error))?;
        } else {
            return Err(CoreError::new(
                400,
                "A plugin comes from an absolute folder path or an https/ssh git URL",
            ));
        }
        let manifest = read_manifest(staging).await.ok_or_else(|| {
            CoreError::new(
                400,
                "No plugin.json (or .claude-plugin/plugin.json) in that folder",
            )
        })?;
        let name = js::trim(text(&manifest, "name")).to_lowercase();
        if !valid_name(&name) {
            return Err(CoreError::new(
                400,
                "plugin.json needs a name: lowercase letters, digits, dashes or underscores",
            ));
        }
        if self
            .plugin_records()
            .iter()
            .any(|record| text(record, "name") == name)
        {
            return Err(CoreError::new(
                409,
                format!("A plugin named {name} is installed already; remove it first to reinstall"),
            ));
        }
        let target = self.plugins_dir().join(&name);
        let _ = tokio::fs::remove_dir_all(&target).await;
        // Without .git or node_modules for a clone too, and leaving every link behind.
        copy_tree(staging, &target)
            .await
            .map_err(|error| failed(&error))?;
        let mut record = json!({ "name": name, "source": from, "installedAt": iso_time(now_millis()), "enabled": true });
        if let Some(version) = manifest
            .get("version")
            .filter(|version| version.is_string())
        {
            record["version"] = version.clone();
        }
        let saved = record.clone();
        self.store
            .update(|state| {
                let list = state.settings.entry("plugins").or_insert_with(|| json!([]));
                if let Some(items) = list.as_array_mut() {
                    items.push(saved);
                }
            })
            .await?;
        self.sync_plugin_servers(&record).await;
        log("runtime", "info", &format!("Plugin {name} installed"));
        Ok(self.plugin_view(&record).await)
    }

    async fn change_plugin(
        &self,
        name: &str,
        change: impl FnOnce(&mut Value),
    ) -> Result<(), CoreError> {
        self.store
            .update(|state| {
                if let Some(item) = state
                    .settings
                    .get_mut("plugins")
                    .and_then(Value::as_array_mut)
                    .and_then(|items| by_id_named(items, name))
                {
                    change(item);
                }
            })
            .await?;
        Ok(())
    }

    pub async fn set_plugin_enabled(&self, name: &str, enabled: bool) -> Result<Value, CoreError> {
        self.find_plugin(name)?;
        self.change_plugin(name, |item| item["enabled"] = enabled.into())
            .await?;
        let record = self.find_plugin(name)?;
        self.sync_plugin_servers(&record).await;
        Ok(self.plugin_view(&record).await)
    }

    pub async fn approve_plugin_hooks(
        &self,
        name: &str,
        fingerprint: &str,
    ) -> Result<Value, CoreError> {
        let view = self.plugin_view(&self.find_plugin(name)?).await;
        let print = view
            .get("hooksFingerprint")
            .and_then(Value::as_str)
            .ok_or_else(|| CoreError::new(400, format!("{name} has no hooks")))?;
        if print != fingerprint {
            return Err(CoreError::new(
                409,
                format!("The hooks of {name} changed since you looked; review them again."),
            ));
        }
        self.change_plugin(name, |item| item["approvedHooks"] = fingerprint.into())
            .await?;
        log(
            "runtime",
            "info",
            &format!("Hooks of the plugin {name} allowed"),
        );
        Ok(self.plugin_view(&self.find_plugin(name)?).await)
    }

    pub async fn uninstall_plugin(&self, name: &str) -> Result<(), CoreError> {
        self.find_plugin(name)?;
        self.remove_plugin_servers(name).await?;
        self.store
            .update(|state| {
                if let Some(items) = state
                    .settings
                    .get_mut("plugins")
                    .and_then(Value::as_array_mut)
                {
                    items.retain(|entry| text(entry, "name") != name);
                }
            })
            .await?;
        // Only ever a name that passed `valid_name` when it was installed.
        let _ = tokio::fs::remove_dir_all(self.plugins_dir().join(name)).await;
        log("runtime", "info", &format!("Plugin {name} removed"));
        Ok(())
    }

    async fn remove_plugin_servers(&self, name: &str) -> Result<(), CoreError> {
        let ids: Vec<String> = self.store.read(|state| {
            state
                .mcp
                .iter()
                .filter(|item| text(item, "pluginName") == name)
                .map(|item| text(item, "id").to_owned())
                .collect()
        });
        for id in ids {
            self.delete_mcp_server(&id).await?;
        }
        Ok(())
    }

    /// A plugin's hook sets when it is on, approved or not; `hooks` runs the approved ones.
    pub(crate) async fn plugin_hook_sets(&self) -> Vec<(String, Vec<Hook>, String, bool)> {
        let mut sets = Vec::new();
        for record in self
            .plugin_records()
            .iter()
            .filter(|record| record.get("enabled") == Some(&Value::Bool(true)))
        {
            let name = text(record, "name");
            let folder = self.plugins_dir().join(name);
            let manifest = read_manifest(&folder).await.unwrap_or_else(|| json!({}));
            let hooks = plugin_hooks(&folder, &manifest).await;
            if !hooks.is_empty() {
                let print = hooks_fingerprint(&hooks);
                let approved = text(record, "approvedHooks") == print;
                sets.push((name.to_owned(), hooks, print, approved));
            }
        }
        sets
    }

    /// A plugin that is on has its MCP servers as connections (local ones still wait for approval); off removes them.
    async fn sync_plugin_servers(&self, record: &Value) {
        let name = text(record, "name");
        if record.get("enabled") != Some(&Value::Bool(true)) {
            if let Err(error) = self.remove_plugin_servers(name).await {
                log(
                    "runtime",
                    "warning",
                    &format!("Plugin {name}: its MCP servers were not removed: {error}"),
                );
            }
            return;
        }
        let folder = self.plugins_dir().join(name);
        let manifest = read_manifest(&folder).await.unwrap_or_else(|| json!({}));
        for server in plugin_servers(&folder, &manifest).await {
            let shown = format!("{name}: {}", server.name);
            if self.store.read(|state| {
                state
                    .mcp
                    .iter()
                    .any(|item| text(item, "pluginName") == name && text(item, "name") == shown)
            }) {
                continue;
            }
            let input = match (&server.command, &server.url) {
                (Some(command), _) => json!({ "name": shown, "command": command }),
                (_, url) => json!({ "name": shown, "url": url }),
            };
            match self.create_mcp(&input).await {
                Ok(created) => {
                    let saved = self
                        .store
                        .update(|state| {
                            if let Some(item) = by_id_mut(&mut state.mcp, text(&created, "id")) {
                                item["pluginName"] = name.into();
                            }
                        })
                        .await;
                    if let Err(error) = saved {
                        log("runtime", "warning", &format!("Plugin {name}: {error}"));
                    }
                }
                Err(error) => log(
                    "runtime",
                    "warning",
                    &format!(
                        "Plugin {name}: MCP server {} not added: {error}",
                        server.name
                    ),
                ),
            }
        }
    }
}

/// The plugin record with this name.
fn by_id_named<'a>(items: &'a mut [Value], name: &str) -> Option<&'a mut Value> {
    items.iter_mut().find(|item| text(item, "name") == name)
}
