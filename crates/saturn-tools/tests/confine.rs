//! The sandbox around an experiment run's program: what its seatbelt profile and bubblewrap arguments allow, and in
//! which order, since the later rule wins.
use std::path::PathBuf;

use saturn_tools::confine::{
    Confinement, bubblewrap_confinement, credential_folders, seatbelt_confinement,
};

/// A confinement over real temporary folders: a project hidden but for one linked folder, a records folder inside it
/// that the program writes, with a record of Saturn's it may not write.
fn sample() -> (tempfile::TempDir, Confinement) {
    let root = tempfile::tempdir().expect("a temporary folder");
    let real = std::fs::canonicalize(root.path()).expect("it exists");
    let project = real.join("project");
    let records = project.join(".saturn/research/runs/run_a");
    let linked = project.join(".venv");
    let tree = real.join("data/run-snapshots/run_a/tree");
    for folder in [&records, &linked, &tree] {
        std::fs::create_dir_all(folder).expect("a folder");
    }
    std::fs::write(records.join("run.json"), "{}").expect("a file");
    let confinement = Confinement {
        writable: vec![records.clone()],
        protected: vec![records.join("run.json"), tree.clone()],
        hidden: vec![project, real.join("data")],
        visible: vec![tree, linked],
        network: false,
    };
    (root, confinement)
}

/// Where a line is in a profile, failing if it is not there.
fn position(profile: &str, needle: &str) -> usize {
    profile
        .find(needle)
        .unwrap_or_else(|| panic!("{needle} is not in\n{profile}"))
}

#[test]
fn seatbelt_reopens_only_what_the_program_may_reach_after_closing_the_rest() {
    let (_root, confinement) = sample();
    let profile = seatbelt_confinement(&confinement, &[PathBuf::from("/private/tmp")]);
    let records = confinement.writable[0].to_string_lossy().into_owned();
    let run_file = confinement.protected[0].to_string_lossy().into_owned();
    let project = confinement.hidden[0].to_string_lossy().into_owned();
    let all_writes_closed = position(&profile, "(deny file-write*)");
    let shared = position(&profile, "(subpath \"/private/tmp\")");
    let hidden_closed = position(
        &profile,
        &format!("(deny file-write* (subpath \"{project}\")"),
    );
    let records_open = profile
        .rfind(&format!("(allow file-write* (subpath \"{records}\")"))
        .expect("the records folder is opened again");
    let run_closed = profile
        .rfind(&format!("(subpath \"{run_file}\")"))
        .expect("the run's record is closed");
    assert!(all_writes_closed < shared && shared < hidden_closed);
    assert!(
        hidden_closed < records_open && records_open < run_closed,
        "{profile}"
    );
    let reads_closed = position(&profile, "(deny file-read-data file-read-xattr");
    let reads_open = position(&profile, "(allow file-read-data file-read-xattr");
    assert!(reads_closed < reads_open);
    assert!(
        profile[reads_open..].contains(".venv"),
        "a linked folder can be read"
    );
    assert!(profile.contains("(deny network*)"));
}

#[test]
fn seatbelt_leaves_the_network_alone_when_it_is_allowed() {
    let (_root, mut confinement) = sample();
    confinement.network = true;
    assert!(!seatbelt_confinement(&confinement, &[]).contains("network"));
}

#[test]
fn bubblewrap_hides_before_it_binds_and_binds_protected_folders_read_only() {
    let (_root, confinement) = sample();
    let records = &confinement.writable[0];
    let args = bubblewrap_confinement(&confinement, &confinement.visible[0]);
    let index = |flag: &str, path: &PathBuf| {
        let path = path.to_string_lossy().into_owned();
        args.windows(2)
            .rposition(|pair| pair[0] == flag && pair[1] == path)
            .unwrap_or_else(|| panic!("{flag} {path} is not in {args:?}"))
    };
    let project_hidden = index("--tmpfs", &confinement.hidden[0]);
    let records_bound = index("--bind-try", records);
    let tree_protected = index("--ro-bind-try", &confinement.protected[1]);
    assert!(project_hidden < records_bound && records_bound < tree_protected);
    // A file bound over itself would be detached the first time Saturn renames a new record over it.
    let run_file = confinement.protected[0].to_string_lossy().into_owned();
    assert!(!args.contains(&run_file), "{args:?}");
    let remounted = index("--remount-ro", &confinement.hidden[0]);
    assert!(
        tree_protected < remounted,
        "a write into the hidden project fails"
    );
    assert!(args.iter().any(|arg| arg == "--unshare-net"));
    assert_eq!(&args[..3], ["--ro-bind", "/", "/"]);
    assert!(
        args.windows(2).any(|pair| pair == ["--tmpfs", "/tmp"]),
        "the program's /tmp is its own"
    );
    assert!(
        !args.iter().any(|arg| arg == "--die-with-parent"),
        "a run outlives Saturn"
    );
}

#[test]
fn the_credential_folders_include_ssh_keys_and_cloud_logins() {
    let folders = credential_folders(std::path::Path::new("/home/someone"));
    for expected in [".ssh", ".aws", ".netrc", ".config/gcloud"] {
        assert!(
            folders.contains(&PathBuf::from("/home/someone").join(expected)),
            "{expected}"
        );
    }
}

#[test]
fn a_token_in_a_shared_cache_stays_hidden_after_the_cache_is_opened() {
    let root = tempfile::tempdir().expect("a temporary folder");
    let home = std::fs::canonicalize(root.path()).expect("it exists");
    let cache = home.join(".cache");
    let token = cache.join("huggingface/token");
    std::fs::create_dir_all(token.parent().expect("a folder")).expect("a folder");
    std::fs::write(&token, "hf_secret").expect("a file");
    let confinement = Confinement {
        writable: vec![cache.clone()],
        hidden: credential_folders(&home),
        network: true,
        ..Confinement::default()
    };
    let profile = seatbelt_confinement(&confinement, &[]);
    let token_text = token.to_string_lossy().into_owned();
    let opened = profile
        .find(&format!(
            "(allow file-read-data file-read-xattr (subpath \"{}\")",
            cache.to_string_lossy()
        ))
        .expect("the cache is readable");
    let hidden_again = profile
        .rfind(&format!(
            "(deny file-read-data file-read-xattr file-write* (subpath \"{token_text}\")"
        ))
        .expect("the token is hidden again");
    assert!(opened < hidden_again, "{profile}");

    let args = bubblewrap_confinement(&confinement, &home);
    let bound = args
        .windows(2)
        .position(|pair| pair[0] == "--bind-try" && pair[1] == cache.to_string_lossy())
        .expect("the cache is bound");
    let covered = args
        .windows(3)
        .rposition(|triple| triple == ["--ro-bind", "/dev/null", token_text.as_str()])
        .expect("the token is covered");
    assert!(bound < covered, "{args:?}");
}
