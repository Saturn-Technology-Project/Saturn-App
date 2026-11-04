//! The Windows side, on any system: a script stands in for the helper, so what goes over its pipes can be checked here.
//! No real desktop is touched.
#![cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use saturn_computer::Computer;
use serde_json::{Value, json};

/// A helper that says it is ready and answers each request with what `answer` makes of the line in `$line`.
fn stand_in(folder: &Path, answer: &str) -> PathBuf {
    let file = folder.join("helper.sh");
    std::fs::write(
        &file,
        format!(
            "#!/bin/sh\necho '{{\"ready\":true}}'\nwhile read -r line; do\n  echo \"$line\" >> '{log}'\n  id=$(echo \"$line\" | sed -E 's/^.*\"id\":([0-9]+).*$/\\1/')\n  op=$(echo \"$line\" | sed -E 's/^.*\"op\":\"([a-zA-Z]+)\".*$/\\1/')\n  {answer}\ndone\n",
            log = folder.join("log").display(),
        ),
    )
    .unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
    file
}

const ANSWERS: &str = r#"case "$op" in
    locked) echo "{\"id\":$id,\"ok\":true,\"result\":false}" ;;
    apps) echo "{\"id\":$id,\"ok\":true,\"result\":[{\"name\":\"b\",\"pid\":2,\"bundle_id\":\"b.exe\",\"frontmost\":false},{\"name\":\"a\",\"pid\":3,\"bundle_id\":\"a.exe\",\"frontmost\":false},{\"name\":\"c\",\"pid\":4,\"bundle_id\":\"c.exe\",\"frontmost\":true}]}" ;;
    frame) echo "{\"id\":$id,\"ok\":true,\"result\":{\"x\":10,\"y\":20,\"width\":640,\"height\":400}}" ;;
    tree) echo "{\"id\":$id,\"ok\":true,\"result\":[{\"path\":[0],\"depth\":1,\"role\":\"Edit\",\"name\":\"Text\",\"value\":\"\",\"actions\":[],\"settable\":true,\"omitted\":0}]}" ;;
    activate) echo "{\"id\":$id,\"ok\":false,\"error\":\"Access is denied\"}" ;;
    setValue) kill $$ ;;
    *) echo "{\"id\":$id,\"ok\":true,\"result\":null}" ;;
  esac"#;

fn logged(folder: &Path) -> Vec<Value> {
    std::fs::read_to_string(folder.join("log"))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[tokio::test]
async fn the_windows_helper_gets_requests_over_its_pipes_and_is_restarted_when_it_stops() {
    let folder = tempfile::tempdir().unwrap();
    let computer = Computer::with_windows_stand_in(folder.path(), stand_in(folder.path(), ANSWERS));

    let status = computer
        .run("computer_check_permissions", &json!({}))
        .await
        .unwrap();
    assert_eq!(status["status"], "ready", "Windows asks for no permission");

    let apps = computer.run("computer_apps", &json!({})).await.unwrap();
    let names: Vec<&str> = apps["apps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|app| app["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["c", "a", "b"], "the frontmost first, then by name");
    assert_eq!(apps["apps"][0]["target_id"], "app_4");

    // Input refused because the app runs as administrator says so.
    let refused = computer
        .run(
            "computer_key",
            &json!({ "key": "a", "target": { "pid": 9 } }),
        )
        .await
        .unwrap_err();
    assert!(refused.contains("running as administrator"), "{refused}");

    let state = computer
        .run("computer_app_state", &json!({ "target": { "pid": 9 } }))
        .await
        .unwrap();
    assert!(
        state["text"]
            .as_str()
            .unwrap()
            .contains("[1] Edit name=\"Text\" settable")
    );
    let snapshot = state["snapshot_id"].clone();

    // The helper stops in the middle of a request: the request says so, and the next one starts it again.
    let stopped = computer
        .run("computer_set_value", &json!({ "target": { "pid": 9 }, "snapshot_id": snapshot, "element_id": 1, "value": "x" }))
        .await
        .unwrap_err();
    assert!(
        stopped.contains("The Windows desktop helper stopped"),
        "{stopped}"
    );
    let again = computer.run("computer_apps", &json!({})).await.unwrap();
    assert_eq!(again["count"], 3);

    let operations: Vec<String> = logged(folder.path())
        .iter()
        .map(|line| line["op"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        operations,
        [
            "locked", "apps", "locked", "activate", "locked", "tree", "locked", "setValue", "apps"
        ]
    );
    let set = logged(folder.path())
        .into_iter()
        .find(|line| line["op"] == "setValue")
        .unwrap();
    assert_eq!(set["path"], json!([0]));
    assert_eq!(set["focusOnly"], false);
}

#[tokio::test]
async fn a_helper_that_never_starts_says_so() {
    let folder = tempfile::tempdir().unwrap();
    let computer = Computer::with_windows_stand_in(folder.path(), folder.path().join("missing"));
    let error = computer
        .run("computer_screenshot", &json!({}))
        .await
        .unwrap_err();
    assert!(
        error.contains("The Windows desktop helper did not start"),
        "{error}"
    );
}

#[tokio::test]
async fn without_a_desktop_only_waiting_works() {
    let computer = Computer::unsupported();
    let waited = computer
        .run("computer_wait", &json!({ "ms": 1, "reason": "why" }))
        .await
        .unwrap();
    assert_eq!(waited["reason"], "why");
    let error = computer
        .run("computer_click", &json!({ "x": 1, "y": 1 }))
        .await
        .unwrap_err();
    assert_eq!(error, "Computer use is available on macOS and Windows.");
}
