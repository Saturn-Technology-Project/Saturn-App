//! What `runtime/test/secrets.test.ts` and `runtime/test/shared-cases.test.ts` check, on this implementation, with the files
//! in `contract/cases` both must agree on. Everything happens in temporary folders with the key file as the key store.
use std::fs;
use std::io;
use std::path::Path;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use saturn_store::key_store::{Key, KeyStore, KeyStoreName, account, dpapi_script, key_store};
use saturn_store::secrets::{Envelope, decrypt, encrypt_with_iv};
use saturn_store::{AppState, FileStore, Secrets, SecretsFile};
use serde_json::{Value, json};

const KEY: &str = "sk-ant-api03-THIS-MUST-NEVER-BE-ON-DISK";

fn key_file_only(directory: &Path) -> SecretsFile {
    let owned = directory.to_path_buf();
    SecretsFile::with_preferred(
        directory,
        Box::new(move || key_store(KeyStoreName::File, &owned)),
    )
}

async fn open(directory: &Path) -> FileStore {
    FileStore::load_with(directory, key_file_only(directory))
        .await
        .expect("the data folder loads")
}

fn temporary() -> tempfile::TempDir {
    tempfile::tempdir().expect("a temporary folder")
}

fn read_json(file: &Path) -> Value {
    serde_json::from_slice(&fs::read(file).expect("the file exists")).expect("the file is JSON")
}

