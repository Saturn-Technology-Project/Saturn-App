//! Toolkits an agent loads when it needs them: their definitions are a large share of every request and most turns use none
//! of them. The system prompt still names each one's tools; `load_tools` adds the definitions for the rest of the chat.

/// Each on-demand toolkit: its server, the name the model loads it by, and that name's aliases.
pub const ON_DEMAND_TOOLKITS: [(&str, &str, &[&str]); 4] = [
    (
        "origin",
        "github",
        &["github", "git", "origin", "cursor-origin"],
    ),
    (
        "computer-use",
        "computer",
        &["computer", "computer-use", "desktop", "cursor-computer-use"],
    ),
    ("browser", "browser", &["browser"]),
    (
        "automations",
        "automations",
        &[
            "automations",
            "automation",
            "customizations",
            "plugins",
            "antigravity",
        ],
    ),
];

/// The name a server's toolkit is loaded by, when the server is an on-demand toolkit.
pub fn toolkit_name(server: &str) -> Option<&'static str> {
    ON_DEMAND_TOOLKITS
        .iter()
        .find(|(id, _, _)| *id == server)
        .map(|(_, name, _)| *name)
}

/// The server id a toolkit name (or alias, any case) stands for.
pub fn toolkit_server(name: &str) -> Option<&'static str> {
    let wanted = crate::js::trim(name).to_lowercase();
    ON_DEMAND_TOOLKITS
        .iter()
        .find(|(id, _, aliases)| *id == wanted || aliases.contains(&wanted.as_str()))
        .map(|(id, _, _)| *id)
}

/// The note under a toolkit's section of the system prompt while it is not loaded.
pub fn load_note(server: &str) -> String {
    toolkit_name(server).map_or_else(String::new, |name| {
        format!(
            "- Not loaded yet: call `load_tools` with toolkits: [\"{name}\"] before using these."
        )
    })
}
