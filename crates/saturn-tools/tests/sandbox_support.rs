//! What the sandbox says it can do on each system, and the folders it leaves writable there.
use std::ffi::OsString;

use saturn_tools::sandbox::{Platform, SandboxSupport, sandbox_support, writable_folders};
use saturn_tools::shell::Env;

/// An environment of the given variables.
fn env(entries: &[(&str, &str)]) -> Env {
    entries
        .iter()
        .map(|(name, value)| (OsString::from(name), OsString::from(value)))
        .collect()
}

#[test]
fn windows_has_no_sandbox_and_says_so() {
    assert_eq!(
        sandbox_support(Platform::Windows, &env(&[])),
        SandboxSupport::Unavailable("Windows has no sandbox for commands")
    );
}

#[test]
fn linux_needs_bubblewrap_on_the_path() {
    assert_eq!(
        sandbox_support(Platform::Linux, &env(&[("PATH", "/nonexistent")])),
        SandboxSupport::Unavailable("bubblewrap (bwrap) is not installed")
    );
}

#[cfg(unix)]
#[test]
fn linux_finds_bubblewrap_on_the_path() {
    use std::os::unix::fs::PermissionsExt;

    let folder = tempfile::tempdir().expect("a temporary folder");
    let program = folder.path().join("bwrap");
    std::fs::write(&program, "#!/bin/sh\n").expect("a file");
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).expect("executable");
    let path = folder.path().to_string_lossy().into_owned();
    assert_eq!(
        sandbox_support(Platform::Linux, &env(&[("PATH", &path)])),
        SandboxSupport::Available("bubblewrap")
    );
}

#[cfg(target_os = "macos")]
#[test]
fn macos_uses_seatbelt() {
    assert_eq!(
        sandbox_support(Platform::Mac, &env(&[])),
        SandboxSupport::Available("seatbelt")
    );
}

// Unix paths, for the macOS and Linux sandboxes; Windows has neither.
#[cfg(unix)]
#[test]
fn the_workspace_extra_folders_and_caches_stay_writable() {
    let home = tempfile::tempdir().expect("a temporary folder");
    let root = tempfile::tempdir().expect("a temporary folder");
    let extra = tempfile::tempdir().expect("a temporary folder");
    let real = |folder: &std::path::Path| {
        std::fs::canonicalize(folder)
            .expect("it exists")
            .to_string_lossy()
            .into_owned()
    };
    let home_text = real(home.path());
    let root_text = real(root.path());
    let extra_text = real(extra.path());
    let folders = writable_folders(
        &root_text,
        std::slice::from_ref(&extra_text),
        &env(&[("HOME", &home_text), ("PATH", "")]),
        Platform::Mac,
    );
    assert_eq!(folders[0], root_text, "the workspace comes first");
    assert!(folders.contains(&extra_text));
    assert!(
        folders.iter().any(|folder| folder.ends_with("/.npm")),
        "{folders:?}"
    );
    assert!(
        folders.iter().any(|folder| folder.ends_with("/.cache")),
        "{folders:?}"
    );
    let mut unique = folders.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), folders.len(), "each once: {folders:?}");
}
