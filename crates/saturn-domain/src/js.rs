//! How JavaScript reads the values a tool call holds, for the places the TypeScript runtime coerces a model's arguments.
use serde_json::Value;

/// Whether JavaScript's `trim` and `\s` count this character as white space.
pub fn is_space(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000d}'
            | ' '
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// The text with JavaScript's `trim`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// The text with JavaScript's `trimEnd`.
pub fn trim_end(text: &str) -> &str {
    text.trim_end_matches(is_space)
}

/// JavaScript's `length`: UTF-16 code units, which is what the limits on text are counted in.
pub fn length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The start of the text, at most `units` long. A character the limit would cut in half is left out.
pub fn prefix(text: &str, units: usize) -> &str {
    let mut used = 0;
    for (index, character) in text.char_indices() {
        used += character.len_utf16();
        if used > units {
            return &text[..index];
        }
    }
    text
}

/// A number as JavaScript prints it.
fn number_text(number: &serde_json::Number) -> String {
    if number.is_i64() || number.is_u64() {
        return number.to_string();
    }
    let value = number.as_f64().unwrap_or(f64::NAN);
    let size = value.abs();
    if size != 0.0 && !(1e-6..1e21).contains(&size) {
        let written = format!("{value:e}");
        return match written.split_once('e') {
            Some((digits, power)) if !power.starts_with('-') => format!("{digits}e+{power}"),
            _ => written,
        };
    }
    format!("{value}")
}

/// `String(value)` for a value inside an array, where null reads as nothing.
fn string_of(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_text(number),
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(string_of).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// A value as text: a string as it is, nothing for a missing value or null, otherwise `String(value)`.
pub fn text(value: Option<&Value>) -> String {
    value.map(string_of).unwrap_or_default()
}

/// Whether JavaScript counts the value as true, for arguments read with `a || b`.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|value| value != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `Number(text)`.
fn number_of(raw: &str) -> f64 {
    let text = trim(raw);
    if text.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        let lower = text.get(..2).map(str::to_ascii_lowercase);
        if lower.as_deref() == Some(prefix) {
            let digits = &text[2..];
            if digits.is_empty() || !digits.chars().all(|digit| digit.is_digit(radix)) {
                return f64::NAN;
            }
            let base = f64::from(radix);
            return digits
                .chars()
                .filter_map(|digit| digit.to_digit(radix))
                .fold(0.0, |total, digit| total * base + f64::from(digit));
        }
    }
    if matches!(text, "Infinity" | "+Infinity" | "-Infinity") {
        return f64::INFINITY;
    }
    // Rust also reads "inf" and "nan"; JavaScript does not.
    if !text
        .chars()
        .all(|character| character.is_ascii_digit() || "+-.eE".contains(character))
    {
        return f64::NAN;
    }
    text.parse().unwrap_or(f64::NAN)
}

/// A whole number from a value the way the tools read one, or `fallback` when it holds none.
#[allow(clippy::cast_possible_truncation)]
pub fn integer(value: Option<&Value>, fallback: i64) -> i64 {
    let number = match value {
        None | Some(Value::Object(_)) => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(other) => number_of(&string_of(other)),
    };
    // A cast out of range stops at the largest whole number, which every caller then limits.
    if number.is_finite() {
        number.trunc() as i64
    } else {
        fallback
    }
}
