//! The tools Saturn itself provides, as saved in the state's list of MCP servers. `builtin-servers.json` is the same list
//! `runtime/src/domain` builds, and a test there keeps the two alike.
use std::sync::LazyLock;

use saturn_store::AppState;
use serde_json::Value;

use crate::records::{by_id, strings, text};
use crate::{CoreError, Kernel};

pub const GENERAL_SKILLS_ID: &str = "general-skills";
pub const COMPUTER_USE_ID: &str = "computer-use";
pub const ORIGIN_ID: &str = "origin";
pub const AUTOMATIONS_ID: &str = "automations";
pub const BROWSER_ID: &str = "browser";
const SATURN_AGENT_ID: &str = "saturn-agent";
/// The editor tools of the removed IDE, which an earlier version saved in the state.
const REMOVED_IDE_SERVER: &str = "ide";

/// General skills, computer use, origin, automations and the browser, in that order.
static SERVERS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("builtin-servers.json")).expect("this file is valid JSON")
});

fn server(id: &str) -> Value {
    by_id(&SERVERS, id)
        .cloned()
        .expect("every built-in server is in the file")
}

/// Whether a server is one of Saturn's, under its name now or an earlier one.
fn builtin_id(id: &str) -> bool {
    matches!(
        id,
        GENERAL_SKILLS_ID
            | COMPUTER_USE_ID
            | "cursor-computer-use"
            | ORIGIN_ID
            | "cursor-origin"
            | AUTOMATIONS_ID
            | "antigravity-skills"
            | BROWSER_ID
    )
}

/// The ids with general skills, which every agent has.
pub fn with_general_skills(mut ids: Vec<String>) -> Vec<String> {
    if !ids.iter().any(|id| id == GENERAL_SKILLS_ID) {
        ids.push(GENERAL_SKILLS_ID.to_owned());
    }
    ids
}

/// True when `install` would change nothing.
pub fn installed(state: &AppState) -> bool {
    let current = |id: &str, old: &str| {
        state
            .mcp
            .iter()
            .find(|item| text(item, "id") == id || text(item, "id") == old)
    };
    let same_address = |id: &str, old: &str| {
        current(id, old).is_some_and(|item| {
            text(item, "id") == id && text(item, "url") == text(&server(id), "url")
        })
    };
    let browser_current = by_id(&state.mcp, BROWSER_ID).is_some_and(|item| {
        let wanted = server(BROWSER_ID);
        text(item, "url") == text(&wanted, "url") && item.get("tools") == wanted.get("tools")
    });
    browser_current
        && !state
            .mcp
            .iter()
            .any(|item| text(item, "id") == REMOVED_IDE_SERVER)
        && !state.agents.iter().any(|agent| {
            strings(agent, "mcpConnectionIds")
                .iter()
                .any(|id| id == REMOVED_IDE_SERVER)
        })
        && state.mcp.first() == Some(&server(GENERAL_SKILLS_ID))
        && state
            .mcp
            .iter()
            .filter(|item| text(item, "id") == GENERAL_SKILLS_ID)
            .count()
            == 1
        && same_address(COMPUTER_USE_ID, "cursor-computer-use")
        && same_address(ORIGIN_ID, "cursor-origin")
        && same_address(AUTOMATIONS_ID, "antigravity-skills")
        && !state
            .agents
            .iter()
            .any(|item| text(item, "id") == SATURN_AGENT_ID)
        && !state
            .runs
            .iter()
            .any(|item| text(item, "agentId") == SATURN_AGENT_ID)
        && state.agents.iter().all(|agent| {
            strings(agent, "mcpConnectionIds")
                .iter()
                .any(|id| id == GENERAL_SKILLS_ID)
        })
}

/// Puts Saturn's own servers first in the list, keeping which tools the user turned off, and every agent on the current names.
pub fn install(state: &mut AppState) {
    let keeping = |state: &AppState, id: &str, old: &str| {
        let mut fresh = server(id);
        let disabled = state
            .mcp
            .iter()
            .find(|item| text(item, "id") == id || text(item, "id") == old)
            .and_then(|item| item.get("disabledTools"))
            .cloned();
        if let Some(disabled) = disabled {
            fresh["disabledTools"] = disabled;
        }
        fresh
    };
    let mut servers = vec![
        server(GENERAL_SKILLS_ID),
        keeping(state, COMPUTER_USE_ID, "cursor-computer-use"),
        keeping(state, ORIGIN_ID, "cursor-origin"),
        keeping(state, AUTOMATIONS_ID, "antigravity-skills"),
        keeping(state, BROWSER_ID, BROWSER_ID),
    ];
    servers.extend(
        state
            .mcp
            .iter()
            .filter(|item| !builtin_id(text(item, "id")) && text(item, "id") != REMOVED_IDE_SERVER)
            .cloned(),
    );
    state.mcp = servers;
    state
        .agents
        .retain(|item| text(item, "id") != SATURN_AGENT_ID);
    state
        .runs
        .retain(|item| text(item, "agentId") != SATURN_AGENT_ID);
    let defaults = [
        GENERAL_SKILLS_ID,
        COMPUTER_USE_ID,
        ORIGIN_ID,
        AUTOMATIONS_ID,
        BROWSER_ID,
    ]
    .map(str::to_owned);
    for agent in &mut state.agents {
        let mapped: Vec<String> = strings(agent, "mcpConnectionIds")
            .into_iter()
            .filter(|id| id != REMOVED_IDE_SERVER)
            .map(|id| {
                match id.as_str() {
                    "cursor-computer-use" => COMPUTER_USE_ID,
                    "cursor-origin" => ORIGIN_ID,
                    "antigravity-skills" => AUTOMATIONS_ID,
                    other => other,
                }
                .to_owned()
            })
            .collect();
        let ids = if mapped == [GENERAL_SKILLS_ID] {
            defaults.to_vec()
        } else {
            let mut next = with_general_skills(mapped);
            // The browser joins agents that have the other built-in servers (an earlier default set), not custom picks.
            let had_defaults = [COMPUTER_USE_ID, ORIGIN_ID, AUTOMATIONS_ID]
                .iter()
                .all(|id| next.iter().any(|item| item == id));
            if had_defaults && !next.iter().any(|item| item == BROWSER_ID) {
                next.push(BROWSER_ID.to_owned());
            }
            next
        };
        agent["mcpConnectionIds"] = ids.into();
    }
}

impl Kernel {
    /// Installs the built-ins only when something is missing, so polling reads never rewrite the state file.
    pub async fn ensure_builtins(&self) -> Result<(), CoreError> {
        if !self.store.read(installed) {
            self.store.update(install).await?;
        }
        Ok(())
    }
}
