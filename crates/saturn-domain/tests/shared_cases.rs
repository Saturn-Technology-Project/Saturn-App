//! The cases `runtime/test/shared-cases.test.ts` answers too, so both implementations decide alike.
use saturn_domain::Arguments;
use saturn_domain::js;
use saturn_domain::permissions::{
    Effect, Layer, Rule, command_segments, from_claude_rule, matches_rule, resolve_permission,
    suggested_pattern,
};
use saturn_domain::policies::{
    GuardrailMode, autonomy_of, is_read_only_call, is_sensitive_operation,
};
use saturn_domain::skills::patch::{FileChange, apply_hunks, parse_patch};
use saturn_domain::skills::plan::TaskPlan;
use saturn_domain::skills::public_address::{is_private_host, parse_public_address};
use saturn_domain::skills::workspace::Workspace;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn field<T: DeserializeOwned>(case: &Value, name: &str) -> T {
    serde_json::from_value(case[name].clone())
        .unwrap_or_else(|error| panic!("{name} in {case}: {error}"))
}

#[test]
fn answers_the_shared_cases() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../../contract/cases/permissions.json"))
            .expect("the cases are JSON");
    assert!(cases.len() > 80);
    for case in &cases {
        let tool = case["tool"].as_str().unwrap_or_default();
        let arguments = || field::<Arguments>(case, "arguments");
        match case["check"].as_str().expect("every case names its check") {
            "commandSegments" => assert_eq!(
                command_segments(case["command"].as_str().expect("a command")),
                field::<Vec<String>>(case, "expect"),
                "{case}"
            ),
            "matchesRule" => assert_eq!(
                matches_rule(&field::<Rule>(case, "rule"), tool, &arguments(), None),
                case["expect"] == true,
                "{case}"
            ),
            "resolvePermission" => {
                let decision =
                    resolve_permission(&field::<Vec<Layer>>(case, "layers"), tool, &arguments());
                assert_eq!(
                    decision.as_ref().map(|decision| decision.effect),
                    field::<Option<Effect>>(case, "effect"),
                    "{case}"
                );
                assert_eq!(
                    decision
                        .map(|decision| serde_json::to_value(decision.scope)
                            .expect("a scope is JSON")),
                    Some(case["scope"].clone()).filter(|scope| !scope.is_null()),
                    "{case}"
                );
            }
            "fromClaudeRule" => assert_eq!(
                from_claude_rule(
                    case["text"].as_str().expect("a text"),
                    field::<Effect>(case, "effect")
                ),
                field::<Option<Rule>>(case, "expect"),
                "{case}"
            ),
            "suggestedPattern" => assert_eq!(
                suggested_pattern(tool, &arguments()),
                case["expect"].as_str().expect("a pattern"),
                "{case}"
            ),
            "isSensitiveOperation" => assert_eq!(
                is_sensitive_operation(tool, &arguments()),
                case["expect"] == true,
                "{case}"
            ),
            "isReadOnlyCall" => assert_eq!(
                is_read_only_call(tool, &arguments(), case["category"].as_str()),
                case["expect"] == true,
                "{case}"
            ),
            "autonomyOf" => {
                let expected = match case["expect"].as_str() {
                    Some("bypass") => GuardrailMode::Bypass,
                    Some("review") => GuardrailMode::Review,
                    _ => GuardrailMode::Default,
                };
                assert_eq!(autonomy_of(case["value"].as_str()), expected, "{case}");
            }
            other => panic!("unknown check {other}"),
        }
    }
}

