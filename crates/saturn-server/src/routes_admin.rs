//! Settings, connections, projects, usage and the workspace views.
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::http::header::{CONTENT_TYPE, HeaderName};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use saturn_core::agent_programs::program_id;
use saturn_core::catalog::llm_providers;
use saturn_core::projects::{launch_app, launch_terminal};
use saturn_core::skill_files::{
    expand_command, list_commands, list_skills, load_skill, skill_json,
};
use saturn_core::{CoreError, Kernel};
use saturn_domain::js;
use saturn_domain::skills::public_address::parse_public_address;
use saturn_telemetry::network;
use saturn_telemetry::{Kind, Span, formats};
use saturn_tools::public_host::{SystemLookup, fetch_public};
use saturn_tools::run_captured;
use saturn_tools::sandbox::Platform;
use saturn_tools::shell::{process_env, shell_invocation};
use serde_json::{Value, json};

use crate::routes::{Answer, Body, Failure, Shared, body_of, created, given, layers_json, ok};
use crate::terminal_sessions;

type QueryText = Query<HashMap<String, String>>;

const CWD_MARKER: &str = "__SATURN_CWD__:";
/// Sent into every page the in-app browser shows: link clicks and GET forms ask the app to load the next page through the proxy,
/// since the sandboxed frame cannot load most sites itself.
const BROWSER_NAVIGATION_SCRIPT: &str = include_str!("browser-navigation.html");

fn no_content() -> Answer {
    Ok(StatusCode::NO_CONTENT.into_response())
}

fn wanted<'a>(query: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    query
        .get(key)
        .map(String::as_str)
        .filter(|text| !text.is_empty())
}

async fn settings(State(kernel): Shared) -> Answer {
    ok(kernel.settings())
}

async fn update_settings(State(kernel): Shared, body: Body) -> Answer {
    ok(kernel.update_settings(&body_of(body)).await?)
}

async fn information(State(kernel): Shared) -> Answer {
    ok(kernel.information().await)
}

async fn logs(Query(query): QueryText) -> Answer {
    let text = |key: &str| wanted(&query, key).unwrap_or("");
    ok(Kernel::list_logs(text("service"), text("level"), text("q")))
}

async fn snapshots(State(kernel): Shared) -> Answer {
    ok(kernel.snapshot_folders().await)
}

async fn delete_snapshots(State(kernel): Shared) -> Answer {
    kernel.delete_snapshot_folders(None).await?;
    ok(json!({ "deleted": true }))
}

async fn delete_snapshot(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    kernel.delete_snapshot_folders(Some(&id)).await?;
    ok(json!({ "deleted": true }))
}

async fn read_memory(State(kernel): Shared, Path(scope): Path<String>) -> Answer {
    ok(json!({ "scope": scope, "content": kernel.read_memory(&scope).await }))
}

async fn write_memory(State(kernel): Shared, Path(scope): Path<String>, body: Body) -> Answer {
    let content = js::text(body_of(body).get("content"));
    kernel
        .write_memory(&scope, &content)
        .await
        .map_err(CoreError::from)?;
    ok(json!({ "scope": scope, "content": kernel.read_memory(&scope).await }))
}

async fn usage(State(kernel): Shared) -> Answer {
    ok(kernel.usage_records())
}

async fn usage_summary(State(kernel): Shared, Query(query): QueryText) -> Answer {
    ok(kernel.usage_summary(wanted(&query, "from"), wanted(&query, "to"))?)
}

async fn providers() -> Answer {
    ok(llm_providers())
}

/// The route keeps the path it had when the local server could only be LM Studio.
async fn local_server(State(kernel): Shared, Query(query): QueryText) -> Answer {
    ok(kernel
        .local_server_models(wanted(&query, "baseUrl").unwrap_or(""))
        .await)
}

async fn provider_models(
    State(kernel): Shared,
    Path(provider): Path<String>,
    Query(query): QueryText,
) -> Answer {
    ok(kernel
        .provider_models(&provider, wanted(&query, "baseUrl").unwrap_or(""))
        .await?)
}

async fn list_connections(State(kernel): Shared, Path(kind): Path<String>) -> Answer {
    ok(kernel.list_connections(&kind).await?)
}

/// Removes a connection. With `moveAgentsTo` (a model's) or `releaseAgents` (a server's or index's) its agents let go of
/// it first; without either, a connection still in use is refused.
async fn remove_connection(
    kernel: &Kernel,
    kind: &str,
    id: &str,
    query: &HashMap<String, String>,
) -> Result<(), CoreError> {
    let move_to = query.get("moveAgentsTo").map(String::as_str);
    if move_to.is_some()
        || query
            .get("releaseAgents")
            .is_some_and(|value| value == "true")
    {
        kernel.release_connection(kind, id, move_to).await
    } else {
        kernel.delete_connection(kind, id).await
    }
}

