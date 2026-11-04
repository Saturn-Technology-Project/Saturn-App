//! Research records' rules, with no I/O: which kinds exist, what each must hold, and what makes two versions the same.
//! `docs/research-contract.md` is the contract.
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

/// The version of the record format this runtime writes.
pub const SCHEMA_VERSION: u64 = 1;

/// The verdicts a hypothesis can have. A run's status never changes it.
const VERDICTS: [&str; 4] = ["undecided", "supported", "refuted", "inconclusive"];
/// What a finding can be.
const FINDING_KINDS: [&str; 3] = ["observation", "ai_suggestion", "conclusion"];
/// Fields only the runtime sets.
const RUNTIME_FIELDS: [&str; 7] = [
    "id",
    "revision",
    "schemaVersion",
    "createdAt",
    "updatedAt",
    "floating",
    "expectedRevision",
];

/// The start of a record's id in a collection, or nothing for a collection that does not exist.
pub fn id_prefix(collection: &str) -> Option<&'static str> {
    match collection {
        "questions" => Some("question"),
        "hypotheses" => Some("hypothesis"),
        "experiments" => Some("experiment"),
        "findings" => Some("finding"),
        "models" => Some("model"),
        "versions" => Some("version"),
        _ => None,
    }
}

/// Whether requests can create and change a collection's records; frozen versions they cannot.
pub fn writable(collection: &str) -> bool {
    id_prefix(collection).is_some() && collection != "versions"
}

/// Whether a text can be a record's id, and so a file's name: no separators, no dots.
pub fn is_id(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 64
        && text
            .chars()
            .all(|letter| letter.is_ascii_alphanumeric() || letter == '_')
}

/// Why a saved record cannot be used, if it cannot.
pub fn unusable(record: &Value) -> Option<String> {
    if !record.is_object() {
        return Some("It is not a record.".to_owned());
    }
    match record.get("schemaVersion").and_then(Value::as_u64) {
        None => Some("It has no schema version.".to_owned()),
        Some(version) if version > SCHEMA_VERSION => Some(format!(
            "It was written by a newer Saturn (format {version})."
        )),
        Some(_) => None,
    }
}

/// A new record from a request, or why not.
pub fn new_record(collection: &str, input: &Value, id: &str, now: &str) -> Result<Value, String> {
    let mut fields = requested_fields(input);
    fields.insert("schemaVersion".to_owned(), json!(SCHEMA_VERSION));
    fields.insert("id".to_owned(), json!(id));
    fields.insert("revision".to_owned(), json!(1));
    fields.insert("createdAt".to_owned(), json!(now));
    fields.insert("updatedAt".to_owned(), json!(now));
    if collection == "hypotheses" && !fields.contains_key("verdict") {
        fields.insert("verdict".to_owned(), json!("undecided"));
    }
    finished(collection, fields)
}

/// A record with a request's changes applied, its revision moved on, or why not.
pub fn changed_record(
    collection: &str,
    record: &Value,
    changes: &Value,
    now: &str,
) -> Result<Value, String> {
    let mut fields = record.as_object().cloned().unwrap_or_default();
    fields.extend(requested_fields(changes));
    let revision = record.get("revision").and_then(Value::as_u64).unwrap_or(0);
    fields.insert("revision".to_owned(), json!(revision + 1));
    fields.insert("updatedAt".to_owned(), json!(now));
    finished(collection, fields)
}

/// A request's fields without those only the runtime sets.
fn requested_fields(input: &Value) -> Map<String, Value> {
    let mut fields = input.as_object().cloned().unwrap_or_default();
    fields.retain(|key, _| !RUNTIME_FIELDS.contains(&key.as_str()));
    fields
}

/// Fills in what follows from a record's fields, and checks them.
fn finished(collection: &str, mut fields: Map<String, Value>) -> Result<Value, String> {
    if collection == "models" {
        let pinned = has_text(&fields, "weightsRevision");
        fields.insert("floating".to_owned(), json!(!pinned));
    }
    check(collection, &fields)?;
    Ok(Value::Object(fields))
}

fn has_text(fields: &Map<String, Value>, key: &str) -> bool {
    fields
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|text| !text.trim().is_empty())
}

/// What a kind of record must hold.
fn check(collection: &str, fields: &Map<String, Value>) -> Result<(), String> {
    let needs = |key: &str| {
        if has_text(fields, key) {
            Ok(())
        } else {
            Err(format!("A record here needs a \"{key}\"."))
        }
    };
    let one_of = |key: &str, allowed: &[&str]| {
        let value = fields.get(key).and_then(Value::as_str).unwrap_or("");
        if allowed.contains(&value) {
            Ok(())
        } else {
            Err(format!("\"{key}\" must be one of {}.", allowed.join(", ")))
        }
    };
    match collection {
        "questions" | "experiments" => needs("title"),
        "hypotheses" => {
            needs("title")?;
            one_of("verdict", &VERDICTS)
        }
        "findings" => {
            needs("text")?;
            one_of("kind", &FINDING_KINDS)
        }
        "models" => needs("source"),
        _ => Ok(()),
    }
}

/// A value's bytes with its object keys in order, so the same content always hashes the same.
fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(fields) => {
            let mut keys: Vec<&String> = fields.keys().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), canonical(&fields[key])))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

/// The SHA-256 of some bytes, as hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// Bytes as lowercase hex.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// What identifies a frozen version's content: equal for the same content whatever order its keys came in.
pub fn fingerprint(content: &Value) -> String {
    sha256_hex(canonical(content).to_string().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_content_has_the_same_fingerprint_in_any_key_order() {
        assert_eq!(
            fingerprint(&json!({"a": 1, "b": {"c": 2, "d": [1, 2]}})),
            fingerprint(&json!({"b": {"d": [1, 2], "c": 2}, "a": 1}))
        );
        assert_ne!(
            fingerprint(&json!({"b": {"d": [1, 2]}})),
            fingerprint(&json!({"b": {"d": [2, 1]}}))
        );
    }

    #[test]
    fn ids_cannot_be_paths() {
        assert!(is_id("question_0123abcd"));
        for bad in ["", "..", "a/b", "a\\b", "a.json", "a b"] {
            assert!(!is_id(bad), "{bad}");
        }
    }

    #[test]
    fn a_request_cannot_set_what_the_runtime_sets() {
        let record = new_record(
            "questions",
            &json!({"title": "x", "id": "mine", "revision": 9}),
            "question_1",
            "now",
        )
        .unwrap();
        assert_eq!(record["id"], "question_1");
        assert_eq!(record["revision"], 1);
    }
}
