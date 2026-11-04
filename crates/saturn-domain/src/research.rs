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
        "counterexamples" => Some("counterexample"),
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
        "counterexamples" => {
            needs("runId")?;
            needs("sampleId")
        }
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

/// What an evaluation must state before two runs can be compared. A chat template may be stated as none.
const EVALUATION_FIELDS: [&str; 7] = [
    "dataset",
    "split",
    "sampleSet",
    "scorer",
    "promptFormat",
    "chatTemplate",
    "generation",
];

/// The hashes of a version's inputs of one role, by path.
fn input_hashes(version: &Value, role: &str) -> Vec<(String, String)> {
    let mut hashes: Vec<(String, String)> = version
        .get("inputs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|input| input.get("role").and_then(Value::as_str) == Some(role))
        .map(|input| {
            let field = |key: &str| {
                input
                    .get(key)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned()
            };
            (field("path"), field("sha256"))
        })
        .collect();
    hashes.sort();
    hashes
}

/// Whether two versions measured the same way: `comparable`, `not_comparable` with what differs, or `unknown` with
/// what is missing. Training data is not part of it, since pretraining, SFT and DPO are meant to differ.
pub fn compare_versions(left: &Value, right: &Value) -> Value {
    let evaluation = |version: &Value| version.get("evaluation").cloned().unwrap_or(Value::Null);
    let (left_spec, right_spec) = (evaluation(left), evaluation(right));
    let mut missing = Vec::new();
    let mut differs = Vec::new();
    for field in EVALUATION_FIELDS {
        let stated = |spec: &Value| match spec.get(field) {
            Some(Value::Null) => field == "chatTemplate",
            Some(_) => true,
            None => false,
        };
        if !stated(&left_spec) || !stated(&right_spec) {
            missing.push(field.to_owned());
        } else if canonical(&left_spec[field]) != canonical(&right_spec[field]) {
            differs.push(field.to_owned());
        }
    }
    // The same names on changed files is not the same evaluation.
    for role in ["data", "scorer"] {
        if input_hashes(left, role) != input_hashes(right, role) {
            differs.push(format!("{role} files"));
        }
    }
    let result = if !differs.is_empty() {
        "not_comparable"
    } else if !missing.is_empty() {
        "unknown"
    } else {
        "comparable"
    };
    json!({ "result": result, "differs": differs, "missing": missing })
}

/// Whether making `parent` the parent of `child` would make a model its own ancestor, given each model's parent.
pub fn makes_cycle(child: &str, parent: &str, parent_of: impl Fn(&str) -> Option<String>) -> bool {
    let mut current = Some(parent.to_owned());
    let mut steps = 0;
    while let Some(id) = current {
        if id == child || steps > 10_000 {
            return true;
        }
        current = parent_of(&id);
        steps += 1;
    }
    false
}

/// What the policy says about an agent writing a file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyVerdict {
    Allowed,
    NeedsApproval,
    Manual,
    Locked,
    Records,
}

/// Whether a path is at or under a policy's key, which is a file, or a folder.
fn is_under(path: &str, key: &str) -> bool {
    let key = key.trim_end_matches('/');
    path == key
        || path
            .strip_prefix(key)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Checks a requested policy's shape.
pub fn check_policy(policy: &Value) -> Result<(), String> {
    if let Some(modes) = policy.get("modes") {
        let modes = modes
            .as_object()
            .ok_or("\"modes\" must map paths to modes.")?;
        if modes
            .values()
            .any(|mode| !matches!(mode.as_str(), Some("manual" | "pair" | "delegate")))
        {
            return Err("A mode must be manual, pair or delegate.".to_owned());
        }
    }
    if let Some(locked) = policy.get("locked")
        && !locked
            .as_array()
            .is_some_and(|paths| paths.iter().all(Value::is_string))
    {
        return Err("\"locked\" must list paths.".to_owned());
    }
    Ok(())
}

/// What the policy says about an agent writing a path. The records and locks always hold; among modes, the most specific
/// key wins, and a file no key names is the agent's to change.
pub fn policy_verdict(policy: &Value, locked: &[String], path: &str) -> PolicyVerdict {
    if is_under(path, ".saturn/research") {
        return PolicyVerdict::Records;
    }
    if locked.iter().any(|key| is_under(path, key)) {
        return PolicyVerdict::Locked;
    }
    let mode = policy
        .get("modes")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(key, _)| is_under(path, key))
        .max_by_key(|(key, _)| key.len())
        .and_then(|(_, mode)| mode.as_str());
    match mode {
        Some("manual") => PolicyVerdict::Manual,
        Some("pair") => PolicyVerdict::NeedsApproval,
        _ => PolicyVerdict::Allowed,
    }
}

