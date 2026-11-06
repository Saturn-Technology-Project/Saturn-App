//! Research records' rules, with no I/O: which kinds exist, what each must hold, and what makes two versions the same.
//! `docs/research-contract.md` is the contract.
use serde_json::{Map, Value, json};
pub mod comparison;
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
        "counterexample_sets" => Some("counterexample_set"),
        "inspection_sessions" => Some("inspection"),
        "artifacts" => Some("artifact"),
        "versions" => Some("version"),
        _ => None,
    }
}

/// Whether requests can create and change a collection's records; frozen versions they cannot.
pub fn writable(collection: &str) -> bool {
    id_prefix(collection).is_some()
        && !matches!(collection, "versions" | "inspection_sessions" | "artifacts")
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

/// Whether a revision names one fixed set of weights: a full git commit (40 hex digits) or a content hash (64). A
/// branch or tag such as `main` or `latest`, or an abbreviated commit, can come to mean other weights.
pub fn revision_pins(revision: &str) -> bool {
    let revision = revision.trim();
    matches!(revision.len(), 40 | 64) && revision.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// What kind of revision this is: `commit`, `hash`, `name` (it can move) or `none`.
pub fn revision_kind(revision: &str) -> &'static str {
    let revision = revision.trim();
    if revision.is_empty() {
        "none"
    } else if revision_pins(revision) {
        if revision.len() == 40 {
            "commit"
        } else {
            "hash"
        }
    } else {
        "name"
    }
}

/// Fills in what follows from a record's fields, and checks them.
fn finished(collection: &str, mut fields: Map<String, Value>) -> Result<Value, String> {
    if collection == "models" {
        let pinned = fields
            .get("weightsRevision")
            .and_then(Value::as_str)
            .is_some_and(revision_pins);
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
        "questions" => needs("title"),
        "experiments" => {
            needs("title")?;
            if fields.contains_key("kind") {
                one_of("kind", &["evaluation", "training"])?;
            }
            check_sandbox(fields)?;
            if let Some(aliases) = fields.get("labelAliases") {
                let valid = aliases.as_object().is_some_and(|aliases| {
                    aliases.iter().all(|(name, target)| {
                        !name.trim().is_empty()
                            && target
                                .as_str()
                                .is_some_and(|target| !target.trim().is_empty())
                    })
                });
                if !valid {
                    return Err(
                        "labelAliases maps each label to a non-empty scorer word.".to_owned()
                    );
                }
            }
            Ok(())
        }
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

/// Whether a name can be an environment variable a run is given: letters, digits and underscores, not starting with a
/// digit, and not one of Saturn's own.
pub fn is_variable_name(name: &str) -> bool {
    let mut characters = name.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
        && !name.starts_with("SATURN_")
}

/// An experiment's sandbox and the variables it passes on, if it says: `sandbox` holds only the switches `isolated`
/// and `network`, and `envNames` only variable names.
fn check_sandbox(fields: &Map<String, Value>) -> Result<(), String> {
    if let Some(sandbox) = fields.get("sandbox") {
        let valid = sandbox.as_object().is_some_and(|sandbox| {
            sandbox.iter().all(|(key, value)| {
                matches!(key.as_str(), "isolated" | "network") && value.is_boolean()
            })
        });
        if !valid {
            return Err(
                "sandbox holds only \"isolated\" and \"network\", each true or false.".to_owned(),
            );
        }
    }
    if let Some(names) = fields.get("envNames") {
        let valid = names.as_array().is_some_and(|names| {
            names
                .iter()
                .all(|name| name.as_str().is_some_and(is_variable_name))
        });
        if !valid {
            return Err("envNames lists environment variable names, such as HF_TOKEN; Saturn's own SATURN_ variables are set for every run.".to_owned());
        }
    }
    Ok(())
}

/// Whether an agent's change to an experiment loosens its sandbox: turning it off, letting the program use the
/// network, or passing it a variable it did not get before. Those are the person's to decide.
pub fn loosens_sandbox(current: &Value, fields: &Value) -> Option<&'static str> {
    let now = |key: &str| current["sandbox"][key].as_bool().unwrap_or(true);
    let asked = &fields["sandbox"];
    if asked["isolated"] == false && now("isolated") {
        return Some("turn the sandbox off");
    }
    if asked["network"] == true && !now("network") {
        return Some("let the program use the network");
    }
    let before: Vec<&str> = current["envNames"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let added = fields["envNames"].as_array().is_some_and(|names| {
        names
            .iter()
            .filter_map(Value::as_str)
            .any(|name| !before.contains(&name))
    });
    added.then_some("pass the program another environment variable")
}

/// Compares a person's label with the scorer's word, using only explicit aliases, whitespace and case normalization.
pub fn labels_agree(label: &str, scorer: &str, aliases: &Value) -> bool {
    let normalized = label.trim().to_lowercase();
    let mapped = aliases
        .as_object()
        .into_iter()
        .flatten()
        .find(|(name, _)| name.trim().to_lowercase() == normalized)
        .and_then(|(_, target)| target.as_str())
        .unwrap_or(label);
    mapped.trim().to_lowercase() == scorer.trim().to_lowercase()
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
    for key in ["locked", "released"] {
        if let Some(paths) = policy.get(key)
            && !paths
                .as_array()
                .is_some_and(|paths| paths.iter().all(Value::is_string))
        {
            return Err(format!("\"{key}\" must list paths."));
        }
    }
    Ok(())
}

/// What a task's chat is called, followed by what it was asked.
pub const TASK_PREFIX: &str = "Task: ";
/// The most tasks an agent may have going in a project at once. Each one is a model working, and may be a program training.
pub const MOST_TASKS_AT_ONCE: usize = 4;

/// Why an agent may not start a task from this chat, if it may not: tasks do not start tasks, and only so many run at once.
pub fn task_refusal(from_title: &str, going: usize) -> Option<String> {
    if from_title.starts_with(TASK_PREFIX) {
        return Some(
            "A task cannot start another task. Do the work here, or say what should be started."
                .to_owned(),
        );
    }
    (going >= MOST_TASKS_AT_ONCE).then(|| {
        format!("{going} tasks are already going, which is the most at once. Wait for one to end, with research_task_read.")
    })
}

/// A task's chat title, from what it was asked: its first line, not too long.
pub fn task_title(prompt: &str) -> String {
    let first = prompt.trim().lines().next().unwrap_or_default().trim();
    format!(
        "{TASK_PREFIX}{}",
        first.chars().take(80).collect::<String>()
    )
}

/// The mode a task starts in, from the chat that starts it. A task never asks less than the person chose for that chat.
pub fn task_mode(from_mode: Option<&str>) -> &'static str {
    if from_mode == Some("delegate_auto") {
        "delegate_auto"
    } else {
        "delegate"
    }
}

/// The kinds of record an agent may make.
const AGENT_COLLECTIONS: [&str; 6] = [
    "questions",
    "hypotheses",
    "experiments",
    "models",
    "findings",
    "counterexamples",
];

/// What an agent asks to make, as it may make it. A verdict is the person's, and whatever an agent finds is its suggestion.
pub fn agent_record(collection: &str, fields: &Value) -> Result<Value, String> {
    if !AGENT_COLLECTIONS.contains(&collection) {
        return Err(format!("An agent cannot make records in \"{collection}\"."));
    }
    if collection == "experiments"
        && let Some(what) = loosens_sandbox(&Value::Null, fields)
    {
        return Err(format!(
            "Only the person can {what}, in Experiments. Make the experiment without it, and say why it is needed."
        ));
    }
    agent_fields(collection, fields)
}

/// The fields an agent writes, as it may write them: no verdict, and its findings are suggestions.
fn agent_fields(collection: &str, fields: &Value) -> Result<Value, String> {
    let mut fields = fields.clone();
    let Some(record) = fields.as_object_mut() else {
        return Err("\"fields\" must be an object.".to_owned());
    };
    if record.contains_key("verdict") {
        return Err(
            "A verdict is the person's to set. Say what the evidence suggests in a finding."
                .to_owned(),
        );
    }
    if collection == "findings" {
        if record
            .get("kind")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind != "ai_suggestion")
        {
            return Err("What an agent finds is recorded as a suggestion: leave out \"kind\". A conclusion is the person's.".to_owned());
        }
        record.insert("kind".to_owned(), json!("ai_suggestion"));
    }
    Ok(fields)
}

/// What an agent asks to change on a record, as it may change it. A hypothesis does not change under the person's verdict, and
/// the only findings an agent changes are its own.
pub fn agent_change(collection: &str, current: &Value, fields: &Value) -> Result<Value, String> {
    if collection == "hypotheses" {
        return Err("A hypothesis does not change once made, since a verdict may rest on it. Make a new one.".to_owned());
    }
    if collection == "findings"
        && current.get("kind").and_then(Value::as_str) != Some("ai_suggestion")
    {
        return Err("This finding is the person's. Add your own instead.".to_owned());
    }
    if collection == "experiments"
        && let Some(what) = loosens_sandbox(current, fields)
    {
        return Err(format!(
            "Only the person can {what}, in Experiments. Say why it is needed and ask them."
        ));
    }
    if !AGENT_COLLECTIONS.contains(&collection) {
        return Err(format!(
            "An agent cannot change records in \"{collection}\"."
        ));
    }
    agent_fields(collection, fields)
}

/// How much a chat's agent may change: `manual` only reads, `pair` asks about each change, `delegate` works on its own and asks
/// before what is sensitive, and `delegate_auto` works on its own and asks nothing.
pub fn is_chat_mode(mode: &str) -> bool {
    matches!(mode, "manual" | "pair" | "delegate" | "delegate_auto")
}

/// The approval setting that goes with a chat's mode, which then decides over the agent's own.
pub fn chat_approvals(mode: &str) -> Option<&'static str> {
    match mode {
        "manual" | "pair" | "delegate" => Some("execute_when_allowed"),
        "delegate_auto" => Some("bypass"),
        _ => None,
    }
}

