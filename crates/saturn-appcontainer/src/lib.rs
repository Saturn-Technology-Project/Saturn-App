//! A program started in a Windows AppContainer, which is how Saturn sandboxes a command on Windows. A program in a
//! container reads and writes only what an access list names for the container, and reaches the network only with a
//! capability, so the sandbox is made of two things: entries added to the access lists of the folders it may use, and
//! the process itself, started with the container's identity.
//!
//! Saturn starts itself again as the launcher (`saturn-server --appcontainer <policy> <command line>`), so a sandboxed
//! command is one program wrapping another, as with `sandbox-exec` and `bwrap`. This is the one crate that calls the
//! system without the compiler's checks; the calls are in `windows.rs` and nothing else is.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(windows)]
#[allow(unsafe_code, reason = "the Win32 calls an AppContainer is made with")]
mod windows;

/// The argument that makes Saturn's own program the launcher.
pub const FLAG: &str = "--appcontainer";

/// Folders that several sandboxes reach, by a capability they all hold: opened once, however many sandboxes use them,
/// where a folder opened to each sandbox by itself would gather an entry per sandbox.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Shared {
    /// The capability's name; sandboxes that give the same name share the folders.
    pub name: String,
    /// Folders they read and write, such as the caches tools keep.
    pub write: Vec<String>,
    /// Folders they read, such as where the programs on `PATH` are.
    pub read: Vec<String>,
}

/// What one sandbox may reach. A container is named after all of it, so two sandboxes that differ in anything do not
/// share what was opened to either.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Policy {
    /// Folders and files only this sandbox reads and writes.
    pub write: Vec<String>,
    /// Folders and files only this sandbox reads.
    pub read: Vec<String>,
    /// Folders it reaches together with other sandboxes. Saturn cannot open every one of them (it does not own
    /// Program Files), so one that stays closed is passed over.
    pub shared: Vec<Shared>,
    /// Paths inside the above that are closed again.
    pub deny: Vec<String>,
    /// The folder the program is told to keep temporary files in, made if it is missing; one of `write`.
    pub temporary: Option<String>,
    /// Whether the program reaches the network.
    pub network: bool,
}

impl Policy {
    /// The container's name: the same policy gets the same container, another policy another.
    pub fn name(&self) -> String {
        let mut identity = self.clone();
        // The network is a capability of the process, not something granted to the container.
        identity.network = false;
        let text = serde_json::to_string(&identity).unwrap_or_default();
        let digest = Sha256::digest(text.as_bytes());
        let hex: String = digest
            .iter()
            .take(16)
            .map(|byte| format!("{byte:02x}"))
            .collect();
        format!("saturn.sandbox.{hex}")
    }

    /// The policy as one argument with nothing a command line would need quoted.
    pub fn encoded(&self) -> String {
        let text = serde_json::to_string(self).unwrap_or_default();
        text.bytes().map(|byte| format!("{byte:02x}")).collect()
    }

    /// The policy an argument carries.
    pub fn decoded(argument: &str) -> Option<Self> {
        if !argument.len().is_multiple_of(2) {
            return None;
        }
        let bytes: Option<Vec<u8>> = (0..argument.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(argument.get(at..at + 2)?, 16).ok())
            .collect();
        serde_json::from_slice(&bytes?).ok()
    }
}

