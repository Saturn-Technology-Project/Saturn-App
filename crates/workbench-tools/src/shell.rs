use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};

use crate::sandbox::Platform;

/// A process's environment.
pub type Env = BTreeMap<OsString, OsString>;

/// Windows variables a program needs to start at all: without SystemRoot many programs (node, git, python) fail to load
/// system DLLs or open sockets, without PATHEXT cmd cannot find `node` from `node.exe`, and TEMP, USERPROFILE and APPDATA
/// are where tools keep their files. Matched case-insensitively.
const WINDOWS_ESSENTIALS: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "USERNAME",
    "USERDOMAIN",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "ALLUSERSPROFILE",
    "PUBLIC",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMFILES(X86)",
    "COMMONPROGRAMW6432",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
    "PSMODULEPATH",
];

/// This process's environment, without what belongs to this process alone (`crate::process::OWN_VARIABLES`): no
/// program started with it, such as the Workspace terminal's shell or git, inherits the runtime's token.
pub fn process_env() -> Env {
    std::env::vars_os()
        .filter(|(key, _)| !crate::process::is_own_variable(&key.to_string_lossy()))
        .collect()
}

/// The small environment the `code` tool runs commands with: PATH, plus what Windows itself needs.
pub fn command_env(platform: Platform, env: &Env) -> Vec<(OsString, OsString)> {
    if platform != Platform::Windows {
        let path = env
            .get(OsStr::new("PATH"))
            .filter(|path| !path.is_empty())
            .cloned()
            .unwrap_or_else(|| OsString::from("/usr/bin:/bin"));
        return vec![(OsString::from("PATH"), path)];
    }
    env.iter()
        .filter(|(key, _)| {
            let name = key.to_string_lossy();
            WINDOWS_ESSENTIALS
                .iter()
                .any(|essential| name.eq_ignore_ascii_case(essential))
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

/// A program to start and what to give it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invocation {
    pub file: String,
    pub args: Vec<String>,
    /// The arguments go on the command line as they are, for cmd.
    pub verbatim: bool,
}

/// How to run `command` through the system shell: on Windows the whole command goes to cmd quoted and verbatim, since cmd
/// does not understand the \" escaping the usual quoting would add.
pub fn shell_invocation(
    command: &str,
    posix_shell: &str,
    platform: Platform,
    env: &Env,
) -> Invocation {
    if platform == Platform::Windows {
        let shell = env
            .iter()
            .find(|(key, value)| {
                key.to_string_lossy().eq_ignore_ascii_case("ComSpec") && !value.is_empty()
            })
            .map_or_else(
                || "cmd.exe".to_owned(),
                |(_, value)| value.to_string_lossy().into_owned(),
            );
        return Invocation {
            file: shell,
            args: vec![
                "/d".to_owned(),
                "/s".to_owned(),
                "/c".to_owned(),
                format!("\"{command}\""),
            ],
            verbatim: true,
        };
    }
    Invocation {
        file: posix_shell.to_owned(),
        args: vec!["-c".to_owned(), command.to_owned()],
        verbatim: false,
    }
}
