//! The `web` tool: the readable text of a public page.
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use regex::{Regex, RegexBuilder};
use saturn_domain::Arguments;
use saturn_domain::js;
use saturn_domain::skills::public_address::parse_public_address;
use serde_json::json;
use url::Url;

use crate::public_host::{Lookup, SystemLookup, fetch_public};
use crate::{ToolResult, clip, text};

/// Redirects followed, counting the first request.
const HOPS: usize = 4;
/// How long a whole fetch may take. A stopped run ends it sooner.
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
/// Bytes of a page read, after decompression: far more than the model is shown, and a compressed bomb stops here.
const PAGE_LIMIT: usize = 8 * 1024 * 1024;

/// The `web` tool.
#[derive(Clone)]
pub struct WebSkill {
    lookup: Arc<dyn Lookup>,
}

impl Default for WebSkill {
    fn default() -> Self {
        Self::new(Arc::new(SystemLookup))
    }
}

impl WebSkill {
    /// The tool, with the name lookup its connections use.
    pub fn new(lookup: Arc<dyn Lookup>) -> Self {
        Self { lookup }
    }

    /// Runs one `web` call.
    pub async fn run(&self, arguments: &Arguments) -> ToolResult {
        let start = parse_public_address(&text(arguments, "url"))?;
        tokio::time::timeout(FETCH_TIMEOUT, self.fetch(start))
            .await
            .unwrap_or_else(|_| Err("The page took too long to answer".to_owned()))
    }

    async fn fetch(&self, start: Url) -> ToolResult {
        let mut current = start;
        let mut status = 0;
        let mut body = String::new();
        for _ in 0..HOPS {
            let response = fetch_public(&current, &[], Arc::clone(&self.lookup)).await?;
            status = response.status().as_u16();
            if (300..400).contains(&status) {
                let location = response
                    .headers()
                    .get("location")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned);
                let Some(location) = location else { break };
                let next = current
                    .join(&location)
                    .map_err(|_| "URL is invalid".to_owned())?;
                current = parse_public_address(next.as_str())?;
                continue;
            }
            body = page_body(response).await?;
            break;
        }
        let (title, readable) = page_text(&body);
        let clipped = clip(&readable);
        Ok(json!({
            "url": current.as_str(),
            "status": status,
            "title": title,
            "text": clipped,
            "body": clipped,
        }))
    }
}

/// The page's text, up to PAGE_LIMIT.
async fn page_body(mut response: reqwest::Response) -> Result<String, String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| error.without_url().to_string())?
    {
        bytes.extend_from_slice(&chunk);
        if bytes.len() >= PAGE_LIMIT {
            bytes.truncate(PAGE_LIMIT);
            break;
        }
    }
    let content = String::from_utf8_lossy(&bytes);
    Ok(content
        .strip_prefix('\u{feff}')
        .unwrap_or(&content)
        .to_owned())
}

fn pattern(text: &str) -> Regex {
    RegexBuilder::new(text)
        .case_insensitive(true)
        .size_limit(1 << 24)
        .build()
        .expect("the pattern is valid")
}

// `(?-u:\b)` is a word boundary by ASCII letters, as in JavaScript.
static TITLE: LazyLock<Regex> = LazyLock::new(|| pattern(r"<title[^>]*>((?s:.)*?)</title>"));
static SCRIPT: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"<script(?-u:\b)(?s:.)*?</script(?-u:\b)[^>]*>"));
static STYLE: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"<style(?-u:\b)(?s:.)*?</style(?-u:\b)[^>]*>"));
static TAG: LazyLock<Regex> = LazyLock::new(|| pattern(r"<[^>]+>"));
static ENTITY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"&(?:nbsp|amp|lt|gt|quot|#39);").expect("the pattern is valid"));

/// One pass, so "&amp;lt;" becomes the text "&lt;" and is not decoded a second time.
fn decode(value: &str) -> String {
    ENTITY
        .replace_all(value, |found: &regex::Captures<'_>| match &found[0] {
            "&nbsp;" => " ",
            "&amp;" => "&",
            "&lt;" => "<",
            "&gt;" => ">",
            "&quot;" => "\"",
            _ => "'",
        })
        .into_owned()
}

/// The text with each run of white space as one space, and none at the ends.
fn squeezed(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut pending = false;
    for character in value.chars() {
        if js::is_space(character) {
            pending = true;
        } else {
            if pending && !result.is_empty() {
                result.push(' ');
            }
            pending = false;
            result.push(character);
        }
    }
    result
}

/// The readable title and text of an HTML page, for the model; nothing here is shown as HTML.
pub fn page_text(html: &str) -> (String, String) {
    let title = TITLE
        .captures(html)
        .and_then(|found| found.get(1))
        .map_or("", |found| found.as_str());
    let without_scripts = SCRIPT.replace_all(html, " ");
    let without_styles = STYLE.replace_all(&without_scripts, " ");
    let without_tags = TAG.replace_all(&without_styles, " ");
    (squeezed(&decode(title)), squeezed(&decode(&without_tags)))
}
