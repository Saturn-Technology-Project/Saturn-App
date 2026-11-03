use serde::Serialize;
use serde_json::Value;

use crate::{Arguments, js};

/// One step of a task plan; `status` is pending, in_progress or completed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PlanStep {
    pub step: String,
    pub status: String,
}

/// A task plan with exactly one step in progress until every step is completed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TaskPlan {
    pub explanation: String,
    pub steps: Vec<PlanStep>,
}

impl TaskPlan {
    /// The plan in a `multi_step` call.
    pub fn from_arguments(arguments: &Arguments) -> Result<Self, String> {
        let raw = arguments
            .get("steps")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice);
        if raw.is_empty() {
            return Err("Plan needs at least one step".to_owned());
        }
        let mut steps = Vec::with_capacity(raw.len());
        for (index, item) in raw.iter().enumerate() {
            steps.push(match item {
                Value::String(step) => PlanStep {
                    step: step.clone(),
                    status: if index == 0 { "in_progress" } else { "pending" }.to_owned(),
                },
                Value::Array(_) | Value::Object(_) => {
                    let step = js::text(item.get("step"));
                    let status = js::text(item.get("status"));
                    if step.is_empty() {
                        return Err("Each step needs a description".to_owned());
                    }
                    if !matches!(status.as_str(), "pending" | "in_progress" | "completed") {
                        return Err(
                            "Step status must be pending, in_progress, or completed".to_owned()
                        );
                    }
                    PlanStep { step, status }
                }
                _ => return Err("Each step needs a description and a status".to_owned()),
            });
        }
        let active = steps
            .iter()
            .filter(|item| item.status == "in_progress")
            .count();
        let open = steps.iter().any(|item| item.status != "completed");
        if open && active != 1 {
            return Err("Keep exactly one step in progress".to_owned());
        }
        if !open && active != 0 {
            return Err("A finished plan has no step in progress".to_owned());
        }
        Ok(Self {
            explanation: js::text(arguments.get("explanation")),
            steps,
        })
    }
}
