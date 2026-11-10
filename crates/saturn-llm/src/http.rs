//! Sending a request to a provider: its failures, and when one is worth trying again.
use std::time::Duration;

use reqwest::header::{CONTENT_TYPE, RETRY_AFTER};
use reqwest::redirect::Policy;
use reqwest::{Client, RequestBuilder, Response, StatusCode};
use saturn_domain::time::{days_from_civil, now_millis};
use saturn_store::json;
use saturn_telemetry::network::{SendNoted, client_builder};
use serde_json::Value;

/// How long one request may take: a long answer from a slow model, as the providers' own SDKs allow.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
/// More attempts after the first, and how long a provider's Retry-After is believed.
const RETRIES: u32 = 2;
const MAX_RETRY_AFTER: Duration = Duration::from_secs(30);

/// A failed call. Its message may quote the provider's answer, and never holds a key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LlmError {
    /// The HTTP status, when the provider answered.
    pub status: Option<u16>,
    pub message: String,
    /// Whether trying again may help.
    pub transient: bool,
    /// How long the provider asked to wait.
    pub retry_after: Option<Duration>,
}

impl LlmError {
    /// A failure with nothing to retry.
    pub fn new(status: Option<u16>, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            transient: false,
            retry_after: None,
        }
    }

    fn from_transport(error: &reqwest::Error) -> Self {
        // A request that never got an answer. The address is left out, since a custom endpoint may hold anything.
        let message = format!("could not reach the model: {}", without_address(error));
        Self {
            status: None,
            message,
            transient: error.is_connect()
                || error.is_timeout()
                || error.is_request()
                || error.is_body(),
            retry_after: None,
        }
    }
}

impl std::fmt::Display for LlmError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for LlmError {}

fn without_address(error: &reqwest::Error) -> String {
    let mut text = error.to_string();
    if let Some(url) = error.url() {
        text = text.replace(url.as_str(), "the endpoint");
    }
    text
}

/// A status worth trying again, as the providers' SDKs decide it (Anthropic answers 529 when overloaded).
fn transient_status(status: u16) -> bool {
    matches!(status, 408 | 409 | 429) || status >= 500
}

/// The wait a Retry-After value asks for, in seconds or as an HTTP date.
pub fn retry_after(value: &str, now: i64) -> Option<Duration> {
    let value = value.trim();
    if let Ok(seconds) = value.parse::<f64>() {
        return (seconds.is_finite() && seconds >= 0.0).then(|| Duration::from_secs_f64(seconds));
    }
    let until = http_date_millis(value)?;
    Some(Duration::from_millis(
        until.saturating_sub(now).max(0) as u64
    ))
}

/// An HTTP date like `Wed, 21 Oct 2026 08:00:10 GMT`, in milliseconds since 1970.
fn http_date_millis(value: &str) -> Option<i64> {
    let mut parts = value.split_whitespace().skip(1);
    let day: u32 = parts.next()?.parse().ok()?;
    let month = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .iter()
    .position(|name| Some(*name) == parts.clone().next())? as u32
        + 1;
    let year: i64 = parts.nth(1)?.parse().ok()?;
    let mut clock = parts.next()?.split(':').map(str::parse::<i64>);
    let (hours, minutes, seconds) = (
        clock.next()?.ok()?,
        clock.next()?.ok()?,
        clock.next()?.ok()?,
    );
    Some(
        (days_from_civil(year, month, day) * 86_400 + hours * 3600 + minutes * 60 + seconds) * 1000,
    )
}

/// The connection to providers, shared by every call.
#[derive(Clone)]
pub struct Http {
    client: Client,
    retry_delay: Duration,
}

impl Http {
    pub fn new() -> Result<Self, LlmError> {
        Self::with_retry_delay(Duration::from_secs(1))
    }

    /// Waits this long before the first retry and three times as long before the second (tests shorten it).
    pub fn with_retry_delay(retry_delay: Duration) -> Result<Self, LlmError> {
        let client = client_builder()
            // A key sent in a provider's own header would follow a redirect to another host, so none is followed.
            .redirect(Policy::none())
            // Like the SDKs: local servers must not go through a proxy the environment names.
            .no_proxy()
            .build()
            .map_err(|error| {
                LlmError::new(None, format!("could not start the HTTP client: {error}"))
            })?;
        Ok(Self {
            client,
            retry_delay,
        })
    }

    /// Posts JSON and reads a JSON answer, trying again when the failure is transient. Dropping the future stops it.
    pub async fn post_json(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        body: &Value,
    ) -> Result<Value, LlmError> {
        let bytes = serde_json::to_vec(body).map_err(|error| {
            LlmError::new(None, format!("could not write the request: {error}"))
        })?;
        let mut attempt = 0;
        loop {
            let request = self.post(url, headers, &bytes).timeout(REQUEST_TIMEOUT);
            let error = match Self::answer(request).await {
                Ok(value) => return Ok(value),
                Err(error) => error,
            };
            if attempt >= RETRIES || !error.transient {
                return Err(error);
            }
            let wait = error
                .retry_after
                .map_or(self.retry_delay * 3u32.pow(attempt), |asked| {
                    asked.min(MAX_RETRY_AFTER)
                });
            eprintln!(
                "[llm] {} failed ({error}); retrying ({}/{RETRIES})",
                endpoint_name(url),
                attempt + 1
            );
            tokio::time::sleep(wait).await;
            attempt += 1;
        }
    }