async fn delete_connection(
    State(kernel): Shared,
    Path((kind, id)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Answer {
    remove_connection(&kernel, &kind, &id, &query).await?;
    no_content()
}

async fn list_mcp(State(kernel): Shared) -> Answer {
    ok(kernel.list_connections("mcp").await?)
}

async fn list_rag(State(kernel): Shared) -> Answer {
    ok(kernel.list_connections("rag").await?)
}

async fn delete_model(
    State(kernel): Shared,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Answer {
    remove_connection(&kernel, "models", &id, &query).await?;
    no_content()
}

async fn delete_mcp_connection(
    State(kernel): Shared,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Answer {
    remove_connection(&kernel, "mcp", &id, &query).await?;
    no_content()
}

async fn delete_rag(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    kernel.delete_connection("rag", &id).await?;
    no_content()
}

async fn update_model(State(kernel): Shared, Path(id): Path<String>, body: Body) -> Answer {
    ok(kernel.update_model(&id, &body_of(body)).await?)
}

async fn create_mcp(State(kernel): Shared, body: Body) -> Answer {
    created(kernel.create_mcp(&body_of(body)).await?)
}

async fn update_mcp(State(kernel): Shared, Path(id): Path<String>, body: Body) -> Answer {
    ok(kernel.update_mcp(&id, &body_of(body)).await?)
}

async fn approve_mcp(State(kernel): Shared, Path(id): Path<String>, body: Body) -> Answer {
    let fingerprint = js::text(body_of(body).get("fingerprint"));
    ok(kernel.approve_mcp(&id, &fingerprint).await?)
}

async fn discover_mcp(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    ok(kernel.discover_mcp(&id).await?)
}

async fn delete_mcp(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    kernel.delete_mcp_server(&id).await?;
    no_content()
}

async fn create_rag(State(kernel): Shared, body: Body) -> Answer {
    created(kernel.create_rag(&body_of(body)).await?)
}

async fn update_rag(State(kernel): Shared, Path(id): Path<String>, body: Body) -> Answer {
    ok(kernel.update_rag(&id, &body_of(body)).await?)
}

async fn hook_sets(State(kernel): Shared, Query(query): QueryText) -> Answer {
    let sets = kernel.hook_sets(wanted(&query, "projectId")).await;
    ok(sets
        .iter()
        .map(saturn_core::hooks::HookSet::to_json)
        .collect::<Vec<_>>())
}

async fn set_hooks(State(kernel): Shared, body: Body) -> Answer {
    let body = body_of(body);
    let sets = kernel
        .set_user_hooks(body.get("hooks").unwrap_or(&Value::Null))
        .await?;
    ok(sets
        .iter()
        .map(saturn_core::hooks::HookSet::to_json)
        .collect::<Vec<_>>())
}

async fn approve_hooks(State(kernel): Shared, Path(id): Path<String>, body: Body) -> Answer {
    let body = body_of(body);
    let sets = kernel
        .approve_hooks(
            &id,
            &js::text(body.get("file")),
            &js::text(body.get("fingerprint")),
        )
        .await?;
    ok(sets
        .iter()
        .map(saturn_core::hooks::HookSet::to_json)
        .collect::<Vec<_>>())
}

async fn revoke_hooks(State(kernel): Shared, Path(id): Path<String>, body: Body) -> Answer {
    let sets = kernel
        .revoke_hooks(&id, &js::text(body_of(body).get("file")))
        .await?;
    ok(sets
        .iter()
        .map(saturn_core::hooks::HookSet::to_json)
        .collect::<Vec<_>>())
}

async fn approve_rules(State(kernel): Shared, Path(id): Path<String>, body: Body) -> Answer {
    let body = body_of(body);
    ok(layers_json(
        &kernel
            .approve_rules_file(
                &id,
                &js::text(body.get("file")),
                &js::text(body.get("fingerprint")),
            )
            .await?,
    ))
}

async fn revoke_rules(State(kernel): Shared, Path(id): Path<String>, body: Body) -> Answer {
    ok(layers_json(
        &kernel
            .revoke_rules_file(&id, &js::text(body_of(body).get("file")))
            .await?,
    ))
}

async fn active_project(State(kernel): Shared) -> Answer {
    ok(kernel.active_project().await?)
}

async fn set_active(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    ok(kernel.set_active_project(&id).await?)
}

async fn update_project(State(kernel): Shared, Path(id): Path<String>, body: Body) -> Answer {
    ok(kernel.update_project(&id, &body_of(body)).await?)
}

async fn delete_project(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    kernel.delete_project(&id).await?;
    no_content()
}

async fn project_access(State(kernel): Shared, Path(id): Path<String>, body: Body) -> Answer {
    let granted = body_of(body).get("granted") != Some(&Value::Bool(false));
    ok(kernel.set_project_access(&id, granted).await?)
}

async fn project_terminal(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    ok(kernel.open_project_terminal(&id).await?)
}

async fn project_folder(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    ok(kernel.open_project_folder(&id).await?)
}

async fn project_rules(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    ok(kernel.project_rules_view(&id).await?)
}

async fn save_rules(State(kernel): Shared, Path(id): Path<String>, body: Body) -> Answer {
    let body = body_of(body);
    ok(kernel
        .save_project_rules(
            &id,
            &js::text(body.get("content")),
            given(&body, "targetFile"),
        )
        .await?)
}

async fn project_context(State(kernel): Shared, Path(id): Path<String>, body: Body) -> Answer {
    let body = body_of(body);
    let items = body
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    ok(kernel.expand_context(&id, &items).await?)
}

async fn project_files(
    State(kernel): Shared,
    Path(id): Path<String>,
    Query(query): QueryText,
) -> Answer {
    let limit = wanted(&query, "limit")
        .and_then(|limit| limit.parse().ok())
        .filter(|limit| *limit != 0)
        .unwrap_or(200);
    ok(kernel
        .project_files(&id, wanted(&query, "q").unwrap_or(""), limit)
        .await?)
}

/// The project folder a request's `projectId` names, which must be one the user has allowed.
fn folder_of(
    kernel: &Kernel,
    project: Option<&str>,
) -> Result<Option<std::path::PathBuf>, Failure> {
    Ok(project.map(|id| kernel.workdir(id)).transpose()?)
}

async fn skills(State(kernel): Shared, Query(query): QueryText) -> Answer {
    let root = folder_of(&kernel, wanted(&query, "projectId"))?;
    let listed = list_skills(
        root.as_deref(),
        &kernel.store.root().join("skills"),
        &kernel.enabled_plugin_folders(),
    )
    .await;
    ok(listed.iter().map(skill_json).collect::<Vec<_>>())
}

async fn skill(State(kernel): Shared, Path(name): Path<String>, Query(query): QueryText) -> Answer {
    let root = folder_of(&kernel, wanted(&query, "projectId"))?;
    let loaded = load_skill(
        root.as_deref(),
        &kernel.store.root().join("skills"),
        &kernel.enabled_plugin_folders(),
        &name,
    )
    .await;
    ok(loaded.ok_or_else(|| CoreError::new(404, "No such skill"))?)
}

async fn commands(State(kernel): Shared, Query(query): QueryText) -> Answer {
    let root = folder_of(&kernel, wanted(&query, "projectId"))?;
    ok(list_commands(
        root.as_deref(),
        &kernel.store.root().join("commands"),
        &kernel.enabled_plugin_folders(),
    )
    .await)
}

async fn expand(State(kernel): Shared, Path(name): Path<String>, body: Body) -> Answer {
    let body = body_of(body);
    let root = folder_of(&kernel, given(&body, "projectId"))?;
    let expanded = expand_command(
        root.as_deref(),
        &kernel.store.root().join("commands"),
        &kernel.enabled_plugin_folders(),
        &name,
        &js::text(body.get("arguments")),
    )
    .await;
    ok(expanded.ok_or_else(|| CoreError::new(404, "No such command"))?)
}

/// The active project's folder, or the agents' own workspace.
async fn active_root(kernel: &Kernel) -> Result<std::path::PathBuf, Failure> {
    let root = match kernel.active_project().await {
        Ok(project)
            if project
                .get("path")
                .and_then(Value::as_str)
                .is_some_and(|path| !path.is_empty()) =>
        {
            std::path::PathBuf::from(project["path"].as_str().unwrap_or(""))
        }
        _ => kernel.store.root().join("workspace"),
    };
    tokio::fs::create_dir_all(&root)
        .await
        .map_err(CoreError::from)?;
    Ok(root)
}

async fn workspace_info(State(kernel): Shared) -> Answer {
    let root = active_root(&kernel).await?;
    let shell = std::env::var("SHELL")
        .unwrap_or_else(|_| if cfg!(windows) { "cmd.exe" } else { "/bin/zsh" }.to_owned());
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "user".to_owned());
    let host = std::env::var("HOSTNAME")
        .ok()
        .filter(|name| !name.is_empty())
        .or_else(|| {
            let output = std::process::Command::new("hostname").output().ok()?;
            Some(String::from_utf8_lossy(&output.stdout).trim().to_owned())
        });
    let host = host.unwrap_or_default();
    ok(
        json!({ "cwd": root.to_string_lossy(), "shell": shell, "user": user, "hostname": host.strip_suffix(".local").unwrap_or(&host) }),
    )
}

/// Splits the working folder the wrapped command printed from its output.
fn extract_cwd(output: &str, fallback: &str) -> (String, String) {
    let Some(index) = output.rfind(CWD_MARKER) else {
        return (output.to_owned(), fallback.to_owned());
    };
    let before = &output[..index];
    let before = before
        .strip_suffix('\n')
        .map_or(before, |text| text.strip_suffix('\r').unwrap_or(text));
    let after = output[index + CWD_MARKER.len()..]
        .lines()
        .next()
        .map_or("", js::trim);
    (
        before.to_owned(),
        if after.is_empty() { fallback } else { after }.to_owned(),
    )
}

/// A command from the app's own terminal panel, which the user typed.
async fn workspace_terminal(State(kernel): Shared, body: Body) -> Answer {
    let root = active_root(&kernel).await?;
    let body = body_of(body);
    let command = js::trim(given(&body, "command").unwrap_or(""));
    let asked = js::trim(given(&body, "cwd").unwrap_or(""));
    let cwd = if !asked.is_empty()
        && tokio::fs::metadata(asked)
            .await
            .is_ok_and(|info| info.is_dir())
    {
        std::path::PathBuf::from(asked)
    } else {
        root
    };
    let shown = cwd.to_string_lossy().into_owned();
    if command.is_empty() {
        return ok(json!({ "stdout": "", "stderr": "", "exitCode": 0, "cwd": shown }));
    }
    // A panel that names itself keeps its shell's environment, functions and aliases from one command to the next.
    let session = given(&body, "session")
        .and_then(terminal_sessions::session_id)
        .filter(|_| !cfg!(windows))
        .map(str::to_owned);
    let kept = session.as_deref().and_then(terminal_sessions::state_of);
    let markers = terminal_sessions::Markers::new();
    let prelude = kept
        .as_ref()
        .filter(|state| !state.definitions.trim().is_empty())
        .map(|state| state.definitions.clone());
    let wrapped = if cfg!(windows) {
        format!("{command} & echo {CWD_MARKER}%CD%")
    } else {
        // The snapshot comes before the kept definitions, so those count as set by the panel and are kept again.
        let mut before = String::new();
        if session.is_some() {
            before.push_str(terminal_sessions::SNAPSHOT);
            before.push('\n');
        }
        if prelude.is_some() {
            before.push_str(terminal_sessions::PRELUDE);
            before.push('\n');
        }
        let after = if session.is_some() {
            format!("{}\n", terminal_sessions::trailer(&markers))
        } else {
            String::new()
        };
        format!(
            "{before}{command}\n__saturn_ec=$?\nprintf \"\\n{CWD_MARKER}%s\\n\" \"$(pwd)\"\n{after}exit $__saturn_ec"
        )
    };
    let env = process_env();
    let shell = env.get(std::ffi::OsStr::new("SHELL")).map_or_else(
        || "/bin/zsh".to_owned(),
        |shell| shell.to_string_lossy().into_owned(),
    );
    let invocation = shell_invocation(&wrapped, &shell, Platform::current(), &env);
    let fresh = kept.is_none();
    let mut variables: Vec<_> = match kept {
        Some(state) => state.environment,
        None => env.into_iter().collect(),
    };
    if fresh {
        variables.push(("TERM".into(), "xterm-256color".into()));
    }
    if fresh && !cfg!(windows) {
        for item in &mut variables {
            if item.0 == "PATH" {
                item.1 = format!(
                    "{}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
                    item.1.to_string_lossy()
                )
                .into();
            }
        }
    }
    // Only the program name is recorded; arguments may carry secrets.
    let span = Span::start(
        "workspace.exec",
        Kind::Internal,
        json!({
            "process.executable.name": shell.rsplit(['/', '\\']).next().unwrap_or_default(),
            "saturn.command.name": command.split_whitespace().next().unwrap_or_default(),
        }),
    );
    let result = span
        .scope(run_captured(
            &invocation,
            &cwd,
            &variables,
            prelude.as_deref().unwrap_or_default().as_bytes(),
            Duration::from_secs(30),
            512 * 1024,
        ))
        .await;
    let output = match (
        session.as_deref(),
        terminal_sessions::split_state(&result.stdout, &markers),
    ) {
        (Some(session), Some((before, state))) => {
            terminal_sessions::keep(session, state);
            before
        }
        _ => result.stdout.as_str(),
    };
    let (stdout, final_cwd) = extract_cwd(output, &shown);
    let code = result.code.unwrap_or(1);
    span.set("process.exit.code", code);
    if code != 0 {
        span.set("error.type", "nonzero_exit");
    }
    saturn_telemetry::add(
        "saturn.workspace.commands",
        1.0,
        json!({ "saturn.command.outcome": if code == 0 { "ok" } else { "failed" } }),
    );
    let stderr = if code != 0 && result.stderr.is_empty() {
        "Command failed".to_owned()
    } else {
        result.stderr
    };
    ok(json!({ "stdout": stdout, "stderr": stderr, "exitCode": code, "cwd": final_cwd }))
}

async fn open_terminal(State(kernel): Shared, body: Body) -> Answer {
    let root = active_root(&kernel).await?;
    let body = body_of(body);
    let asked = js::trim(given(&body, "cwd").unwrap_or(""));
    // Absolute, so a folder cannot be read as one of the program's options.
    let cwd = if asked.is_empty() {
        root
    } else {
        std::path::absolute(asked).map_err(CoreError::from)?
    };
    launch_terminal(&cwd);
    ok(json!({ "opened": true, "cwd": cwd.to_string_lossy() }))
}

/// What the user typed in the address bar as a URL: a link as it is, a bare name with a scheme, anything else a search.
fn normalize_url(input: &str) -> String {
    let trimmed = js::trim(input);
    if trimmed.is_empty() {
        return "https://example.com".to_owned();
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return trimmed.to_owned();
    }
    let host = trimmed.split('/').next().unwrap_or("");
    let bare = host.split(':').next().unwrap_or("");
    if matches!(
        bare.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1"
    ) && host
        .split(':')
        .nth(1)
        .is_none_or(|port| !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return format!("http://{trimmed}");
    }
    let label = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    };
    if host.contains('.') && host.split('.').all(label) {
        return format!("https://{trimmed}");
    }
    let mut search = url::Url::parse("https://duckduckgo.com/").expect("this address is valid");
    search.query_pairs_mut().append_pair("q", trimmed);
    search.to_string()
}

fn escape_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

async fn open_browser(body: Body) -> Answer {
    let body = body_of(body);
    let url = normalize_url(given(&body, "url").unwrap_or("https://www.google.com"));
    if cfg!(target_os = "macos") {
        launch_app("the browser", "open", &[&url], None);
    } else if cfg!(windows) {
        launch_app("the browser", "cmd.exe", &["/c", "start", "", &url], None);
    } else {
        launch_app("the browser", "xdg-open", &[&url], None);
    }
    ok(json!({ "opened": true, "url": url }))
}

/// One page for the in-app browser. Redirects are followed by hand, so every hop gets the public-address check (at most four).
async fn proxied_page(target: &str) -> Result<(String, String), String> {
    let mut current = parse_public_address(target)?;
    let headers = [
        (
            "user-agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        ),
        (
            "accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ),
    ];
    let mut hop = 0;
    let response = loop {
        let response = fetch_public(&current, &headers, Arc::new(SystemLookup)).await?;
        let location = response
            .status()
            .is_redirection()
            .then(|| {
                response
                    .headers()
                    .get("location")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned)
            })
            .flatten();
        let Some(location) = location else {
            break response;
        };
        if hop == 4 {
            return Err("Too many redirects".to_owned());
        }
        hop += 1;
        let next = current.join(&location).map_err(|error| error.to_string())?;
        current = parse_public_address(next.as_str())?;
    };
    let final_url = current.to_string();
    let kind = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("text/html; charset=utf-8")
        .to_owned();
    let base = format!(
        "<base href=\"{}\">{BROWSER_NAVIGATION_SCRIPT}",
        escape_attribute(&final_url)
    );
    let page = if kind.contains("html") {
        let body = response
            .text()
            .await
            .map_err(|error| error.without_url().to_string())?;
        let head = regex::Regex::new("(?i)<head[^>]*>").expect("this pattern is valid");
        match head.find(&body) {
            Some(found) => format!("{}{base}{}", &body[..found.end()], &body[found.end()..]),
            None => format!("{base}{body}"),
        }
    } else if kind.starts_with("image/") {
        format!(
            "<!doctype html><html><head>{base}</head><body style=\"margin:0;display:grid;place-items:center;min-height:100vh;background:#111\"><img src=\"{}\" style=\"max-width:100%\"></body></html>",
            escape_attribute(&final_url)
        )
    } else {
        let body = response
            .text()
            .await
            .map_err(|error| error.without_url().to_string())?;
        format!(
            "<!doctype html><html><head><meta charset=\"utf-8\">{base}</head><body style=\"margin:0\"><pre style=\"white-space:pre-wrap;word-break:break-word;padding:16px;font:13px ui-monospace,monospace\">{}</pre></body></html>",
            escape_attribute(js::prefix(&body, 2_000_000))
        )
    };
    Ok((final_url, page))
}

/// The in-app browser's page loader. Public addresses only, like the agents' web tool: this runs as the user, and a page shown
/// here could otherwise read anything on localhost or the private network, the runtime included.
async fn browser_proxy(Query(query): QueryText) -> Response {
    let target = normalize_url(wanted(&query, "url").unwrap_or("https://example.com"));
    let html: HeaderName = CONTENT_TYPE;
    let loading = tokio::time::timeout(Duration::from_secs(12), proxied_page(&target));
    match loading
        .await
        .unwrap_or_else(|_| Err("The page took too long to load".to_owned()))
    {
        Ok((url, page)) => (
            [
                (html, "text/html; charset=utf-8".to_owned()),
                (HeaderName::from_static("x-saturn-url"), url),
            ],
            page,
        )
            .into_response(),
        Err(message) => {
            saturn_core::log(
                "workspace",
                "warning",
                &format!("Browser preview could not load a page: {message}"),
            );
            let page = format!(
                "<!doctype html><html><head><meta charset=\"utf-8\"><style>body{{font-family:-apple-system,sans-serif;background:#111318;color:#e5e7eb;padding:32px;line-height:1.5}}code{{background:#1f2430;padding:2px 6px;border-radius:4px;color:#93c5fd}}</style></head><body><h3>Could not load page</h3><p><code>{}</code></p><p>{}</p></body></html>",
                escape_attribute(&target),
                escape_attribute(&message)
            );
            ([(html, "text/html; charset=utf-8")], page).into_response()
        }
    }
}

/// A file or folder in the active project for the file view. A symbolic link counts as where it points: a cloned repository can
/// bring one that leads out of the folder.
async fn workspace_files(State(kernel): Shared, Query(query): QueryText) -> Answer {
    let root = active_root(&kernel).await?;
    let asked = js::trim(wanted(&query, "path").unwrap_or(""));
    let workspace = saturn_domain::skills::workspace::Workspace::new(&root);
    let target = match saturn_tools::file::inside_workspace(
        &workspace,
        if asked.is_empty() { "." } else { asked },
    )
    .await
    {
        Ok(target) => target,
        Err(_) => {
            saturn_core::log(
                "workspace",
                "warning",
                "Refused a file path outside the workspace",
            );
            workspace.root().to_path_buf()
        }
    };
    let base = workspace.root().to_path_buf();
    let shown = |path: &std::path::Path| {
        path.strip_prefix(&base)
            .map_or(String::new(), |item| item.to_string_lossy().into_owned())
    };
    let info = tokio::fs::metadata(&target)
        .await
        .map_err(CoreError::from)?;
    if info.is_dir() {
        let mut entries = tokio::fs::read_dir(&target)
            .await
            .map_err(CoreError::from)?;
        let mut items = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let folder = entry.file_type().await.is_ok_and(|kind| kind.is_dir());
            items.push(json!({ "name": name, "path": shown(&target.join(&name)), "kind": if folder { "directory" } else { "file" } }));
        }
        let place = shown(&target);
        return ok(
            json!({ "kind": "directory", "path": if place.is_empty() { ".".to_owned() } else { place }, "entries": items }),
        );
    }
    let content = tokio::fs::read(&target).await.map_err(CoreError::from)?;
    let content = String::from_utf8_lossy(&content);
    ok(json!({ "kind": "file", "path": shown(&target), "content": js::prefix(&content, 100_000) }))
}

async fn automations(State(kernel): Shared) -> Answer {
    ok(kernel.list_automations())
}

async fn create_automation(State(kernel): Shared, body: Body) -> Answer {
    created(kernel.create_automation(&body_of(body)).await?)
}

async fn update_automation(State(kernel): Shared, Path(id): Path<String>, body: Body) -> Answer {
    ok(kernel.update_automation(&id, &body_of(body)).await?)
}

async fn delete_automation(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    kernel.delete_automation(&id).await?;
    no_content()
}

async fn run_automation(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    ok(kernel.run_automation(&id).await?)
}

async fn draft_automation(State(kernel): Shared, body: Body) -> Answer {
    ok(kernel.draft_automation(&body_of(body)).await?)
}

async fn groups(State(kernel): Shared) -> Answer {
    ok(kernel.list_groups())
}

async fn create_group(State(kernel): Shared, body: Body) -> Answer {
    created(kernel.create_group(&body_of(body)).await?)
}

async fn update_group(State(kernel): Shared, Path(id): Path<String>, body: Body) -> Answer {
    ok(kernel.update_group(&id, &body_of(body)).await?)
}

async fn delete_group(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    kernel.delete_group(&id).await?;
    no_content()
}

async fn group_messages(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    ok(kernel.group_transcript(&id)?)
}

async fn post_group_message(State(kernel): Shared, Path(id): Path<String>, body: Body) -> Answer {
    created(
        kernel
            .post_group_message(&id, &js::text(body_of(body).get("text")))
            .await?,
    )
}

async fn plugins(State(kernel): Shared) -> Answer {
    ok(kernel.list_plugins().await)
}

async fn install_plugin(State(kernel): Shared, body: Body) -> Answer {
    created(
        kernel
            .install_plugin(&js::text(body_of(body).get("source")))
            .await?,
    )
}

async fn change_plugin(State(kernel): Shared, Path(name): Path<String>, body: Body) -> Answer {
    let enabled = body_of(body).get("enabled") != Some(&Value::Bool(false));
    ok(kernel.set_plugin_enabled(&name, enabled).await?)
}

async fn approve_plugin_hooks(
    State(kernel): Shared,
    Path(name): Path<String>,
    body: Body,
) -> Answer {
    ok(kernel
        .approve_plugin_hooks(&name, &js::text(body_of(body).get("fingerprint")))
        .await?)
}

async fn uninstall_plugin(State(kernel): Shared, Path(name): Path<String>) -> Answer {
    kernel.uninstall_plugin(&name).await?;
    no_content()
}

async fn complete(State(kernel): Shared, body: Body) -> Answer {
    ok(kernel.complete_for_editor(&body_of(body)).await?)
}

/// Tab as a stream: one JSON line per piece of text, the last with done: true (or an error line). A client that leaves stops it.
async fn complete_stream(State(kernel): Shared, body: Body) -> Response {
    let mut input = body_of(body);
    input["kind"] = "inline".into();
    let (sender, receiver) =
        tokio::sync::mpsc::channel::<Result<String, std::convert::Infallible>>(16);
    tokio::spawn(async move {
        let line = |value: Value| Ok(format!("{value}\n"));
        let mut stream = match kernel.complete_inline_stream(&input).await {
            Ok(stream) => stream,
            Err(error) => {
                let _ = sender
                    .send(line(
                        json!({ "error": error.message, "status": error.status }),
                    ))
                    .await;
                return;
            }
        };
        loop {
            let piece = tokio::select! {
                () = sender.closed() => return,
                piece = stream.next() => piece,
            };
            match piece {
                Ok(Some(piece)) => {
                    if sender.send(line(piece)).await.is_err() {
                        return;
                    }
                }
                Ok(None) => return,
                Err(error) => {
                    let _ = sender
                        .send(line(
                            json!({ "error": error.message, "status": error.status }),
                        ))
                        .await;
                    return;
                }
            }
        }
    });
    let body = axum::body::Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(receiver));
    (
        [
            (CONTENT_TYPE, "application/x-ndjson"),
            (axum::http::header::CACHE_CONTROL, "no-cache"),
        ],
        body,
    )
        .into_response()
}

/// Whether this computer lets Saturn control it, and so whether Settings asks for anything.
async fn computer_permissions(State(kernel): Shared) -> Answer {
    ok(kernel.computer.permission_status().await)
}

/// The `saturn` command: whether its launcher is installed (and current).
async fn cli_status() -> Answer {
    ok(saturn_core::cli_install::cli_status().await?)
}

/// Installs it in ~/.local/bin.
async fn install_cli() -> Answer {
    ok(saturn_core::cli_install::install_cli().await?)
}

/// Every HTTP(S) request the runtime has sent since it started: by host, and the latest ones (no queries, no bodies).
async fn network_view(Query(query): QueryText) -> Answer {
    let asked = query
        .get("limit")
        .and_then(|limit| limit.parse::<usize>().ok())
        .filter(|limit| *limit > 0);
    ok(network::view(asked.unwrap_or(200).min(500)))
}

async fn telemetry_status() -> Answer {
    ok(saturn_telemetry::status())
}

async fn telemetry_traces() -> Answer {
    ok(saturn_telemetry::summaries())
}

async fn telemetry_trace(Path(id): Path<String>) -> Answer {
    ok(saturn_telemetry::trace(&id)
        .ok_or_else(|| CoreError::new(404, "Trace is no longer in memory"))?)
}

async fn telemetry_metrics() -> Answer {
    ok(saturn_telemetry::metric_view())
}

async fn telemetry_logs(Query(query): QueryText) -> Answer {
    let least = query
        .get("minSeverity")
        .and_then(|least| least.parse::<f64>().ok())
        .filter(|least| *least != 0.0);
    ok(saturn_telemetry::logs(
        query.get("traceId").map(String::as_str),
        least,
    ))
}

/// Saves telemetry.json now and sends it as ?format=saturn (the file itself), otlp (OTLP/JSON lines) or siem (ECS NDJSON).
async fn telemetry_export(Query(query): QueryText) -> Answer {
    let format = match query.get("format").map(String::as_str) {
        Some("otlp") => "otlp",
        Some("siem") => "siem",
        _ => "saturn",
    };
    let document = saturn_telemetry::save()
        .await
        .map_err(|error| CoreError::new(500, error.to_string()))?;
    let (extension, kind) = formats::details(format);
    let saved = document["savedAt"].as_str().unwrap_or_default();
    let stamp = js::prefix(saved, 19).replace([':', 'T'], "-");
    let name = if format == "saturn" {
        "saturn-telemetry".to_owned()
    } else {
        format!("saturn-telemetry-{format}")
    };
    Ok((
        [
            (
                axum::http::header::CONTENT_TYPE,
                format!("{kind}; charset=utf-8"),
            ),
            (
                axum::http::header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{name}-{stamp}.{extension}\""),
            ),
        ],
        formats::render(&document, format),
    )
        .into_response())
}

