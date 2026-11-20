//! Reading JSON that JavaScript wrote.
use std::borrow::Cow;

use serde::de::DeserializeOwned;

/// Values nested deeper than this are clipped when reading a saved file. The code that later copies, writes and frees a value
/// recurses, so a deeper one (tool arguments are whatever a model sent) could overflow the stack and end the whole runtime.
pub const MAX_DEPTH: usize = 100;

/// Parses JSON that `JSON.parse` accepts, half of a surrogate pair included. Depth stays limited: see `clip_deep_values`.
pub fn parse<T: DeserializeOwned>(text: &str) -> serde_json::Result<T> {
    serde_json::from_str(&repair_lone_surrogates(text))
}

/// Replaces each array or object nested deeper than `MAX_DEPTH` with `null`. Walks the text without recursing, so it is safe
/// on any input, and leaves text it cannot make sense of for the parser to refuse.
pub fn clip_deep_values(text: &str) -> Cow<'_, str> {
    let mut clipped: Option<String> = None;
    let mut copied = 0;
    let mut depth = 0;
    let mut clipped_from = None;
    let mut in_string = false;
    let mut escaped = false;
    for (index, byte) in text.bytes().enumerate() {
        if in_string {
            match byte {
                _ if escaped => escaped = false,
                b'\\' => escaped = true,
                b'"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'[' | b'{' => {
                if depth == MAX_DEPTH && clipped_from.is_none() {
                    clipped_from = Some(index);
                }
                depth += 1;
            }
            b']' | b'}' => {
                depth = depth.saturating_sub(1);
                if depth == MAX_DEPTH
                    && let Some(start) = clipped_from.take()
                {
                    let output = clipped.get_or_insert_with(|| String::with_capacity(text.len()));
                    output.push_str(&text[copied..start]);
                    output.push_str("null");
                    copied = index + 1;
                }
            }
            _ => {}
        }
    }
    match clipped {
        Some(mut output) => {
            output.push_str(&text[copied..]);
            Cow::Owned(output)
        }
        None => Cow::Borrowed(text),
    }
}

/// `JSON.stringify` writes half of a surrogate pair as an escape, which a JavaScript string gets from clipping text in the
/// middle of an emoji. Rust strings cannot hold one, so each becomes U+FFFD and the rest of the file stays readable.
pub fn repair_lone_surrogates(text: &str) -> Cow<'_, str> {
    if !text.contains("\\u") {
        return Cow::Borrowed(text);
    }
    let bytes = text.as_bytes();
    let mut repaired: Option<String> = None;
    let mut copied = 0;
    let mut index = 0;
    while index + 1 < bytes.len() {
        if bytes[index] != b'\\' {
            index += 1;
            continue;
        }
        // Every escape is walked whole, so the second backslash of `\\` never starts one.
        if bytes[index + 1] != b'u' {
            index += 2;
            continue;
        }
        let Some(unit) = escape_at(bytes, index) else {
            index += 2;
            continue;
        };
        let next = index + 6;
        let paired = (0xD800..0xDC00).contains(&unit)
            && escape_at(bytes, next).is_some_and(|low| (0xDC00..0xE000).contains(&low));
        if paired {
            index = next + 6;
        } else if (0xD800..0xE000).contains(&unit) {
            let output = repaired.get_or_insert_with(|| String::with_capacity(text.len()));
            output.push_str(&text[copied..index]);
            output.push_str("\\ufffd");
            copied = next;
            index = next;
        } else {
            index = next;
        }
    }
    match repaired {
        Some(mut output) => {
            output.push_str(&text[copied..]);
            Cow::Owned(output)
        }
        None => Cow::Borrowed(text),
    }
}

/// The UTF-16 unit of a `\uXXXX` escape starting at `index`.
fn escape_at(bytes: &[u8], index: usize) -> Option<u32> {
    let escape = bytes.get(index..index + 6)?;
    if &escape[..2] != b"\\u" {
        return None;
    }
    escape[2..].iter().try_fold(0, |unit, &byte| {
        Some(unit * 16 + (byte as char).to_digit(16)?)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn read(text: &str) -> Value {
        parse(text).unwrap_or_else(|error| panic!("{text}: {error}"))
    }

    #[test]
    fn half_a_surrogate_pair_becomes_a_replacement_character() {
        assert_eq!(read(r#""a\ud83d""#), json!("a\u{fffd}"));
        assert_eq!(read(r#""\ud83db""#), json!("\u{fffd}b"));
        assert_eq!(read(r#""\uDE00""#), json!("\u{fffd}"));
        assert_eq!(read(r#""\ud83d\n\ud83d""#), json!("\u{fffd}\n\u{fffd}"));
        assert_eq!(read(r#""\ud83d😀""#), json!("\u{fffd}😀"));
    }

    #[test]
    fn everything_else_is_left_as_it_was() {
        assert_eq!(read(r#""😀""#), json!("😀"));
        assert_eq!(read(r#""\\ud83d""#), json!("\\ud83d"));
        assert_eq!(read(r#""\\\\ud83d""#), json!("\\\\ud83d"));
        assert_eq!(read(r#""Aé""#), json!("Aé"));
        let plain = r#"{"a":"A\\n"}"#;
        assert!(matches!(repair_lone_surrogates(plain), Cow::Borrowed(_)));
    }

    #[test]
    fn what_json_refuses_is_still_refused() {
        assert!(parse::<Value>("{").is_err());
        assert!(parse::<Value>("[] trailing").is_err());
        assert!(parse::<Value>(r#""\u12""#).is_err());
    }

    /// Arrays nested `depth` deep around a value.
    fn nested(depth: usize, inner: &str) -> String {
        format!("{}{inner}{}", "[".repeat(depth), "]".repeat(depth))
    }

    #[test]
    fn values_nested_too_deep_are_clipped_and_the_rest_is_kept() {
        let deep = nested(1_000_000, "");
        let text = format!(r#"{{"kept":1,"deep":{deep},"after":"]["}}"#);
        let value: Value = parse(&clip_deep_values(&text)).expect("it parses");
        assert_eq!(value["kept"], 1);
        assert_eq!(value["after"], "][");
        let mut level = &value["deep"];
        let mut found = 1;
        while let Some(inner) = level.get(0) {
            level = inner;
            found += 1;
        }
        assert_eq!(
            found, MAX_DEPTH,
            "the object is one level, and the clipped value takes the last"
        );
        assert!(level.is_null());
    }

    #[test]
    fn values_within_the_limit_are_left_alone() {
        let text = nested(MAX_DEPTH, r#""[[[ { \" ""#);
        assert!(matches!(clip_deep_values(&text), Cow::Borrowed(_)));
        assert!(parse::<Value>(&text).is_ok());
    }

    #[test]
    fn broken_text_is_still_refused_after_clipping() {
        for text in ["{", "]]]", &"[".repeat(MAX_DEPTH + 5), "\"[["] {
            assert!(parse::<Value>(&clip_deep_values(text)).is_err(), "{text}");
        }
    }
}
