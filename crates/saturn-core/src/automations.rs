//! Scheduled prompts that start agent runs on their own.
use std::sync::Arc;
use std::time::Duration;

use jiff::Timestamp;
use jiff::tz::TimeZone;
use saturn_domain::js;
use saturn_domain::new_id;
use saturn_domain::prompt::clip;
use saturn_domain::schedule::{next_slot, previous_slot, slot_label, trigger_of};
use saturn_domain::time::{days_from_civil, iso_time, now_millis};
use saturn_llm::{CallContext, ChatMessage, CompletionInput, Role};
use serde_json::{Value, json};

use crate::records::{by_id, by_id_mut, remove, text};
use crate::runs::StartOptions;
use crate::{CoreError, Kernel, log};

const CHECK_EVERY: Duration = Duration::from_secs(30);
const DRAFT_SYSTEM: &str = "You turn a request into a scheduled automation for an AI agent.\nReply with JSON only, no prose, shaped as:\n{\"name\": string, \"prompt\": string, \"frequency\": \"hourly\"|\"daily\"|\"weekdays\"|\"weekly\", \"time\": \"HH:MM\", \"weekday\": 0-6}\nname is a short title. prompt is the instruction the agent runs each time, written to the agent.\ntime is 24-hour local time; for hourly only the minutes matter. weekday is 0 for Sunday and only matters for weekly.\nDefault to daily at 09:00 when the request gives no schedule.";

/// A time zone from a request, UTC when none is named.
pub fn valid_time_zone(value: Option<&Value>) -> Result<String, CoreError> {
    let named = value
        .and_then(Value::as_str)
        .map(js::trim)
        .filter(|zone| !zone.is_empty())
        .unwrap_or("UTC");
    TimeZone::get(named)
        .map(|_| named.to_owned())
        .map_err(|_| CoreError::new(400, format!("Unknown time zone: {named}")))
}

/// Minutes since the epoch of the wall-clock time in a zone, treated as if it were UTC. A zone that is gone counts as UTC.
pub fn local_minute(now: i64, zone: &str) -> i64 {
    let zone = TimeZone::get(zone).unwrap_or(TimeZone::UTC);
    let Ok(stamp) = Timestamp::from_millisecond(now) else {
        return now.div_euclid(60_000);
    };
    let local = stamp.to_zoned(zone).datetime();
    days_from_civil(
        i64::from(local.year()),
        u32::try_from(local.month()).unwrap_or(1),
        u32::try_from(local.day()).unwrap_or(1),
    ) * 1440
        + i64::from(local.hour()) * 60
        + i64::from(local.minute())
}

/// A text field, trimmed.
fn trimmed(input: &Value, key: &str) -> String {
    js::trim(&js::text(input.get(key))).to_owned()
}

impl Kernel {
    /// Checks for automations that are due now and every half minute.
    pub fn start_automations(self: &Arc<Self>) {
        let kernel = Arc::clone(self);
        tokio::spawn(async move {
            let mut timer = tokio::time::interval(CHECK_EVERY);
            loop {
                timer.tick().await;
                kernel.tick_automations(now_millis()).await;
            }
        });
    }

    fn automation_view(&self, automation: &Value, now: i64) -> Value {
        let mut view = automation.clone();
        let agent = self.store.read(|state| {
            by_id(&state.agents, text(automation, "agentId"))
                .map(|item| text(item, "name").to_owned())
        });
        view["agentName"] = agent.unwrap_or_else(|| "Agent".to_owned()).into();
        view["nextRun"] = if automation.get("enabled") == Some(&Value::Bool(true)) {
            slot_label(next_slot(
                &automation["trigger"],
                local_minute(now, text(automation, "timeZone")),
            ))
            .into()
        } else {
            Value::Null
        };
        view
    }

    pub fn list_automations(&self) -> Vec<Value> {
        let now = now_millis();
        self.store
            .read(|state| state.automations.clone())
            .iter()
            .map(|item| self.automation_view(item, now))
            .collect()
    }

    fn get_automation(&self, id: &str) -> Result<Value, CoreError> {
        self.store
            .read(|state| by_id(&state.automations, id).cloned())
            .ok_or_else(|| CoreError::new(404, "Automation not found"))
    }

    /// Automations run unattended. Anthropic does not allow that on a Claude subscription (no automated access except through an
    /// API key), so an agent on Claude (via Claude Code) cannot be scheduled. Checked when saving and again before every run,
    /// since the agent's model can change later.
    fn allowed_agent(&self, agent_id: &str) -> Result<Value, CoreError> {
        let agent = self.get_agent(agent_id)?;
        if self
            .model_of(&agent)
            .is_some_and(|model| text(&model, "provider") == "claude-code")
        {
            return Err(CoreError::new(
                409,
                format!(
                    "{} runs on Claude (via Claude Code), your Claude subscription. Running it on a schedule is a violation of Anthropic's policy; choose an agent on an API model (Claude with an API key, for example).",
                    text(&agent, "name")
                ),
            ));
        }
        Ok(agent)
    }

