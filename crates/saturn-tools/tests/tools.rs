//! What the tools do on a real file system with real commands, in temporary folders.
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::get;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use saturn_domain::Arguments;
use saturn_domain::skills::workspace::Workspace;
use saturn_tools::TEXT_LIMIT;
use saturn_tools::code::{CodeOptions, ScopedJobs, code_output, code_stop, run_code};
use saturn_tools::file::{CaptureFuture, FileCheckpoint, FileSkill};
use saturn_tools::general::{CallFuture, GeneralSkills, ToolCaller};
use saturn_tools::jobs::{JobTable, MAX_JOBS};
use saturn_tools::public_host::{
    Lookup, LookupFuture, assert_public_host, fetch_public, request_through,
};
use saturn_tools::sandbox::{Platform, SandboxMode, SandboxSettings, wrap_command};
use saturn_tools::shell::{Env, Invocation};
use saturn_tools::web::WebSkill;
use serde_json::{Value, json};
use url::Url;

fn args(value: Value) -> Arguments {
    value.as_object().expect("an object").clone()
}

fn off() -> CodeOptions {
    CodeOptions {
        sandbox: Some(SandboxSettings {
            mode: SandboxMode::Off,
            network: true,
        }),
        ..CodeOptions::default()
    }
}

fn with_jobs(table: &JobTable) -> CodeOptions {
    CodeOptions {
        jobs: Some(ScopedJobs {
            table: table.clone(),
            scope: "thread_1".to_owned(),
        }),
        ..off()
    }
}

fn workspace() -> (tempfile::TempDir, Workspace) {
    let folder = tempfile::tempdir().expect("a temporary folder");
    let workspace = Workspace::new(folder.path());
    (folder, workspace)
}

