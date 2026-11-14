//! The Windows sandbox, as far as it is decided before a program starts: what a command's container is opened to, and
//! the invocation that starts it. That a container then keeps a program to that is tried on Windows, by the contract.
use std::ffi::OsString;
use std::path::{Path, PathBuf};

#[cfg(not(windows))]
use saturn_appcontainer::Policy;
use saturn_tools::confine::{Confinement, windows_confinement};
#[cfg(not(windows))]
use saturn_tools::sandbox::{Platform, SandboxSupport, sandbox_support, wrap_command};
use saturn_tools::sandbox::{SandboxMode, SandboxSettings, windows_hint, windows_policy};
use saturn_tools::shell::Env;
#[cfg(not(windows))]
use saturn_tools::shell::Invocation;

/// A folder that exists, so its path resolves the same way every time it is asked for.
fn folder(root: &Path, name: &str) -> String {
    let folder = root.join(name);
    std::fs::create_dir_all(&folder).expect("a folder");
    std::fs::canonicalize(&folder)
        .map(saturn_domain::plain_path)
        .expect("resolves")
        .to_string_lossy()
        .into_owned()
}

fn env(root: &Path) -> Env {
    let path = std::env::join_paths([folder(root, "tools")]).expect("a path");
    [
        (OsString::from("PATH"), path),
        (
            OsString::from("USERPROFILE"),
            OsString::from(folder(root, "home")),
        ),
        (
            OsString::from("SystemRoot"),
            OsString::from(folder(root, "windows")),
        ),
    ]
    .into_iter()
    .collect()
}

const WRITE: SandboxSettings = SandboxSettings {
    mode: SandboxMode::WorkspaceWrite,
    network: true,
};

#[test]
fn a_command_writes_its_workspace_and_a_temporary_folder_of_its_own_and_shares_the_caches() {
    let root = tempfile::tempdir().expect("a folder");
    let env = env(root.path());
    let (work, extra) = (folder(root.path(), "work"), folder(root.path(), "extra"));
    let token = folder(root.path(), "home/.cache/huggingface");
    let secrets = folder(root.path(), "home/.ssh");
    let programs = folder(root.path(), "saturn/programs");
    let hidden = [
        token.clone(),
        secrets.clone(),
        folder(root.path(), "saturn"),
    ];
    let policy = windows_policy(
        WRITE,
        &work,
        std::slice::from_ref(&extra),
        &hidden,
        std::slice::from_ref(&programs),
        &env,
    );
    let temporary = policy.temporary.clone().expect("a temporary folder");
    assert_eq!(
        policy.write,
        vec![work.clone(), extra.clone(), temporary.clone()]
    );
    assert!(policy.read.is_empty());
    assert!(policy.network);
    let shared = &policy.shared[0];
    assert!(shared.read.contains(&folder(root.path(), "tools")));
    assert!(shared.read.contains(&programs));
    assert!(shared.write.contains(&folder(root.path(), "home/.cache")));
    // Only what lies inside an opened folder has to be closed; the rest was never opened.
    assert_eq!(policy.deny, vec![token]);

    let reading = windows_policy(
        SandboxSettings {
            mode: SandboxMode::ReadOnly,
            network: false,
        },
        &work,
        std::slice::from_ref(&extra),
        &hidden,
        &[],
        &env,
    );
    assert_eq!(reading.read, vec![work, extra]);
    assert_eq!(
        reading.write,
        vec![reading.temporary.clone().expect("a temporary folder")]
    );
    assert!(reading.shared[0].write.is_empty());
    assert!(!reading.network);
    // Another policy is another container, so what was opened to write is not open to the one that only reads.
    assert_ne!(reading.name(), policy.name());
}

#[test]
fn a_run_shares_what_outlasts_it_with_its_project_and_keeps_the_rest_to_itself() {
    let root = tempfile::tempdir().expect("a folder");
    let env = env(root.path());
    let path = |name: &str| PathBuf::from(folder(root.path(), name));
    let records = path("project/.saturn/research/runs/r1");
    std::fs::write(records.join("run.json"), "{}").expect("a file");
    let confinement = Confinement {
        writable: vec![records.clone(), path("home/.cache")],
        protected: vec![records.join("run.json"), path("snapshot")],
        hidden: vec![path("project"), path("home/.cache/huggingface/token")],
        visible: vec![path("snapshot"), path("project/.venv")],
        network: false,
        lasting: vec![path("project/.venv")],
        group: "C:\\Study".to_owned(),
    };
    let policy = windows_confinement(&confinement, &env);
    let text = |path: &Path| path.to_string_lossy().into_owned();
    assert_eq!(policy.write, vec![text(&records)]);
    assert_eq!(policy.read, vec![text(&path("snapshot"))]);
    assert_eq!(policy.shared[0].write, vec![text(&path("home/.cache"))]);
    assert_eq!(policy.shared[1].name, "saturnRuns:c:\\study");
    assert_eq!(policy.shared[1].read, vec![text(&path("project/.venv"))]);
    assert_eq!(
        policy.deny,
        vec![
            text(&path("home/.cache/huggingface/token")),
            text(&records.join("run.json"))
        ]
    );
    assert_eq!(policy.temporary, None);
}

