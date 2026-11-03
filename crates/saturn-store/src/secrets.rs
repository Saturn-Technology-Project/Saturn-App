//! The runtime's secrets (API keys, OAuth tokens), encrypted at rest. A random 256-bit key encrypts `secrets.json` with
//! AES-256-GCM; the key itself lives in the operating system's key store, or in a key file when there is none. A plaintext
//! `secrets.json` from an early version is encrypted on first load.
//!
//! Nothing is ever lost silently: a file whose key cannot be found is copied aside before Saturn starts fresh.
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::key_store::{Key, KeyStore, KeyStoreName, key_store, new_key, preferred_key_store};
use crate::{json, set_aside, write_private};

/// Secrets by id. Nothing holding one derives `Debug`, so a log line cannot print them by accident.
pub type Secrets = BTreeMap<String, String>;

const FORMAT: &str = "saturn-secrets";
const CIPHER: &str = "aes-256-gcm";
const ASSOCIATED_DATA: &[u8] = b"saturn-secrets-v1";
const IV_BYTES: usize = 12;
const TAG_BYTES: usize = 16;

/// `secrets.json` on disk: the secrets as one AES-256-GCM ciphertext, and which store holds its key.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub format: String,
    pub version: u32,
    pub cipher: String,
    pub key_store: KeyStoreName,
    pub iv: String,
    pub tag: String,
    pub data: String,
}

/// What the UI shows about how secrets are protected.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SecretsProtection {
    pub encrypted: bool,
    pub key_store: KeyStoreName,
    pub label: &'static str,
}

/// Encrypts secrets under a given IV. Every write needs a new random one (see `encrypt`).
pub fn encrypt_with_iv(
    secrets: &Secrets,
    key: &Key,
    store: KeyStoreName,
    iv: &[u8; IV_BYTES],
) -> io::Result<Envelope> {
    let plaintext = serde_json::to_vec(secrets)?;
    let mut sealed = cipher(key)
        .encrypt(
            Nonce::from_slice(iv),
            Payload {
                msg: &plaintext,
                aad: ASSOCIATED_DATA,
            },
        )
        .map_err(|_| io::Error::other("could not encrypt the secrets"))?;
    let tag = sealed.split_off(sealed.len() - TAG_BYTES);
    Ok(Envelope {
        format: FORMAT.to_owned(),
        version: 1,
        cipher: CIPHER.to_owned(),
        key_store: store,
        iv: BASE64.encode(iv),
        tag: BASE64.encode(tag),
        data: BASE64.encode(sealed),
    })
}

/// Encrypts secrets under a new random IV.
pub fn encrypt(secrets: &Secrets, key: &Key, store: KeyStoreName) -> io::Result<Envelope> {
    let mut iv = [0; IV_BYTES];
    getrandom::fill(&mut iv).map_err(io::Error::other)?;
    encrypt_with_iv(secrets, key, store, &iv)
}

/// Decrypts an envelope. Fails on the wrong key or on any changed byte, so nothing is ever half-read.
pub fn decrypt(envelope: &Envelope, key: &Key) -> io::Result<Secrets> {
    let bytes = |field: &str| {
        BASE64
            .decode(field)
            .map_err(|_| io::Error::other("the secrets file is not valid base64"))
    };
    let iv = bytes(&envelope.iv)?;
    let tag = bytes(&envelope.tag)?;
    let mut sealed = bytes(&envelope.data)?;
    if iv.len() != IV_BYTES || tag.len() != TAG_BYTES {
        return Err(io::Error::other(
            "the secrets file has a malformed IV or tag",
        ));
    }
    sealed.extend_from_slice(&tag);
    let plaintext = cipher(key)
        .decrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: &sealed,
                aad: ASSOCIATED_DATA,
            },
        )
        .map_err(|_| io::Error::other("the key does not open this file, or it was changed"))?;
    serde_json::from_slice(&plaintext)
        .map_err(|_| io::Error::other("the decrypted secrets are not a list of strings"))
}

fn cipher(key: &Key) -> Aes256Gcm {
    Aes256Gcm::new(key.into())
}

/// Picks the store for a new key, so tests can stand in for the operating system's.
pub type PreferredStore = Box<dyn Fn() -> Box<dyn KeyStore> + Send + Sync>;

/// `secrets.json` in a data folder, and the key that opens it.
pub struct SecretsFile {
    directory: PathBuf,
    preferred: PreferredStore,
    store: Box<dyn KeyStore>,
    key: Option<Key>,
}

