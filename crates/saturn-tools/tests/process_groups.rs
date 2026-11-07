//! Pausing, continuing and ending a command's whole process group, as an experiment run's pause, continue and stop do.
#![cfg(unix)]

use std::path::Path;
use std::time::{Duration, Instant};

use saturn_tools::{continue_group, group_alive, in_own_group, pause_group, terminate};
use tokio::process::Command;

/// How long the file is, or nothing yet.
fn length(path: &Path) -> u64 {
    std::fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

/// Waits until `done`, failing after five seconds.
async fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "never happened: {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn a_paused_group_writes_nothing_until_it_goes_on_and_still_ends_when_asked() {
    let folder = tempfile::tempdir().expect("a folder");
    let file = folder.path().join("ticks");
    // A child of the shell writes, so the whole group has to stop, not only the process Saturn started.
    let mut command = Command::new("/bin/sh");
    command.args([
        "-c",
        &format!(
            "( while :; do echo tick >> '{}'; sleep 0.05; done ) & wait",
            file.display()
        ),
    ]);
    in_own_group(&mut command);
    let mut child = command.spawn().expect("the loop starts");
    let pid = child.id().expect("a pid");
    until("the first ticks", || length(&file) > 0).await;

    assert!(pause_group(pid), "the group takes the pause");
    // A tick already under way may land; after that nothing.
    tokio::time::sleep(Duration::from_millis(150)).await;
    let paused = length(&file);
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(length(&file), paused, "nothing is written while paused");
    assert!(group_alive(pid), "a paused group is still there");

    assert!(continue_group(pid), "the group goes on");
    until("ticks again", || length(&file) > paused).await;

    pause_group(pid);
    terminate(pid);
    let ended = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    assert!(ended.is_ok(), "a paused group ends when asked to");
    until("the whole group to be gone", || !group_alive(pid)).await;
    assert!(!pause_group(pid), "a group that is gone cannot be paused");
}
