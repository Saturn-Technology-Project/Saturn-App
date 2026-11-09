//! Permission rules for tool calls, in layers: the user's own, a project's, an agent's, then the project's
//! `.saturn/settings.json` and `.claude/settings.json`. `decide` is what the run loop asks before each tool call.
use std::path::Path;

use saturn_domain::permissions::{
    Decision, Effect, Layer, Rule, Scope, describe_rule, from_claude_rule, resolve_permission,
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::records::{by_id, by_id_mut, text};
use crate::{CoreError, Kernel, log};

/// The project's own rules, shared through version control.
pub const PROJECT_SETTINGS_FILE: &str = ".saturn/settings.json";
/// Claude Code's project settings; its `permissions.allow/deny/ask` are read too, as far as they translate.
pub const CLAUDE_SETTINGS_FILE: &str = ".claude/settings.json";

/// A layer as the settings page shows it.
#[derive(Clone, Debug)]
pub struct LayerView {
    pub layer: Layer,
    pub editable: bool,
    pub label: String,
    /// A file layer's allow rules that wait for the user: they apply only once the user allowed that exact set.
    pub held: Option<Vec<Rule>>,
    pub fingerprint: Option<String>,
    pub approved: Option<bool>,
    /// Rules never applied from any file: ones that would allow every call.
    pub refused: Vec<Rule>,
}

impl LayerView {
    /// The layer as the API answers it.
    pub fn to_json(&self) -> Value {
        let mut fields = Map::new();
        fields.insert("scope".to_owned(), json!(self.layer.scope));
        fields.insert("rules".to_owned(), json!(self.layer.rules));
        if let Some(path) = &self.layer.path {
            fields.insert("path".to_owned(), json!(path));
        }
        fields.insert("editable".to_owned(), json!(self.editable));
        fields.insert("label".to_owned(), json!(self.label));
        if let Some(fingerprint) = &self.fingerprint {
            fields.insert("fingerprint".to_owned(), json!(fingerprint));
        }
        if let Some(approved) = self.approved {
            fields.insert("approved".to_owned(), json!(approved));
        }
        if let Some(held) = &self.held {
            fields.insert("held".to_owned(), json!(held));
        }
        if !self.refused.is_empty() {
            fields.insert("refused".to_owned(), json!(self.refused));
        }
        Value::Object(fields)
    }
}

/// Programs that run whatever command follows them: a rule allowing one with a wildcard allows every command.
const LAUNCHERS: [&str; 19] = [
    "sh",
    "bash",
    "zsh",
    "fish",
    "dash",
    "ksh",
    "csh",
    "tcsh",
    "busybox",
    "env",
    "eval",
    "exec",
    "xargs",
    "nohup",
    "sudo",
    "doas",
    "pwsh",
    "powershell",
    "cmd",
];

/// A rule that would allow every shell command, or every call of every tool: not a rule, whoever writes it. That
/// includes a shell or a launcher followed by a wildcard (`sh *`, `bash -c *`, `env *`) and a wildcard in the command's
/// own name (`* *`), which allow every command as surely as `*` does.
pub fn allows_everything(rule: &Rule) -> bool {
    let any = |value: &str| matches!(saturn_domain::js::trim(value), "*" | "**");
    if rule.effect != Effect::Allow {
        return false;
    }
    if any(&rule.tool) && any(&rule.pattern) {
        return true;
    }
    if rule.tool.trim() != "code" {
        return false;
    }
    let pattern = saturn_domain::js::trim(&rule.pattern);
    if any(pattern) {
        return true;
    }
    let program = pattern.split_whitespace().next().unwrap_or_default();
    let name = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(program)
        .to_lowercase();
    let name = name.strip_suffix(".exe").unwrap_or(&name);
    pattern.contains('*') && (program.contains('*') || LAUNCHERS.contains(&name))
}

/// Names a file's allow rules: approving them names this, and any change to them asks again.
pub fn rules_fingerprint(rules: &[Rule]) -> String {
    let mut allow: Vec<String> = rules
        .iter()
        .filter(|rule| rule.effect == Effect::Allow)
        .map(|rule| format!("{}\u{0}{}", rule.tool, rule.pattern))
        .collect();
    allow.sort();
    let digest = Sha256::digest(json!(allow).to_string().as_bytes());
    saturn_domain::research::hex(&digest[..8])
}

/// A list of saved rules; anything that is not a rule is left out.
fn rules_of(value: Option<&Value>) -> Vec<Rule> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| serde_json::from_value::<Rule>(item.clone()).ok())
        .filter(|rule| !saturn_domain::js::trim(&rule.tool).is_empty())
        .collect()
}

