//! The cases in `contract/cases`, recorded from the TypeScript runtime before it was removed.
use std::ffi::OsString;

use saturn_tools::sandbox::{
    Platform, SandboxMode, SandboxSettings, sandbox_hint, seatbelt_profile,
};
use saturn_tools::shell::{Env, command_env, shell_invocation};
use saturn_tools::{TEXT_LIMIT, clip};
use serde_json::{Map, Value, json};

fn platform_of(value: &Value) -> Platform {
    match value.as_str().expect("a platform") {
        "darwin" => Platform::Mac,
        "win32" => Platform::Windows,
        _ => Platform::Linux,
    }
}

fn env_of(value: &Value) -> Env {
    value
        .as_object()
        .expect("an environment")
        .iter()
        .map(|(key, value)| {
            (
                OsString::from(key),
                OsString::from(value.as_str().expect("a variable")),
            )
        })
        .collect()
}

fn mode_of(value: &Value) -> SandboxMode {
    SandboxMode::from_value(Some(value)).expect("a mode")
}

#[test]
fn answers_the_tool_cases() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../../contract/cases/tools.json"))
            .expect("the cases are JSON");
    let mut answered = 0;
    for case in &cases {
        match case["check"].as_str().expect("every case names its check") {
            "pageText" => {
                let (title, text) =
                    saturn_tools::web::page_text(case["html"].as_str().expect("a page"));
                assert_eq!(
                    json!({ "title": title, "text": text }),
                    case["expect"],
                    "{case}"
                );
            }
            "clip" => {
                let piece = case["text"].as_str().expect("text");
                let times = usize::try_from(case["times"].as_u64().expect("a count"))
                    .expect("a small count");
                let whole = piece.repeat(times);
                let clipped = clip(&whole);
                let kept = saturn_domain::js::prefix(&clipped, TEXT_LIMIT);
                assert!(whole.starts_with(kept), "{case}");
                assert_eq!(&clipped[kept.len()..], case["rest"], "{case}");
            }
            "seatbelt" => {
                let writable: Vec<String> =
                    serde_json::from_value(case["writable"].clone()).expect("folders");
                assert_eq!(
                    seatbelt_profile(mode_of(&case["mode"]), &writable, case["network"] == true),
                    case["expect"],
                    "{case}"
                );
            }
            "sandboxHint" => {
                let settings = SandboxSettings {
                    mode: mode_of(&case["mode"]),
                    network: case["network"] == true,
                };
                assert_eq!(
                    json!(sandbox_hint(
                        case["stderr"].as_str().expect("text"),
                        settings
                    )),
                    case["expect"],
                    "{case}"
                );
            }
            "shell" => {
                let invocation = shell_invocation(
                    case["command"].as_str().expect("a command"),
                    case["posix"].as_str().expect("a shell"),
                    platform_of(&case["platform"]),
                    &env_of(&case["env"]),
                );
                assert_eq!(
                    json!({
                        "file": invocation.file,
                        "args": invocation.args,
                        "windowsVerbatimArguments": invocation.verbatim,
                    }),
                    case["expect"],
                    "{case}"
                );
            }
            "commandEnv" => {
                let chosen: Map<String, Value> =
                    command_env(platform_of(&case["platform"]), &env_of(&case["env"]))
                        .into_iter()
                        .map(|(key, value)| {
                            (
                                key.to_string_lossy().into_owned(),
                                json!(value.to_string_lossy()),
                            )
                        })
                        .collect();
                let expected = case["expect"].as_object().expect("an environment");
                assert_eq!(chosen.len(), expected.len(), "{case}");
                assert!(
                    chosen
                        .iter()
                        .all(|(key, value)| expected.get(key) == Some(value)),
                    "{case}"
                );
            }
            "sandboxMode" => {
                let named = SandboxMode::from_value(Some(&case["value"]));
                assert_eq!(json!(named), case["expect"], "{case}");
            }
            _ => continue,
        }
        answered += 1;
    }
    assert!(answered > 50);
}