/// What applies to an agent writing a path. The records and locks always hold; after them, the mode of the chat it works in.
/// A chat with no mode, such as a task's, is the agent's to change.
pub fn policy_verdict(locked: &[String], path: &str, chat_mode: Option<&str>) -> PolicyVerdict {
    if is_under(path, ".saturn/research") {
        return PolicyVerdict::Records;
    }
    if locked.iter().any(|key| is_under(path, key)) {
        return PolicyVerdict::Locked;
    }
    match chat_mode {
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
    fn only_a_full_commit_or_hash_pins_weights() {
        assert!(revision_pins(&"a".repeat(40)));
        assert!(revision_pins(&"0F".repeat(32)));
        for moving in ["", "main", "latest", "v1.0", "abc1234", &"g".repeat(40)] {
            assert!(!revision_pins(moving), "{moving}");
        }
        assert_eq!(revision_kind("main"), "name");
        assert_eq!(revision_kind(&"a".repeat(40)), "commit");
        assert_eq!(revision_kind(""), "none");
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
    fn tasks_do_not_start_tasks_and_only_so_many_run_at_once() {
        assert_eq!(task_refusal("Research assistant", 0), None);
        assert_eq!(
            task_refusal("Research assistant", MOST_TASKS_AT_ONCE - 1),
            None
        );
        assert!(task_refusal("Research assistant", MOST_TASKS_AT_ONCE).is_some());
        assert!(task_refusal("Task: clean up", 0).is_some());
        assert_eq!(task_title("  Train it\nthen more"), "Task: Train it");
        assert_eq!(task_title(&"x".repeat(200)).len(), TASK_PREFIX.len() + 80);
        assert_eq!(task_mode(Some("delegate_auto")), "delegate_auto");
        for mode in [Some("pair"), Some("delegate"), Some("manual"), None] {
            assert_eq!(task_mode(mode), "delegate");
        }
    }

    #[test]
    fn an_agent_cannot_set_what_is_the_persons() {
        assert!(
            agent_record("hypotheses", &json!({"title": "H", "verdict": "supported"})).is_err()
        );
        assert!(agent_record("versions", &json!({})).is_err());
        assert!(agent_record("findings", &json!({"text": "T", "kind": "conclusion"})).is_err());
        assert_eq!(
            agent_record("findings", &json!({"text": "T"})).unwrap()["kind"],
            "ai_suggestion"
        );
        assert!(agent_change("hypotheses", &json!({}), &json!({"title": "H"})).is_err());
        assert!(
            agent_change(
                "findings",
                &json!({"kind": "conclusion"}),
                &json!({"text": "T"})
            )
            .is_err()
        );
        assert!(
            agent_change(
                "findings",
                &json!({"kind": "ai_suggestion"}),
                &json!({"text": "T"})
            )
            .is_ok()
        );
    }

    #[test]
    fn the_chat_mode_decides_after_locks_and_records() {
        let locks = ["set.jsonl".to_owned()];
        assert_eq!(
            policy_verdict(&locks, "probe.py", Some("manual")),
            PolicyVerdict::Manual
        );
        assert_eq!(
            policy_verdict(&locks, "probe.py", Some("pair")),
            PolicyVerdict::NeedsApproval
        );
        assert_eq!(
            policy_verdict(&locks, "probe.py", Some("delegate")),
            PolicyVerdict::Allowed
        );
        assert_eq!(
            policy_verdict(&locks, "probe.py", Some("delegate_auto")),
            PolicyVerdict::Allowed
        );
        assert_eq!(
            policy_verdict(&locks, "set.jsonl", Some("delegate_auto")),
            PolicyVerdict::Locked
        );
        assert_eq!(chat_approvals("delegate_auto"), Some("bypass"));
        assert_eq!(chat_approvals("delegate"), Some("execute_when_allowed"));
        assert_eq!(chat_approvals("anything else"), None);
        assert_eq!(
            policy_verdict(&locks, "probe.py", None),
            PolicyVerdict::Allowed
        );
        assert_eq!(
            policy_verdict(&locks, "set.jsonl", None),
            PolicyVerdict::Locked
        );
        assert_eq!(
            policy_verdict(
                &locks,
                ".saturn/research/hypotheses/h.json",
                Some("delegate")
            ),
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
    fn review_words_match_only_by_case_whitespace_and_explicit_aliases() {
        let aliases = json!({"Wrong name": "Wrong"});
        assert!(labels_agree(" wrong NAME ", " Wrong ", &aliases));
        assert!(labels_agree(" refused ", "REFUSED", &json!({})));
        assert!(!labels_agree("Not wrong", "Wrong", &aliases));
        assert!(!labels_agree("Wrong name", "Wrong", &json!({})));
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

    #[test]
    fn an_agent_may_tighten_an_experiments_sandbox_but_not_loosen_it() {
        let open = json!({ "title": "E", "envNames": ["HF_HOME"] });
        let closed = json!({ "title": "E", "sandbox": { "network": false } });
        let change = |current: &Value, fields: Value| agent_change("experiments", current, &fields);
        assert!(change(&open, json!({ "sandbox": { "network": false } })).is_ok());
        assert!(
            change(&open, json!({ "envNames": ["HF_HOME"] })).is_ok(),
            "a name it already had"
        );
        assert!(change(&open, json!({ "envNames": [] })).is_ok());
        let refused = change(&open, json!({ "sandbox": { "isolated": false } })).unwrap_err();
        assert!(refused.contains("turn the sandbox off"), "{refused}");
        assert!(change(&closed, json!({ "sandbox": { "network": true } })).is_err());
        assert!(change(&open, json!({ "envNames": ["HF_HOME", "OPENAI_API_KEY"] })).is_err());
        assert!(
            agent_record(
                "experiments",
                &json!({ "title": "E", "envNames": ["HF_TOKEN"] })
            )
            .is_err()
        );
        assert!(
            agent_record(
                "experiments",
                &json!({ "title": "E", "sandbox": { "network": false } })
            )
            .is_ok()
        );
    }

    #[test]
    fn an_experiments_sandbox_holds_two_switches_and_its_variables_are_names() {
        let experiment = |fields: Value| {
            let mut record = json!({ "title": "E" });
            record
                .as_object_mut()
                .unwrap()
                .extend(fields.as_object().unwrap().clone());
            check("experiments", record.as_object().unwrap())
        };
        assert!(experiment(json!({ "sandbox": { "isolated": true, "network": false } })).is_ok());
        assert!(experiment(json!({ "sandbox": { "network": "no" } })).is_err());
        assert!(experiment(json!({ "sandbox": { "mounts": [] } })).is_err());
        assert!(experiment(json!({ "envNames": ["HF_TOKEN", "_X1"] })).is_ok());
        for bad in ["1X", "A-B", "", "SATURN_RUNTIME_TOKEN"] {
            assert!(experiment(json!({ "envNames": [bad] })).is_err(), "{bad}");
        }
    }
}
