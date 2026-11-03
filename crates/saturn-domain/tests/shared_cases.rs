//! The cases `runtime/test/shared-cases.test.ts` answers too, so both implementations decide alike.
use saturn_domain::Arguments;
use saturn_domain::permissions::{
    Effect, Layer, Rule, command_segments, from_claude_rule, matches_rule, resolve_permission,
    suggested_pattern,
};
use saturn_domain::policies::{
    GuardrailMode, autonomy_of, is_read_only_call, is_sensitive_operation,
};
use serde::de::DeserializeOwned;
use serde_json::Value;

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
