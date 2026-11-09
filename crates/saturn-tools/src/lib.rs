//! The tools an agent runs: files, commands in a sandbox, background commands and web pages.
//! `contract/cases/tools.json` holds the cases they must answer. Stopping a tool
//! is dropping its future: a command's whole process group goes with it.
use saturn_domain::Arguments;
use saturn_domain::js;
use serde_json::Value;

pub mod code;
pub mod confine;
pub mod file;
pub mod general;
pub mod jobs;
mod process;
pub mod public_host;
pub mod sandbox;
pub mod shell;
pub mod web;

pub use process::{
    Captured, EndOnDrop, continue_group, force, group_alive, group_of, in_own_group, launch_env,
    leave_session, no_window, no_window_blocking, pause_group, run_captured, terminate,
};

/// What a tool returns to the model, or the message saying why it could not.
pub type ToolResult = Result<Value, String>;

/// Characters of text a tool returns or writes at once.
pub const TEXT_LIMIT: usize = 32_000;

/// The text up to TEXT_LIMIT; past that, a note says how much was cut, so the model reads less instead of guessing.
pub fn clip(value: &str) -> String {
    let length = js::length(value);
    if length <= TEXT_LIMIT {
        return value.to_owned();
    }
    format!(
        "{}\n…[{} more characters cut. Read a narrower part: filter with grep, head or tail, or read a file with offset and limit.]",
        js::prefix(value, TEXT_LIMIT),
        length - TEXT_LIMIT
    )
}

/// An argument as text.
pub(crate) fn text(arguments: &Arguments, key: &str) -> String {
    js::text(arguments.get(key))
}

/// The first of two arguments that holds something, as text (`args.a || args.b`).
pub(crate) fn either(arguments: &Arguments, first: &str, second: &str) -> String {
    if js::truthy(arguments.get(first)) {
        text(arguments, first)
    } else {
        text(arguments, second)
    }
}