    pub async fn create_automation(&self, input: &Value) -> Result<Value, CoreError> {
        let now = now_millis();
        let name = trimmed(input, "name");
        let prompt = trimmed(input, "prompt");
        if name.is_empty() {
            return Err(CoreError::new(400, "Automation name is required"));
        }
        if prompt.is_empty() {
            return Err(CoreError::new(400, "Automation prompt is required"));
        }
        let agent = self.allowed_agent(&js::text(input.get("agentId")))?;
        let trigger = trigger_of(input.get("trigger").unwrap_or(&Value::Null), None);
        let zone = valid_time_zone(input.get("timeZone"))?;
        let enabled = input
            .get("enabled")
            .filter(|flag| !flag.is_null())
            .is_none_or(|flag| js::truthy(Some(flag)));
        let automation = json!({
            "id": new_id("auto")?,
            "name": name,
            "agentId": text(&agent, "id"),
            "prompt": prompt,
            "trigger": trigger,
            "timeZone": zone,
            "enabled": enabled,
            "createdAt": iso_time(now),
            "lastSlot": previous_slot(&trigger, local_minute(now, &zone)),
        });
        let saved = automation.clone();
        self.store
            .update(|state| state.automations.push(saved))
            .await?;
        log("automations", "info", &format!("Created automation {name}"));
        Ok(self.automation_view(&automation, now))
    }

    pub async fn update_automation(&self, id: &str, patch: &Value) -> Result<Value, CoreError> {
        let now = now_millis();
        let current = self.get_automation(id)?;
        let mut next = current.clone();
        let given = |key: &str| patch.get(key).filter(|value| !value.is_null());
        if given("name").is_some() {
            next["name"] = trimmed(patch, "name").into();
            if text(&next, "name").is_empty() {
                return Err(CoreError::new(400, "Automation name is required"));
            }
        }
        if given("prompt").is_some() {
            next["prompt"] = trimmed(patch, "prompt").into();
            if text(&next, "prompt").is_empty() {
                return Err(CoreError::new(400, "Automation prompt is required"));
            }
        }
        if let Some(agent) = given("agentId") {
            next["agentId"] = self.allowed_agent(&js::text(Some(agent)))?["id"].clone();
        }
        if let Some(trigger) = given("trigger") {
            next["trigger"] = trigger_of(trigger, current.get("trigger"));
        }
        if let Some(zone) = given("timeZone") {
            next["timeZone"] = valid_time_zone(Some(zone))?.into();
        }
        if let Some(enabled) = given("enabled") {
            next["enabled"] = js::truthy(Some(enabled)).into();
        }
        let on = next["enabled"] == true;
        if given("trigger").is_some()
            || given("timeZone").is_some()
            || (on && current["enabled"] != true)
        {
            next["lastSlot"] =
                previous_slot(&next["trigger"], local_minute(now, text(&next, "timeZone"))).into();
        }
        let saved = next.clone();
        self.store
            .update(|state| {
                if let Some(item) = by_id_mut(&mut state.automations, id) {
                    *item = saved;
                }
            })
            .await?;
        if next["enabled"] != current["enabled"] {
            log(
                "automations",
                "info",
                &format!(
                    "Automation {} {}",
                    text(&next, "name"),
                    if on { "resumed" } else { "paused" }
                ),
            );
        }
        Ok(self.automation_view(&next, now))
    }

    pub async fn delete_automation(&self, id: &str) -> Result<(), CoreError> {
        let automation = self.get_automation(id)?;
        self.store
            .update(|state| state.automations.retain(|item| text(item, "id") != id))
            .await?;
        log(
            "automations",
            "info",
            &format!("Automation {} deleted", text(&automation, "name")),
        );
        Ok(())
    }

    /// Runs an automation now, apart from its schedule.
    pub async fn run_automation(self: &Arc<Self>, id: &str) -> Result<Value, CoreError> {
        let automation = self.get_automation(id)?;
        let now = now_millis();
        let slot = automation
            .get("lastSlot")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        self.fire_automation(&automation, slot, now).await?;
        Ok(self.automation_view(&self.get_automation(id)?, now))
    }

    /// Fires every enabled automation whose latest slot has not been handled yet.
    pub async fn tick_automations(self: &Arc<Self>, now: i64) {
        for automation in self.store.read(|state| state.automations.clone()) {
            if automation.get("enabled") != Some(&Value::Bool(true)) {
                continue;
            }
            let local = local_minute(now, text(&automation, "timeZone"));
            let slot = previous_slot(&automation["trigger"], local);
            if slot
                <= automation
                    .get("lastSlot")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
            {
                continue;
            }
            // Only the latest missed slot runs; earlier ones while the runtime was off are not replayed.
            if local - slot > 2 {
                log(
                    "automations",
                    "info",
                    &format!(
                        "Automation {} is running {} minutes late",
                        text(&automation, "name"),
                        local - slot
                    ),
                );
            }
            if let Err(error) = self.fire_automation(&automation, slot, now).await {
                log(
                    "automations",
                    "warning",
                    &format!("Could not save an automation's run: {error}"),
                );
            }
        }
    }