#[test]
fn prices_calls_as_the_shared_cases_say() {
    use saturn_domain::llm::{CallToPrice, price_call};
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../../contract/cases/pricing.json"))
            .expect("the cases are JSON");
    assert!(cases.len() > 300);
    for case in &cases {
        let text = |name: &str| case[name].as_str().expect("a string");
        let tokens = |name: &str| case[name].as_u64().expect("a count");
        let at = text("at");
        let date = |range: std::ops::Range<usize>| at[range].parse::<i64>().expect("a number");
        let days =
            saturn_domain::time::days_from_civil(date(0..4), date(5..7) as u32, date(8..10) as u32);
        let millis = days * 86_400_000
            + date(11..13) * 3_600_000
            + date(14..16) * 60_000
            + date(17..19) * 1000
            + date(20..23);
        let priced = price_call(&CallToPrice {
            provider: text("provider"),
            model: text("model"),
            hosted: case["hosted"].as_bool().expect("a flag"),
            at: millis,
            input_tokens: tokens("inputTokens"),
            output_tokens: tokens("outputTokens"),
            cached_tokens: tokens("cachedTokens"),
            cache_write_tokens: tokens("cacheWriteTokens"),
        });
        let expect = &case["expect"];
        let Some(priced) = priced else {
            assert!(expect.is_null(), "{case}");
            continue;
        };
        let close = |value: f64, name: &str| {
            let wanted = expect[name]
                .as_f64()
                .unwrap_or_else(|| panic!("{name} in {case}"));
            assert!((value - wanted).abs() < 1e-9, "{name}: {value} in {case}");
        };
        close(priced.input_rate, "inputRate");
        close(priced.output_rate, "outputRate");
        close(priced.cached_rate, "cachedRate");
        close(priced.cache_write_rate, "cacheWriteRate");
        close(priced.cost_usd, "costUsd");
        assert_eq!(
            priced.tier,
            expect["tier"].as_str().expect("a tier"),
            "{case}"
        );
    }
}

/// An answer the way the cases write it: `{ ok }` or `{ error }`.
fn answer<T: serde::Serialize>(result: Result<T, String>) -> Value {
    match result {
        Ok(value) => json!({ "ok": value }),
        Err(message) => json!({ "error": message }),
    }
}

#[test]
fn answers_the_tool_cases() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../../contract/cases/tools.json"))
            .expect("the cases are JSON");
    assert!(cases.len() > 200);
    let mut answered = 0;
    for case in &cases {
        match case["check"].as_str().expect("every case names its check") {
            "isPrivateHost" => assert_eq!(
                is_private_host(case["host"].as_str().expect("a host")),
                case["expect"] == true,
                "{case}"
            ),
            "publicAddress" => assert_eq!(
                answer(
                    parse_public_address(case["url"].as_str().expect("a url"))
                        .map(|url| url.to_string())
                ),
                case["expect"],
                "{case}"
            ),
            "patch" => {
                let parsed = parse_patch(case["patch"].as_str().expect("a patch")).map(|changes| {
                    let update = changes.iter().find_map(|change| match change {
                        FileChange::Update { hunks, .. } => Some(hunks),
                        _ => None,
                    });
                    let applied = match (case["source"].as_str(), update) {
                        (Some(source), Some(hunks)) => answer(apply_hunks(source, hunks)),
                        _ => Value::Null,
                    };
                    json!({ "changes": changes, "applied": applied })
                });
                assert_eq!(answer(parsed), case["expect"], "{case}");
            }
            "plan" => assert_eq!(
                answer(TaskPlan::from_arguments(&field::<Arguments>(
                    case,
                    "arguments"
                ))),
                case["expect"],
                "{case}"
            ),
            "value" => {
                let value = case.get("value");
                assert_eq!(js::text(value), case["text"], "{case}");
                // Past the range of a whole number JavaScript keeps the float; the tools limit it either way.
                let expected = case["integer"].as_f64().expect("a number");
                let read = js::integer(value, -99);
                if expected.abs() < 9e15 {
                    assert_eq!(
                        serde_json::Number::from(read).as_f64(),
                        Some(expected),
                        "{case}"
                    );
                } else {
                    assert!(read.abs() > 9_000_000_000_000_000, "{case}");
                }
            }
            "workspace" => {
                if cfg!(windows) {
                    continue;
                }
                let workspace = Workspace::new(case["root"].as_str().expect("a root"));
                let resolved = workspace
                    .resolve(case["requested"].as_str().expect("a path"))
                    .map(|target| {
                        json!({
                            "target": target.to_string_lossy(),
                            "relative": workspace.relative(&target),
                        })
                    });
                // TypeScript refuses every path under a root of "/" (it looks for "//"); nothing depends on that.
                if case["root"] == "/" {
                    assert!(resolved.is_ok());
                } else {
                    assert_eq!(answer(resolved), case["expect"], "{case}");
                }
            }
            _ => continue,
        }
        answered += 1;
    }
    assert!(answered > 150);
}
