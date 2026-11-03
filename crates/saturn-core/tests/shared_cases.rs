//! The cases `runtime/test/shared-cases.test.ts` answers too, so both implementations decide alike.
use saturn_core::history::tool_turns;
use saturn_core::memory::{merge, parse_notes};
use saturn_core::permissions::{allows_everything, rules_fingerprint};
use saturn_domain::context::{
    budget_start, clip_middle, compact_actions, compaction_start, context_tokens_for,
    estimate_tokens, history_budget_chars,
};
use saturn_domain::diff::unified_diff;
use saturn_domain::hooks::{
    Hook, HookDecision, from_claude_hooks, hooks_fingerprint, matches_tool, parse_answer,
};
use saturn_domain::prompt::{
    PromptInput, RunMode, build_system_prompt, clip, explain_run_error, join_thinking, number_of,
    read_only_refusal,
};
use saturn_domain::schedule::{next_slot, previous_slot, slot_label, trigger_of};
use saturn_domain::skill_files::{parse_skill, skills_prompt};
use saturn_domain::toolkits::{load_note, toolkit_server};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn field<T: DeserializeOwned>(case: &Value, name: &str) -> T {
    serde_json::from_value(case[name].clone())
        .unwrap_or_else(|error| panic!("{name} in {case}: {error}"))
}

fn words(case: &Value, name: &str) -> String {
    case[name].as_str().map(str::to_owned).unwrap_or_default()
}

