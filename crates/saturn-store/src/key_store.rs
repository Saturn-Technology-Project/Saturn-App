//! Where the key that encrypts `secrets.json` is kept. The same places and names as `runtime/`, so either reads the other's.
use std::env;
use std::fmt::Write as _;
use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::write_private;

pub const KEY_BYTES: usize = 32;
const SERVICE: &str = "Saturn";

/// A key that encrypts `secrets.json`.
pub type Key = [u8; KEY_BYTES];

/// The kinds of key store, as `secrets.json` names them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyStoreName {
    Keychain,
    Dpapi,
    Libsecret,
    File,
}

/// One place a key can be kept. Calls block on a file or a system tool.
pub trait KeyStore: Send + Sync {
    fn name(&self) -> KeyStoreName;
    /// How the key is protected, for the UI and logs.
    fn label(&self) -> &'static str;
    /// The saved key, or `None` when there is none yet. An error means the store could not be read.
    fn get(&self) -> io::Result<Option<Key>>;
    fn set(&self, key: &Key) -> io::Result<()>;
}

/// One key per data folder, so isolated data folders (tests, a second profile) never share or overwrite a key.
/// The account name is derived from the folder's real path.
pub fn account(data_dir: &Path) -> String {
    let real = fs::canonicalize(data_dir).unwrap_or_else(|_| data_dir.to_path_buf());
    let digest = Sha256::digest(real.to_string_lossy().as_bytes());
    format!("api-keys-{}", &to_hex(&digest)[..16])
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut text, byte| {
        let _ = write!(text, "{byte:02x}");
        text
    })
}

/// A key saved as hex; anything that is not exactly one key counts as none.
fn key_from_hex(text: &str) -> Option<Key> {
    let text = text.trim();
    if text.len() != KEY_BYTES * 2 || !text.is_ascii() {
        return None;
    }
    let mut key = [0; KEY_BYTES];
    for (index, byte) in key.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(key)
}

fn key_from_base64(text: &str) -> Option<Key> {
    BASE64.decode(text.trim()).ok()?.try_into().ok()
}