fn names_starting(directory: &Path, prefix: &str) -> Vec<String> {
    fs::read_dir(directory)
        .expect("the folder exists")
        .map(|entry| {
            entry
                .expect("an entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name.starts_with(prefix))
        .collect()
}

fn secret_cases() -> Value {
    serde_json::from_str(include_str!("../../../contract/cases/secrets.json"))
        .expect("the cases are JSON")
}

fn state_cases() -> Value {
    serde_json::from_str(include_str!("../../../contract/cases/state.json"))
        .expect("the cases are JSON")
}

fn case_key(cases: &Value) -> Key {
    let hex = cases["key"].as_str().expect("a key");
    let bytes: Vec<u8> = (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).expect("hex"))
        .collect();
    bytes.try_into().expect("32 bytes")
}

#[test]
fn opens_what_typescript_encrypted_and_encrypts_it_byte_for_byte() {
    let cases = secret_cases();
    let key = case_key(&cases);
    let envelope: Envelope =
        serde_json::from_value(cases["envelope"].clone()).expect("an envelope");
    let secrets: Secrets = serde_json::from_value(cases["secrets"].clone()).expect("secrets");
    assert_eq!(decrypt(&envelope, &key).expect("it opens"), secrets);

    let iv: [u8; 12] = BASE64
        .decode(&envelope.iv)
        .expect("base64")
        .try_into()
        .expect("12 bytes");
    let again = encrypt_with_iv(&secrets, &key, KeyStoreName::File, &iv).expect("it encrypts");
    assert_eq!(
        again, envelope,
        "the same bytes, which runtime/ decrypts in its own test"
    );
    assert_eq!(
        serde_json::to_value(&again).expect("JSON"),
        cases["envelope"]
    );
}

#[test]
fn names_keys_and_scripts_as_typescript_does() {
    let cases = secret_cases();
    for item in cases["accounts"].as_array().expect("accounts") {
        let dir = item["dir"].as_str().expect("a folder");
        assert_eq!(
            account(Path::new(dir)),
            item["account"].as_str().expect("an account")
        );
    }
    for operation in ["Protect", "Unprotect"] {
        assert_eq!(
            dpapi_script(operation),
            cases["dpapi"][operation].as_str().expect("a script")
        );
    }
}

#[tokio::test]
async fn saves_a_state_file_the_way_typescript_does() {
    let cases = state_cases();
    let folder = temporary();
    let file = folder.path().join("state.json");
    fs::write(&file, serde_json::to_vec(&cases["saved"]).expect("JSON")).expect("writable");

    let store = open(folder.path()).await;
    store.update(|_| ()).await.expect("it saves");
    assert_eq!(read_json(&file), cases["written"]);
    assert!(
        names_starting(folder.path(), "state.json.").is_empty(),
        "nothing was set aside"
    );

    // And a second round changes nothing.
    let store = open(folder.path()).await;
    store.update(|_| ()).await.expect("it saves");
    assert_eq!(read_json(&file), cases["written"]);
}

#[tokio::test]
async fn an_empty_folder_starts_with_the_defaults() {
    let folder = temporary();
    let nested = folder.path().join("not").join("yet");
    let store = open(&nested).await;
    store.update(|_| ()).await.expect("it saves");
    assert_eq!(
        read_json(&nested.join("state.json")),
        json!({
            "projects": [], "activeProjectId": null, "agents": [], "automations": [], "models": [], "mcp": [], "rag": [],
            "runs": [], "threads": [], "groups": [], "groupMessages": [], "usage": [],
            "settings": { "name": "Saturn", "environment": "production", "logging": "info", "completionModelId": null },
        })
    );
    assert!(
        !nested.join("secrets.json").exists(),
        "no key is made until there is a secret to keep"
    );
}

#[tokio::test]
async fn a_clipped_emoji_does_not_cost_the_rest_of_the_state() {
    let folder = temporary();
    // What JSON.stringify writes for "😀".slice(0, 1).
    fs::write(
        folder.path().join("state.json"),
        r#"{"runs":[{"id":"r1","output":"before \ud83d"},{"id":"r2","output":"😀"}]}"#,
    )
    .expect("writable");
    let store = open(folder.path()).await;
    let outputs = store.read(|state| {
        state
            .runs
            .iter()
            .map(|run| run["output"].clone())
            .collect::<Vec<_>>()
    });
    assert_eq!(outputs, [json!("before \u{fffd}"), json!("😀")]);
    assert!(names_starting(folder.path(), "state.json.").is_empty());
}

#[tokio::test]
async fn a_value_nested_too_deep_cannot_end_the_runtime_or_cost_the_rest_of_the_state() {
    let folder = temporary();
    let depth = 200_000;
    let contents = format!(
        r#"{{"runs":[{{"id":"r1","actions":[{{"arguments":{}{}}}]}}],"agents":[{{"id":"a1"}}]}}"#,
        "[".repeat(depth),
        "]".repeat(depth)
    );
    fs::write(folder.path().join("state.json"), &contents).expect("writable");
    let store = open(folder.path()).await;
    assert_eq!(store.read(|state| state.runs[0]["id"].clone()), "r1");
    assert_eq!(
        store.read(|state| state.agents.clone()),
        [json!({ "id": "a1" })]
    );
    store.update(|_| ()).await.expect("it saves");
    let kept = names_starting(folder.path(), "state.json.unreadable-");
    assert_eq!(kept.len(), 1);
    assert_eq!(
        fs::read_to_string(folder.path().join(&kept[0])).expect("kept"),
        contents
    );
}

#[tokio::test]
async fn an_unusable_state_file_is_kept_aside() {
    for contents in [
        "{ not json",
        "null",
        "[]",
        "{\"runs\":{\"not\":\"a list\"}}",
    ] {
        let folder = temporary();
        let file = folder.path().join("state.json");
        fs::write(&file, contents).expect("writable");
        let store = open(folder.path()).await;
        assert_eq!(
            store.read(AppState::clone),
            AppState::default(),
            "{contents}"
        );
        store.update(|_| ()).await.expect("it saves");
        let kept = names_starting(folder.path(), "state.json.unreadable-");
        assert_eq!(kept.len(), 1, "{contents}");
        assert_eq!(
            fs::read_to_string(folder.path().join(&kept[0])).expect("kept"),
            contents
        );
    }
}

#[tokio::test]
async fn only_the_damaged_part_of_a_state_file_starts_empty() {
    let folder = temporary();
    fs::write(
        folder.path().join("state.json"),
        r#"{"runs":"not a list","agents":[{"id":"a1"}]}"#,
    )
    .expect("writable");
    let store = open(folder.path()).await;
    assert_eq!(
        store.read(|state| state.agents.clone()),
        [json!({ "id": "a1" })]
    );
    assert_eq!(
        names_starting(folder.path(), "state.json.unreadable-").len(),
        1
    );
}

#[tokio::test]
async fn changes_stay_in_order_and_are_announced() {
    let folder = temporary();
    let store = Arc::new(open(folder.path()).await);
    let mut changes = store.changes();
    let writers: Vec<_> = (0..20)
        .map(|index| {
            let store = Arc::clone(&store);
            tokio::spawn(async move {
                store
                    .update(|state| state.runs.push(json!({ "id": index })))
                    .await
                    .expect("it saves");
            })
        })
        .collect();
    for writer in writers {
        writer.await.expect("it finishes");
    }
    assert_eq!(
        read_json(&folder.path().join("state.json"))["runs"]
            .as_array()
            .expect("runs")
            .len(),
        20
    );
    changes.changed().await.expect("announced");
    assert_eq!(*changes.borrow_and_update(), 20);
}

#[tokio::test]
async fn secrets_json_holds_only_ciphertext_and_a_fresh_start_reads_the_key_back() {
    let folder = temporary();
    let store = open(folder.path()).await;
    store
        .put_secret("model:anthropic", KEY)
        .await
        .expect("it saves");

    let file = folder.path().join("secrets.json");
    let raw = fs::read_to_string(&file).expect("written");
    assert!(
        !raw.contains(KEY) && !raw.contains("sk-ant"),
        "no plaintext key on disk"
    );
    let envelope: Value = serde_json::from_str(&raw).expect("JSON");
    assert_eq!(envelope["format"], "saturn-secrets");
    assert_eq!(envelope["cipher"], "aes-256-gcm");
    assert_eq!(envelope["keyStore"], "file");
    #[cfg(unix)]
    for name in ["secrets.json", "secrets.key", "state.json"] {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = fs::metadata(folder.path().join(name))
            .expect("written")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "{name}");
    }

    let again = open(folder.path()).await;
    assert_eq!(again.secret("model:anthropic").as_deref(), Some(KEY));
    let protection = again.secrets_protection().await;
    assert_eq!(protection.key_store, KeyStoreName::File);
    assert_eq!(protection.label, "key file in the data folder");

    // A new IV on every write: the same secrets never produce the same file.
    again
        .put_secret("model:anthropic", KEY)
        .await
        .expect("it saves");
    assert_ne!(read_json(&file)["iv"], envelope["iv"]);
}

#[tokio::test]
async fn a_saved_state_change_leaves_secrets_json_alone() {
    let folder = temporary();
    let store = open(folder.path()).await;
    store
        .put_secret("model:anthropic", KEY)
        .await
        .expect("it saves");
    let file = folder.path().join("secrets.json");
    let before = fs::read(&file).expect("written");
    store
        .update(|state| state.runs.push(json!({})))
        .await
        .expect("it saves");
    assert_eq!(fs::read(&file).expect("still there"), before);
    store
        .delete_secret("model:anthropic")
        .await
        .expect("it saves");
    assert_eq!(open(folder.path()).await.secret("model:anthropic"), None);
}

#[tokio::test]
async fn a_plaintext_secrets_file_from_an_early_version_is_encrypted_on_first_load() {
    let folder = temporary();
    let file = folder.path().join("secrets.json");
    fs::write(
        &file,
        json!({ "model:openai": KEY, "mcp:github": "ghp_token" }).to_string(),
    )
    .expect("writable");
    let store = open(folder.path()).await;
    assert_eq!(store.secret("model:openai").as_deref(), Some(KEY));
    assert_eq!(store.secret("mcp:github").as_deref(), Some("ghp_token"));
    let raw = fs::read_to_string(&file).expect("written");
    assert!(
        !raw.contains(KEY) && !raw.contains("ghp_token"),
        "the plaintext is gone"
    );
}

#[tokio::test]
async fn a_file_whose_key_is_gone_is_kept_aside_and_saturn_starts_fresh() {
    let folder = temporary();
    open(folder.path())
        .await
        .put_secret("model:anthropic", KEY)
        .await
        .expect("it saves");
    let file = folder.path().join("secrets.json");
    let sealed = fs::read(&file).expect("written");
    fs::remove_file(folder.path().join("secrets.key")).expect("removed");

    let store = open(folder.path()).await;
    assert_eq!(store.secret("model:anthropic"), None);
    let kept = names_starting(folder.path(), "secrets.json.locked-");
    assert_eq!(kept.len(), 1);
    assert_eq!(
        fs::read(folder.path().join(&kept[0])).expect("kept"),
        sealed
    );

    store
        .put_secret("model:openai", "sk-new")
        .await
        .expect("it saves");
    assert_eq!(
        open(folder.path()).await.secret("model:openai").as_deref(),
        Some("sk-new")
    );
}

#[tokio::test]
async fn tampered_ciphertext_is_rejected_rather_than_half_read() {
    let folder = temporary();
    open(folder.path())
        .await
        .put_secret("model:anthropic", KEY)
        .await
        .expect("it saves");
    let file = folder.path().join("secrets.json");
    let mut envelope = read_json(&file);
    let mut data = BASE64
        .decode(envelope["data"].as_str().expect("data"))
        .expect("base64");
    data[0] ^= 0xff;
    envelope["data"] = json!(BASE64.encode(data));
    fs::write(&file, envelope.to_string()).expect("writable");

    assert_eq!(open(folder.path()).await.secret("model:anthropic"), None);
    assert_eq!(
        names_starting(folder.path(), "secrets.json.locked-").len(),
        1
    );
}

#[tokio::test]
async fn a_secrets_file_this_version_cannot_read_is_not_taken_for_plaintext() {
    let later = json!({ "format": "saturn-secrets", "version": 2, "cipher": "another-cipher", "keyStore": "file", "iv": "aa", "tag": "bb", "data": "cc" }).to_string();
    for contents in [later.as_str(), "{ not json", "[]"] {
        let folder = temporary();
        let file = folder.path().join("secrets.json");
        fs::write(&file, contents).expect("writable");
        let store = open(folder.path()).await;
        assert_eq!(store.secret("format"), None, "{contents}");
        assert_eq!(fs::read_to_string(&file).expect("untouched"), contents);
        assert_eq!(
            names_starting(folder.path(), "secrets.json.unreadable-").len(),
            1,
            "{contents}"
        );
    }
}

/// An operating system's key store that refuses every write.
struct Refusing;

impl KeyStore for Refusing {
    fn name(&self) -> KeyStoreName {
        KeyStoreName::Keychain
    }

    fn label(&self) -> &'static str {
        "macOS Keychain"
    }

    fn get(&self) -> io::Result<Option<Key>> {
        Ok(None)
    }

    fn set(&self, _key: &Key) -> io::Result<()> {
        Err(io::Error::other("User interaction is not allowed."))
    }
}

