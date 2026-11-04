//! The loop against a scripted model, on a temporary data folder: what `contract/loop.test.mjs` does not reach.
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use saturn_core::Kernel;
use saturn_core::runs::StartOptions;
use saturn_llm::Http;
use saturn_store::key_store::{KeyStoreName, key_store};
use saturn_store::{FileStore, SecretsFile};
use serde_json::{Value, json};
use tempfile::TempDir;

/// A scripted model: each request takes the next turn. Text is an answer, a list is tool calls.
#[derive(Clone, Default)]
struct Script {
    turns: Arc<Mutex<Vec<Value>>>,
    requests: Arc<Mutex<Vec<Value>>>,
}

async fn answer(State(script): State<Script>, Json(request): Json<Value>) -> Json<Value> {
    script.requests.lock().expect("not poisoned").push(request);
    let turn = {
        let mut turns = script.turns.lock().expect("not poisoned");
        if turns.is_empty() {
            json!("finished")
        } else {
            turns.remove(0)
        }
    };
    let message = if turn.is_array() {
        json!({ "role": "assistant", "content": "", "tool_calls": turn })
    } else {
        json!({ "role": "assistant", "content": turn })
    };
    Json(
        json!({ "id": "reply", "object": "chat.completion", "model": "scripted", "choices": [{ "index": 0, "finish_reason": "stop", "message": message }], "usage": { "prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12 } }),
    )
}

fn call(name: &str, arguments: Value) -> Value {
    json!({ "id": format!("call_{name}"), "type": "function", "function": { "name": name, "arguments": arguments.to_string() } })
}

/// A runtime on a temporary folder, an agent on a scripted model, and a chat in a project folder.
struct Setup {
    kernel: Arc<Kernel>,
    script: Script,
    agent: String,
    project: String,
    thread: String,
    folder: PathBuf,
    _data: TempDir,
    _work: TempDir,
}

async fn setup(turns: Vec<Value>, autonomy: &str) -> Setup {
    let script = Script {
        turns: Arc::new(Mutex::new(turns)),
        ..Script::default()
    };
    let app = Router::new()
        .route("/chat/completions", post(answer))
        .with_state(script.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a free port");
    let address = listener.local_addr().expect("an address");
    tokio::spawn(async move { axum::serve(listener, app).await });
    let data = tempfile::tempdir().expect("a folder");
    let work = tempfile::tempdir().expect("a folder");
    let folder = std::fs::canonicalize(work.path()).expect("a real path");
    let root = data.path().to_path_buf();
    let secrets = SecretsFile::with_preferred(
        data.path(),
        Box::new(move || key_store(KeyStoreName::File, &root)),
    );
    let store = Arc::new(
        FileStore::load_with(data.path(), secrets)
            .await
            .expect("a store"),
    );
    let kernel = Kernel::with_http(
        store,
        Http::with_retry_delay(Duration::from_millis(1)).expect("a client"),
    )
    .expect("a kernel");
    let model = kernel.create_model(&json!({ "name": "Scripted", "provider": "openai", "model": "scripted", "baseUrl": format!("http://{address}") })).await.expect("a model");
    let agent = kernel
        .create_agent(
            &json!({ "name": "Builder", "modelConnectionId": model["id"], "autonomy": autonomy }),
        )
        .await
        .expect("an agent");
    let agent = agent["id"].as_str().expect("an id").to_owned();
    let project = kernel
        .create_project(&json!({ "path": folder.to_string_lossy(), "grant": true }))
        .await
        .expect("a project");
    let project = project["id"].as_str().expect("an id").to_owned();
    let thread = kernel
        .create_thread(&agent, Some("Test"), Some(&project))
        .await
        .expect("a chat");
    Setup {
        kernel,
        script,
        agent,
        project,
        thread: thread["id"].as_str().expect("an id").to_owned(),
        folder,
        _data: data,
        _work: work,
    }
}

impl Setup {
    /// Starts a turn and waits for it to stop moving.
    async fn turn(&self, input: &str) -> Value {
        let run = self
            .kernel
            .start_run(
                &self.agent,
                input,
                Some(&self.thread),
                None,
                StartOptions::default(),
            )
            .await
            .expect("a run");
        self.settled(run["id"].as_str().expect("an id")).await
    }

    async fn settled(&self, id: &str) -> Value {
        for _ in 0..500 {
            let run = self.kernel.get_run(id).expect("the run");
            if !matches!(run["status"].as_str(), Some("running" | "queued")) {
                return run;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the run did not settle");
    }

    /// Everything the model was sent in one request, as text.
    fn sent(&self, index: usize) -> String {
        self.script.requests.lock().expect("not poisoned")[index].to_string()
    }

    fn requests(&self) -> usize {
        self.script.requests.lock().expect("not poisoned").len()
    }

    async fn set_hooks(&self, hooks: Value) {
        self.kernel
            .set_user_hooks(&hooks)
            .await
            .expect("valid hooks");
    }
}

fn read(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

async fn until(what: &str, mut done: impl FnMut() -> bool) {
    for _ in 0..500 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("never happened: {what}");
}

fn git(folder: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(folder)
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn git_repository(folder: &Path) {
    git(folder, &["init", "-q", "-b", "main"]);
    git(folder, &["config", "user.email", "test@localhost"]);
    git(folder, &["config", "user.name", "Test"]);
    std::fs::write(folder.join("tracked.txt"), "original\n").expect("a file");
    git(folder, &["add", "-A"]);
    git(folder, &["commit", "-q", "-m", "first"]);
}

#[tokio::test]
async fn a_written_file_is_reviewed_and_reverted_with_its_original_bytes() {
    let setup = setup(
        vec![
            json!([call(
                "files",
                json!({ "action": "write", "path": "new.txt", "content": "made by the agent\n" })
            )]),
            json!("wrote it"),
        ],
        "bypass",
    )
    .await;
    std::fs::write(setup.folder.join("keep.txt"), "untouched").expect("a file");
    let run = setup.turn("write").await;
    assert_eq!(run["status"], "completed", "{run}");
    assert_eq!(
        read(&setup.folder.join("new.txt")).as_deref(),
        Some("made by the agent\n")
    );
    let id = run["id"].as_str().expect("an id");
    let changes = setup.kernel.run_changes(id).await.expect("changes");
    assert_eq!(changes["files"][0]["status"], "added");
    assert_eq!(changes["files"][0]["additions"], 1);
    assert!(
        changes["files"][0]["diff"]
            .as_str()
            .expect("a diff")
            .contains("+made by the agent")
    );
    setup.kernel.revert_run(id, None).await.expect("reverted");
    assert!(
        read(&setup.folder.join("new.txt")).is_none(),
        "a file the run created is deleted"
    );
    assert_eq!(
        read(&setup.folder.join("keep.txt")).as_deref(),
        Some("untouched")
    );
}

#[tokio::test]
async fn a_command_s_changes_join_the_checkpoint_in_a_git_folder_and_outside_one() {
    for in_git in [true, false] {
        let setup = setup(
            vec![
                json!([call(
                    "code",
                    json!({ "command": "echo changed > tracked.txt; echo more > added.txt" })
                )]),
                json!("done"),
            ],
            "bypass",
        )
        .await;
        if in_git {
            git_repository(&setup.folder);
        } else {
            std::fs::write(setup.folder.join("tracked.txt"), "original\n").expect("a file");
        }
        let run = setup.turn("change").await;
        assert_eq!(run["status"], "completed", "{run}");
        assert_eq!(run["actions"][0]["status"], "completed", "{run}");
        let id = run["id"].as_str().expect("an id");
        let changes = setup.kernel.run_changes(id).await.expect("changes");
        let files = changes["files"].as_array().expect("files");
        assert_eq!(files.len(), 2, "in git: {in_git}, {changes}");
        setup.kernel.revert_run(id, None).await.expect("reverted");
        assert_eq!(
            read(&setup.folder.join("tracked.txt")).as_deref(),
            Some("original\n"),
            "in git: {in_git}"
        );
        assert!(
            read(&setup.folder.join("added.txt")).is_none(),
            "in git: {in_git}"
        );
        assert!(
            !setup.folder.join("saturn-folder").exists(),
            "the private snapshot stays out of the folder"
        );
    }
}

#[tokio::test]
async fn restoring_to_a_step_puts_back_what_that_step_and_later_ones_wrote() {
    let write = |content: &str, id: &str| {
        let mut made = call(
            "files",
            json!({ "action": "write", "path": "file.txt", "content": content }),
        );
        made["id"] = id.into();
        made
    };
    let setup = setup(
        vec![
            json!([write("one", "c1")]),
            json!([write("two", "c2")]),
            json!("done"),
        ],
        "bypass",
    )
    .await;
    let run = setup.turn("write twice").await;
    assert_eq!(read(&setup.folder.join("file.txt")).as_deref(), Some("two"));
    let id = run["id"].as_str().expect("an id");
    let second = run["actions"][1]["id"].as_str().expect("a step");
    setup
        .kernel
        .restore_to_step(id, second)
        .await
        .expect("restored");
    assert_eq!(read(&setup.folder.join("file.txt")).as_deref(), Some("one"));
}

#[tokio::test]
async fn a_pre_tool_hook_blocks_asks_and_allows() {
    let blocked = setup(
        vec![
            json!([call("code", json!({ "command": "echo hi" }))]),
            json!("understood"),
        ],
        "bypass",
    )
    .await;
    blocked.set_hooks(json!([{ "event": "pre_tool", "matcher": "code", "command": "echo 'not this' >&2; exit 2" }])).await;
    let run = blocked.turn("go").await;
    assert_eq!(run["actions"][0]["status"], "denied", "{run}");
    assert_eq!(run["actions"][0]["reason"], "Blocked by a hook: not this");

    let asked = setup(
        vec![
            json!([call("code", json!({ "command": "echo hi" }))]),
            json!("done"),
        ],
        "bypass",
    )
    .await;
    asked.set_hooks(json!([{ "event": "pre_tool", "command": "echo '{\"decision\":\"ask\",\"reason\":\"check first\"}'" }])).await;
    let run = asked.turn("go").await;
    assert_eq!(run["status"], "waiting_approval", "{run}");
    assert_eq!(run["actions"][0]["reason"], "check first");

    let allowed = setup(
        vec![
            json!([call("code", json!({ "command": "echo hi" }))]),
            json!("done"),
        ],
        "review",
    )
    .await;
    allowed
        .set_hooks(json!([{ "event": "pre_tool", "command": "echo '{\"decision\":\"allow\"}'" }]))
        .await;
    let run = allowed.turn("go").await;
    assert_eq!(run["status"], "completed", "{run}");
    assert_eq!(run["actions"][0]["status"], "completed");
}

#[tokio::test]
async fn a_hook_gets_the_call_on_stdin_and_a_post_tool_hook_can_add_feedback() {
    let setup = setup(
        vec![
            json!([call("code", json!({ "command": "echo hi" }))]),
            json!("done"),
        ],
        "bypass",
    )
    .await;
    let seen = setup.folder.join("seen.json");
    setup.set_hooks(json!([{ "event": "post_tool", "matcher": "code", "command": format!("cat > '{}'; echo 'mind the tests' >&2; exit 2", seen.display()) }])).await;
    let run = setup.turn("go").await;
    assert_eq!(
        run["actions"][0]["result"]["hookFeedback"], "mind the tests",
        "{run}"
    );
    assert!(setup.sent(1).contains("mind the tests"));
    let input: Value = serde_json::from_str(&read(&seen).expect("the hook ran")).expect("JSON");
    assert_eq!(input["tool"], "code");
    assert_eq!(input["arguments"]["command"], "echo hi");
    assert_eq!(input["run_id"], run["id"]);
}

#[tokio::test]
async fn a_project_s_hooks_run_only_once_that_exact_set_is_allowed() {
    let setup = setup(
        vec![
            json!([call("code", json!({ "command": "echo hi" }))]),
            json!("first"),
            json!([call("code", json!({ "command": "echo hi" }))]),
            json!("second"),
        ],
        "bypass",
    )
    .await;
    std::fs::create_dir_all(setup.folder.join(".saturn")).expect("a folder");
    let marker = setup.folder.join("hook-ran");
    std::fs::write(setup.folder.join(".saturn/hooks.json"), json!({ "hooks": [{ "event": "pre_tool", "command": format!("touch '{}'", marker.display()) }] }).to_string()).expect("a file");
    let run = setup.turn("go").await;
    assert_eq!(run["status"], "completed", "{run}");
    assert!(
        !marker.exists(),
        "a cloned repository's hook does not run by itself"
    );
    let sets = setup.kernel.hook_sets(Some(&setup.project)).await;
    let print = sets[1].fingerprint.clone().expect("a fingerprint");
    assert!(
        setup
            .kernel
            .approve_hooks(&setup.project, ".saturn/hooks.json", "other")
            .await
            .is_err(),
        "only the set the user saw"
    );
    setup
        .kernel
        .approve_hooks(&setup.project, ".saturn/hooks.json", &print)
        .await
        .expect("allowed");
    setup.turn("again").await;
    assert!(marker.exists());
}

#[tokio::test]
async fn a_stop_hook_sends_the_turn_back_at_most_twice() {
    let setup = setup(Vec::new(), "bypass").await;
    setup
        .set_hooks(json!([{ "event": "stop", "command": "echo 'run the tests' >&2; exit 2" }]))
        .await;
    setup.turn("go").await;
    let counted = setup.kernel.clone();
    let thread = setup.thread.clone();
    until("two automatic rounds", move || {
        counted.automatic_rounds(&thread) == 2
    })
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(setup.kernel.automatic_rounds(&setup.thread), 2);
    assert!(
        setup
            .sent(1)
            .contains("A stop hook did not accept this turn")
    );
}

#[tokio::test]
async fn a_failing_check_goes_back_to_the_agent_after_it_changed_files() {
    let setup = setup(
        vec![
            json!([call(
                "files",
                json!({ "action": "write", "path": "a.txt", "content": "x" })
            )]),
            json!("wrote"),
            json!("fixed"),
        ],
        "bypass",
    )
    .await;
    setup
        .kernel
        .store
        .update(|state| state.projects[0]["verifyCommand"] = "echo broken-build; exit 3".into())
        .await
        .expect("saved");
    let run = setup.turn("go").await;
    let id = run["id"].as_str().expect("an id").to_owned();
    let kernel = setup.kernel.clone();
    until("the check result", move || {
        kernel
            .get_run(&id)
            .expect("the run")
            .get("verification")
            .is_some()
    })
    .await;
    let run = setup
        .kernel
        .get_run(run["id"].as_str().expect("an id"))
        .expect("the run");
    assert_eq!(run["verification"]["ok"], false);
    assert_eq!(run["verification"]["code"], 3);
    let counted = setup.kernel.clone();
    let thread = setup.thread.clone();
    until("the automatic round", move || {
        counted.automatic_rounds(&thread) >= 1
    })
    .await;
}

#[tokio::test]
async fn stopping_a_run_ends_its_command_and_keeps_what_the_command_changed() {
    let setup = setup(vec![json!([call("code", json!({ "command": "echo partial > partial.txt; echo $$ > pid.txt; sleep 30; echo late > late.txt" }))])], "bypass").await;
    git_repository(&setup.folder);
    let run = setup
        .kernel
        .start_run(
            &setup.agent,
            "go",
            Some(&setup.thread),
            None,
            StartOptions::default(),
        )
        .await
        .expect("a run");
    let id = run["id"].as_str().expect("an id");
    let marker = setup.folder.join("pid.txt");
    until("the command started", || marker.exists()).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    let stopped = setup.kernel.stop_run(id).await.expect("stopped");
    assert_eq!(stopped["status"], "cancelled");
    let kernel = setup.kernel.clone();
    let owned = id.to_owned();
    until("the partial change recorded", move || {
        kernel
            .get_run(&owned)
            .expect("the run")
            .get("checkpoint")
            .is_some_and(|checkpoint| {
                checkpoint["files"]
                    .as_array()
                    .is_some_and(|files| !files.is_empty())
            })
    })
    .await;
    let changes = setup.kernel.run_changes(id).await.expect("changes");
    assert!(changes.to_string().contains("partial.txt"), "{changes}");
    assert!(read(&setup.folder.join("late.txt")).is_none());
}

#[tokio::test]
async fn load_tools_and_skill_work_and_a_tool_not_ported_yet_says_so() {
    let setup = setup(
        vec![
            json!([call("load_tools", json!({ "toolkits": ["github"] }))]),
            json!([call("skill", json!({ "name": "deploy" }))]),
            json!([call("computer_screenshot", json!({}))]),
            json!("done"),
        ],
        "bypass",
    )
    .await;
    let folder = setup.folder.join(".saturn/skills/deploy");
    std::fs::create_dir_all(&folder).expect("a folder");
    std::fs::write(
        folder.join("SKILL.md"),
        "---\nname: deploy\ndescription: How to deploy\n---\nRun the script.\n",
    )
    .expect("a file");
    let run = setup.turn("go").await;
    let tools = |index: usize| {
        setup.script.requests.lock().expect("not poisoned")[index]["tools"].to_string()
    };
    assert!(
        !tools(0).contains("get_repository"),
        "a toolkit is left out until it is loaded"
    );
    assert!(tools(1).contains("get_repository"), "and offered after");
    assert!(
        setup.sent(0).contains("How to deploy"),
        "skills are listed in the prompt"
    );
    assert_eq!(
        run["actions"][1]["result"]["instructions"],
        "Run the script."
    );
    assert_eq!(run["actions"][2]["status"], "failed");
    assert!(
        run["actions"][2]["reason"]
            .as_str()
            .expect("a reason")
            .contains("not in the Rust runtime yet")
    );
    assert_eq!(run["status"], "completed");
}

#[tokio::test]
async fn usage_is_filed_and_a_long_chat_is_folded_into_its_summary() {
    let setup = setup(
        vec![
            json!("one"),
            json!("two"),
            json!("the summary"),
            json!("three"),
        ],
        "bypass",
    )
    .await;
    setup.turn(&"a".repeat(100)).await;
    setup.turn(&"b".repeat(100)).await;
    assert_eq!(setup.kernel.store.read(|state| state.usage.len()), 2);
    setup
        .kernel
        .store
        .update(|state| state.models[0]["contextTokens"] = 50.into())
        .await
        .expect("saved");
    let run = setup.turn("next").await;
    assert_eq!(run["output"], "three", "{run}");
    assert!(
        run["compacted"]["turns"]
            .as_u64()
            .is_some_and(|turns| turns >= 1),
        "{run}"
    );
    assert!(setup.sent(setup.requests() - 1).contains("the summary"));
    assert!(
        setup
            .kernel
            .store
            .read(|state| state.threads[0]["summary"]["text"] == "the summary")
    );
}

#[tokio::test]
async fn a_worktree_keeps_a_chat_s_work_apart_until_it_is_merged() {
    let setup = setup(
        vec![
            json!([call(
                "files",
                json!({ "action": "write", "path": "from-chat.txt", "content": "x\n" })
            )]),
            json!("done"),
        ],
        "bypass",
    )
    .await;
    git_repository(&setup.folder);
    let status = setup
        .kernel
        .create_worktree(&setup.thread)
        .await
        .expect("a worktree");
    assert_eq!(status["base"], "main");
    setup.turn("write").await;
    assert!(
        !setup.folder.join("from-chat.txt").exists(),
        "the project's own checkout is untouched"
    );
    let status = setup
        .kernel
        .worktree_status(&setup.thread)
        .await
        .expect("its state");
    assert_eq!(status["dirty"], 1, "{status}");
    let finished = setup
        .kernel
        .finish_worktree(&setup.thread, "merge", None)
        .await
        .expect("merged");
    assert_eq!(finished["merged"], true);
    assert!(setup.folder.join("from-chat.txt").exists());
    assert!(!git(&setup.folder, &["branch", "--list", "saturn/*"]).contains("saturn/"));
}

#[tokio::test]
async fn a_chat_without_access_to_its_folder_does_not_start() {
    let setup = setup(Vec::new(), "bypass").await;
    setup
        .kernel
        .store
        .update(|state| state.projects[0]["access"] = Value::Null)
        .await
        .expect("saved");
    let refused = setup
        .kernel
        .start_run(
            &setup.agent,
            "go",
            Some(&setup.thread),
            None,
            StartOptions::default(),
        )
        .await
        .expect_err("refused");
    assert_eq!(refused.status, 403);
    assert_eq!(setup.requests(), 0);
}

#[tokio::test]
async fn memory_learns_from_the_latest_turns() {
    let setup = setup(Vec::new(), "bypass").await;
    for index in 1..=12 {
        setup.turn(&format!("question {index}.")).await;
    }
    let script = setup.script.clone();
    until("the memory call", move || {
        script
            .requests
            .lock()
            .expect("not poisoned")
            .iter()
            .filter(|request| request.to_string().contains("You keep short notes"))
            .count()
            >= 2
    })
    .await;
    let requests = setup.script.requests.lock().expect("not poisoned").clone();
    let last = requests
        .iter()
        .rfind(|request| request.to_string().contains("You keep short notes"))
        .expect("a memory call")
        .to_string();
    let conversation = &last[last.find("Recent conversation").expect("the transcript")..];
    assert!(conversation.contains("question 12."), "{conversation}");
    assert!(conversation.contains("question 7."), "{conversation}");
    assert!(!conversation.contains("question 6."), "{conversation}");
    assert!(conversation.find("question 7.") < conversation.find("question 12."));
}

#[tokio::test]
async fn a_sub_agent_in_ask_mode_cannot_change_files() {
    let setup = setup(
        vec![
            json!([call("delegate", json!({ "task": "try to write" }))]),
            json!([call(
                "files",
                json!({ "action": "write", "path": "no.txt", "content": "x" })
            )]),
            json!("could not"),
            json!("parent done"),
        ],
        "bypass",
    )
    .await;
    let run = setup.turn("go").await;
    assert_eq!(run["output"], "parent done", "{run}");
    assert!(!setup.folder.join("no.txt").exists());
    assert_eq!(
        setup.kernel.with_children(run)["children"][0]["actions"][0]["status"],
        "denied"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn reverting_does_not_follow_a_link_a_command_put_in_the_file_s_place() {
    let outside = tempfile::tempdir().expect("a folder");
    let target = outside.path().join("victim.txt");
    std::fs::write(&target, "the user's own file").expect("a file");
    let setup = setup(
        vec![
            json!([call(
                "files",
                json!({ "action": "write", "path": "file.txt", "content": "from the agent" })
            )]),
            json!("done"),
        ],
        "bypass",
    )
    .await;
    std::fs::write(setup.folder.join("file.txt"), "original").expect("a file");
    let run = setup.turn("write").await;
    std::fs::remove_file(setup.folder.join("file.txt")).expect("removed");
    std::os::unix::fs::symlink(&target, setup.folder.join("file.txt")).expect("a link");
    let refused = setup
        .kernel
        .revert_run(run["id"].as_str().expect("an id"), None)
        .await
        .expect_err("refused");
    assert!(
        refused.message.contains("outside the workspace"),
        "{refused}"
    );
    assert_eq!(read(&target).as_deref(), Some("the user's own file"));
}

#[tokio::test]
async fn a_scheduled_automation_fires_once_for_its_slot_and_a_missed_one_only_the_latest() {
    let setup = setup(Vec::new(), "bypass").await;
    let made = setup.kernel.create_automation(&json!({ "name": "Daily", "agentId": setup.agent, "prompt": "report", "trigger": { "frequency": "daily", "time": "09:00" } })).await.expect("made");
    let at = saturn_domain::time::parse_iso("2026-01-10T12:00:00.000Z").expect("a time");
    setup
        .kernel
        .store
        .update(|state| state.automations[0]["lastSlot"] = 0.into())
        .await
        .expect("saved");
    setup.kernel.tick_automations(at).await;
    setup.kernel.tick_automations(at + 60_000).await;
    let saved = setup
        .kernel
        .store
        .read(|state| state.automations[0].clone());
    let slot = saturn_domain::schedule::previous_slot(
        &saved["trigger"],
        saturn_core::automations::local_minute(at, "UTC"),
    );
    assert_eq!(saved["lastSlot"], slot);
    assert!(saved["lastRunId"].is_string(), "{saved}");
    let runs = setup.kernel.store.read(|state| {
        state
            .runs
            .iter()
            .filter(|run| run["input"] == "report")
            .count()
    });
    assert_eq!(
        runs, 1,
        "one run, however many days were missed and however often it is checked"
    );
    setup
        .kernel
        .update_automation(
            made["id"].as_str().expect("an id"),
            &json!({ "enabled": false }),
        )
        .await
        .expect("paused");
    setup.kernel.tick_automations(at + 3 * 86_400_000).await;
    assert_eq!(
        setup.kernel.store.read(|state| state
            .runs
            .iter()
            .filter(|run| run["input"] == "report")
            .count()),
        1,
        "a paused one does not run"
    );
}