/// Where the launcher's own arguments end in a command line: after the program, `--appcontainer` and the policy. What
/// follows is the sandboxed program's command line, passed on exactly as written, so a line meant for cmd arrives as
/// cmd reads it. Returns the policy's argument and the offset of the rest.
pub fn split_command_line(line: &[u16]) -> Option<(String, usize)> {
    let space = |unit: u16| unit == u16::from(b' ') || unit == u16::from(b'\t');
    let mut at = 0;
    // The program's own name: quoted as a whole, or without spaces.
    if line.first() == Some(&u16::from(b'"')) {
        at = 1 + line[1..].iter().position(|unit| *unit == u16::from(b'"'))? + 1;
    }
    while at < line.len() && !space(line[at]) {
        at += 1;
    }
    let word = |at: &mut usize| -> Option<String> {
        while *at < line.len() && space(line[*at]) {
            *at += 1;
        }
        let start = *at;
        while *at < line.len() && !space(line[*at]) {
            *at += 1;
        }
        (start < *at).then(|| String::from_utf16_lossy(&line[start..*at]))
    };
    if word(&mut at)? != FLAG {
        return None;
    }
    let policy = word(&mut at)?;
    while at < line.len() && space(line[at]) {
        at += 1;
    }
    Some((policy, at))
}

/// Runs the launcher: starts the command line's program in its policy's container, waits for it and returns its exit
/// code, or 126 with a line on standard error when the container could not be made.
#[cfg(windows)]
pub fn launch() -> i32 {
    match windows::launch() {
        Ok(code) => code,
        Err(reason) => {
            eprintln!("Saturn's sandbox could not start the command: {reason}");
            126
        }
    }
}

/// Opens a policy's folders without starting anything, and says which of the shared folders, and of the folders above
/// the ones it names, stayed closed. Run by an administrator, it opens the ones Saturn itself may not: a drive's top
/// folder, `Users`, a program's folder under Program Files.
#[cfg(windows)]
pub fn prepare(policy: &Policy) -> Result<Vec<String>, String> {
    windows::prepare(policy).map(|(_, closed)| closed)
}

/// Opens a policy's folders; there are no containers outside Windows.
#[cfg(not(windows))]
pub fn prepare(_policy: &Policy) -> Result<Vec<String>, String> {
    Err("An AppContainer is a Windows sandbox".to_owned())
}

/// Takes away the registration of a policy's container, once the program it ran has ended. A container is registered
/// with Windows when its first program starts, and one made for a single run would otherwise stay registered.
pub fn forget(name: &str) {
    #[cfg(windows)]
    windows::forget(name);
    #[cfg(not(windows))]
    let _ = name;
}

/// Runs the launcher; there is none outside Windows.
#[cfg(not(windows))]
pub fn launch() -> i32 {
    eprintln!("An AppContainer is a Windows sandbox");
    126
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    #[test]
    fn a_policy_survives_its_argument_and_names_its_container() {
        let policy = Policy {
            write: vec!["C:\\work space".to_owned()],
            network: true,
            ..Policy::default()
        };
        let argument = policy.encoded();
        assert!(argument.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(Policy::decoded(&argument), Some(policy.clone()));
        assert_eq!(Policy::decoded("zz"), None);
        let offline = Policy {
            network: false,
            ..policy.clone()
        };
        assert_eq!(policy.name(), offline.name());
        let other = Policy {
            read: vec!["C:\\else".to_owned()],
            ..policy.clone()
        };
        assert_ne!(policy.name(), other.name());
        assert!(policy.name().len() <= 64);
    }

    #[test]
    fn the_rest_of_the_command_line_is_passed_on_as_written() {
        let line = units(
            r#""C:\Program Files\Saturn\saturn-server.exe" --appcontainer 7b7d cmd /d /c "echo "a  b" & dir""#,
        );
        let (policy, rest) = split_command_line(&line).expect("splits");
        assert_eq!(policy, "7b7d");
        assert_eq!(
            String::from_utf16_lossy(&line[rest..]),
            r#"cmd /d /c "echo "a  b" & dir""#
        );
        let bare = units("saturn-server.exe  --appcontainer 7b7d   node  x.js");
        let (_, rest) = split_command_line(&bare).expect("splits");
        assert_eq!(String::from_utf16_lossy(&bare[rest..]), "node  x.js");
        assert!(split_command_line(&units("saturn-server.exe --other 7b7d x")).is_none());
        assert!(split_command_line(&units("saturn-server.exe --appcontainer")).is_none());
    }
}
