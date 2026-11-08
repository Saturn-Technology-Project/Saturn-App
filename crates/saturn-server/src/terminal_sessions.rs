//! What the Workspace's terminal panel keeps between commands. Each command runs in a new shell, so without this a
//! `source .venv/bin/activate` or an `export` would be gone by the next command. After every command the shell prints
//! its functions, shell variables, aliases and environment after markers made for that one command; the next command
//! of the same panel starts with that environment and defines the rest again first. (An alias only takes effect where
//! the shell applies aliases in a script: bash does, zsh parses the whole script before running it.) Kept in this
//! process's memory only, never written or returned, since an environment can hold keys.
use std::collections::HashMap;
use std::ffi::OsString;
use std::sync::{LazyLock, Mutex};

/// The markers one command's trailer prints its state after. Each command gets its own random pair, so nothing a command
/// or a variable's value holds can pass for them.
pub struct Markers {
    /// Opens the functions, shell variables and aliases.
    pub definitions: String,
    /// Opens the environment, as NUL-separated `NAME=value` items.
    pub environment: String,
}

impl Markers {
    pub fn new() -> Self {
        let nonce = saturn_domain::random_hex(8).unwrap_or_else(|_| {
            CLOCK
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                .to_string()
        });
        Self {
            definitions: format!("__SATURN_DEFINITIONS_{nonce}__:"),
            environment: format!("__SATURN_ENVIRONMENT_{nonce}__:"),
        }
    }
}
/// How many panels' states are kept; the least recently used goes first.
const KEPT: usize = 16;

/// One panel's shell state.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TerminalState {
    /// The environment the last command left.
    pub environment: Vec<(OsString, OsString)>,
    /// Shell source that defines the functions and aliases it left.
    pub definitions: String,
}

/// The kept states by panel, each with when it was last used.
static STATES: LazyLock<Mutex<HashMap<String, (u64, TerminalState)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static CLOCK: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A panel's id as the app sends it: letters, digits, `-` and `_`, at most 64.
pub fn session_id(given: &str) -> Option<&str> {
    let valid = !given.is_empty()
        && given.len() <= 64
        && given
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    valid.then_some(given)
}

/// The state a panel's last command left, if it is still kept.
pub fn state_of(session: &str) -> Option<TerminalState> {
    let mut states = STATES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let tick = CLOCK.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    states.get_mut(session).map(|(used, state)| {
        *used = tick;
        state.clone()
    })
}

/// Keeps the state a panel's command left, forgetting the least recently used panel past the limit.
pub fn keep(session: &str, state: TerminalState) {
    let mut states = STATES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let tick = CLOCK.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    states.insert(session.to_owned(), (tick, state));
    while states.len() > KEPT {
        let Some(oldest) = states
            .iter()
            .min_by_key(|(_, (used, _))| *used)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        states.remove(&oldest);
    }
}

/// The first line of every command of a panel: the names the fresh shell starts with, so the trailer can tell which
/// shell variables the person's commands set (`activate` keeps the old PATH in one that is not exported).
pub const SNAPSHOT: &str = "if [ -n \"$ZSH_VERSION\" ]; then __saturn_names=\" ${(k)parameters} \"; elif [ -n \"$BASH_VERSION\" ]; then __saturn_names=\" $(compgen -v | tr '\\n' ' ') \"; fi";