/// A project file's layer as it applies: deny and ask rules at once; allow rules only once the user has allowed that exact
/// set; never a rule that would allow everything.
fn file_layer(scope: Scope, file: &str, read: Vec<Rule>, approvals: Option<&Value>) -> LayerView {
    let refused: Vec<Rule> = read
        .iter()
        .filter(|rule| allows_everything(rule))
        .cloned()
        .collect();
    let rules: Vec<Rule> = read
        .into_iter()
        .filter(|rule| {
            !allows_everything(rule) && !saturn_domain::js::trim(&rule.pattern).is_empty()
        })
        .collect();
    let allow: Vec<Rule> = rules
        .iter()
        .filter(|rule| rule.effect == Effect::Allow)
        .cloned()
        .collect();
    let fingerprint = (!allow.is_empty()).then(|| rules_fingerprint(&allow));
    let approved = fingerprint.as_deref().is_some_and(|print| {
        approvals
            .and_then(|items| items.get(file))
            .and_then(Value::as_str)
            == Some(print)
    });
    LayerView {
        layer: Layer {
            scope,
            path: Some(file.to_owned()),
            rules: if approved {
                rules
            } else {
                rules
                    .into_iter()
                    .filter(|rule| rule.effect != Effect::Allow)
                    .collect()
            },
        },
        editable: false,
        label: file.to_owned(),
        approved: fingerprint.is_some().then_some(approved),
        held: fingerprint
            .is_some()
            .then(|| if approved { Vec::new() } else { allow }),
        fingerprint,
        refused,
    }
}

/// A JSON object from a file; anything else counts as no file.
pub(crate) async fn read_json(file: &Path) -> Option<Value> {
    let text = tokio::fs::read_to_string(file).await.ok()?;
    serde_json::from_str::<Value>(&text)
        .ok()
        .filter(Value::is_object)
}

/// `.saturn/settings.json`: `{ "permissions": { "rules": [{ tool, pattern, effect }] } }`.
async fn read_project_rules(file: &Path) -> Option<Vec<Rule>> {
    let json = read_json(file).await?;
    let rules = json.get("permissions")?.get("rules")?;
    rules.is_array().then(|| rules_of(Some(rules)))
}

/// `.claude/settings.json`: `{ "permissions": { "allow": [...], "deny": [...], "ask": [...] } }`, translated where possible.
async fn read_claude_rules(file: &Path) -> Option<Vec<Rule>> {
    let json = read_json(file).await?;
    let permissions = json.get("permissions")?;
    let mut rules = Vec::new();
    for (name, effect) in [
        ("allow", Effect::Allow),
        ("deny", Effect::Deny),
        ("ask", Effect::Ask),
    ] {
        for item in permissions
            .get(name)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(rule) = item
                .as_str()
                .and_then(|text| from_claude_rule(text, effect))
            {
                rules.push(rule);
            }
        }
    }
    (!rules.is_empty()).then_some(rules)
}