fn answer(case: &Value) -> Value {
    let provider = words(case, "provider");
    let model = words(case, "model");
    let own = case["contextTokens"].as_f64();
    let limit = || case["limit"].as_u64().expect("a limit") as usize;
    let bytes = |name: &str| case[name].as_str().map(|text| text.as_bytes().to_vec());
    match case["check"].as_str().expect("every case names its check") {
        "estimateTokens" => json!(estimate_tokens(&words(case, "text"))),
        "contextTokens" => json!(context_tokens_for(&provider, &model, own)),
        "historyBudget" => json!(history_budget_chars(&provider, &model, own)),
        "clipMiddle" => json!(clip_middle(&words(case, "text"), limit())),
        "compactActions" => json!(compact_actions(&field::<Vec<Value>>(case, "actions"))),
        "budgetHistory" => {
            let turns: Vec<(String, usize)> = field(case, "turns");
            let sized: Vec<(bool, usize)> = turns
                .iter()
                .map(|(role, size)| (role == "user", *size))
                .collect();
            json!(budget_start(&sized, field(case, "budget")))
        }
        "splitForCompaction" => json!(compaction_start(
            &field::<Vec<usize>>(case, "sizes"),
            field(case, "keep")
        )),
        "clip" => json!(clip(&words(case, "text"), limit())),
        "explainRunError" => json!(explain_run_error(&words(case, "message"))),
        "readOnlyRefusal" => json!(read_only_refusal(
            RunMode::parse(case["mode"].as_str()).expect("a mode")
        )),
        "joinThinking" => json!(join_thinking(
            case["current"].as_str(),
            &words(case, "next")
        )),
        "numberOf" => {
            let number = number_of(
                Some(&case["value"]),
                field(case, "fallback"),
                field(case, "low"),
                field(case, "high"),
            );
            if number.fract() == 0.0 {
                json!(number as i64)
            } else {
                json!(number)
            }
        }
        "prompt" => {
            let servers: Vec<String> = field(case, "serverIds");
            let deferred: Vec<String> =
                serde_json::from_value(case["deferred"].clone()).unwrap_or_default();
            json!(build_system_prompt(&PromptInput {
                instructions: &words(case, "instructions"),
                context: &words(case, "context"),
                server_ids: &servers,
                deferred: &deferred,
                memory: &words(case, "memory"),
                rules: &words(case, "rules"),
                plan_approval: case["planApproval"] == true,
                mode: RunMode::parse(case["mode"].as_str()),
            }))
        }
        "matchesTool" => json!(matches_tool(case["matcher"].as_str(), &words(case, "tool"))),
        "fromClaudeHooks" => json!(from_claude_hooks(Some(&case["value"]))),
        "fingerprint" => json!(hooks_fingerprint(&field::<Vec<Hook>>(case, "hooks"))),
        "parseAnswer" => {
            let (decision, reason) = parse_answer(&words(case, "stdout"));
            let mut value = json!({});
            if let Some(decision) = decision {
                value["decision"] = match decision {
                    HookDecision::Allow => "allow",
                    HookDecision::Ask => "ask",
                    HookDecision::Deny => "deny",
                }
                .into();
            }
            if let Some(reason) = reason {
                value["reason"] = reason.into();
            }
            value
        }
        "parseSkill" => {
            let parsed = parse_skill(&words(case, "text"), &words(case, "fallback"));
            json!({ "name": parsed.name, "description": parsed.description, "body": parsed.body })
        }
        "skillsPrompt" => json!(skills_prompt(&field::<Vec<(String, String)>>(
            case, "skills"
        ))),
        "diff" => {
            let result = unified_diff(
                &words(case, "file"),
                bytes("before").as_deref(),
                bytes("after").as_deref(),
                3,
            );
            json!({ "diff": result.diff, "additions": result.additions, "deletions": result.deletions, "binary": result.binary })
        }
        "toolkitServer" => json!(toolkit_server(&words(case, "name"))),
        "loadNote" => json!(load_note(&words(case, "server"))),
        "allowsEverything" => json!(allows_everything(&field(case, "rule"))),
        "rulesFingerprint" => json!(rules_fingerprint(&field::<Vec<_>>(case, "rules"))),
        "parseNotes" => {
            let (global, project) = parse_notes(&words(case, "text"));
            json!({ "global": global, "project": project })
        }
        "mergeNotes" => json!(merge(
            &words(case, "existing"),
            &field::<Vec<String>>(case, "entries")
        )),
        "toolTurns" => {
            let messages = tool_turns(
                &field::<Vec<Value>>(case, "rounds"),
                &field::<Vec<Value>>(case, "actions"),
            );
            messages
                .iter()
                .map(|message| {
                    let mut value =
                        json!({ "role": message.role.as_str(), "content": message.content });
                    if let Some(reasoning) = &message.reasoning {
                        value["reasoning"] = json!(reasoning);
                    }
                    if !message.tool_calls.is_empty() {
                        value["toolCalls"] = json!(message.tool_calls);
                    }
                    if let Some(replay) = &message.replay {
                        value["replay"] = json!(replay);
                    }
                    if let Some(id) = &message.tool_call_id {
                        value["toolCallId"] = json!(id);
                        value["toolName"] = json!(message.tool_name);
                    }
                    if message.failed {
                        value["failed"] = json!(true);
                    }
                    if !message.images.is_empty() {
                        value["images"] = json!(message.images);
                    }
                    value
                })
                .collect()
        }
        "localMinute" => json!(saturn_core::automations::local_minute(
            saturn_domain::time::parse_iso(&words(case, "at")).expect("a time"),
            &words(case, "zone")
        )),
        "previousSlot" => json!(previous_slot(&case["trigger"], field(case, "local"))),
        "nextSlot" => json!(next_slot(&case["trigger"], field(case, "local"))),
        "slotLabel" => json!(slot_label(field(case, "minute"))),
        "triggerOf" => json!(trigger_of(
            &case["value"],
            Some(&case["fallback"]).filter(|item| !item.is_null())
        )),
        "validTimeZone" => match saturn_core::automations::valid_time_zone(Some(&case["value"])) {
            Ok(zone) => json!(zone),
            Err(error) => json!({ "error": error.message }),
        },
        "mentions" => json!(saturn_core::groups::mentions(
            &words(case, "text"),
            &words(case, "name")
        )),
        "isPass" => json!(saturn_core::groups::is_pass(&words(case, "text"))),
        other => panic!("unknown check {other}"),
    }
}

#[test]
fn answers_the_agent_loop_cases() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("../../../contract/cases/core.json"))
        .expect("the cases are JSON");
    assert!(cases.len() > 90);
    let mut wrong = Vec::new();
    for case in &cases {
        let mine = answer(case);
        if mine != case["expect"] {
            let shown = case.to_string();
            wrong.push(format!(
                "{}\n  rust: {}\n  ts:   {}",
                &shown[..shown.floor_char_boundary(200)],
                mine.to_string().chars().take(600).collect::<String>(),
                case["expect"]
                    .to_string()
                    .chars()
                    .take(600)
                    .collect::<String>()
            ));
        }
    }
    assert!(
        wrong.is_empty(),
        "{} wrong:\n{}",
        wrong.len(),
        wrong.join("\n")
    );
}