async fn telemetry_clear() -> Answer {
    saturn_telemetry::clear()
        .await
        .map_err(|error| CoreError::new(500, error.to_string()))?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn open_permission_pane(body: Body) -> Answer {
    let body = body_of(body);
    let pane = match given(&body, "which") {
        Some("accessibility") => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
        Some("screenRecording") => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        }
        _ => {
            return Err(
                CoreError::new(400, "which must be accessibility or screenRecording").into(),
            );
        }
    };
    if !cfg!(target_os = "macos") {
        return Err(CoreError::new(409, "Only macOS asks for these permissions").into());
    }
    launch_app("System Settings", "open", &[pane], None);
    ok(json!({ "ok": true }))
}

/// Settings, connections, projects, usage and the workspace views.
/// Claude Code and Codex: whether each is installed (and where from), and downloading Saturn's tested copy.
async fn programs(State(kernel): Shared) -> Answer {
    ok(kernel.program_statuses().await)
}

async fn program(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    ok(kernel.program_status(program_id(&id)?).await)
}

async fn install_program(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    let status = kernel.install_program(program_id(&id)?).await?;
    Ok((StatusCode::ACCEPTED, axum::Json(status)).into_response())
}

async fn remove_program(State(kernel): Shared, Path(id): Path<String>) -> Answer {
    ok(kernel.remove_program(program_id(&id)?).await?)
}

