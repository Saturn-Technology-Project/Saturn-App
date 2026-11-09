//! The sandbox a run's program runs in, as its version asks. By default the program reads its snapshot and writes only
//! its own records, its output folder, a temporary folder of its own and the shared caches; the project it was copied
//! from, Saturn's data and the usual credential folders are hidden from it; it gets only the environment variables the
//! version names and a few that say where things are; and it uses the network unless the version says not to. A
//! version may turn the sandbox off, which leaves the snapshot protected by its permissions only.
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use saturn_tools::confine::{Confinement, confine, credential_folders, shared_caches};
use saturn_tools::sandbox::Platform;
use saturn_tools::shell::Invocation;
use serde_json::{Value, json};
use tokio::process::Command;

/// The folder in a run's records that its program writes its own files to.
pub(super) const OUTPUT: &str = "written";

/// The files in its records folder that a run's program writes to; an empty one means it wrote nothing.
const CHANNELS: [&str; 4] = [
    "samples.jsonl",
    "metrics.jsonl",
    "artifacts.jsonl",
    "report.jsonl",
];

/// Variables every confined program gets when they are set: where things are, not who anyone is.
const PASSED: [&str; 34] = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "TERM",
    "TZ",
    "VIRTUAL_ENV",
    "JAVA_HOME",
    "LD_LIBRARY_PATH",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "NODE_EXTRA_CA_CERTS",
    "NODE_PATH",
    "HF_HOME",
    "HF_HUB_CACHE",
    "HF_DATASETS_CACHE",
    "HF_HUB_OFFLINE",
    "HF_DATASETS_OFFLINE",
    "TRANSFORMERS_CACHE",
    "TRANSFORMERS_OFFLINE",
    "TOKENIZERS_PARALLELISM",
    "TORCH_HOME",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
];
/// Families of variables that configure libraries and devices, passed like those above.
const PASSED_PREFIXES: [&str; 12] = [
    "LC_", "CUDA_", "NVIDIA_", "ROCM_", "HIP_", "CONDA_", "PYTHON", "OMP_", "MKL_", "PYTORCH_",
    "XDG_", "UV_",
];
/// Words that mark a variable as a credential; one of these is passed only when the version names it.
const SECRET_WORDS: [&str; 6] = ["TOKEN", "KEY", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH"];

/// What a version asks of the sandbox: whether to use it, and whether the program may use the network.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Settings {
    pub isolated: bool,
    pub network: bool,
}

/// The sandbox a version asks for; one that says nothing gets the sandbox, with the network.
pub(super) fn settings(version: &Value) -> Settings {
    let asked = &version["sandbox"];
    Settings {
        isolated: asked["isolated"].as_bool().unwrap_or(true),
        network: asked["network"].as_bool().unwrap_or(true),
    }
}