/// The lines a POSIX shell runs after the command, printing its state after the markers. zsh and bash also print their
/// functions, aliases and the shell variables set since the snapshot that are neither exported (those are in the
/// environment) nor read-only nor the shell's own; another shell keeps its environment only.
pub fn trailer(markers: &Markers) -> String {
    let skip = "__saturn_*|PIPESTATUS|BASH*|FUNCNAME|_) continue;;";
    let (definitions, environment) = (&markers.definitions, &markers.environment);
    format!(
        "printf '%s' '{definitions}'\n\
         {{ if [ -n \"$ZSH_VERSION\" ]; then typeset -f; alias -L; \
         for __saturn_name in ${{(k)parameters}}; do case \"$__saturn_names\" in *\" $__saturn_name \"*) continue;; esac; \
         case $__saturn_name in {skip} esac; \
         case \"${{parameters[$__saturn_name]}}\" in *export*|*readonly*|*special*|*local*) continue;; esac; \
         typeset -p -- \"$__saturn_name\"; done; \
         elif [ -n \"$BASH_VERSION\" ]; then declare -f; alias -p; \
         for __saturn_name in $(compgen -v); do case \"$__saturn_names\" in *\" $__saturn_name \"*) continue;; esac; \
         case $__saturn_name in {skip} esac; \
         __saturn_declared=$(declare -p \"$__saturn_name\" 2>/dev/null) || continue; __saturn_flags=${{__saturn_declared#declare -}}; \
         case \"${{__saturn_flags%% *}}\" in *x*|*r*) continue;; esac; printf '%s\\n' \"$__saturn_declared\"; done; fi; }} 2>/dev/null\n\
         printf '%s' '{environment}'\n\
         env -0"
    )
}

/// The lines that define the kept functions, aliases and shell variables again, read from standard input so they need
/// no file. The command after them reads an empty input, as before.
pub const PRELUDE: &str = "__saturn_definitions=\"$(cat)\"\neval \"$__saturn_definitions\" 2>/dev/null\nunset __saturn_definitions";

/// Splits the state a command's trailer printed from what the command itself printed. `None` when the trailer did not
/// run (the command exited the shell, or was stopped).
pub fn split_state<'a>(output: &'a str, markers: &Markers) -> Option<(&'a str, TerminalState)> {
    let environment_at = output.rfind(&markers.environment)?;
    let definitions_at = output[..environment_at].rfind(&markers.definitions)?;
    let definitions = output[definitions_at + markers.definitions.len()..environment_at].to_owned();
    let environment = output[environment_at + markers.environment.len()..]
        .split('\0')
        .filter_map(|item| {
            let (name, value) = item.split_once('=')?;
            // `_` is the shell's last argument, not the person's setting.
            (!name.is_empty() && name != "_" && !name.contains('\n'))
                .then(|| (OsString::from(name), OsString::from(value)))
        })
        .collect::<Vec<_>>();
    if environment.is_empty() {
        return None;
    }
    Some((
        &output[..definitions_at],
        TerminalState {
            environment,
            definitions,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_state_is_split_from_the_output_and_a_missing_trailer_leaves_none() {
        let markers = Markers::new();
        assert_ne!(markers.definitions, Markers::new().definitions);
        // The command printed another command's markers: only this command's count.
        let output = format!(
            "hello __SATURN_ENVIRONMENT_0__:\n__SATURN_CWD__:/tmp\n{}deactivate () {{\n\ttrue\n}}\n{}PATH=/venv/bin:/usr/bin\0VIRTUAL_ENV=/venv\0_=/usr/bin/env\0",
            markers.definitions, markers.environment
        );
        let (before, state) = split_state(&output, &markers).unwrap();
        assert_eq!(
            before,
            "hello __SATURN_ENVIRONMENT_0__:\n__SATURN_CWD__:/tmp\n"
        );
        assert!(state.definitions.starts_with("deactivate ()"));
        assert_eq!(
            state.environment,
            vec![
                ("PATH".into(), "/venv/bin:/usr/bin".into()),
                ("VIRTUAL_ENV".into(), "/venv".into())
            ]
        );
        assert!(split_state("hello\n", &markers).is_none());
        assert!(
            split_state(&output, &Markers::new()).is_none(),
            "another command's markers find nothing"
        );
    }

    #[test]
    fn a_session_id_is_short_and_plain_and_old_states_are_forgotten() {
        assert_eq!(session_id("panel-1_a"), Some("panel-1_a"));
        assert!(session_id("").is_none());
        assert!(session_id("../x").is_none());
        assert!(session_id(&"a".repeat(65)).is_none());
        for index in 0..(KEPT + 2) {
            keep(&format!("forget-test-{index}"), TerminalState::default());
        }
        assert!(state_of("forget-test-0").is_none());
        assert!(state_of(&format!("forget-test-{}", KEPT + 1)).is_some());
    }
}