    fn post(&self, url: &str, headers: &[(&str, &str)], body: &[u8]) -> RequestBuilder {
        let mut request = self
            .client
            .post(url)
            .header(CONTENT_TYPE, "application/json")
            .body(body.to_vec());
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        request
    }

    /// One attempt.
    async fn answer(request: RequestBuilder) -> Result<Value, LlmError> {
        let response = request
            .send_noted()
            .await
            .map_err(|error| LlmError::from_transport(&error))?;
        let response = Self::successful(response).await?;
        let text = response
            .text()
            .await
            .map_err(|error| LlmError::from_transport(&error))?;
        parse_reply(&text)
    }

    /// The response, or the error its status means.
    async fn successful(response: Response) -> Result<Response, LlmError> {
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        Err(Self::refusal(status, response).await)
    }

    async fn refusal(status: StatusCode, response: Response) -> LlmError {
        let header = |name| {
            response
                .headers()
                .get(name)
                .and_then(|value: &reqwest::header::HeaderValue| value.to_str().ok())
                .map(str::to_owned)
        };
        let asked = header(RETRY_AFTER).and_then(|value| retry_after(&value, now_millis()));
        let should_retry = header(reqwest::header::HeaderName::from_static("x-should-retry"));
        let text = response.text().await.unwrap_or_default();
        let clipped: String = text.chars().take(2000).collect();
        LlmError {
            status: Some(status.as_u16()),
            message: format!("{} {clipped}", status.as_u16())
                .trim_end()
                .to_owned(),
            transient: match should_retry.as_deref() {
                Some("true") => true,
                Some("false") => false,
                _ => transient_status(status.as_u16()),
            },
            retry_after: asked,
        }
    }

    /// Reads a JSON answer from a local address, or `None` for any failure.
    pub async fn get_json(&self, url: &str, timeout: Duration) -> Result<Option<Value>, LlmError> {
        let response = self
            .client
            .get(url)
            .timeout(timeout)
            .send_noted()
            .await
            .map_err(|error| LlmError::from_transport(&error))?;
        if !response.status().is_success() {
            return Ok(None);
        }
        let text = response
            .text()
            .await
            .map_err(|error| LlmError::from_transport(&error))?;
        Ok(parse_reply(&text).ok())
    }

    /// Reads a provider's JSON with the headers its key goes in. A refusal keeps only its status, since some providers
    /// quote part of the key back in the body.
    pub async fn get_json_with(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        timeout: Duration,
    ) -> Result<Value, LlmError> {
        let mut request = self.client.get(url).timeout(timeout);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = request
            .send_noted()
            .await
            .map_err(|error| LlmError::from_transport(&error))?;
        let status = response.status();
        if !status.is_success() {
            return Err(LlmError::new(
                Some(status.as_u16()),
                status.as_u16().to_string(),
            ));
        }
        let text = response
            .text()
            .await
            .map_err(|error| LlmError::from_transport(&error))?;
        parse_reply(&text)
    }
}

/// A provider's JSON, which may hold what JavaScript and Python write but Rust's parser refuses, or nesting that deep.
pub(crate) fn parse_reply(text: &str) -> Result<Value, LlmError> {
    json::parse(&json::clip_deep_values(text)).map_err(|error| {
        LlmError::new(
            None,
            format!("the model's answer is not valid JSON: {error}"),
        )
    })
}

/// A URL's host for the log, since the rest may hold anything.
fn endpoint_name(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_owned))
        .unwrap_or_else(|| "the model".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_after_is_read_in_seconds_or_as_a_date() {
        assert_eq!(retry_after("2", 0), Some(Duration::from_secs(2)));
        assert_eq!(retry_after("0.2", 0), Some(Duration::from_millis(200)));
        let now = http_date_millis("Wed, 21 Oct 2026 08:00:00 GMT").expect("a date");
        assert_eq!(
            retry_after("Wed, 21 Oct 2026 08:00:10 GMT", now),
            Some(Duration::from_secs(10))
        );
        assert_eq!(
            retry_after("Wed, 21 Oct 2026 07:00:00 GMT", now),
            Some(Duration::ZERO)
        );
        assert_eq!(retry_after("soon", now), None);
        assert_eq!(retry_after("-1", now), None);
        assert_eq!(now, 1_792_569_600_000);
    }

    #[test]
    fn the_providers_transient_statuses() {
        for status in [408, 409, 429, 500, 502, 503, 504, 529] {
            assert!(transient_status(status), "{status}");
        }
        for status in [400, 401, 403, 404, 422] {
            assert!(!transient_status(status), "{status}");
        }
    }
}
