//! Drives Notepad for real: launch, screenshot, element tree, Unicode typing, a shortcut, a click. Needs an interactive desktop: it
//! runs on Windows when one is there, and SATURN_TEST_DESKTOP=1 makes a missing desktop a failure, for CI.
#![cfg(windows)]
use std::time::Duration;

use saturn_computer::Computer;
use serde_json::{Value, json};

/// The tree, read until it shows `wanted`: Notepad reports its text to UI Automation a moment after drawing it.
async fn state_showing(computer: &Computer, target: &Value, wanted: &str) -> String {
    let mut text = String::new();
    for _ in 0..20 {
        let state = computer
            .run("computer_app_state", &json!({ "target": target }))
            .await
            .expect("the tree");
        text = state["text"].as_str().unwrap_or_default().to_owned();
        if text.contains(wanted) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    text
}

#[tokio::test(flavor = "multi_thread")]
async fn computer_use_drives_notepad_end_to_end() {
    let data = tempfile::tempdir().expect("a folder");
    let computer = Computer::new(data.path());
    let status = computer
        .run("computer_check_permissions", &json!({}))
        .await
        .expect("the status");
    if status["status"] != "ready" {
        assert!(
            std::env::var("SATURN_TEST_DESKTOP").as_deref() != Ok("1"),
            "No usable desktop: {status}"
        );
        return;
    }
    let apps = computer
        .run("computer_apps", &json!({}))
        .await
        .expect("the apps");
    assert!(apps["count"].is_number());

    let notepad = computer
        .run("computer_resolve_app", &json!({ "app_name": "notepad" }))
        .await
        .expect("Notepad starts");
    let target =
        json!({ "scope": "app", "pid": notepad["pid"], "target_id": notepad["target_id"] });

    let screen = computer
        .run(
            "computer_screenshot",
            &json!({ "target": { "scope": "screen" } }),
        )
        .await
        .expect("a screenshot");
    let image = screen["image"].as_str().unwrap_or_default();
    assert!(image.starts_with("data:image/jpeg;base64,") && image.len() > 5000);

    let shot = computer
        .run("computer_screenshot", &json!({ "target": target }))
        .await
        .expect("a window screenshot");
    assert_eq!(shot["scope"], "app");
    assert!(
        shot["region"]["width"].as_i64() > Some(100)
            && shot["region"]["height"].as_i64() > Some(100)
    );
    let token = shot["coordinate_token"].clone();

    let state = computer
        .run("computer_app_state", &json!({ "target": target }))
        .await
        .expect("the tree");
    let tree = state["text"].as_str().unwrap_or_default();
    let editor = tree
        .lines()
        .find(|line| {
            let line = line.trim_start();
            line.starts_with('[')
                && (line.contains("] Document") || line.contains("] Edit"))
                && line.contains("settable")
        })
        .unwrap_or_else(|| panic!("Notepad's text area in the tree:\n{tree}"));
    let element: i64 = editor
        .split_once('[')
        .and_then(|(_, rest)| rest.split_once(']'))
        .and_then(|(id, _)| id.parse().ok())
        .expect("an element id");

    computer
        .run(
            "computer_type",
            &json!({ "target": target, "text": "Hello Saturn 你好\nsecond line", "element_id": element, "snapshot_id": state["snapshot_id"] }),
        )
        .await
        .expect("it types");
    let after = state_showing(&computer, &target, "Hello Saturn 你好").await;
    assert!(
        after.contains("Hello Saturn 你好"),
        "typed text, including Chinese, reached the editor"
    );

    computer
        .run(
            "computer_key",
            &json!({ "target": target, "key": "ctrl+a" }),
        )
        .await
        .expect("the shortcut");
    computer
        .run(
            "computer_type",
            &json!({ "target": target, "text": "replaced" }),
        )
        .await
        .expect("it types");
    let after = state_showing(&computer, &target, "value=\"replaced\"").await;
    assert!(
        after.contains("value=\"replaced\""),
        "Ctrl+A then typing replaced the text:\n{after}"
    );

    let click = computer
        .run(
            "computer_click",
            &json!({ "target": target, "coordinate_token": token, "x": 640, "y": 400 }),
        )
        .await
        .expect("a click");
    assert_eq!(click["success"], true);
    let scrolled = computer
        .run("computer_scroll", &json!({ "target": target, "coordinate_token": token, "x": 640, "y": 400, "direction": "down", "amount": 2 }))
        .await
        .expect("a scroll");
    assert_eq!(scrolled["success"], true);

    if let Some(pid) = notepad["pid"].as_i64() {
        let _ = std::process::Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/F"])
            .status();
    }
}