/// Whether a variable is one every confined program gets.
fn passed_always(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    if SECRET_WORDS.iter().any(|word| upper.contains(word)) {
        return false;
    }
    PASSED.contains(&name)
        || PASSED_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

/// The environment a confined program gets from `from`: the variables that say where things are, and those the
/// version names. Saturn's own are never passed; the run's are added by the caller. Also what to record: the names
/// passed, and the named ones that were not set.
pub(super) fn environment(
    version: &Value,
    from: impl Iterator<Item = (OsString, OsString)>,
) -> (Vec<(OsString, OsString)>, Value) {
    let declared: Vec<String> = version["envNames"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let mut passed = Vec::new();
    let mut names = Vec::new();
    let mut withheld = 0;
    for (key, value) in from {
        let name = key.to_string_lossy().into_owned();
        if name.starts_with("SATURN_") {
            continue;
        }
        if declared.contains(&name) || passed_always(&name) {
            names.push(name);
            passed.push((key, value));
        } else {
            withheld += 1;
        }
    }
    names.sort();
    let missing: Vec<&String> = declared
        .iter()
        .filter(|name| !names.contains(name))
        .collect();
    (
        passed,
        json!({ "passed": names, "declared": declared, "missing": missing, "withheld": withheld }),
    )
}

/// Where a run's program is, in folders: its snapshot, its own temporary folder, the folder it writes its records in
/// with Saturn's own files there that it may only read, the folders it was made from, which it may not read, and what
/// else it may read though it lies there, such as the run it resumes and that run's checkpoint.
pub(super) struct Placement {
    pub tree: PathBuf,
    pub temporary: PathBuf,
    pub records: PathBuf,
    pub protected: Vec<PathBuf>,
    pub sources: Vec<PathBuf>,
    pub readable: Vec<PathBuf>,
}

/// What the snapshot's links lead to that the run may read, wherever it lies: a folder of the project such as an
/// environment, or a file elsewhere that a committed link names. Either is listed as uncontrolled with the snapshot;
/// reading it here keeps the program's view the same on every system (on Linux `/tmp` is otherwise the sandbox's own).
/// Links into Saturn's data or the credential folders stay hidden.
fn link_targets(
    tree: &Path,
    sources: &[PathBuf],
    data: &[PathBuf],
    hidden: &[PathBuf],
) -> Vec<PathBuf> {
    let sources: Vec<PathBuf> = sources
        .iter()
        .filter_map(|source| std::fs::canonicalize(source).ok())
        .collect();
    let data: Vec<PathBuf> = data
        .iter()
        .filter_map(|path| std::fs::canonicalize(path).ok())
        .collect();
    let hidden: Vec<PathBuf> = hidden
        .iter()
        .filter_map(|path| std::fs::canonicalize(path).ok())
        .collect();
    let mut found = Vec::new();
    let mut pending = vec![tree.to_path_buf()];
    while let Some(folder) = pending.pop() {
        let Ok(reading) = std::fs::read_dir(&folder) else {
            continue;
        };
        for item in reading.flatten() {
            let Ok(kind) = item.file_type() else { continue };
            if kind.is_dir() {
                pending.push(item.path());
            } else if kind.is_symlink() {
                let Ok(target) = std::fs::canonicalize(item.path()) else {
                    continue;
                };
                let in_project = sources.iter().any(|source| target.starts_with(source));
                let in_data = data.iter().any(|folder| target.starts_with(folder));
                if (in_project || !in_data)
                    && !hidden.iter().any(|secret| target.starts_with(secret))
                    && !found.contains(&target)
                {
                    found.push(target);
                }
            }
        }
    }
    found
}

/// The local files or folders the version's models come from, as they are on this computer: a source that is a path,
/// absolute or inside the project, and exists.
fn model_files(version: &Value, sources: &[PathBuf]) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for model in version["models"].as_array().into_iter().flatten() {
        let Some(source) = model["source"].as_str().filter(|source| !source.is_empty()) else {
            continue;
        };
        let given = Path::new(source);
        let candidates: Vec<PathBuf> = if given.is_absolute() {
            vec![given.to_path_buf()]
        } else {
            sources.iter().map(|folder| folder.join(given)).collect()
        };
        if let Some(path) = candidates
            .into_iter()
            .find_map(|candidate| std::fs::canonicalize(candidate).ok())
        {
            found.push(path);
        }
    }
    found
}

/// The home folder, as the program will see it.
pub(super) fn home() -> PathBuf {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .or_else(std::env::home_dir)
        .unwrap_or_default()
}

/// The command that starts `script` in `working` as the version asks: in the sandbox, with the environment it allows,
/// or, with the sandbox off, as before. `data` is Saturn's data folder on this computer. Returns the command (without
/// the run's own variables, its output or its process group, which the caller adds) and what to record about it.
pub(super) async fn command(
    version: &Value,
    placement: &Placement,
    data: &[PathBuf],
    working: &Path,
    script: &str,
) -> std::io::Result<(Command, Value)> {
    let asked = settings(version);
    let output = placement.records.join(OUTPUT);
    tokio::fs::create_dir_all(&output).await?;
    if !asked.isolated {
        let mut command = Command::new("/bin/sh");
        saturn_tools::launch_env(&mut command);
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("SATURN_") {
                command.env_remove(&key);
            }
        }
        command
            .args(["-c", script])
            .current_dir(working)
            .env("SATURN_RUN_OUTPUT", &output);
        let observed = json!({
            "requested": false,
            "isolation": super::snapshot::ISOLATION,
            "network": "not restricted",
            "environment": "inherited",
            "note": "The version turned the sandbox off: the program could write anywhere this account can, and read everything it can.",
        });
        return Ok((command, observed));
    }

    tokio::fs::create_dir_all(&placement.temporary).await?;
    // The files the program writes its records to exist before it starts: on Linux it can write only what is there.
    for name in CHANNELS {
        let file = placement.records.join(name);
        if tokio::fs::symlink_metadata(&file).await.is_err() {
            tokio::fs::write(&file, b"").await?;
        }
    }
    for file in &placement.protected {
        // A record Saturn writes later is made now, so the program cannot make it first.
        if tokio::fs::symlink_metadata(file).await.is_err() {
            let _ = tokio::fs::write(file, b"").await;
        }
    }
    let home = home();
    let credentials = credential_folders(&home);
    let mut hidden: Vec<PathBuf> = placement.sources.clone();
    hidden.extend(data.iter().cloned());
    hidden.extend(credentials.iter().cloned());
    let visible = {
        let tree = placement.tree.clone();
        let sources = placement.sources.clone();
        let secrets = credentials.clone();
        let saturn = data.to_vec();
        let mut visible =
            tokio::task::spawn_blocking(move || link_targets(&tree, &sources, &saturn, &secrets))
                .await
                .unwrap_or_default();
        visible.insert(0, placement.tree.clone());
        // The local weights the version names, such as a checkpoint another run wrote, are read where they are, and so
        // is what a resumed run continues from.
        for path in model_files(version, &placement.sources)
            .into_iter()
            .chain(placement.readable.iter().cloned())
        {
            if !credentials.iter().any(|secret| path.starts_with(secret))
                && !visible.contains(&path)
            {
                visible.push(path);
            }
        }
        visible
    };
    let caches = shared_caches(&home, Platform::current());
    let mut writable = vec![placement.records.clone(), placement.temporary.clone()];
    writable.extend(caches.iter().cloned());
    // The snapshot is read-only wherever it is, even inside a folder the program may otherwise write in.
    let mut protected = placement.protected.clone();
    protected.push(placement.tree.clone());
    let confinement = Confinement {
        writable,
        protected,
        hidden: hidden.clone(),
        visible: visible.clone(),
        network: asked.network,
    };
    let (variables, environment) = environment(version, std::env::vars_os());
    let wrapped = {
        let invocation = Invocation {
            file: "/bin/sh".to_owned(),
            args: vec!["-c".to_owned(), script.to_owned()],
            verbatim: false,
        };
        let env: saturn_tools::shell::Env = std::env::vars_os().collect();
        let working = working.to_path_buf();
        tokio::task::spawn_blocking(move || confine(invocation, &confinement, &working, &env))
            .await
            .unwrap_or_else(|error| Err(error.to_string()))
    };
    let listed = |paths: &[PathBuf]| -> Vec<String> {
        paths
            .iter()
            .filter(|path| path.exists())
            .map(|path| path.to_string_lossy().into_owned())
            .collect()
    };
    let (mut command, observed) = match wrapped {
        Ok(confined) => {
            let mut command = Command::new(&confined.invocation.file);
            saturn_tools::no_window(&mut command);
            command.args(&confined.invocation.args);
            let observed = json!({
                "requested": true,
                "isolation": "sandbox",
                "mechanism": confined.mechanism,
                "network": if asked.network { "allowed" } else { "blocked" },
                "writable": {
                    "records": placement.records,
                    "output": output,
                    "temporary": placement.temporary,
                    "caches": listed(&caches),
                    "sharedTemporary": confined.shared_writable,
                },
                "hidden": listed(&hidden),
                "readable": listed(&visible),
                "environment": environment,
            });
            (command, observed)
        }
        Err(reason) => {
            // No sandbox here: the run goes ahead as it did before there was one, and says so.
            let mut command = Command::new("/bin/sh");
            command.args(["-c", script]);
            let observed = json!({
                "requested": true,
                "isolation": super::snapshot::ISOLATION,
                "unavailable": reason,
                "network": "not restricted",
                "environment": environment,
            });
            (command, observed)
        }
    };
    command
        .current_dir(working)
        .env_clear()
        .envs(variables)
        .env("TMPDIR", &placement.temporary)
        .env("SATURN_RUN_OUTPUT", &output);
    Ok((command, observed))
}