async fn claude_status(State(kernel): Shared) -> Answer {
    ok(kernel.claude_status().await?)
}

async fn claude_logout(State(kernel): Shared) -> Answer {
    ok(kernel.claude_logout().await?)
}

async fn codex_status(State(kernel): Shared) -> Answer {
    ok(kernel.codex_status().await?)
}

/// Starts the official `codex login`: mode "device" (a one-time code, no local redirect) or "browser".
async fn codex_sign_in(State(kernel): Shared, body: Body) -> Answer {
    let browser = body_of(body).get("mode").and_then(Value::as_str) == Some("browser");
    ok(kernel.start_codex_sign_in(browser).await?)
}

/// Opens the page Codex printed for this sign-in in the default browser (never a URL from the request).
async fn codex_sign_in_open(State(kernel): Shared) -> Answer {
    ok(kernel.open_codex_sign_in()?)
}

async fn codex_sign_in_cancel(State(kernel): Shared) -> Answer {
    kernel.cancel_codex_sign_in();
    ok(kernel.codex_status().await?)
}

async fn codex_logout(State(kernel): Shared) -> Answer {
    ok(kernel.codex_logout().await?)
}

/// Saturn's skills as a stateless MCP server for Codex, which only reaches MCP servers out of process. The bearer token picks the
/// turn; it stops working when the turn ends.
async fn agent_mcp(
    State(kernel): Shared,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let message: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    match kernel.answer_agent_mcp(token, &message).await {
        None => (
            StatusCode::UNAUTHORIZED,
            axum::Json(json!({ "error": "Unauthorized" })),
        )
            .into_response(),
        Some(Some(answer)) => axum::Json(answer).into_response(),
        // A notification has nothing to answer.
        Some(None) => StatusCode::ACCEPTED.into_response(),
    }
}