impl Kernel {
    /// Every layer that applies to an agent working in a project.
    pub async fn permission_layers(
        &self,
        agent_id: Option<&str>,
        project_id: Option<&str>,
    ) -> Vec<LayerView> {
        let (user, project, agent) = self.store.read(|state| {
            (
                rules_of(state.settings.get("permissions")),
                project_id.and_then(|id| by_id(&state.projects, id).cloned()),
                agent_id.and_then(|id| by_id(&state.agents, id).cloned()),
            )
        });
        let plain = |scope, rules, label: &str| LayerView {
            layer: Layer {
                scope,
                rules,
                path: None,
            },
            editable: true,
            label: label.to_owned(),
            held: None,
            fingerprint: None,
            approved: None,
            refused: Vec::new(),
        };
        let mut layers = vec![plain(Scope::User, user, "Everywhere")];
        if let Some(project) = project {
            layers.push(plain(
                Scope::Project,
                rules_of(project.get("permissions")),
                text(&project, "name"),
            ));
            let root = Path::new(text(&project, "path"));
            let approvals = project.get("approvedRules");
            if let Some(rules) = read_project_rules(&root.join(PROJECT_SETTINGS_FILE)).await {
                layers.push(file_layer(
                    Scope::ProjectFile,
                    PROJECT_SETTINGS_FILE,
                    rules,
                    approvals,
                ));
            }
            if let Some(rules) = read_claude_rules(&root.join(CLAUDE_SETTINGS_FILE)).await {
                layers.push(file_layer(
                    Scope::ClaudeFile,
                    CLAUDE_SETTINGS_FILE,
                    rules,
                    approvals,
                ));
            }
        }
        if let Some(agent) = agent {
            layers.push(plain(
                Scope::Agent,
                rules_of(agent.get("permissions")),
                text(&agent, "name"),
            ));
        }
        layers
    }

    /// What the rules say about one tool call of a run, or nothing when none applies.
    pub(crate) async fn decide_permission(
        &self,
        agent_id: &str,
        run: &Value,
        tool: &str,
        arguments: &saturn_domain::Arguments,
    ) -> Option<Decision> {
        let project = self
            .find_thread(text(run, "threadId"))
            .map(|thread| text(&thread, "projectId").to_owned())
            .filter(|id| !id.is_empty());
        let views = self
            .permission_layers(Some(agent_id), project.as_deref())
            .await;
        let layers: Vec<Layer> = views.into_iter().map(|view| view.layer).collect();
        resolve_permission(&layers, tool, arguments)
    }

    /// The user allows a project file's allow rules: only the exact set they saw, named by its fingerprint.
    pub async fn approve_rules_file(
        &self,
        project_id: &str,
        file: &str,
        fingerprint: &str,
    ) -> Result<Vec<LayerView>, CoreError> {
        let layers = self.permission_layers(None, Some(project_id)).await;
        let layer = layers
            .iter()
            .find(|item| item.layer.path.as_deref() == Some(file));
        let print = layer
            .and_then(|item| item.fingerprint.as_deref())
            .ok_or_else(|| CoreError::new(404, format!("{file} has no allow rules to allow")))?;
        if print != fingerprint {
            return Err(CoreError::new(
                409,
                format!("The rules in {file} changed since you looked; review them again."),
            ));
        }
        self.store
            .update(|state| {
                let project = by_id_mut(&mut state.projects, project_id)
                    .ok_or_else(|| CoreError::new(404, "Project not found"))?;
                if !project.get("approvedRules").is_some_and(Value::is_object) {
                    project["approvedRules"] = json!({});
                }
                project["approvedRules"][file] = fingerprint.into();
                Ok::<(), CoreError>(())
            })
            .await??;
        log(
            "runtime",
            "info",
            &format!("Allow rules in {file} allowed for this project"),
        );
        Ok(self.permission_layers(None, Some(project_id)).await)
    }

    /// Holds a project file's allow rules again.
    pub async fn revoke_rules_file(
        &self,
        project_id: &str,
        file: &str,
    ) -> Result<Vec<LayerView>, CoreError> {
        self.store
            .update(|state| {
                if let Some(approved) = by_id_mut(&mut state.projects, project_id)
                    .and_then(|project| project.get_mut("approvedRules"))
                {
                    crate::records::remove(approved, file);
                }
            })
            .await?;
        Ok(self.permission_layers(None, Some(project_id)).await)
    }

    /// Adds a rule to an editable layer, or changes the effect of the same rule.
    pub async fn add_permission_rule(
        &self,
        scope: Scope,
        rule: &Value,
        project_id: Option<&str>,
        agent_id: Option<&str>,
    ) -> Result<Vec<LayerView>, CoreError> {
        let checked = check_rule(rule)?;
        let adding = checked.clone();
        self.edit_rules(scope, project_id, agent_id, move |rules| {
            match rules
                .iter_mut()
                .find(|item| item.tool == adding.tool && item.pattern == adding.pattern)
            {
                Some(same) => same.effect = adding.effect,
                None => rules.push(adding),
            }
        })
        .await?;
        log(
            "runtime",
            "info",
            &format!(
                "Permission rule added ({scope:?}): {:?} {}",
                checked.effect,
                describe_rule(&checked)
            ),
        );
        Ok(self.permission_layers(agent_id, project_id).await)
    }

