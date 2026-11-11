//! Token and cost totals from the per-call usage history.
use std::collections::HashMap;

use saturn_domain::llm::{CallToPrice, describe_price, llm_provider, price_call};
use saturn_domain::time::{iso_time, now_millis, parse_iso};
use serde_json::{Value, json};

use crate::catalog::connection_of;
use crate::records::{by_id, text};
use crate::{CoreError, Kernel};

/// `inputTokens` counts every prompt token; cached and cache-write tokens are the parts billed at cache rates.
#[derive(Clone, Debug, Default)]
struct Tally {
    calls: u64,
    input: u64,
    output: u64,
    cached: u64,
    cache_write: u64,
    cost: f64,
    unpriced: u64,
}

impl Tally {
    fn add(&mut self, record: &Value, cost: Option<f64>) {
        let count = |key: &str| record.get(key).and_then(Value::as_u64).unwrap_or(0);
        self.calls += 1;
        self.input += count("inputTokens");
        self.output += count("outputTokens");
        self.cached += count("cachedInputTokens");
        self.cache_write += count("cacheWriteTokens");
        match cost {
            Some(cost) => self.cost += cost,
            None => self.unpriced += 1,
        }
    }

    /// The tally's fields, added to `value`.
    fn with_totals(&self, mut value: Value) -> Value {
        value["calls"] = self.calls.into();
        value["inputTokens"] = self.input.into();
        value["outputTokens"] = self.output.into();
        value["cachedInputTokens"] = self.cached.into();
        value["cacheWriteTokens"] = self.cache_write.into();
        value["costUsd"] = self.cost.into();
        value["unpricedCalls"] = self.unpriced.into();
        value
    }
}

/// One model's or agent's totals, with what the page shows about it.
type Row = (String, Tally, Value);
/// One agent's totals and the models it ran on.
type AgentRow = (String, Tally, Value, Vec<Row>);

/// Most spent first, then most tokens.
fn by_spend(rows: &mut [(Tally, Value)]) {
    rows.sort_by(|a, b| {
        b.0.cost
            .total_cmp(&a.0.cost)
            .then((b.0.input + b.0.output).cmp(&(a.0.input + a.0.output)))
    });
}

/// A range end as milliseconds. Empty is open, anything else unreadable is the caller's mistake.
fn instant(value: Option<&str>, name: &str) -> Result<Option<i64>, CoreError> {
    match value.filter(|value| !value.is_empty()) {
        None => Ok(None),
        Some(value) => parse_iso(value)
            .map(Some)
            .ok_or_else(|| CoreError::new(400, format!("{name} must be a date or time"))),
    }
}

impl Kernel {
    /// A record's cost as fixed when it was made. Records from before costs were recorded are priced now, at the time they were
    /// made.
    fn record_cost(&self, record: &Value) -> Option<f64> {
        if let Some(cost) = record.get("costUsd") {
            return cost.as_f64();
        }
        let provider = text(record, "provider");
        let connection = self
            .store
            .read(|state| by_id(&state.models, text(record, "modelId")).cloned());
        let hosted = connection.map_or(llm_provider(provider).is_some(), |model| {
            self.broker.hosted(&connection_of(&model))
        });
        let count = |key: &str| record.get(key).and_then(Value::as_u64).unwrap_or(0);
        price_call(&CallToPrice {
            provider,
            model: text(record, "model"),
            hosted,
            at: parse_iso(text(record, "createdAt")).unwrap_or(0),
            input_tokens: count("inputTokens"),
            output_tokens: count("outputTokens"),
            cached_tokens: count("cachedInputTokens"),
            cache_write_tokens: count("cacheWriteTokens"),
        })
        .map(|priced| priced.cost_usd)
    }

    /// Every call's line in the usage history.
    pub fn usage_records(&self) -> Vec<Value> {
        self.store.read(|state| state.usage.clone())
    }

