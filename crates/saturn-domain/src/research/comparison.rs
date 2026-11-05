//! Paired comparisons: identities and inputs must agree; repeated trials belong to one independent prompt.
use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};

/// An identity excludes the selected model, so two different models can see the same prompt and trial.
fn identity(row: &Value) -> String {
    serde_json::to_string(&(
        row.get("sampleId"),
        row.get("trial").and_then(Value::as_u64).unwrap_or(0),
    ))
    .unwrap_or_default()
}

/// A conservative two-sided 95% Student t critical value; degrees of freedom are rounded down.
fn critical(degrees: usize) -> f64 {
    let table = [
        12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160,
        2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056,
        2.052, 2.048, 2.045, 2.042,
    ];
    table[degrees.saturating_sub(1).min(29)]
}

/// Counts pairs and computes the mean of prompt means. The interval does not treat repeated trials as new prompts.
fn summary(rows: &[Value], inference: bool) -> Value {
    let paired: Vec<&Value> = rows
        .iter()
        .filter(|row| row.get("delta").and_then(Value::as_f64).is_some())
        .collect();
    let mut groups: BTreeMap<&str, Vec<f64>> = BTreeMap::new();
    for row in &paired {
        groups
            .entry(row["sampleId"].as_str().unwrap_or(""))
            .or_default()
            .push(row["delta"].as_f64().unwrap_or(0.0));
    }
    let mut mean = 0.0;
    let mut sum_squares = 0.0;
    for (index, values) in groups.values().enumerate() {
        let average = values.iter().enumerate().fold(0.0, |mean, (index, value)| {
            mean + (value - mean) / (index + 1) as f64
        });
        let difference = average - mean;
        mean += difference / (index + 1) as f64;
        sum_squares += difference * (average - mean);
    }
    let count = groups.len();
    let interval = if inference && count >= 2 && sum_squares.is_finite() {
        let half_width =
            critical(count - 1) * (sum_squares.max(0.0) / (count - 1) as f64 / count as f64).sqrt();
        let bounds = [mean - half_width, mean + half_width];
        bounds
            .iter()
            .all(|value| value.is_finite())
            .then_some(bounds)
    } else {
        None
    };
    let change_count = |change: &str| rows.iter().filter(|row| row["change"] == change).count();
    json!({ "paired": paired.len(), "independentSamples": count, "meanDelta": if count > 0 { json!(mean) } else { Value::Null },
        "interval95": interval, "intervalMethod": "conservative paired t on means within sample ID",
        "improved": change_count("improved"), "regressed": change_count("regressed"), "unchanged": change_count("unchanged"),
        "missingLeft": change_count("missing_left"), "missingRight": change_count("missing_right"), "excluded": change_count("excluded") })
}

/// Reads an explicit nested field; a plain category also accepts preserved metadata when no top-level value exists.
fn slice_name<'a>(source: &'a Value, field: &str) -> &'a str {
    let nested = |root: &'a Value| field.split('.').try_fold(root, |value, key| value.get(key));
    source
        .get(field)
        .or_else(|| nested(source))
        .or_else(|| source.get("metadata").and_then(nested))
        .and_then(Value::as_str)
        .unwrap_or("(unclassified)")
}