/// The longest line a samples file may have.
pub const MAX_SAMPLE_LINE: u64 = 64 * 1024 * 1024;

/// A sample line's identity within a run, or why the line breaks JSONL version 1.
pub fn sample_identity(line: &Value) -> Result<String, String> {
    let fields = line.as_object().ok_or("A sample must be a JSON object.")?;
    if fields.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("\"schemaVersion\" must be 1.".to_owned());
    }
    let sample = fields
        .get("sampleId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or("\"sampleId\" is required.")?;
    let trial = match fields.get("trial") {
        None => 0,
        Some(value) => value.as_u64().ok_or("\"trial\" must be a whole number.")?,
    };
    let model = match fields.get("modelId") {
        None | Some(Value::Null) => "",
        Some(value) => value.as_str().ok_or("\"modelId\" must be text.")?,
    };
    match fields.get("scores") {
        None | Some(Value::Null) => {}
        Some(Value::Object(scores)) => {
            if scores
                .values()
                .any(|score| !(score.is_number() || score.is_string() || score.is_boolean()))
            {
                return Err("Each score must be a number, text or true or false.".to_owned());
            }
        }
        Some(_) => return Err("\"scores\" must be an object.".to_owned()),
    }
    match fields.get("error") {
        None | Some(Value::Null) => {}
        Some(error) => {
            let kind = error.get("kind").and_then(Value::as_str);
            if !matches!(kind, Some("infrastructure" | "model" | "scorer")) {
                return Err(
                    "An error's \"kind\" must be infrastructure, model or scorer.".to_owned(),
                );
            }
        }
    }
    Ok(serde_json::to_string(&(sample, trial, model)).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evaluation() -> Value {
        json!({"dataset": "ioi", "split": "test", "sampleSet": "all", "scorer": "logit", "promptFormat": "continuation", "chatTemplate": null, "generation": {"top_k": 1}})
    }

    #[test]
    fn versions_compare_only_through_how_they_were_evaluated() {
        let base = json!({"evaluation": evaluation(), "trainingData": "pile"});
        let tuned = json!({"evaluation": evaluation(), "trainingData": "qa"});
        assert_eq!(compare_versions(&base, &tuned)["result"], "comparable");

        let mut templated = evaluation();
        templated["chatTemplate"] = json!("chatml");
        let answer = compare_versions(&base, &json!({"evaluation": templated}));
        assert_eq!(answer["result"], "not_comparable");
        assert_eq!(answer["differs"], json!(["chatTemplate"]));

        let mut partial = evaluation();
        partial.as_object_mut().unwrap().remove("split");
        let answer = compare_versions(&base, &json!({"evaluation": partial}));
        assert_eq!(answer["result"], "unknown");
        assert_eq!(answer["missing"], json!(["split"]));
    }

    #[test]
    fn a_stated_name_on_changed_files_is_not_the_same_evaluation() {
        let with_data = |hash: &str| json!({"evaluation": evaluation(), "inputs": [{"role": "data", "path": "set", "sha256": hash}]});
        assert_eq!(
            compare_versions(&with_data("a"), &with_data("a"))["result"],
            "comparable"
        );
        let answer = compare_versions(&with_data("a"), &with_data("b"));
        assert_eq!(answer["differs"], json!(["data files"]));
    }

    #[test]
    fn a_model_cannot_become_its_own_ancestor() {
        let parent_of = |id: &str| match id {
            "b" => Some("a".to_owned()),
            "c" => Some("b".to_owned()),
            _ => None,
        };
        assert!(makes_cycle("a", "c", parent_of));
        assert!(makes_cycle("a", "a", parent_of));
        assert!(!makes_cycle("d", "c", parent_of));
    }

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
    fn the_most_specific_mode_wins_and_locks_and_records_always_hold() {
        let policy =
            json!({"modes": {"src": "manual", "src/data.py": "delegate", "pair.py": "pair"}});
        let locks = ["set.jsonl".to_owned()];
        assert_eq!(
            policy_verdict(&policy, &locks, "src/probe.py"),
            PolicyVerdict::Manual
        );
        assert_eq!(
            policy_verdict(&policy, &locks, "src/data.py"),
            PolicyVerdict::Allowed
        );
        assert_eq!(
            policy_verdict(&policy, &locks, "srcs/other.py"),
            PolicyVerdict::Allowed
        );
        assert_eq!(
            policy_verdict(&policy, &locks, "pair.py"),
            PolicyVerdict::NeedsApproval
        );
        assert_eq!(
            policy_verdict(&policy, &locks, "set.jsonl"),
            PolicyVerdict::Locked
        );
        assert_eq!(
            policy_verdict(&policy, &locks, ".saturn/research/hypotheses/h.json"),
            PolicyVerdict::Records
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