/// Stateless: no session stream to open or close.
async fn agent_mcp_other() -> Response {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        [(axum::http::header::ALLOW, "POST")],
        axum::Json(json!({ "error": "Method not allowed" })),
    )
        .into_response()
}

pub fn router(kernel: Arc<Kernel>) -> Router {
    Router::new()
        .route("/programs", get(programs))
        .route("/programs/{id}", get(program).delete(remove_program))
        .route("/programs/{id}/install", post(install_program))
        .route("/claude-code/status", get(claude_status))
        .route("/claude-code/logout", post(claude_logout))
        .route("/codex/status", get(codex_status))
        .route(
            "/codex/sign-in",
            post(codex_sign_in).delete(codex_sign_in_cancel),
        )
        .route("/codex/sign-in/open", post(codex_sign_in_open))
        .route("/codex/logout", post(codex_logout))
        .route("/agent-mcp", post(agent_mcp).fallback(agent_mcp_other))
        .route("/settings", get(settings).patch(update_settings))
        .route("/information", get(information))
        .route("/logs", get(logs))
        .route(
            "/storage/snapshots",
            get(snapshots).delete(delete_snapshots),
        )
        .route("/storage/snapshots/{id}", delete(delete_snapshot))
        .route("/memory/{scope}", get(read_memory).put(write_memory))
        .route("/usage", get(usage))
        .route("/usage/summary", get(usage_summary))
        .route("/llm/providers", get(providers))
        .route("/llm/providers/{provider}/models", get(provider_models))
        .route("/llm/lmstudio/models", get(local_server))
        .route("/connections/{kind}", get(list_connections))
        .route("/connections/{kind}/{id}", delete(delete_connection))
        .route(
            "/connections/models/{id}",
            patch(update_model).delete(delete_model),
        )
        .route("/connections/mcp", get(list_mcp).post(create_mcp))
        .route(
            "/connections/mcp/{id}",
            patch(update_mcp).delete(delete_mcp_connection),
        )
        .route("/connections/mcp/{id}/approve", post(approve_mcp))
        .route("/connections/mcp/{id}/discover", post(discover_mcp))
        .route("/mcp/{id}", delete(delete_mcp))
        .route("/connections/rag", get(list_rag).post(create_rag))
        .route(
            "/connections/rag/{id}",
            patch(update_rag).delete(delete_rag),
        )
        .route("/hooks", get(hook_sets).put(set_hooks))
        .route("/projects/active", get(active_project))
        .route(
            "/projects/{id}",
            patch(update_project).delete(delete_project),
        )
        .route("/projects/{id}/active", post(set_active))
        .route("/projects/{id}/access", post(project_access))
        .route("/projects/{id}/terminal", post(project_terminal))
        .route("/projects/{id}/folder", post(project_folder))
        .route("/projects/{id}/rules", get(project_rules).put(save_rules))
        .route("/projects/{id}/context", post(project_context))
        .route("/projects/{id}/files", get(project_files))
        .route(
            "/projects/{id}/hooks/approve",
            post(approve_hooks).delete(revoke_hooks),
        )
        .route(
            "/projects/{id}/permissions/approve",
            post(approve_rules).delete(revoke_rules),
        )
        .route("/skills", get(skills))
        .route("/skills/{name}", get(skill))
        .route("/commands", get(commands))
        .route("/commands/{name}/expand", post(expand))
        .route("/workspace/info", get(workspace_info))
        .route("/workspace/terminal", post(workspace_terminal))
        .route("/workspace/terminal/open", post(open_terminal))
        .route("/workspace/files", get(workspace_files))
        .route("/workspace/browser/open", post(open_browser))
        .route("/workspace/browser/proxy", get(browser_proxy))
        .route("/cli", get(cli_status))
        .route("/cli/install", post(install_cli))
        .route("/network", get(network_view))
        .route("/telemetry", delete(telemetry_clear))
        .route("/telemetry/status", get(telemetry_status))
        .route("/telemetry/traces", get(telemetry_traces))
        .route("/telemetry/traces/{id}", get(telemetry_trace))
        .route("/telemetry/metrics", get(telemetry_metrics))
        .route("/telemetry/logs", get(telemetry_logs))
        .route("/telemetry/export", get(telemetry_export))
        .route("/computer/permissions", get(computer_permissions))
        .route("/computer/permissions/open", post(open_permission_pane))
        .route("/automations", get(automations).post(create_automation))
        .route("/automations/draft", post(draft_automation))
        .route(
            "/automations/{id}",
            patch(update_automation).delete(delete_automation),
        )
        .route("/automations/{id}/run", post(run_automation))
        .route("/groups", get(groups).post(create_group))
        .route("/groups/{id}", patch(update_group).delete(delete_group))
        .route(
            "/groups/{id}/messages",
            get(group_messages).post(post_group_message),
        )
        .route("/plugins", get(plugins).post(install_plugin))
        .route(
            "/plugins/{name}",
            patch(change_plugin).delete(uninstall_plugin),
        )
        .route("/plugins/{name}/hooks/approve", post(approve_plugin_hooks))
        .route("/complete", post(complete))
        .route("/complete/stream", post(complete_stream))
        .with_state(kernel)
}