/// What a sandboxed command may neither read nor write: Saturn's data folders (the runtime's token, the keys, every
/// conversation) and the usual credential folders. A command that could read the token could use the runtime's own API
/// to turn its sandbox off or allow itself, and one that could read the keys could send them anywhere.
pub(crate) fn hidden_from_commands(root: &Path) -> Vec<String> {
    let mut hidden = data_folders(root);
    hidden.extend(saturn_tools::confine::credential_folders(&home()));
    hidden
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

/// Saturn's data folders on this computer: the one in use and the usual one, which may differ when a test or a second
/// copy runs.
pub(super) fn data_folders(root: &Path) -> Vec<PathBuf> {
    let mut folders = vec![root.to_path_buf()];
    let usual = home().join(".saturn-app");
    if usual != root {
        folders.push(usual);
    }
    folders
}

#[cfg(test)]
mod tests {
    use super::*;

    fn variables(entries: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        entries
            .iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value)))
            .collect()
    }

    #[test]
    fn a_program_gets_where_things_are_and_what_its_version_names_never_other_keys() {
        let version = json!({ "envNames": ["OPENAI_API_KEY", "NOT_SET"] });
        let (passed, recorded) = environment(
            &version,
            variables(&[
                ("PATH", "/usr/bin"),
                ("HF_HOME", "/cache"),
                ("CUDA_VISIBLE_DEVICES", "0"),
                ("OPENAI_API_KEY", "named"),
                ("ANTHROPIC_API_KEY", "not named"),
                ("HF_TOKEN", "not named"),
                ("PYTHON_KEYRING", "looks like a key"),
                ("SATURN_RUNTIME_TOKEN", "Saturn's own"),
            ])
            .into_iter(),
        );
        let names: Vec<String> = passed
            .iter()
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect();
        for given in ["PATH", "HF_HOME", "CUDA_VISIBLE_DEVICES", "OPENAI_API_KEY"] {
            assert!(names.contains(&given.to_owned()), "{given} in {names:?}");
        }
        for kept in [
            "ANTHROPIC_API_KEY",
            "HF_TOKEN",
            "PYTHON_KEYRING",
            "SATURN_RUNTIME_TOKEN",
        ] {
            assert!(!names.contains(&kept.to_owned()), "{kept} in {names:?}");
        }
        assert_eq!(recorded["missing"], json!(["NOT_SET"]));
        assert_eq!(recorded["withheld"], json!(3));
        assert!(
            !recorded.to_string().contains("named"),
            "only names are recorded"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_run_reads_what_its_links_name_but_never_saturns_data_or_credentials() {
        let root = tempfile::tempdir().expect("a temporary folder");
        let real = std::fs::canonicalize(root.path()).expect("it exists");
        let project = real.join("project");
        let data = real.join("saturn-data");
        let keys = real.join("home/.ssh");
        let elsewhere = real.join("elsewhere");
        let tree = real.join("tree");
        for folder in [&project.join(".venv"), &data, &keys, &elsewhere, &tree] {
            std::fs::create_dir_all(folder).expect("a folder");
        }
        for (name, content) in [
            (elsewhere.join("set.jsonl"), "{}"),
            (data.join("state.json"), "{}"),
            (keys.join("id"), "key"),
        ] {
            std::fs::write(name, content).expect("a file");
        }
        let link = |target: &Path, name: &str| {
            std::os::unix::fs::symlink(target, tree.join(name)).expect("a link")
        };
        link(&project.join(".venv"), ".venv");
        link(&elsewhere.join("set.jsonl"), "set.jsonl");
        link(&data.join("state.json"), "state.json");
        link(&keys.join("id"), "id");
        let found = link_targets(
            &tree,
            std::slice::from_ref(&project),
            std::slice::from_ref(&data),
            std::slice::from_ref(&keys),
        );
        assert!(found.contains(&project.join(".venv")), "{found:?}");
        assert!(
            found.contains(&elsewhere.join("set.jsonl")),
            "a committed link's outside target, as on every system: {found:?}"
        );
        assert!(!found.contains(&data.join("state.json")), "{found:?}");
        assert!(!found.contains(&keys.join("id")), "{found:?}");
    }

    #[test]
    fn a_version_that_says_nothing_gets_the_sandbox_with_the_network() {
        assert_eq!(
            settings(&json!({})),
            Settings {
                isolated: true,
                network: true
            }
        );
        assert_eq!(
            settings(&json!({ "sandbox": { "network": false } })),
            Settings {
                isolated: true,
                network: false
            }
        );
        assert!(!settings(&json!({ "sandbox": { "isolated": false } })).isolated);
    }
}