    /// Removes one rule from an editable layer.
    pub async fn remove_permission_rule(
        &self,
        scope: Scope,
        rule: &Value,
        project_id: Option<&str>,
        agent_id: Option<&str>,
    ) -> Result<Vec<LayerView>, CoreError> {
        let checked = check_rule(rule)?;
        self.edit_rules(scope, project_id, agent_id, move |rules| {
            rules.retain(|item| *item != checked);
        })
        .await?;
        Ok(self.permission_layers(agent_id, project_id).await)
    }

    async fn edit_rules(
        &self,
        scope: Scope,
        project_id: Option<&str>,
        agent_id: Option<&str>,
        change: impl FnOnce(&mut Vec<Rule>),
    ) -> Result<(), CoreError> {
        match scope {
            Scope::ProjectFile | Scope::ClaudeFile => {
                let file = if scope == Scope::ProjectFile {
                    PROJECT_SETTINGS_FILE
                } else {
                    CLAUDE_SETTINGS_FILE
                };
                return Err(CoreError::new(
                    400,
                    format!("Rules in {file} are edited in that file."),
                ));
            }
            Scope::Project if project_id.is_none() => {
                return Err(CoreError::new(400, "A project rule needs projectId"));
            }
            Scope::Agent if agent_id.is_none() => {
                return Err(CoreError::new(400, "An agent rule needs agentId"));
            }
            _ => {}
        }
        self.store
            .update(|state| {
                let edited = |current: Option<&Value>| {
                    let mut rules = rules_of(current);
                    change(&mut rules);
                    json!(rules)
                };
                match scope {
                    Scope::User => {
                        let rules = edited(state.settings.get("permissions"));
                        state.settings.insert("permissions".to_owned(), rules);
                    }
                    Scope::Project => {
                        let project = by_id_mut(&mut state.projects, project_id.unwrap_or(""))
                            .ok_or_else(|| CoreError::new(404, "Project not found"))?;
                        project["permissions"] = edited(project.get("permissions"));
                    }
                    _ => {
                        let agent = by_id_mut(&mut state.agents, agent_id.unwrap_or(""))
                            .ok_or_else(|| CoreError::new(404, "Agent not found"))?;
                        agent["permissions"] = edited(agent.get("permissions"));
                    }
                }
                Ok(())
            })
            .await?
    }
}

/// The reason shown on a card or a denied step: which rule, from where.
pub fn explain(decision: &Decision) -> String {
    let scope = serde_json::to_value(decision.scope).unwrap_or_default();
    let place = decision
        .path
        .as_deref()
        .unwrap_or_else(|| scope.as_str().unwrap_or(""));
    let verb = match decision.effect {
        Effect::Deny => "Denied",
        Effect::Ask => "Asks",
        Effect::Allow => "Allowed",
    };
    format!(
        "{verb} by a permission rule ({place}: {})",
        describe_rule(&decision.rule)
    )
}

fn check_rule(value: &Value) -> Result<Rule, CoreError> {
    let rule: Rule = serde_json::from_value(value.clone()).map_err(|_| {
        CoreError::new(
            400,
            "A rule needs a tool, a pattern, and an effect of allow, deny or ask",
        )
    })?;
    if saturn_domain::js::trim(&rule.tool).is_empty() {
        return Err(CoreError::new(
            400,
            "A rule needs a tool, a pattern, and an effect of allow, deny or ask",
        ));
    }
    let pattern = saturn_domain::js::trim(&rule.pattern).to_owned();
    if pattern.is_empty() {
        return Err(CoreError::new(400, "The rule's pattern is empty"));
    }
    let checked = Rule {
        tool: saturn_domain::js::trim(&rule.tool).to_owned(),
        pattern,
        effect: rule.effect,
    };
    if allows_everything(&Rule {
        tool: rule.tool,
        ..checked.clone()
    }) {
        return Err(CoreError::new(
            400,
            "Allowing every shell command is not a rule; set the agent's approval mode instead.",
        ));
    }
    Ok(checked)
}