// Not on Windows itself, where naming a launcher is not enough: the sandbox is tried before it is used, and the
// contract does that with the real launcher.
#[cfg(not(windows))]
#[test]
fn only_a_program_that_named_its_launcher_sandboxes_on_windows() {
    let root = tempfile::tempdir().expect("a folder");
    let env = env(root.path());
    let work = folder(root.path(), "work");
    let command = || Invocation {
        file: "cmd.exe".to_owned(),
        args: vec!["/c".to_owned(), "\"dir\"".to_owned()],
        verbatim: true,
    };
    let wrap = || {
        wrap_command(
            command(),
            WRITE,
            &work,
            &[],
            &[],
            &[],
            Platform::Windows,
            &env,
        )
    };
    let plain = wrap();
    assert!(!plain.sandboxed);
    assert_eq!(plain.invocation, command());
    assert_eq!(
        plain.reason.as_deref(),
        Some("this program cannot start a Windows sandbox")
    );

    saturn_tools::appcontainer::set_launcher(PathBuf::from("saturn-server.exe"));
    assert_eq!(
        sandbox_support(Platform::Windows, &env),
        SandboxSupport::Available("AppContainer")
    );
    let wrapped = wrap();
    assert!(wrapped.sandboxed);
    assert_eq!(wrapped.invocation.file, "saturn-server.exe");
    assert!(wrapped.invocation.verbatim);
    assert_eq!(wrapped.invocation.args[0], "--appcontainer");
    let policy = Policy::decoded(&wrapped.invocation.args[1]).expect("a policy");
    assert_eq!(policy.write[0], work);
    assert_eq!(&wrapped.invocation.args[2..], ["cmd.exe", "/c", "\"dir\""]);
    let off = SandboxSettings {
        mode: SandboxMode::Off,
        network: true,
    };
    let unwrapped = wrap_command(
        command(),
        off,
        &work,
        &[],
        &[],
        &[],
        Platform::Windows,
        &env,
    );
    assert_eq!(unwrapped.invocation, command());
}

#[test]
fn a_failure_the_container_caused_is_explained_and_another_is_not() {
    let offline = SandboxSettings {
        mode: SandboxMode::WorkspaceWrite,
        network: false,
    };
    let hint = |stderr: &str, settings| windows_hint(stderr, settings).unwrap_or_default();
    assert!(
        hint(
            "'node' is not recognized as an internal or external command,",
            WRITE
        )
        .contains("only programs in folders opened to it")
    );
    assert!(hint("Access is denied.", WRITE).contains("only the workspace"));
    assert!(hint("connect ECONNREFUSED 127.0.0.1:4700", WRITE).contains("localhost"));
    assert!(hint("getaddrinfo ENOTFOUND example.com", offline).contains("blocks network access"));
    assert_eq!(
        windows_hint("getaddrinfo ENOTFOUND example.com", WRITE),
        None
    );
    assert_eq!(windows_hint("SyntaxError: unexpected token", WRITE), None);
}

#[test]
fn the_setup_names_the_programs_folders_the_caches_and_a_folder_given() {
    let root = tempfile::tempdir().expect("a folder");
    let env = env(root.path());
    let elsewhere = folder(root.path(), "drive/study");
    let policy = saturn_tools::appcontainer::setup_policy(&env, std::slice::from_ref(&elsewhere));
    assert!(policy.write.is_empty() && policy.read.is_empty() && policy.deny.is_empty());
    let shared = &policy.shared[0];
    assert!(shared.read.contains(&folder(root.path(), "tools")));
    assert!(shared.write.contains(&folder(root.path(), "home/.cache")));
    // The folder given is named by a file inside it, so the folders above are opened and the folder itself is not.
    assert!(shared.read.iter().any(|path| {
        std::path::Path::new(path).parent() == Some(std::path::Path::new(&elsewhere))
    }));
    assert!(!shared.read.contains(&elsewhere));
}