impl SecretsFile {
    /// Uses the operating system's key store, or the one SATURN_SECRET_STORE names.
    pub fn new(directory: &Path) -> Self {
        let owned = directory.to_path_buf();
        Self::with_preferred(directory, Box::new(move || preferred_key_store(&owned)))
    }

    pub fn with_preferred(directory: &Path, preferred: PreferredStore) -> Self {
        let store = preferred();
        Self {
            directory: directory.to_path_buf(),
            preferred,
            store,
            key: None,
        }
    }

    fn file(&self) -> PathBuf {
        self.directory.join("secrets.json")
    }

    pub fn protection(&self) -> SecretsProtection {
        SecretsProtection {
            encrypted: true,
            key_store: self.store.name(),
            label: self.store.label(),
        }
    }

    /// The saved secrets. A file that cannot be opened is copied aside and counts as none. An error means the file could not
    /// be read at all, or old plaintext could not be encrypted: starting empty then would overwrite it at the next save.
    pub fn load(&mut self) -> io::Result<Secrets> {
        let file = self.file();
        let raw = match fs::read(&file) {
            Ok(raw) => raw,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Secrets::new()),
            Err(error) => return Err(error),
        };
        let parsed: Option<Value> = std::str::from_utf8(&raw)
            .ok()
            .and_then(|text| json::parse(text).ok());
        let Some(Value::Object(fields)) = parsed else {
            self.keep_aside("unreadable", "is not a JSON object");
            return Ok(Secrets::new());
        };

        if fields.get("format").and_then(Value::as_str) == Some(FORMAT) {
            let envelope = serde_json::from_value::<Envelope>(Value::Object(fields))
                .ok()
                .filter(|envelope| envelope.cipher == CIPHER);
            let Some(envelope) = envelope else {
                self.keep_aside("unreadable", "is not in a format this version can read");
                return Ok(Secrets::new());
            };
            self.store = key_store(envelope.key_store, &self.directory);
            return Ok(match self.open(&envelope) {
                Ok((secrets, key)) => {
                    self.key = Some(key);
                    secrets
                }
                Err(error) => {
                    self.keep_aside("locked", &format!("could not be decrypted ({error})"));
                    self.store = (self.preferred)();
                    Secrets::new()
                }
            });
        }

        // An early version's plaintext file: encrypt it now, so the plaintext does not stay on disk.
        let secrets: Secrets = fields
            .into_iter()
            .filter_map(|(id, value)| match value {
                Value::String(secret) => Some((id, secret)),
                _ => None,
            })
            .collect();
        self.save(&secrets)?;
        eprintln!(
            "[store] Encrypted {} saved secrets in secrets.json; the key is kept in the {}",
            secrets.len(),
            self.store.label()
        );
        Ok(secrets)
    }

    fn open(&self, envelope: &Envelope) -> io::Result<(Secrets, Key)> {
        let key = self
            .store
            .get()?
            .ok_or_else(|| io::Error::other(format!("no key in the {}", self.store.label())))?;
        Ok((decrypt(envelope, &key)?, key))
    }

    /// Replaces the file with these secrets, under a new IV.
    pub fn save(&mut self, secrets: &Secrets) -> io::Result<()> {
        let key = self.ensure_key()?;
        let envelope = encrypt(secrets, &key, self.store.name())?;
        let mut text = serde_json::to_string_pretty(&envelope)?;
        text.push('\n');
        write_private(&self.file(), text.as_bytes())
    }

    /// The key for the next write: the loaded one, one already in the store, or a new one (the key file if the OS store
    /// refuses).
    fn ensure_key(&mut self) -> io::Result<Key> {
        if let Some(key) = self.key {
            return Ok(key);
        }
        let key = match self.key_from_store() {
            Ok(key) => key,
            Err(error) if self.store.name() != KeyStoreName::File => {
                eprintln!(
                    "[store] Could not use the {} for the secrets key ({error}); using a key file in the data folder instead",
                    self.store.label()
                );
                self.store = key_store(KeyStoreName::File, &self.directory);
                self.key_from_store()?
            }
            Err(error) => return Err(error),
        };
        self.key = Some(key);
        Ok(key)
    }

    fn key_from_store(&self) -> io::Result<Key> {
        if let Some(key) = self.store.get()? {
            return Ok(key);
        }
        let key = new_key()?;
        self.store.set(&key)?;
        Ok(key)
    }

    fn keep_aside(&self, reason: &str, problem: &str) {
        let kept =
            set_aside(&self.file(), reason).unwrap_or_else(|| "(no copy could be made)".to_owned());
        eprintln!(
            "[store] secrets.json {problem}; starting with no saved keys. The file was kept as {kept}, so nothing is lost."
        );
    }
}