    async fn fire_automation(
        self: &Arc<Self>,
        automation: &Value,
        slot: i64,
        now: i64,
    ) -> Result<(), CoreError> {
        let agent = text(automation, "agentId");
        let started = match self.allowed_agent(agent) {
            Ok(_) => {
                self.start_run(
                    agent,
                    text(automation, "prompt"),
                    None,
                    None,
                    StartOptions::default(),
                )
                .await
            }
            Err(error) => Err(error),
        };
        let (run_id, error) = match started {
            Ok(run) => {
                log(
                    "automations",
                    "info",
                    &format!("Ran automation {}", text(automation, "name")),
                );
                (Some(text(&run, "id").to_owned()), None)
            }
            Err(error) => {
                log(
                    "automations",
                    "warning",
                    &format!("Automation {} failed: {error}", text(automation, "name")),
                );
                (None, Some(error.message))
            }
        };
        self.store
            .update(|state| {
                let Some(target) = by_id_mut(&mut state.automations, text(automation, "id")) else {
                    return;
                };
                let last = target.get("lastSlot").and_then(Value::as_i64).unwrap_or(0);
                target["lastSlot"] = last.max(slot).into();
                target["lastRunAt"] = iso_time(now).into();
                match run_id {
                    Some(id) => target["lastRunId"] = id.into(),
                    None => remove(target, "lastRunId"),
                }
                match error {
                    Some(message) => target["lastError"] = message.into(),
                    None => remove(target, "lastError"),
                }
            })
            .await?;
        Ok(())
    }

    /// Turns a plain-language request into a draft the New Automation form can prefill. Drafting is a plain API call: it uses
    /// the agent's model only if that model has an API, else the background model or any API model.
    pub async fn draft_automation(&self, input: &Value) -> Result<Value, CoreError> {
        let wanted = trimmed(input, "text");
        if wanted.is_empty() {
            return Err(CoreError::new(400, "Describe the automation first"));
        }
        let (agent, model) = self.store.read(|state| {
            let asked = text(input, "agentId");
            let agent = by_id(&state.agents, asked)
                .or_else(|| {
                    state
                        .agents
                        .iter()
                        .find(|item| !text(item, "modelConnectionId").is_empty())
                })
                .cloned();
            let own = agent
                .as_ref()
                .and_then(|item| by_id(&state.models, text(item, "modelConnectionId")));
            let background = state
                .settings
                .get("completionModelId")
                .and_then(Value::as_str)
                .and_then(|id| by_id(&state.models, id));
            let usable =
                |model: &&Value| !saturn_domain::llm::runs_on_plan(text(model, "provider"));
            let model = own
                .filter(usable)
                .or(background.filter(usable))
                .or_else(|| state.models.iter().find(usable))
                .cloned();
            (agent, model)
        });
        let (Some(agent), Some(model)) = (agent, model) else {
            return Err(CoreError::new(
                409,
                "Drafting needs a model with an API key (Claude, OpenAI, Gemini, DeepSeek or LM Studio)",
            ));
        };
        let body = self
            .call_model(
                &model,
                CompletionInput {
                    context: CallContext {
                        agent_id: text(&agent, "id").to_owned(),
                        agent_name: text(&agent, "name").to_owned(),
                        run_id: None,
                        purpose: "automation_draft",
                    },
                    temperature: Some(0.0),
                    max_output: Some(600),
                    low_thinking: false,
                    messages: vec![
                        ChatMessage::new(Role::System, DRAFT_SYSTEM),
                        ChatMessage::new(Role::User, wanted.as_str()),
                    ],
                    tools: Vec::new(),
                },
            )
            .await?;
        let raw = &body.content;
        let parsed: Option<Value> = raw
            .find('{')
            .zip(raw.rfind('}'))
            .filter(|(start, end)| start <= end)
            .and_then(|(start, end)| serde_json::from_str(&raw[start..=end]).ok());
        let Some(parsed) = parsed else {
            log(
                "automations",
                "warning",
                &format!(
                    "{} did not return usable JSON for an automation draft",
                    text(&model, "name")
                ),
            );
            return Err(CoreError::new(
                502,
                "The model did not return a usable automation",
            ));
        };
        let or = |key: &str, fallback: String| {
            let value = trimmed(&parsed, key);
            if value.is_empty() { fallback } else { value }
        };
        Ok(json!({
            "name": or("name", clip(&wanted, 40)),
            "prompt": or("prompt", wanted.clone()),
            "trigger": trigger_of(&json!({ "frequency": parsed.get("frequency"), "time": parsed.get("time"), "weekday": parsed.get("weekday") }), None),
        }))
    }
}