/// What a system tool did.
struct Finished {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

impl Finished {
    fn succeeded(&self) -> bool {
        self.code == Some(0)
    }
}

/// Runs a system tool. Keys only ever travel through stdin, never as arguments, so they stay out of the process list.
fn run(program: &Path, arguments: &[&str], input: &str) -> io::Result<Finished> {
    let mut command = Command::new(program);
    command
        .args(arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::os::windows::process::CommandExt::creation_flags(&mut command, CREATE_NO_WINDOW);
    }
    let mut child = command.spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        // A tool that exits without reading its input closes the pipe; what it reports decides the result.
        match stdin.write_all(input.as_bytes()) {
            Err(error) if error.kind() != io::ErrorKind::BrokenPipe => return Err(error),
            _ => {}
        }
    }
    let output = child.wait_with_output()?;
    Ok(Finished {
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// macOS Keychain, through the system `security` tool. Items created this way are readable by `security` without a prompt
/// while the login keychain is unlocked.
pub struct Keychain {
    account: String,
}

const SECURITY: &str = "/usr/bin/security";

impl KeyStore for Keychain {
    fn name(&self) -> KeyStoreName {
        KeyStoreName::Keychain
    }

    fn label(&self) -> &'static str {
        "macOS Keychain"
    }

    fn get(&self) -> io::Result<Option<Key>> {
        let result = run(
            Path::new(SECURITY),
            &[
                "find-generic-password",
                "-s",
                SERVICE,
                "-a",
                &self.account,
                "-w",
            ],
            "",
        )?;
        const ITEM_NOT_FOUND: i32 = 44;
        if result.code == Some(ITEM_NOT_FOUND) {
            return Ok(None);
        }
        if !result.succeeded() {
            return Err(io::Error::other(format!(
                "security find-generic-password failed ({:?}): {}",
                result.code,
                result.stderr.trim()
            )));
        }
        Ok(key_from_hex(&result.stdout))
    }

    fn set(&self, key: &Key) -> io::Result<()> {
        // `security -i` exits non-zero at end of input even after a successful command, so success is read back.
        let line = format!(
            "add-generic-password -U -s \"{SERVICE}\" -a \"{}\" -l \"Saturn API key encryption\" -w {}\nquit\n",
            self.account,
            to_hex(key)
        );
        run(Path::new(SECURITY), &["-i"], &line)?;
        if self.get()?.as_ref() != Some(key) {
            return Err(io::Error::other("the Keychain did not keep the key"));
        }
        Ok(())
    }
}

/// PowerShell, encoded for `-EncodedCommand`, that reads one base64 line from stdin, applies DPAPI (current user) and prints
/// base64.
pub fn dpapi_script(operation: &str) -> String {
    let script = [
        "$ErrorActionPreference = 'Stop'".to_owned(),
        "Add-Type -AssemblyName System.Security".to_owned(),
        "$data = [Convert]::FromBase64String([Console]::In.ReadLine())".to_owned(),
        format!(
            "$out = [Security.Cryptography.ProtectedData]::{operation}($data, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)"
        ),
        "[Console]::Out.Write([Convert]::ToBase64String($out))".to_owned(),
    ]
    .join("; ");
    let wide: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    BASE64.encode(wide)
}

/// Windows Data Protection API: the key is encrypted with the Windows user's credentials and the result saved as
/// `<data>/secrets.dpapi`. Only the same Windows user on the same machine can decrypt it.
pub struct Dpapi {
    file: PathBuf,
    powershell: PathBuf,
}

impl Dpapi {
    fn call(&self, operation: &str, input: &str) -> io::Result<String> {
        let result = run(
            &self.powershell,
            &[
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                &dpapi_script(operation),
            ],
            &format!("{input}\n"),
        )?;
        if !result.succeeded() {
            let detail: String = result.stderr.trim().chars().take(300).collect();
            return Err(io::Error::other(format!(
                "DPAPI {operation} failed ({:?}): {detail}",
                result.code
            )));
        }
        Ok(result.stdout.trim().to_owned())
    }
}

impl KeyStore for Dpapi {
    fn name(&self) -> KeyStoreName {
        KeyStoreName::Dpapi
    }

    fn label(&self) -> &'static str {
        "Windows Data Protection (DPAPI)"
    }

    fn get(&self) -> io::Result<Option<Key>> {
        let Some(blob) = read_if_present(&self.file)? else {
            return Ok(None);
        };
        Ok(key_from_base64(&self.call("Unprotect", blob.trim())?))
    }

    fn set(&self, key: &Key) -> io::Result<()> {
        let blob = self.call("Protect", &BASE64.encode(key))?;
        write_private(&self.file, format!("{blob}\n").as_bytes())?;
        if self.get()?.as_ref() != Some(key) {
            return Err(io::Error::other("DPAPI did not return the key"));
        }
        Ok(())
    }
}

/// The Secret Service (GNOME Keyring, KWallet) through `secret-tool`, which reads the secret from stdin.
pub struct Libsecret {
    account: String,
}

const SECRET_TOOL: &str = "secret-tool";

impl KeyStore for Libsecret {
    fn name(&self) -> KeyStoreName {
        KeyStoreName::Libsecret
    }

    fn label(&self) -> &'static str {
        "Secret Service (libsecret)"
    }

    fn get(&self) -> io::Result<Option<Key>> {
        let result = run(
            Path::new(SECRET_TOOL),
            &["lookup", "service", SERVICE, "account", &self.account],
            "",
        )?;
        if result.succeeded() {
            return Ok(key_from_hex(&result.stdout));
        }
        // Not found: exit 1 with nothing printed. Anything on stderr is a real failure (no Secret Service running, locked).
        if result.stderr.trim().is_empty() {
            return Ok(None);
        }
        Err(io::Error::other(format!(
            "secret-tool lookup failed: {}",
            result.stderr.trim()
        )))
    }

    fn set(&self, key: &Key) -> io::Result<()> {
        let result = run(
            Path::new(SECRET_TOOL),
            &[
                "store",
                "--label=Saturn API key encryption",
                "service",
                SERVICE,
                "account",
                &self.account,
            ],
            &to_hex(key),
        )?;
        if !result.succeeded() {
            return Err(io::Error::other(format!(
                "secret-tool store failed: {}",
                result.stderr.trim()
            )));
        }
        if self.get()?.as_ref() != Some(key) {
            return Err(io::Error::other("the Secret Service did not keep the key"));
        }
        Ok(())
    }
}

/// The key in `<data>/secrets.key` (mode 0600), for systems without an OS key store and for tests. It keeps `secrets.json`
/// unreadable on its own (a copied or synced file, a pasted log), but anyone who can read the folder has both halves.
pub struct KeyFile {
    file: PathBuf,
}