/// Whether a process is alive, by asking the system's own `kill`.
#[cfg(unix)]
fn alive(pid: u64) -> bool {
    std::process::Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Waits a few seconds for something to become true.
async fn eventually(mut condition: impl FnMut() -> bool) -> bool {
    for _ in 0..100 {
        if condition() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

// ---- files ----

#[tokio::test]
async fn files_list_read_write_and_patch() {
    let (folder, workspace) = workspace();
    let skill = FileSkill::new(workspace, None);
    let written = skill
        .run(&args(
            json!({ "action": "write", "path": "a/b.txt", "content": "one\ntwo\nthree\n" }),
        ))
        .await
        .expect("written");
    assert_eq!(written, json!({ "path": "a/b.txt", "bytes": 14 }));
    let listed = skill
        .run(&args(json!({ "path": "a" })))
        .await
        .expect("listed");
    assert_eq!(
        listed,
        json!({ "path": "a", "entries": [{ "name": "b.txt", "kind": "file" }] })
    );
    let top = skill
        .run(&args(json!({ "action": "" })))
        .await
        .expect("listed");
    assert_eq!(
        top,
        json!({ "path": ".", "entries": [{ "name": "a", "kind": "directory" }] })
    );

    let read = skill
        .run(&args(
            json!({ "action": "read", "path": "a/b.txt", "offset": "2", "limit": 1 }),
        ))
        .await
        .expect("read");
    assert_eq!(
        read,
        json!({ "path": "a/b.txt", "offset": 2, "lines": 3, "content": "two" })
    );
    let past = skill
        .run(&args(
            json!({ "action": "read", "path": "a/b.txt", "offset": 99 }),
        ))
        .await
        .expect("read");
    assert_eq!(past["content"], "");

    let patched = skill
        .run(&args(json!({ "action": "patch", "patch": "*** Begin Patch\n*** Add File: new.txt\n+hello\n*** Update File: a/b.txt\n*** Move to: c/d.txt\n@@\n one\n-two\n+2\n*** Delete File: new.txt\n*** End Patch" })))
        .await
        .expect("patched");
    assert_eq!(
        patched,
        json!({ "applied": [
            { "path": "new.txt", "action": "add" },
            { "path": "c/d.txt", "action": "move" },
            { "path": "new.txt", "action": "delete" },
        ]})
    );
    assert_eq!(
        std::fs::read_to_string(folder.path().join("c/d.txt")).expect("moved"),
        "one\n2\nthree\n"
    );
    assert!(!folder.path().join("a/b.txt").exists());

    for (call, message) in [
        (
            json!({ "action": "shred" }),
            "Use list, read, write, or patch",
        ),
        (
            json!({ "action": "read", "path": "../x" }),
            "outside the workspace",
        ),
        (
            json!({ "action": "write", "path": "/etc/x", "content": "x" }),
            "outside the workspace",
        ),
        (
            json!({ "action": "read", "path": "missing.txt" }),
            "missing.txt",
        ),
        (
            json!({ "action": "patch", "patch": "*** Begin Patch\n*** End Patch" }),
            "no file operations",
        ),
        (
            json!({ "action": "patch", "patch": "*** Begin Patch\n*** Add File: c/d.txt\n+x\n*** End Patch" }),
            "c/d.txt already exists",
        ),
        (
            json!({ "action": "patch", "patch": "*** Begin Patch\n*** Update File: c/d.txt\n@@\n-absent\n*** End Patch" }),
            "context was not found",
        ),
    ] {
        let error = skill.run(&args(call.clone())).await.expect_err("refused");
        assert!(error.contains(message), "{call}: {error}");
    }
    let large = "x".repeat(TEXT_LIMIT + 1);
    let error = skill
        .run(&args(
            json!({ "action": "write", "path": "big", "content": large }),
        ))
        .await
        .expect_err("refused");
    assert_eq!(error, "File is too large");
}

/// Records what a checkpoint is told, in order.
#[derive(Default)]
struct Recording(Mutex<Vec<String>>);

impl Recording {
    fn note(&self, what: &str, target: &Path) {
        let name = target.file_name().unwrap_or_default().to_string_lossy();
        self.0
            .lock()
            .expect("not poisoned")
            .push(format!("{what} {name}"));
    }
}

impl FileCheckpoint for Recording {
    fn before<'a>(&'a self, target: &'a Path) -> CaptureFuture<'a> {
        self.note("before", target);
        Box::pin(async { Ok(()) })
    }

    fn after<'a>(&'a self, target: &'a Path) -> CaptureFuture<'a> {
        self.note("after", target);
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test]
async fn every_write_is_shown_to_the_checkpoint_even_when_it_fails() {
    let (_folder, workspace) = workspace();
    let recording = Arc::new(Recording::default());
    let skill = FileSkill::new(workspace, Some(recording.clone()));
    skill
        .run(&args(
            json!({ "action": "write", "path": "a.txt", "content": "a\n" }),
        ))
        .await
        .expect("written");
    skill
        .run(&args(json!({ "action": "patch", "patch": "*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-a\n+b\n*** End Patch" })))
        .await
        .expect("moved");
    let failed = skill
        .run(&args(json!({ "action": "patch", "patch": "*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch" })))
        .await;
    assert!(failed.is_err());
    let seen = recording.0.lock().expect("not poisoned").clone();
    assert_eq!(
        seen,
        [
            "before a.txt",
            "after a.txt",
            "before a.txt",
            "before b.txt",
            "after a.txt",
            "after b.txt",
            "before gone.txt",
            "after gone.txt",
        ]
    );
}

#[cfg(unix)]
#[tokio::test]
async fn the_files_tool_does_not_follow_a_link_out_of_the_workspace() {
    use std::os::unix::fs::symlink;
    let base = tempfile::tempdir().expect("a temporary folder");
    let root = base.path().join("root");
    let outside = base.path().join("outside");
    std::fs::create_dir_all(&root).expect("made");
    std::fs::create_dir_all(&outside).expect("made");
    std::fs::write(outside.join("secret.txt"), "outside").expect("written");
    std::fs::write(root.join("inside.txt"), "inside\n").expect("written");
    symlink(&outside, root.join("out")).expect("linked");
    symlink(outside.join("secret.txt"), root.join("secret-link.txt")).expect("linked");
    symlink(outside.join("not-yet.txt"), root.join("dangling.txt")).expect("linked");
    symlink(root.join("inside.txt"), root.join("stays-in.txt")).expect("linked");
    let workspace = Workspace::new(&root);
    let skill = FileSkill::new(workspace.clone(), None);
    let patch = |body: &str| json!({ "action": "patch", "patch": format!("*** Begin Patch\n{body}\n*** End Patch") });
    for call in [
        json!({ "action": "list", "path": "out" }),
        json!({ "action": "read", "path": "out/secret.txt" }),
        json!({ "action": "read", "path": "secret-link.txt" }),
        json!({ "action": "write", "path": "out/new.txt", "content": "x" }),
        json!({ "action": "write", "path": "out/deep/new.txt", "content": "x" }),
        json!({ "action": "write", "path": "dangling.txt", "content": "x" }),
        patch("*** Add File: out/added.txt\n+x"),
        patch("*** Delete File: secret-link.txt"),
        patch("*** Update File: out/secret.txt\n@@\n-outside\n+changed"),
        patch("*** Update File: inside.txt\n*** Move to: out/moved.txt\n@@\n-inside\n+moved"),
    ] {
        let error = skill.run(&args(call.clone())).await.expect_err("refused");
        assert!(error.contains("outside the workspace"), "{call}: {error}");
    }
    assert_eq!(
        std::fs::read_to_string(outside.join("secret.txt")).expect("kept"),
        "outside"
    );
    assert!(!outside.join("new.txt").exists());
    assert!(!outside.join("not-yet.txt").exists());
    let error = run_code(
        &workspace,
        &args(json!({ "command": "pwd", "cwd": "out" })),
        &off(),
    )
    .await
    .expect_err("refused");
    assert!(error.contains("outside the workspace"), "{error}");

    let kept = skill
        .run(&args(json!({ "action": "read", "path": "stays-in.txt" })))
        .await
        .expect("read");
    assert_eq!(kept["content"], "inside");
    skill
        .run(&args(
            json!({ "action": "write", "path": "new/folder/file.txt", "content": "x" }),
        ))
        .await
        .expect("written");
    assert_eq!(
        std::fs::read_to_string(root.join("new/folder/file.txt")).expect("written"),
        "x"
    );
}

// ---- code ----

#[cfg(unix)]
#[tokio::test]
async fn a_command_reports_its_output_and_exit_code() {
    let (folder, workspace) = workspace();
    std::fs::create_dir(folder.path().join("sub")).expect("made");
    let run = |call: Value| {
        let workspace = workspace.clone();
        async move { run_code(&workspace, &args(call), &off()).await }
    };
    assert_eq!(
        run(json!({ "command": "echo out; echo err >&2" }))
            .await
            .expect("ran"),
        json!({ "stdout": "out\n", "stderr": "err\n", "exitCode": 0, "sandboxed": false })
    );
    let failed = run(json!({ "command": "echo some; exit 7" }))
        .await
        .expect("ran");
    assert_eq!(failed["exitCode"], 7);
    assert_eq!(failed["stdout"], "some\n");
    assert_eq!(failed["stderr"], "Command failed: echo some; exit 7\n");
    let inside = run(json!({ "command": "pwd", "cwd": "sub" }))
        .await
        .expect("ran");
    assert!(
        inside["stdout"]
            .as_str()
            .expect("text")
            .trim_end()
            .ends_with("/sub")
    );
    // Only PATH reaches a command, so the runtime's own keys do not.
    let env =
        run(json!({ "command": "env | grep -v '^PWD=\\|^SHLVL=\\|^_=\\|^OLDPWD=' | cut -d= -f1" }))
            .await
            .expect("ran");
    assert_eq!(env["stdout"], "PATH\n");
    assert_eq!(
        run(json!({ "command": "   " })).await,
        Err("Command is empty".to_owned())
    );
    assert_eq!(
        run(json!({ "command": "true", "cwd": "../.." }))
            .await
            .expect_err("refused"),
        "Path is outside the workspace"
    );
    // Nothing to read: a command waiting for input ends at once rather than at its timeout.
    assert_eq!(
        run(json!({ "command": "cat" })).await.expect("ran")["exitCode"],
        0
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_command_past_its_timeout_ends_with_what_it_started() {
    let (folder, workspace) = workspace();
    let marker = folder.path().join("pid");
    let started = Instant::now();
    let result = run_code(
        &workspace,
        &args(json!({ "command": format!("echo before; sleep 60 & echo $! > {}; wait", marker.display()), "timeout": 1000 })),
        &off(),
    )
    .await
    .expect("ran");
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!(result["exitCode"], 1);
    assert_eq!(result["stdout"], "before\n");
    assert!(
        result["stderr"]
            .as_str()
            .expect("text")
            .contains("stopped after 1000 ms"),
        "{result}"
    );
    let pid: u64 = std::fs::read_to_string(&marker)
        .expect("written")
        .trim()
        .parse()
        .expect("a pid");
    assert!(eventually(|| !alive(pid)).await, "the child went too");
}

#[cfg(unix)]
#[tokio::test]
async fn too_much_output_stops_the_command_and_says_so() {
    let (_folder, workspace) = workspace();
    let result = run_code(&workspace, &args(json!({ "command": "yes é" })), &off())
        .await
        .expect("ran");
    assert_eq!(result["exitCode"], 1);
    let stdout = result["stdout"].as_str().expect("text");
    assert_eq!(saturn_domain::js::length(stdout), TEXT_LIMIT);
    assert!(
        result["stderr"]
            .as_str()
            .expect("text")
            .contains("stdout passed 32000 characters"),
        "{result}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn dropping_a_running_command_ends_it() {
    let (folder, workspace) = workspace();
    let marker = folder.path().join("pid");
    let call =
        args(json!({ "command": format!("sleep 60 & echo $! > {}; wait", marker.display()) }));
    let options = off();
    let running = run_code(&workspace, &call, &options);
    // A stopped run drops the tool's future.
    let _ = tokio::time::timeout(Duration::from_millis(500), running).await;
    let pid: u64 = std::fs::read_to_string(&marker)
        .expect("written")
        .trim()
        .parse()
        .expect("a pid");
    assert!(eventually(|| !alive(pid)).await);
}

#[test]
fn the_sandbox_plan_says_what_it_runs() {
    let invocation = Invocation {
        file: "/bin/sh".to_owned(),
        args: vec!["-c".to_owned(), "true".to_owned()],
        verbatim: false,
    };
    let write = SandboxSettings {
        mode: SandboxMode::WorkspaceWrite,
        network: false,
    };
    let off = SandboxSettings {
        mode: SandboxMode::Off,
        network: true,
    };
    let plan = wrap_command(
        invocation.clone(),
        off,
        "/work",
        &[],
        Platform::current(),
        &Env::new(),
    );
    assert_eq!(
        (plan.invocation, plan.sandboxed, plan.reason),
        (invocation.clone(), false, None)
    );
    let windows = wrap_command(
        invocation.clone(),
        write,
        "C:\\work",
        &[],
        Platform::Windows,
        &Env::new(),
    );
    assert!(!windows.sandboxed);
    assert_eq!(
        windows.reason.as_deref(),
        Some("Windows has no sandbox for commands")
    );
    let mut no_path = Env::new();
    no_path.insert("PATH".into(), "/nonexistent".into());
    let linux = wrap_command(
        invocation.clone(),
        write,
        "/work",
        &[],
        Platform::Linux,
        &no_path,
    );
    assert!(!linux.sandboxed);
    assert_eq!(
        linux.reason.as_deref(),
        Some("bubblewrap (bwrap) is not installed")
    );
}

#[cfg(unix)]
#[test]
fn on_linux_bubblewrap_binds_the_writable_folders() {
    use std::os::unix::fs::PermissionsExt;
    let folder = tempfile::tempdir().expect("a temporary folder");
    let bwrap = folder.path().join("bwrap");
    std::fs::write(&bwrap, "#!/bin/sh\n").expect("written");
    std::fs::set_permissions(&bwrap, std::fs::Permissions::from_mode(0o755)).expect("set");
    let mut env = Env::new();
    env.insert("PATH".into(), folder.path().into());
    env.insert("HOME".into(), "/nonexistent-home".into());
    let invocation = Invocation {
        file: "/bin/sh".to_owned(),
        args: vec!["-c".to_owned(), "true".to_owned()],
        verbatim: false,
    };
    let plan = wrap_command(
        invocation,
        SandboxSettings {
            mode: SandboxMode::WorkspaceWrite,
            network: false,
        },
        "/nonexistent-work",
        &[],
        Platform::Linux,
        &env,
    );
    assert!(plan.sandboxed);
    assert_eq!(plan.invocation.file, bwrap.to_string_lossy());
    let joined = plan.invocation.args.join(" ");
    assert!(joined.starts_with("--ro-bind / / --dev /dev --proc /proc --die-with-parent --bind-try /nonexistent-work /nonexistent-work "), "{joined}");
    assert!(
        joined.contains("--bind-try /nonexistent-home/.npm /nonexistent-home/.npm"),
        "{joined}"
    );
    assert!(
        joined.ends_with("--unshare-net -- /bin/sh -c true"),
        "{joined}"
    );
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn on_macos_a_sandboxed_command_writes_inside_the_workspace_only() {
    let (folder, workspace) = workspace();
    let elsewhere = std::env::home_dir()
        .expect("a home folder")
        .join(format!(".saturn-tools-test-{}", std::process::id()));
    let run = |command: String, mode: SandboxMode, sandbox: Option<&str>| {
        let workspace = workspace.clone();
        let mut call = json!({ "command": command });
        if let Some(value) = sandbox {
            call["sandbox"] = json!(value);
        }
        async move {
            let options = CodeOptions {
                sandbox: Some(SandboxSettings {
                    mode,
                    network: true,
                }),
                ..CodeOptions::default()
            };
            run_code(&workspace, &args(call), &options)
                .await
                .expect("ran")
        }
    };
    let inside = run(
        "echo hello > note.txt && cat note.txt".to_owned(),
        SandboxMode::WorkspaceWrite,
        None,
    )
    .await;
    assert_eq!(inside["exitCode"], 0, "{inside}");
    assert_eq!(inside["sandboxed"], true);
    assert_eq!(
        std::fs::read_to_string(folder.path().join("note.txt")).expect("written"),
        "hello\n"
    );

    let blocked = run(
        format!("mkdir {}", elsewhere.display()),
        SandboxMode::WorkspaceWrite,
        None,
    )
    .await;
    assert_ne!(blocked["exitCode"], 0);
    assert!(
        blocked["stderr"]
            .as_str()
            .expect("text")
            .contains("sandbox: \"off\""),
        "{blocked}"
    );
    assert!(!elsewhere.exists());

    let read_only = run("echo x > other.txt".to_owned(), SandboxMode::ReadOnly, None).await;
    assert_ne!(read_only["exitCode"], 0);
    assert!(!folder.path().join("other.txt").exists());
    let reading = run("cat note.txt".to_owned(), SandboxMode::ReadOnly, None).await;
    assert_eq!(reading["stdout"], "hello\n");

    // The call's own sandbox: "off" (approved by the time the tool runs) lifts the limit.
    let lifted = run(
        format!("mkdir {0} && rmdir {0}", elsewhere.display()),
        SandboxMode::WorkspaceWrite,
        Some("off"),
    )
    .await;
    assert_eq!(lifted["exitCode"], 0, "{lifted}");
    assert_eq!(lifted["sandboxed"], false);
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn on_macos_the_sandbox_can_keep_commands_off_the_network() {
    let address = serve(Router::new().route("/", get(|| async { "reached" }))).await;
    let (_folder, workspace) = workspace();
    let curl = json!({ "command": format!("curl -s http://{address}/") });
    let run = |network: bool| {
        let workspace = workspace.clone();
        let call = args(curl.clone());
        async move {
            let options = CodeOptions {
                sandbox: Some(SandboxSettings {
                    mode: SandboxMode::WorkspaceWrite,
                    network,
                }),
                ..CodeOptions::default()
            };
            run_code(&workspace, &call, &options).await.expect("ran")
        }
    };
    assert_eq!(run(true).await["stdout"], "reached");
    assert_ne!(run(false).await["exitCode"], 0);
}

// ---- background commands ----

#[cfg(unix)]
#[tokio::test]
async fn a_background_command_can_be_read_waited_for_and_stopped() {
    let (_folder, workspace) = workspace();
    let table = JobTable::new();
    let options = with_jobs(&table);
    let started = run_code(
        &workspace,
        &args(json!({ "command": "for i in 1 2 3; do echo tick$i; sleep 0.2; done; echo end", "background": true })),
        &options,
    )
    .await
    .expect("started");
    let id = started["jobId"].as_str().expect("an id").to_owned();
    assert!(id.starts_with("job_"));
    assert_eq!(started["running"], true);
    assert!(
        started["note"]
            .as_str()
            .expect("text")
            .contains("code_output")
    );

    table.when_ended(&id).await;
    let last = code_output(&args(json!({ "jobId": id, "wait": 200 })), &options)
        .await
        .expect("read");
    assert_eq!(last["running"], false);
    assert_eq!(last["exitCode"], 0);
    assert_eq!(
        last["output"]
            .as_str()
            .map(|text| text.ends_with("end\n") || text.contains("tick3")),
        Some(true),
        "{last}"
    );
    assert!(last["startedAt"].is_string() && last["endedAt"].is_string());

    // A long one is stopped, together with the process the shell started.
    let long = run_code(
        &workspace,
        &args(json!({ "command": "sleep 60 & wait", "background": true })),
        &options,
    )
    .await
    .expect("started");
    let long_id = long["jobId"].as_str().expect("an id").to_owned();
    let pid = long["pid"].as_u64().expect("a pid");
    assert!(alive(pid));
    assert_eq!(
        code_stop(&args(json!({ "id": long_id })), &options).expect("stopped"),
        json!({ "jobId": long_id, "command": "sleep 60 & wait", "stopped": true })
    );
    assert!(eventually(|| table.get(&long_id).is_some_and(|job| !job.running)).await);
    assert!(eventually(|| !alive(pid)).await, "the shell is gone");
    let view = serde_json::to_value(table.get(&long_id).expect("kept")).expect("a view");
    assert_eq!(view["signal"], "SIGTERM");
    assert_eq!(view["exitCode"], Value::Null);

    // A command that fails at once comes back with its error and exit code.
    let failed = run_code(
        &workspace,
        &args(json!({ "command": "exit 3", "background": true })),
        &options,
    )
    .await
    .expect("started");
    assert_eq!(
        (failed["running"].clone(), failed["exitCode"].clone()),
        (json!(false), json!(3))
    );

    // Jobs are per chat: deleting the chat ends what is left.
    let error = code_output(&args(json!({ "jobId": "job_nope" })), &options)
        .await
        .expect_err("unknown");
    assert!(error.contains("No background command"));
    assert!(table.list(Some("thread_1")).iter().any(|job| job.id == id));
    assert!(table.list(Some("thread_2")).is_empty());
    let server = run_code(
        &workspace,
        &args(json!({ "command": "sleep 60", "background": true })),
        &options,
    )
    .await
    .expect("started");
    assert_eq!(
        table.stop_all(Some("thread_1")),
        1,
        "one job was still running"
    );
    assert!(table.list(Some("thread_1")).is_empty());
    let server_pid = server["pid"].as_u64().expect("a pid");
    assert!(eventually(|| !alive(server_pid)).await);

    // A cap on running jobs.
    for _ in 0..MAX_JOBS {
        run_code(
            &workspace,
            &args(json!({ "command": "sleep 30", "background": true })),
            &options,
        )
        .await
        .expect("started");
    }
    let error = run_code(
        &workspace,
        &args(json!({ "command": "sleep 30", "background": true })),
        &options,
    )
    .await
    .expect_err("refused");
    assert!(error.contains("already runs"), "{error}");
    table.stop_all(None);
}

#[cfg(unix)]
#[tokio::test]
async fn a_job_keeps_only_its_latest_output() {
    let (_folder, workspace) = workspace();
    let table = JobTable::new();
    let options = with_jobs(&table);
    let started = run_code(
        &workspace,
        &args(json!({ "command": "i=0; while [ $i -lt 30000 ]; do echo line$i; i=$((i+1)); done", "background": true })),
        &options,
    )
    .await
    .expect("started");
    let id = started["jobId"].as_str().expect("an id");
    table.when_ended(id).await;
    let (job, output) = table.output(id, Duration::ZERO).await.expect("read");
    assert!(job.bytes > 64 * 1024);
    assert!(output.len() <= 64 * 1024 + 16 * 1024);
    assert!(!output.contains("line0\n"));
}

#[tokio::test]
async fn without_a_job_table_background_and_its_two_tools_are_refused() {
    let (_folder, workspace) = workspace();
    let message = "Background commands are not available here";
    let call = args(json!({ "command": "true", "background": true, "jobId": "x" }));
    assert_eq!(
        run_code(&workspace, &call, &off())
            .await
            .expect_err("refused"),
        message
    );
    assert_eq!(
        code_output(&call, &off()).await.expect_err("refused"),
        message
    );
    assert_eq!(code_stop(&call, &off()).expect_err("refused"), message);
}

// ---- web ----

/// Serves on a port of 127.0.0.1 for the rest of the test.
async fn serve(router: Router) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bound");
    let address = listener.local_addr().expect("an address");
    tokio::spawn(async move {
        axum::serve(listener, router).await.expect("served");
    });
    address
}

/// A name lookup with fixed answers, counting how often it was asked.
struct FixedLookup {
    answers: Vec<IpAddr>,
    asked: AtomicUsize,
}

impl FixedLookup {
    fn new(answers: &[&str]) -> Arc<Self> {
        Arc::new(Self {
            answers: answers
                .iter()
                .map(|text| text.parse().expect("an address"))
                .collect(),
            asked: AtomicUsize::new(0),
        })
    }
}

impl Lookup for FixedLookup {
    fn lookup<'a>(&'a self, _host: &'a str) -> LookupFuture<'a> {
        self.asked.fetch_add(1, Ordering::SeqCst);
        let answers = self.answers.clone();
        Box::pin(async move { Ok(answers) })
    }
}

/// A lookup that cannot find anything.
struct NoLookup;

impl Lookup for NoLookup {
    fn lookup<'a>(&'a self, _host: &'a str) -> LookupFuture<'a> {
        Box::pin(async { Err(io::Error::new(io::ErrorKind::NotFound, "no such name")) })
    }
}

/// Sends every name to this computer, for pages served by the test.
struct ToThisComputer;

impl Resolve for ToThisComputer {
    fn resolve(&self, _name: Name) -> Resolving {
        Box::pin(async {
            let addresses: Addrs =
                Box::new(vec![SocketAddr::from((Ipv4Addr::LOCALHOST, 0))].into_iter());
            Ok(addresses)
        })
    }
}

#[tokio::test]
async fn the_web_tool_does_not_reach_this_computer() {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let address = serve(Router::new().route(
        "/",
        get(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            async { "local only" }
        }),
    ))
    .await;
    let port = address.port();
    let skill = WebSkill::default();
    for host in [
        "127.0.0.1",
        "[::ffff:127.0.0.1]",
        "[::ffff:7f00:1]",
        "localhost",
        "2130706433",
    ] {
        let error = skill
            .run(&args(json!({ "url": format!("http://{host}:{port}/") })))
            .await
            .expect_err("refused");
        assert_eq!(error, "That address is not allowed", "{host}");
    }
    // A public name that answers with a private address, and one that answers with a mix.
    for answers in [
        &["127.0.0.1"][..],
        &["8.8.8.8", "127.0.0.1"],
        &["::1"],
        &["::ffff:127.0.0.1"],
        &[],
    ] {
        let lookup = FixedLookup::new(answers);
        let error = WebSkill::new(lookup.clone())
            .run(&args(
                json!({ "url": format!("http://rebind.example:{port}/") }),
            ))
            .await
            .expect_err("refused");
        assert_eq!(error, "That address is not allowed", "{answers:?}");
        assert_eq!(
            lookup.asked.load(Ordering::SeqCst),
            1,
            "looked up once, by the connection"
        );
    }
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    let error = WebSkill::new(Arc::new(NoLookup))
        .run(&args(json!({ "url": "http://gone.example/" })))
        .await
        .expect_err("refused");
    assert_eq!(error, "Could not resolve gone.example");

    let url = |text: &str| Url::parse(text).expect("a url");
    let public = FixedLookup::new(&["93.184.216.34", "2606:2800:220:1::1"]);
    assert_public_host(&url("https://public.example/"), public.as_ref())
        .await
        .expect("public");
    let private = FixedLookup::new(&["93.184.216.34", "10.0.0.5"]);
    assert!(
        assert_public_host(&url("https://mixed.example/"), private.as_ref())
            .await
            .is_err()
    );
    assert!(
        fetch_public(&url("http://[::1]/"), &[], public.clone())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn a_page_comes_back_decompressed_with_its_status_and_no_redirect_followed() {
    use std::io::Write;
    let compressed = {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(b"<p>hello</p>").expect("written");
        encoder.finish().expect("finished")
    };
    let router = Router::new()
        .route(
            "/",
            get(move |headers: HeaderMap| {
                let agent = headers
                    .get("user-agent")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .to_owned();
                let encodings = headers
                    .get("accept-encoding")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .to_owned();
                let body = compressed.clone();
                async move {
                    (
                        [
                            (header::CONTENT_ENCODING, "gzip".to_owned()),
                            (header::HeaderName::from_static("x-agent"), agent),
                            (header::HeaderName::from_static("x-encodings"), encodings),
                        ],
                        body,
                    )
                }
            }),
        )
        .route(
            "/moved",
            get(|| async { (StatusCode::FOUND, [(header::LOCATION, "/next")]) }),
        )
        .route(
            "/empty",
            get(|| async { StatusCode::NO_CONTENT.into_response() }),
        );
    let address = serve(router).await;
    let port = address.port();
    let page_url =
        |path: &str| Url::parse(&format!("http://app.example:{port}{path}")).expect("a url");
    let resolver = Arc::new(ToThisComputer);
    let page = request_through(
        &page_url("/"),
        &[("user-agent", "Saturn test")],
        resolver.clone(),
    )
    .await
    .expect("fetched");
    assert_eq!(page.status(), 200);
    assert_eq!(page.headers()["x-agent"], "Saturn test");
    assert!(
        page.headers()["x-encodings"]
            .to_str()
            .expect("text")
            .contains("gzip")
    );
    assert_eq!(page.text().await.expect("text"), "<p>hello</p>");
    let moved = request_through(&page_url("/moved"), &[], resolver.clone())
        .await
        .expect("fetched");
    assert_eq!(moved.status(), 302);
    assert_eq!(moved.headers()["location"], "/next");
    assert_eq!(
        request_through(&page_url("/empty"), &[], resolver)
            .await
            .expect("fetched")
            .status(),
        204
    );
}

// ---- the dispatcher ----

/// Answers any tool with its name.
struct Echo;

impl ToolCaller for Echo {
    fn call<'a>(&'a self, tool: &'a str, arguments: Arguments) -> CallFuture<'a> {
        Box::pin(async move { Ok(json!({ "tool": tool, "arguments": arguments })) })
    }
}

#[tokio::test]
async fn the_built_in_skills_choose_by_name() {
    let data = tempfile::tempdir().expect("a temporary folder");
    let skills = GeneralSkills::new(data.path(), None, Some(Arc::new(Echo)), None, off());
    skills
        .run(
            "files",
            &args(json!({ "action": "write", "path": "note.txt", "content": "x" })),
        )
        .await
        .expect("written");
    assert!(
        data.path().join("workspace/note.txt").exists(),
        "outside a project: the agent's private sandbox"
    );
    assert_eq!(
        skills
            .run("multi_step", &args(json!({ "steps": ["one"] })))
            .await
            .expect("planned"),
        json!({ "explanation": "", "steps": [{ "step": "one", "status": "in_progress" }] })
    );
    assert_eq!(
        skills
            .run(
                "mcp",
                &args(json!({ "tool": "other", "arguments": { "a": 1 } }))
            )
            .await
            .expect("called"),
        json!({ "tool": "other", "arguments": { "a": 1 } })
    );
    assert_eq!(
        skills.run("mcp", &args(json!({ "tool": "files" }))).await,
        Err("Call that skill directly".to_owned())
    );
    assert_eq!(
        skills.run("mcp", &args(json!({}))).await,
        Err("Name the MCP tool to call".to_owned())
    );
    assert_eq!(
        skills.run("nope", &args(json!({}))).await,
        Err("Unknown skill: nope".to_owned())
    );
    let alone = GeneralSkills::new(data.path(), Some(data.path()), None, None, off());
    assert_eq!(
        alone.run("mcp", &args(json!({ "tool": "other" }))).await,
        Err("No other MCP server is enabled".to_owned())
    );
}