/// Compares selected model samples and returns complete rows and descriptive statistics before paging.
pub fn paired(
    left: &[Value],
    right: &[Value],
    scorer: &str,
    higher_is_better: bool,
    slice: &str,
    inference: bool,
) -> Value {
    let left: BTreeMap<String, &Value> = left.iter().map(|row| (identity(row), row)).collect();
    let right: BTreeMap<String, &Value> = right.iter().map(|row| (identity(row), row)).collect();
    let keys: BTreeSet<&String> = left.keys().chain(right.keys()).collect();
    let mut rows = Vec::new();
    for key in keys {
        let a = left.get(key).copied();
        let b = right.get(key).copied();
        let source = a.or(b).unwrap_or(&Value::Null);
        let mut row = json!({ "sampleId": source["sampleId"], "trial": source.get("trial").and_then(Value::as_u64).unwrap_or(0),
            "slice": slice_name(source, slice), "left": a, "right": b, "delta": null });
        let reason = match (a, b) {
            (None, _) => "missing_left",
            (_, None) => "missing_right",
            (Some(a), Some(b)) => {
                if a.get("identityGenerated") == Some(&json!(true))
                    || b.get("identityGenerated") == Some(&json!(true))
                {
                    "generated_identity"
                } else if a.get("input").is_none() || b.get("input").is_none() {
                    "missing_input"
                } else if a.get("input") != b.get("input") {
                    "input_mismatch"
                } else if a.get("error").is_some_and(|value| !value.is_null())
                    || b.get("error").is_some_and(|value| !value.is_null())
                {
                    "sample_error"
                } else if let (Some(x), Some(y)) = (
                    a.get("scores")
                        .and_then(|scores| scores.get(scorer))
                        .and_then(Value::as_f64),
                    b.get("scores")
                        .and_then(|scores| scores.get(scorer))
                        .and_then(Value::as_f64),
                ) {
                    let delta = y - x;
                    if delta.is_finite() {
                        row["delta"] = json!(delta);
                        ""
                    } else {
                        "non_finite_difference"
                    }
                } else {
                    "missing_numeric_score"
                }
            }
        };
        let change = match reason {
            "missing_left" | "missing_right" => reason,
            "" => {
                let value = row["delta"].as_f64().unwrap_or(0.0)
                    * if higher_is_better { 1.0 } else { -1.0 };
                if value > 0.0 {
                    "improved"
                } else if value < 0.0 {
                    "regressed"
                } else {
                    "unchanged"
                }
            }
            _ => "excluded",
        };
        row["change"] = json!(change);
        row["reason"] = if reason.is_empty() {
            Value::Null
        } else {
            json!(reason)
        };
        rows.push(row);
    }
    let names: BTreeSet<&str> = rows
        .iter()
        .filter_map(|row| row["slice"].as_str())
        .collect();
    let slices: Vec<Value> = names
        .into_iter()
        .map(|name| {
            let own: Vec<Value> = rows
                .iter()
                .filter(|row| row["slice"] == name)
                .cloned()
                .collect();
            let mut stats = summary(&own, inference);
            stats["name"] = json!(name);
            stats
        })
        .collect();
    json!({ "summary": summary(&rows, inference), "slices": slices, "items": rows })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trials_are_grouped_and_negative_scores_keep_their_sign() {
        let a = vec![
            json!({"sampleId":"a","input":"a","scores":{"s":-2}}),
            json!({"sampleId":"a","trial":1,"input":"a","scores":{"s":-2}}),
            json!({"sampleId":"b","input":"b","scores":{"s":0}}),
        ];
        let b = vec![
            json!({"sampleId":"a","input":"a","scores":{"s":0}}),
            json!({"sampleId":"a","trial":1,"input":"a","scores":{"s":0}}),
            json!({"sampleId":"b","input":"b","scores":{"s":0}}),
        ];
        let result = paired(&a, &b, "s", true, "category", true);
        assert_eq!(result["summary"]["paired"], 3);
        assert_eq!(result["summary"]["independentSamples"], 2);
        assert_eq!(result["summary"]["meanDelta"], 1.0);
    }

    #[test]
    fn a_single_prompt_and_unknown_conditions_have_no_interval() {
        let rows = vec![json!({"sampleId":"a","input":"a","scores":{"s":1}})];
        assert!(
            paired(&rows, &rows, "s", true, "category", true)["summary"]["interval95"].is_null()
        );
        assert!(
            paired(&rows, &rows, "s", true, "category", false)["summary"]["interval95"].is_null()
        );
    }
}