    /// Totals by model and agent for calls in a time window; either end may be open.
    pub fn usage_summary(&self, from: Option<&str>, to: Option<&str>) -> Result<Value, CoreError> {
        let (from, to) = (instant(from, "from")?, instant(to, "to")?);
        if let (Some(from), Some(to)) = (from, to)
            && from >= to
        {
            return Err(CoreError::new(400, "The range must end after it starts"));
        }
        let records: Vec<Value> = self
            .usage_records()
            .into_iter()
            .filter(|record| {
                let at = parse_iso(text(record, "createdAt")).unwrap_or(0);
                from.is_none_or(|from| at >= from) && to.is_none_or(|to| at < to)
            })
            .collect();
        let now = now_millis();
        let mut totals = Tally::default();
        let mut models: Vec<Row> = Vec::new();
        let mut agents: Vec<AgentRow> = Vec::new();
        let mut model_at = HashMap::new();
        let mut agent_at = HashMap::new();
        for record in &records {
            let cost = self.record_cost(record);
            let (provider, model) = (text(record, "provider"), text(record, "model"));
            let key = format!("{provider}/{model}");
            // The name the call was recorded under, else the name of the connection it went through, else the id:
            // Saturn has no names of its own for a provider's models.
            let label = if text(record, "modelName").is_empty() {
                self.store
                    .read(|state| {
                        by_id(&state.models, text(record, "modelId"))
                            .map(|connection| text(connection, "name").to_owned())
                    })
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| model.to_owned())
            } else {
                text(record, "modelName").to_owned()
            };
            totals.add(record, cost);
            let at = *model_at.entry(key.clone()).or_insert_with(|| {
                models.push((key.clone(), Tally::default(), json!({ "provider": provider, "model": model, "label": label, "price": describe_price(provider, model, now) })));
                models.len() - 1
            });
            models[at].1.add(record, cost);
            let agent_id = text(record, "agentId");
            let at = *agent_at.entry(agent_id.to_owned()).or_insert_with(|| {
                let current = self.store.read(|state| {
                    by_id(&state.agents, agent_id).map(|agent| text(agent, "name").to_owned())
                });
                let saved = text(record, "agentName");
                let name = current.clone().unwrap_or_else(|| {
                    if saved.is_empty() {
                        "Deleted agent".to_owned()
                    } else {
                        saved.to_owned()
                    }
                });
                agents.push((
                    agent_id.to_owned(),
                    Tally::default(),
                    json!({ "agentId": agent_id, "name": name, "exists": current.is_some() }),
                    Vec::new(),
                ));
                agents.len() - 1
            });
            let agent = &mut agents[at];
            agent.1.add(record, cost);
            let used = match agent.3.iter().position(|item| item.0 == key) {
                Some(index) => index,
                None => {
                    agent.3.push((
                        key.clone(),
                        Tally::default(),
                        json!({ "provider": provider, "model": model, "label": label }),
                    ));
                    agent.3.len() - 1
                }
            };
            agent.3[used].1.add(record, cost);
        }
        let mut model_rows: Vec<(Tally, Value)> = models
            .into_iter()
            .map(|(_, tally, value)| (tally, value))
            .collect();
        by_spend(&mut model_rows);
        let mut agent_rows: Vec<(Tally, Value)> = agents
            .into_iter()
            .map(|(_, tally, mut value, used)| {
                let mut rows: Vec<(Tally, Value)> = used
                    .into_iter()
                    .map(|(_, tally, value)| (tally, value))
                    .collect();
                by_spend(&mut rows);
                value["models"] = rows
                    .iter()
                    .map(|(tally, value)| tally.with_totals(value.clone()))
                    .collect();
                (tally, value)
            })
            .collect();
        by_spend(&mut agent_rows);
        let since = records.iter().map(|record| text(record, "createdAt")).min();
        Ok(json!({
            "currency": "USD",
            "range": { "from": from.map(iso_time), "to": to.map(iso_time) },
            "since": since,
            "totals": totals.with_totals(json!({})),
            "models": model_rows.iter().map(|(tally, value)| tally.with_totals(value.clone())).collect::<Vec<_>>(),
            "agents": agent_rows.iter().map(|(tally, value)| tally.with_totals(value.clone())).collect::<Vec<_>>(),
        }))
    }
}
