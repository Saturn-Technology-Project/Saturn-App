//! What each provider's module sends and reads, against fake servers: `contract/cases/llm.json` as the official SDKs do it, then
//! what the broker adds. Keys here are fake, and no call leaves 127.0.0.1.
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use saturn_llm::broker::{Adapter, provider_key_id};
use saturn_llm::lmstudio::{self, RawRequest, alternating, openai_compatible_url};
use saturn_llm::mlx;
use saturn_llm::{
    Broker, CallContext, ChatMessage, ChatRequest, Completion, CompletionInput, Http, KeyVault,
    ModelConnection, Role, ToolDef,
};
use serde_json::{Map, Value, json};

/// A scripted reply.
#[derive(Clone)]
struct Reply {
    status: u16,
    body: String,
    headers: Vec<(&'static str, String)>,
}

fn reply(status: u16, body: Value) -> Reply {
    Reply {
        status,
        body: body.to_string(),
        headers: Vec::new(),
    }
}

/// A fake model server: answers from a script and records what it was sent.
struct FakeServer {
    base_url: String,
    sent: Arc<Mutex<Vec<Value>>>,
}

const RECORDED_HEADERS: [&str; 5] = [
    "authorization",
    "x-api-key",
    "x-goog-api-key",
    "anthropic-version",
    "content-type",
];

async fn fake_server(replies: Vec<Reply>) -> FakeServer {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let script = Arc::new(Mutex::new(VecDeque::from(replies)));
    let recorded = Arc::clone(&sent);
    let app = Router::new().fallback(move |uri: Uri, headers: HeaderMap, body: Bytes| {
        let recorded = Arc::clone(&recorded);
        let script = Arc::clone(&script);
        async move {
            let wanted: Map<String, Value> = RECORDED_HEADERS
                .iter()
                .filter_map(|name| {
                    Some((
                        (*name).to_owned(),
                        json!(headers.get(*name)?.to_str().ok()?),
                    ))
                })
                .collect();
            recorded.lock().expect("not poisoned").push(json!({
                "path": uri.to_string(),
                "headers": wanted,
                "body": serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null),
            }));
            let next = script
                .lock()
                .expect("not poisoned")
                .pop_front()
                .unwrap_or_else(|| {
                    reply(500, json!({ "error": { "message": "no more replies" } }))
                });
            let mut response: Response = (
                StatusCode::from_u16(next.status).expect("a status"),
                next.body,
            )
                .into_response();
            response
                .headers_mut()
                .insert("content-type", HeaderValue::from_static("application/json"));
            for (name, value) in next.headers {
                response
                    .headers_mut()
                    .insert(name, HeaderValue::from_str(&value).expect("a header"));
            }
            response
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a port");
    let address = listener.local_addr().expect("an address");
    tokio::spawn(async move { axum::serve(listener, app).await.expect("it serves") });
    FakeServer {
        base_url: format!("http://{address}"),
        sent,
    }
}

fn http() -> Http {
    Http::with_retry_delay(Duration::from_millis(1)).expect("a client")
}

fn adapter_named(name: &str) -> Adapter {
    match name {
        "claude" => Adapter::Claude,
        "gemini" => Adapter::Gemini,
        "deepseek" => Adapter::DeepSeek,
        "lmstudio" => Adapter::LmStudio,
        "mlx" => Adapter::Mlx,
        "openai-chat" => Adapter::OpenAiChat,
        "openai-responses" => Adapter::OpenAiResponses,
        other => panic!("unknown adapter {other}"),
    }
}

fn field<T: serde::de::DeserializeOwned>(fields: &Value, name: &str) -> T {
    serde_json::from_value(fields[name].clone()).unwrap_or_else(|error| panic!("{name}: {error}"))
}

fn request_of(case: &Value, base_url: &str) -> ChatRequest {
    let fields = &case["request"];
    let text = |name: &str| fields[name].as_str().map(str::to_owned);
    let messages: Vec<ChatMessage> = if fields["messages"].is_null() {
        Vec::new()
    } else {
        field(fields, "messages")
    };
    let tools: Vec<ToolDef> = if fields["tools"].is_null() {
        Vec::new()
    } else {
        field(fields, "tools")
    };
    ChatRequest {
        model: text("model").expect("a model"),
        base_url: base_url.to_owned(),
        api_key: Some(text("apiKey").unwrap_or_else(|| "fake-key".to_owned())),
        messages,
        tools,
        temperature: fields["temperature"].as_f64(),
        max_output: fields["maxOutput"].as_u64(),
        low_thinking: fields["thinking"] == "low",
        effort: fields.get("effort").map(|_| field(fields, "effort")),
        cache_key: text("cacheKey"),
    }
}

/// A completion in the form the cases hold it.
fn as_case(completion: &Completion) -> Value {
    let calls: Vec<Value> = completion
        .tool_calls
        .iter()
        .map(|call| {
            let mut fields = Map::new();
            if let Some(id) = &call.id {
                fields.insert("id".to_owned(), json!(id));
            }
            fields.insert("name".to_owned(), json!(call.name));
            fields.insert(
                "arguments".to_owned(),
                Value::Object(call.arguments.clone()),
            );
            if let Some(signature) = &call.thought_signature {
                fields.insert("thoughtSignature".to_owned(), json!(signature));
            }
            Value::Object(fields)
        })
        .collect();
    let mut usage = Map::new();
    let usage_fields = [
        ("input_tokens", completion.usage.input),
        ("output_tokens", completion.usage.output),
        ("cached_input_tokens", completion.usage.cached),
        ("cache_write_input_tokens", completion.usage.cache_write),
    ];
    for (name, count) in usage_fields {
        if let Some(count) = count {
            usage.insert(name.to_owned(), json!(count));
        }
    }
    let mut case = json!({ "content": completion.content, "thinking": completion.thinking, "toolCalls": calls, "usage": usage });
    if let Some(replay) = &completion.replay {
        case["replay"] = json!(replay);
    }
    case
}

/// A value with whole numbers written one way: `1.0` and `1` are the same number in JSON.
fn same_numbers(value: Value) -> Value {
    match value {
        Value::Number(number) => match number.as_f64() {
            Some(float) if float.fract() == 0.0 && float.abs() < 1e15 => json!(float as i64),
            _ => Value::Number(number),
        },
        Value::Array(items) => Value::Array(items.into_iter().map(same_numbers).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .map(|(name, item)| (name, same_numbers(item)))
                .collect(),
        ),
        other => other,
    }
}

#[tokio::test]
async fn sends_and_reads_what_the_sdks_do() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("../../../contract/cases/llm.json"))
        .expect("the cases are JSON");
    assert!(cases.len() >= 19);
    for case in &cases {
        let name = case["name"].as_str().expect("a name");
        let replies = case["replies"]
            .as_array()
            .expect("replies")
            .iter()
            .map(|item| {
                reply(
                    item["status"].as_u64().unwrap_or(200) as u16,
                    item["body"].clone(),
                )
            })
            .collect();
        let server = fake_server(replies).await;
        let request = request_of(case, &server.base_url);
        let result = adapter_named(case["adapter"].as_str().expect("an adapter"))
            .complete(&http(), &request)
            .await;
        let sent = server.sent.lock().expect("not poisoned").clone();
        assert_eq!(
            same_numbers(Value::Array(sent)),
            same_numbers(case["sent"].clone()),
            "{name}: what was sent"
        );
        match result {
            Ok(completion) => assert_eq!(
                as_case(&completion),
                case["completion"],
                "{name}: what came back"
            ),
            Err(error) => assert_eq!(
                Some(json!(error.status)),
                case["error"].get("status").cloned(),
                "{name}: {error}"
            ),
        }
    }
}

/// A key vault in memory.
#[derive(Default)]
struct Keys(Mutex<std::collections::HashMap<String, String>>);

impl KeyVault for Keys {
    fn secret(&self, id: &str) -> Option<String> {
        self.0.lock().expect("not poisoned").get(id).cloned()
    }