#[tokio::test]
async fn when_the_os_key_store_refuses_the_key_goes_to_a_key_file_and_secrets_are_still_encrypted()
{
    let folder = temporary();
    let secrets = SecretsFile::with_preferred(folder.path(), Box::new(|| Box::new(Refusing)));
    let store = FileStore::load_with(folder.path(), secrets)
        .await
        .expect("it loads");
    store
        .put_secret("model:anthropic", KEY)
        .await
        .expect("it saves");
    assert_eq!(
        store.secrets_protection().await.key_store,
        KeyStoreName::File
    );
    let raw = fs::read_to_string(folder.path().join("secrets.json")).expect("written");
    assert_eq!(
        serde_json::from_str::<Value>(&raw).expect("JSON")["keyStore"],
        "file"
    );
    assert!(!raw.contains(KEY));
    assert_eq!(
        open(folder.path())
            .await
            .secret("model:anthropic")
            .as_deref(),
        Some(KEY),
        "the envelope names the store its key is in"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_failed_secret_write_is_retried_by_the_next_save() {
    use std::os::unix::fs::PermissionsExt as _;
    let folder = temporary();
    let store = open(folder.path()).await;
    let locked = |mode| {
        fs::set_permissions(folder.path(), fs::Permissions::from_mode(mode)).expect("settable")
    };
    locked(0o500);
    let failed = store.put_secret("model:anthropic", KEY).await;
    locked(0o700);
    assert!(failed.is_err(), "the folder cannot be written");
    assert_eq!(
        store.secret("model:anthropic").as_deref(),
        Some(KEY),
        "the change stays in memory"
    );

    store.update(|_| ()).await.expect("it saves");
    assert_eq!(
        open(folder.path())
            .await
            .secret("model:anthropic")
            .as_deref(),
        Some(KEY)
    );
}