impl KeyStore for KeyFile {
    fn name(&self) -> KeyStoreName {
        KeyStoreName::File
    }

    fn label(&self) -> &'static str {
        "key file in the data folder"
    }

    fn get(&self) -> io::Result<Option<Key>> {
        Ok(read_if_present(&self.file)?.and_then(|text| key_from_hex(&text)))
    }

    fn set(&self, key: &Key) -> io::Result<()> {
        write_private(&self.file, format!("{}\n", to_hex(key)).as_bytes())
    }
}

fn read_if_present(file: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(file) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// The store of a given kind for a data folder.
pub fn key_store(name: KeyStoreName, data_dir: &Path) -> Box<dyn KeyStore> {
    match name {
        KeyStoreName::Keychain => Box::new(Keychain {
            account: account(data_dir),
        }),
        KeyStoreName::Dpapi => {
            let root = env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
            Box::new(Dpapi {
                file: data_dir.join("secrets.dpapi"),
                powershell: Path::new(&root)
                    .join("System32")
                    .join("WindowsPowerShell")
                    .join("v1.0")
                    .join("powershell.exe"),
            })
        }
        KeyStoreName::Libsecret => Box::new(Libsecret {
            account: account(data_dir),
        }),
        KeyStoreName::File => Box::new(KeyFile {
            file: data_dir.join("secrets.key"),
        }),
    }
}

/// Which store a new key goes to: `chosen` (SATURN_SECRET_STORE) when it names one, otherwise the operating system's own.
pub fn preferred_kind(chosen: Option<&str>, platform: &str) -> KeyStoreName {
    match chosen.map(|name| name.trim().to_lowercase()).as_deref() {
        Some("keychain") => KeyStoreName::Keychain,
        Some("dpapi") => KeyStoreName::Dpapi,
        Some("libsecret") => KeyStoreName::Libsecret,
        Some("file") => KeyStoreName::File,
        _ => match platform {
            "macos" => KeyStoreName::Keychain,
            "windows" => KeyStoreName::Dpapi,
            _ => KeyStoreName::Libsecret,
        },
    }
}

/// The store for a new key on this computer.
pub fn preferred_key_store(data_dir: &Path) -> Box<dyn KeyStore> {
    let chosen = env::var("SATURN_SECRET_STORE").ok();
    key_store(preferred_kind(chosen.as_deref(), env::consts::OS), data_dir)
}

/// A new random key.
pub fn new_key() -> io::Result<Key> {
    let mut key = [0; KEY_BYTES];
    getrandom::fill(&mut key).map_err(io::Error::other)?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_store_follows_the_platform_unless_a_setting_picks_one() {
        assert_eq!(preferred_kind(None, "macos"), KeyStoreName::Keychain);
        assert_eq!(preferred_kind(None, "windows"), KeyStoreName::Dpapi);
        assert_eq!(preferred_kind(None, "linux"), KeyStoreName::Libsecret);
        assert_eq!(preferred_kind(Some(" FILE "), "macos"), KeyStoreName::File);
        assert_eq!(
            preferred_kind(Some("nope"), "macos"),
            KeyStoreName::Keychain
        );
    }

    #[test]
    fn only_exactly_one_key_counts_as_a_key() {
        assert_eq!(key_from_hex(&"07".repeat(32)), Some([7; 32]));
        assert_eq!(
            key_from_hex(&format!("{}\n", "07".repeat(32))),
            Some([7; 32])
        );
        assert_eq!(key_from_hex(&"07".repeat(31)), None);
        assert_eq!(key_from_hex(&"zz".repeat(32)), None);
        assert_eq!(key_from_hex(&"é".repeat(32)), None);
        assert_eq!(key_from_base64(&BASE64.encode([1; 32])), Some([1; 32]));
        assert_eq!(key_from_base64(&BASE64.encode([1; 31])), None);
    }

    #[test]
    fn the_key_file_round_trips_a_key() {
        let folder = tempfile::tempdir().expect("a temporary folder");
        let store = key_store(KeyStoreName::File, folder.path());
        assert_eq!(store.get().expect("readable"), None);
        store.set(&[7; 32]).expect("writable");
        assert_eq!(store.get().expect("readable"), Some([7; 32]));
    }
}