    async fn put_secret(&self, id: &str, value: &str) -> std::io::Result<()> {
        self.0
            .lock()
            .expect("not poisoned")
            .insert(id.to_owned(), value.to_owned());
        Ok(())
    }
}

fn broker(entries: &[(&str, &str)]) -> Broker<Keys> {
    let keys = Keys::default();
    for (id, value) in entries {
        keys.0
            .lock()
            .expect("not poisoned")
            .insert((*id).to_owned(), (*value).to_owned());
    }
    Broker::new(Arc::new(keys), http())
}

fn model(provider: &str, base_url: &str, id: &str) -> ModelConnection {
    ModelConnection {
        id: id.to_owned(),
        name: provider.to_owned(),
        provider: provider.to_owned(),
        model: "m".to_owned(),
        base_url: base_url.to_owned(),
        effort: None,
    }
}

#[test]
fn the_broker_sends_each_provider_to_its_own_module() {
    let broker = broker(&[]);
    let adapter = |provider, url| {
        broker
            .adapter_for(&model(provider, url, "x"))
            .expect("an adapter")
            .id()
    };
    assert_eq!(
        adapter("gemini", "https://generativelanguage.googleapis.com"),
        "gemini"
    );
    assert_eq!(adapter("claude", "https://api.anthropic.com"), "claude");
    assert_eq!(adapter("deepseek", "https://api.deepseek.com"), "deepseek");
    assert_eq!(adapter("lmstudio", "http://127.0.0.1:1234"), "lmstudio");
    assert_eq!(adapter("mlx", "http://127.0.0.1:8080"), "mlx");
    assert_eq!(
        adapter("openai", "https://api.openai.com/v1"),
        "openai-responses"
    );
    assert_eq!(adapter("openai", "http://127.0.0.1:8080/v1"), "openai-chat");
    for provider in ["claude-code", "codex"] {
        let error = broker
            .adapter_for(&model(provider, "", "x"))
            .expect_err("no API requests");
        assert!(error.message.contains("on your own plan"), "{error}");
    }
}

#[tokio::test]
async fn the_broker_picks_the_models_key_before_its_providers() {
    let shared = provider_key_id("gemini");
    let broker = broker(&[(&shared, "shared"), ("mdl_b", "own")]);
    let gemini = "https://generativelanguage.googleapis.com";
    assert_eq!(
        broker.key_for(&model("gemini", gemini, "mdl_a")).as_deref(),
        Some("shared")
    );
    assert_eq!(
        broker.key_for(&model("gemini", gemini, "mdl_b")).as_deref(),
        Some("own")
    );

    let claude = model("claude", "https://api.anthropic.com", "mdl_c");
    broker.save_key(&claude, "  ck  ").await.expect("saved");
    assert_eq!(broker.key_for(&claude).as_deref(), Some("ck"));
    assert_eq!(
        broker
            .key_for(&model("claude", "https://api.anthropic.com", "mdl_d"))
            .as_deref(),
        Some("ck")
    );

    let refused = broker
        .require_key(&model("deepseek", "https://api.deepseek.com", "x"))
        .expect_err("no key");
    assert_eq!(refused.status, Some(409));
    assert!(refused.message.contains("no DeepSeek API key"), "{refused}");
    broker
        .require_key(&model("openai", "http://127.0.0.1:8080/v1", "x"))
        .expect("a custom endpoint needs none");
}

fn chat_reply(content: &str) -> Value {
    json!({ "choices": [{ "message": { "role": "assistant", "content": content } }], "usage": { "prompt_tokens": 1000, "completion_tokens": 10 } })
}

fn input_with_tool_turn() -> CompletionInput {
    let tool_turn: Vec<ChatMessage> = serde_json::from_value(json!([
        { "role": "user", "content": "go" },
        { "role": "assistant", "content": "", "toolCalls": [{ "id": "c1", "name": "files", "arguments": {} }] },
        { "role": "tool", "toolCallId": "c1", "toolName": "files", "content": "{\"status\":\"completed\"}" },
    ]))
    .expect("messages");
    CompletionInput {
        context: CallContext {
            agent_id: "agent_1".to_owned(),
            agent_name: "Saturn".to_owned(),
            run_id: Some("run_1".to_owned()),
            purpose: "run",
        },
        messages: tool_turn,
        ..CompletionInput::default()
    }
}

#[tokio::test]
async fn a_server_that_refuses_native_tool_turns_gets_them_as_text() {
    let server = fake_server(vec![
        reply(400, json!({ "error": { "message": "unknown role tool" } })),
        reply(200, chat_reply("ok")),
    ])
    .await;
    let completion = broker(&[])
        .complete(
            &model("openai", &server.base_url, "x"),
            &input_with_tool_turn(),
        )
        .await
        .expect("it answers");
    assert_eq!(completion.content, "ok");
    let sent = server.sent.lock().expect("not poisoned").clone();
    assert_eq!(sent[0]["body"]["messages"][2]["role"], "tool");
    let messages = sent[1]["body"]["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[1]["role"], "assistant");
    assert!(
        messages[1]["content"]
            .as_str()
            .expect("text")
            .contains("\"toolId\":\"files\"")
    );
    assert_eq!(
        messages[2]["content"],
        saturn_llm::shared::CONTINUE_AFTER_TOOLS
    );
}

#[tokio::test]
async fn a_refusal_without_tool_turns_is_not_asked_again() {
    let server = fake_server(vec![reply(400, json!({ "error": { "message": "nope" } }))]).await;
    let input = CompletionInput {
        messages: vec![ChatMessage::new(Role::User, "hi")],
        ..CompletionInput::default()
    };
    let error = broker(&[])
        .complete(&model("openai", &server.base_url, "x"), &input)
        .await
        .expect_err("refused");
    assert_eq!(error.status, Some(400));
    assert_eq!(server.sent.lock().expect("not poisoned").len(), 1);
}

#[tokio::test]
async fn a_call_leaves_a_priced_line_for_the_usage_history() {
    // The list price needs the provider's own address, which a fake server cannot have: this one is unpriced.
    let server = fake_server(vec![reply(200, chat_reply("ok"))]).await;
    let completion = broker(&[])
        .complete(
            &model("openai", &server.base_url, "mdl_1"),
            &input_with_tool_turn(),
        )
        .await
        .expect("it answers");
    let record = completion.usage_record.expect("tokens were reported");
    assert_eq!(record["runId"], "run_1");
    assert_eq!(record["agentName"], "Saturn");
    assert_eq!(record["modelId"], "mdl_1");
    assert_eq!(record["purpose"], "run");
    assert_eq!(record["inputTokens"], 1000);
    assert_eq!(record["pricing"], "unpriced");
    assert!(record["costUsd"].is_null());
    assert!(record["id"].as_str().expect("an id").starts_with("usage_"));
    assert!(record.get("cachedRate").is_none());

    let server = fake_server(vec![reply(200, chat_reply("ok"))]).await;
    let local = broker(&[])
        .complete(
            &model("lmstudio", &server.base_url, "mdl_2"),
            &input_with_tool_turn(),
        )
        .await
        .expect("it answers");
    let record = local.usage_record.expect("tokens were reported");
    assert_eq!(record["pricing"], "local");
    assert_eq!(record["costUsd"], 0.0);

    let server = fake_server(vec![reply(
        200,
        json!({ "choices": [{ "message": { "content": "ok" } }] }),
    )])
    .await;
    let silent = broker(&[])
        .complete(
            &model("openai", &server.base_url, "x"),
            &input_with_tool_turn(),
        )
        .await
        .expect("it answers");
    assert_eq!(silent.usage_record, None, "no tokens, no line");
}

fn simple_request(base_url: &str) -> ChatRequest {
    ChatRequest {
        model: "m".to_owned(),
        base_url: base_url.to_owned(),
        messages: vec![ChatMessage::new(Role::User, "hi")],
        ..ChatRequest::default()
    }
}

#[tokio::test]
async fn a_transient_failure_is_tried_again_and_a_lasting_one_gives_up() {
    let failing = || reply(503, json!({ "error": { "message": "overloaded" } }));
    let server = fake_server(vec![failing(), failing(), reply(200, chat_reply("ok"))]).await;
    let completion = Adapter::OpenAiChat
        .complete(&http(), &simple_request(&server.base_url))
        .await
        .expect("the third try");
    assert_eq!(completion.content, "ok");

    let server = fake_server(vec![
        failing(),
        failing(),
        failing(),
        reply(200, chat_reply("never")),
    ])
    .await;
    let error = Adapter::OpenAiChat
        .complete(&http(), &simple_request(&server.base_url))
        .await
        .expect_err("gave up");
    assert_eq!(error.status, Some(503));
    assert_eq!(server.sent.lock().expect("not poisoned").len(), 3);

    let server = fake_server(vec![reply(
        401,
        json!({ "error": { "message": "bad key" } }),
    )])
    .await;
    let error = Adapter::OpenAiChat
        .complete(&http(), &simple_request(&server.base_url))
        .await
        .expect_err("not transient");
    assert_eq!(error.status, Some(401));
    assert_eq!(server.sent.lock().expect("not poisoned").len(), 1);

    let told_not_to = Reply {
        headers: vec![("x-should-retry", "false".to_owned())],
        ..failing()
    };
    let server = fake_server(vec![told_not_to]).await;
    Adapter::OpenAiChat
        .complete(&http(), &simple_request(&server.base_url))
        .await
        .expect_err("the server said not to");
    assert_eq!(server.sent.lock().expect("not poisoned").len(), 1);
}

#[tokio::test]
async fn retry_after_is_waited_for_instead_of_the_default() {
    let limited = Reply {
        headers: vec![("retry-after", "0.2".to_owned())],
        ..reply(429, json!({ "error": { "message": "slow down" } }))
    };
    let server = fake_server(vec![limited, reply(200, chat_reply("ok"))]).await;
    let started = std::time::Instant::now();
    let client = Http::with_retry_delay(Duration::from_secs(60)).expect("a client");
    Adapter::OpenAiChat
        .complete(&client, &simple_request(&server.base_url))
        .await
        .expect("it answers");
    let waited = started.elapsed();
    assert!(
        waited >= Duration::from_millis(180) && waited < Duration::from_secs(5),
        "{waited:?}"
    );
}

#[tokio::test]
async fn a_server_that_is_not_there_is_reported_without_its_address_query() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a port");
    let address = listener.local_addr().expect("an address");
    drop(listener);
    let request = simple_request(&format!("http://{address}/secret-path"));
    let error = Adapter::OpenAiChat
        .complete(&http(), &request)
        .await
        .expect_err("nothing listens");
    assert_eq!(error.status, None);
    assert!(error.transient);
    assert!(!error.message.contains("secret-path"), "{error}");
}

#[tokio::test]
async fn a_redirect_is_not_followed_so_a_key_stays_with_its_host() {
    let other = fake_server(vec![reply(200, chat_reply("stolen"))]).await;
    let moved = Reply {
        headers: vec![("location", other.base_url.clone())],
        ..reply(307, json!({}))
    };
    let server = fake_server(vec![moved]).await;
    let request = ChatRequest {
        api_key: Some("fake-key".to_owned()),
        ..simple_request(&server.base_url)
    };
    let error = Adapter::OpenAiChat
        .complete(&http(), &request)
        .await
        .expect_err("a redirect is a failure");
    assert_eq!(error.status, Some(307));
    assert!(other.sent.lock().expect("not poisoned").is_empty());
}

#[tokio::test]
async fn deep_tool_arguments_from_a_model_are_clipped_not_fatal() {
    let depth = 100_000;
    let arguments = format!("{{\"deep\":{}{}}}", "[".repeat(depth), "]".repeat(depth));
    let body = json!({ "choices": [{ "message": { "tool_calls": [{ "id": "c", "type": "function", "function": { "name": "files", "arguments": arguments } }] } }] });
    let server = fake_server(vec![reply(200, body)]).await;
    let completion = Adapter::OpenAiChat
        .complete(&http(), &simple_request(&server.base_url))
        .await
        .expect("it answers");
    assert_eq!(completion.tool_calls[0].name, "files");
    assert!(completion.tool_calls[0].arguments["deep"].is_array());
}

#[test]
fn lm_studio_gets_strictly_alternating_turns_at_its_v1_address() {
    let turns: Vec<ChatMessage> = serde_json::from_value(json!([
        { "role": "system", "content": "rules" },
        { "role": "assistant", "content": "earlier summary" },
        { "role": "user", "content": "one" },
        { "role": "user", "content": "two" },
        { "role": "assistant", "content": "" },
        { "role": "assistant", "content": "answer" },
        { "role": "assistant", "content": "more" },
    ]))
    .expect("messages");
    let result: Vec<(Role, String)> = alternating(&turns)
        .into_iter()
        .map(|turn| (turn.role, turn.content))
        .collect();
    assert_eq!(
        result,
        [
            (Role::System, "rules".to_owned()),
            (Role::User, "(continuing the conversation)".to_owned()),
            (Role::Assistant, "earlier summary".to_owned()),
            (Role::User, "one\n\ntwo".to_owned()),
            (Role::Assistant, "answer\n\nmore".to_owned()),
        ]
    );
    let url = |base| openai_compatible_url(base).expect("valid");
    assert_eq!(url("http://127.0.0.1:1234"), "http://127.0.0.1:1234/v1");
    assert_eq!(url("http://127.0.0.1:1234/v1/"), "http://127.0.0.1:1234/v1");
    assert_eq!(url("ws://192.168.1.5:1234"), "http://192.168.1.5:1234/v1");
    assert_eq!(url("wss://host.example/lm"), "https://host.example/lm/v1");
}

#[tokio::test]
async fn raw_completions_stream_fragments_even_split_inside_a_character() {
    let event = |text: &str| format!("data: {}\n\n", json!({ "choices": [{ "text": text }] }));
    let body = format!(
        "{}{}: ignored\n{}data: [DONE]\n\n{}",
        event("return "),
        "event",
        event("a + é;"),
        event("never")
    );
    let server = fake_server(vec![Reply {
        status: 200,
        body,
        headers: Vec::new(),
    }])
    .await;
    let stops: Vec<String> = (0..7).map(|index| format!("<stop{index}>")).collect();
    let request = RawRequest {
        model: "qwen3-8b".to_owned(),
        base_url: server.base_url.clone(),
        prompt: "function add(a, b) {".to_owned(),
        stops: stops.clone(),
        max_output: 32,
        temperature: Some(1.5),
        ..RawRequest::default()
    };
    let client = http();
    let mut stream = lmstudio::complete_raw(&client, &request)
        .await
        .expect("it streams");
    let mut text = String::new();
    while let Some(fragment) = stream.next().await.expect("a fragment") {
        text.push_str(&fragment);
    }
    assert_eq!(text, "return a + é;");
    let sent = server.sent.lock().expect("not poisoned").clone();
    assert_eq!(sent[0]["path"], "/v1/completions");
    assert_eq!(sent[0]["body"]["stop"], json!(stops));
    assert_eq!(sent[0]["body"]["temperature"], 1.0);

    let server = fake_server(vec![reply(
        500,
        json!({ "error": { "message": "no model" } }),
    )])
    .await;
    let refused = lmstudio::complete_raw(
        &client,
        &RawRequest {
            base_url: server.base_url.clone(),
            ..RawRequest::default()
        },
    )
    .await;
    assert_eq!(refused.err().expect("refused").status, Some(500));
}

#[tokio::test]
async fn the_openai_raw_endpoint_keeps_four_stops_and_other_providers_have_none() {
    let server = fake_server(vec![Reply {
        status: 200,
        body: "data: [DONE]\n".to_owned(),
        headers: Vec::new(),
    }])
    .await;
    let request = RawRequest {
        base_url: format!("{}/v1", server.base_url),
        stops: (0..7).map(|index| index.to_string()).collect(),
        ..RawRequest::default()
    };
    let client = http();
    let mut stream = Adapter::OpenAiChat
        .complete_raw(&client, &request)
        .await
        .expect("it has one")
        .expect("it streams");
    assert_eq!(stream.next().await.expect("the end"), None);
    let sent = server.sent.lock().expect("not poisoned").clone();
    assert_eq!(sent[0]["path"], "/v1/completions");
    assert_eq!(sent[0]["body"]["stop"].as_array().expect("stops").len(), 4);
    assert_eq!(sent[0]["headers"]["authorization"], "Bearer local");
    assert!(
        Adapter::Claude
            .complete_raw(&client, &request)
            .await
            .is_none()
    );
}

#[tokio::test]
async fn the_lm_studio_model_list_prefers_its_rest_api() {
    let current = json!({ "data": [{ "id": "qwen3-8b", "type": "llm" }, { "id": "gemma-3-4b", "type": "vlm" }, { "id": "nomic-embed-text", "type": "embeddings" }] });
    let server = fake_server(vec![reply(200, current)]).await;
    let client = http();
    assert_eq!(
        lmstudio::list_models(&client, &server.base_url)
            .await
            .expect("a list"),
        ["qwen3-8b", "gemma-3-4b"]
    );

    let older = json!({ "data": [{ "id": "old-model" }, { "id": "nomic-Embed-text" }] });
    let server = fake_server(vec![reply(404, json!({})), reply(200, older)]).await;
    assert_eq!(
        lmstudio::list_models(&client, &server.base_url)
            .await
            .expect("a list"),
        ["old-model"]
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a port");
    let address = listener.local_addr().expect("an address");
    drop(listener);
    let error = lmstudio::list_models(&client, &format!("http://{address}"))
        .await
        .expect_err("nothing listens");
    assert_eq!(error.message, "LM Studio is not running");
}

#[tokio::test]
async fn an_mlx_model_is_asked_through_mlx_lm_server_and_its_tool_calls_and_reasoning_are_read() {
    // What mlx_lm.server answers: the arguments as a JSON string, the reasoning under "reasoning".
    let answer = json!({
        "choices": [{
            "message": {
                "role": "assistant",
                "content": "",
                "reasoning": "The files first.",
                "tool_calls": [{ "id": "call_1", "type": "function", "function": { "name": "files", "arguments": "{\"path\":\"a\"}" } }],
            },
            "finish_reason": "tool_calls",
        }],
        "usage": { "prompt_tokens": 900, "completion_tokens": 20, "total_tokens": 920 },
    });
    let server = fake_server(vec![reply(200, answer)]).await;
    let tool: ToolDef = serde_json::from_value(
        json!({ "function": { "name": "files", "parameters": { "type": "object" } } }),
    )
    .expect("a tool");
    let input = CompletionInput {
        tools: vec![tool],
        ..input_with_tool_turn()
    };
    let completion = broker(&[])
        .complete(&model("mlx", &server.base_url, "mdl_3"), &input)
        .await
        .expect("it answers");
    assert_eq!(completion.tool_calls[0].name, "files");
    assert_eq!(completion.tool_calls[0].arguments["path"], "a");
    assert_eq!(completion.thinking, "The files first.");
    let record = completion.usage_record.expect("tokens were reported");
    assert_eq!(
        record["pricing"], "local",
        "a model on this computer costs nothing"
    );
    assert_eq!(record["costUsd"], 0.0);
    let sent = server.sent.lock().expect("not poisoned").clone();
    assert_eq!(sent[0]["path"], "/v1/chat/completions");
    assert_eq!(sent[0]["body"]["tools"][0]["function"]["name"], "files");
    assert_eq!(
        sent[0]["headers"]["authorization"], "Bearer mlx",
        "it takes any key"
    );
    assert!(
        sent[0]["body"]["messages"]
            .as_array()
            .expect("messages")
            .iter()
            .all(|message| message["role"] != "tool"),
        "earlier tool turns go as text, which every chat template takes"
    );
}

#[tokio::test]
async fn the_mlx_model_list_is_what_mlx_lm_server_can_load_without_embedding_models() {
    let models = json!({ "object": "list", "data": [
        { "id": "mlx-community/Qwen3-8B-4bit", "object": "model", "created": 1 },
        { "id": "mlx-community/nomic-embed-text-v1.5", "object": "model", "created": 1 },
        { "id": "mlx-community/bge-m3-mlx-fp16", "object": "model", "created": 1 },
        { "id": "mlx-community/multilingual-e5-small-mlx", "object": "model", "created": 1 },
        { "id": "mlx-community/Qwen3-Reranker-0.6B", "object": "model", "created": 1 },
        { "id": "mlx-community/gemma-3-4b-it-4bit", "object": "model", "created": 1 },
    ] });
    let server = fake_server(vec![reply(200, models)]).await;
    let client = http();
    assert_eq!(
        mlx::list_models(&client, &server.base_url)
            .await
            .expect("a list"),
        [
            "mlx-community/Qwen3-8B-4bit",
            "mlx-community/gemma-3-4b-it-4bit"
        ]
    );
    assert_eq!(
        server.sent.lock().expect("not poisoned")[0]["path"],
        "/v1/models"
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a port");
    let address = listener.local_addr().expect("an address");
    drop(listener);
    let error = mlx::list_models(&client, &format!("http://{address}"))
        .await
        .expect_err("nothing listens");
    assert_eq!(error.message, "mlx_lm.server is not running");
}
