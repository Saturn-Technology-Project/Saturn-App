use std::sync::Arc;

use axum::Json;
use axum::extract::{Request, State};
use axum::http::header::{self, HeaderMap, HeaderValue};
use axum::http::{Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::auth::token_matches;

/// Open to callers without the token: the health probe, and the OAuth redirect the provider's browser lands on.
const OPEN_PATHS: [&str; 2] = ["/health", "/oauth/callback"];
const AGENT_SKILLS_PATH: &str = "/agent-mcp";

/// The only cross-origin callers are Saturn's own windows, which load from a loopback origin. A sandboxed iframe or a
/// `data:` or `file:` document sends the literal "null", which is never echoed back.
pub fn allowed_origin(origin: &str) -> bool {
    let Some((scheme, rest)) = origin.split_once("://") else {
        return false;
    };
    if scheme != "http" && scheme != "https" {
        return false;
    }
    let authority = rest.split('/').next().unwrap_or_default();
    // URL userinfo would make "http://127.0.0.1@evil.example" look like loopback.
    if authority.contains('@') {
        return false;
    }
    let host = authority_host(authority).to_ascii_lowercase();
    host == "127.0.0.1" || host == "localhost"
}

/// The Host must be loopback, so a page using a name that resolves to 127.0.0.1 (DNS rebinding) cannot reach us.
pub fn loopback_host(host: &str) -> bool {
    let host = authority_host(host).to_ascii_lowercase();
    host == "127.0.0.1" || host == "localhost" || host == "[::1]"
}

/// The host of `host:port`, keeping the brackets of an IPv6 address.
fn authority_host(authority: &str) -> &str {
    if authority.starts_with('[') {
        return authority
            .split_once(']')
            .map_or(authority, |(host, _)| &authority[..=host.len()]);
    }
    authority.split(':').next().unwrap_or_default()
}

/// Sets the cross-origin headers on every answer and answers preflight requests itself.
pub async fn cors(request: Request, next: Next) -> Response {
    let origin = request.headers().get(header::ORIGIN).cloned();
    let mut response = if request.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    if let Some(origin) = origin.filter(|origin| origin.to_str().is_ok_and(allowed_origin)) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET,POST,PUT,PATCH,DELETE,OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("content-type, authorization, traceparent, tracestate, baggage"),
    );
    // Lets the desktop read the file name the runtime suggests for downloads, and where a proxied page ended up.
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Content-Disposition, X-Saturn-Url"),
    );
    response
}

/// Loopback is not a trust boundary: any local process or web page can reach 127.0.0.1. So every request needs a
/// loopback Host and, except on the open paths, the session token.
pub async fn authenticate(State(token): State<Arc<str>>, request: Request, next: Next) -> Response {
    if !host_allowed(request.headers()) {
        return refuse(StatusCode::FORBIDDEN, "Forbidden");
    }
    let path = request.uri().path();
    if OPEN_PATHS.contains(&path) || path == AGENT_SKILLS_PATH {
        return next.run(request).await;
    }
    let provided = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if !token_matches(&token, provided) {
        return refuse(StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    next.run(request).await
}

fn host_allowed(headers: &HeaderMap) -> bool {
    match headers.get(header::HOST) {
        None => true,
        Some(host) => host.to_str().is_ok_and(loopback_host),
    }
}

fn refuse(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins() {
        for origin in [
            "http://127.0.0.1:5174",
            "http://localhost",
            "https://LOCALHOST:1",
        ] {
            assert!(allowed_origin(origin), "{origin}");
        }
        for origin in [
            "null",
            "file://",
            "https://evil.example",
            "http://127.0.0.1.evil.example",
            "http://127.0.0.1@evil.example",
            "ftp://localhost",
        ] {
            assert!(!allowed_origin(origin), "{origin}");
        }
    }

    #[test]
    fn hosts() {
        for host in [
            "127.0.0.1",
            "127.0.0.1:4700",
            "localhost:1",
            "[::1]",
            "[::1]:4700",
        ] {
            assert!(loopback_host(host), "{host}");
        }
        for host in [
            "rebind.example",
            "127.0.0.1.rebind.example:4700",
            "[::2]:4700",
        ] {
            assert!(!loopback_host(host), "{host}");
        }
    }
}
