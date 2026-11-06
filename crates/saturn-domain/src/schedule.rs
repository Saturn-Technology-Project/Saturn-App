//! When a scheduled automation runs. Slots are compared as minutes of wall-clock time treated as UTC, so daylight-saving shifts
//! never skip or repeat a run by a full day.
use serde_json::{Value, json};

use crate::time::{iso_time, weekday};

const DAY: i64 = 1440;

/// A saved trigger's fields.
fn frequency_of(trigger: &Value) -> &str {
    trigger
        .get("frequency")
        .and_then(Value::as_str)
        .unwrap_or("daily")
}

/// Hours and minutes of a trigger's `HH:MM`.
fn clock_of(trigger: &Value) -> (i64, i64) {
    let time = trigger
        .get("time")
        .and_then(Value::as_str)
        .unwrap_or("09:00");
    let (hour, minute) = time.split_once(':').unwrap_or(("9", "0"));
    (hour.parse().unwrap_or(9), minute.parse().unwrap_or(0))
}

/// Whether a time is `HH:MM` on a 24-hour clock.
fn valid_time(time: &str) -> bool {
    let bytes = time.as_bytes();
    bytes.len() == 5
        && bytes[2] == b':'
        && bytes[..2].iter().chain(&bytes[3..]).all(u8::is_ascii_digit)
        && time[..2] < *"24"
        && bytes[3] <= b'5'
}

/// A trigger from a request: what it does not say well comes from `fallback`, then the defaults.
pub fn trigger_of(value: &Value, fallback: Option<&Value>) -> Value {
    let known = |key: &str| fallback.and_then(|item| item.get(key));
    let frequency = value
        .get("frequency")
        .and_then(Value::as_str)
        .filter(|name| matches!(*name, "hourly" | "daily" | "weekdays" | "weekly"))
        .or_else(|| known("frequency").and_then(Value::as_str))
        .unwrap_or("daily");
    let time = value
        .get("time")
        .and_then(Value::as_str)
        .filter(|time| valid_time(time))
        .or_else(|| known("time").and_then(Value::as_str))
        .unwrap_or("09:00");
    let given = value
        .get("weekday")
        .and_then(Value::as_f64)
        .filter(|day| day.fract() == 0.0 && (0.0..=6.0).contains(day));
    let day = given
        .or_else(|| known("weekday").and_then(Value::as_f64))
        .unwrap_or(1.0);
    json!({ "frequency": frequency, "time": time, "weekday": day as i64 })
}

fn matches(trigger: &Value, minute: i64) -> bool {
    let day = i64::from(weekday(minute.div_euclid(DAY)));
    match frequency_of(trigger) {
        "weekdays" => (1..=5).contains(&day),
        "weekly" => day == trigger.get("weekday").and_then(Value::as_i64).unwrap_or(1),
        _ => true,
    }
}

/// The first candidate near `local`, and the step between candidates.
fn anchor(trigger: &Value, local: i64) -> (i64, i64) {
    let (hour, minute) = clock_of(trigger);
    if frequency_of(trigger) == "hourly" {
        return (local.div_euclid(60) * 60 + minute, 60);
    }
    (local.div_euclid(DAY) * DAY + hour * 60 + minute, DAY)
}

/// Latest scheduled slot at or before `local`.
pub fn previous_slot(trigger: &Value, local: i64) -> i64 {
    let (mut start, step) = anchor(trigger, local);
    while start > local || !matches(trigger, start) {
        start -= step;
    }
    start
}

/// Earliest scheduled slot after `local`.
pub fn next_slot(trigger: &Value, local: i64) -> i64 {
    let (mut start, step) = anchor(trigger, local);
    while start <= local || !matches(trigger, start) {
        start += step;
    }
    start
}

/// "YYYY-MM-DD HH:MM" wall-clock text for a local-minute index.
pub fn slot_label(minute: i64) -> String {
    let text = iso_time(minute * 60_000);
    text[..16].replace('T', " ")
}

/// Reads the cron shapes the scheduler can run: hourly ("M * * * *"), daily ("M H * * *"), weekdays ("M H * * 1-5") and weekly
/// ("M H * * D"), optionally prefixed with CRON_TZ=<zone>, which `check_zone` looks at. Anything else is refused with the
/// supported shapes, instead of being stored and never firing.
pub fn cron_to_trigger(
    cron: &str,
    check_zone: impl Fn(&str) -> Result<String, String>,
) -> Result<(Value, Option<String>), String> {
    let mut text = cron.trim();
    let mut zone = None;
    if let Some(rest) = text.strip_prefix("CRON_TZ=")
        && let Some((name, schedule)) = rest.split_once(char::is_whitespace)
    {
        zone = Some(check_zone(name)?);
        text = schedule.trim();
    }
    let unsupported = || {
        format!(
            "Unsupported schedule \"{cron}\". Saturn runs hourly (\"M * * * *\"), daily (\"M H * * *\"), weekdays (\"M H * * 1-5\") or weekly (\"M H * * D\", 0 = Sunday) schedules."
        )
    };
    let fields: Vec<&str> = text.split_whitespace().collect();
    let &[minute, hour, day, month, weekday] = fields.as_slice() else {
        return Err(unsupported());
    };
    let number = |value: &str, largest: u32| {
        (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| value.parse::<u32>().ok())
            .flatten()
            .filter(|parsed| *parsed <= largest)
    };
    let Some(m) = number(minute, 59).filter(|_| day == "*" && month == "*") else {
        return Err(unsupported());
    };
    let trigger = |frequency: &str, time: String, on: u32| {
        (
            json!({ "frequency": frequency, "time": time, "weekday": on }),
            zone.clone(),
        )
    };
    if hour == "*" && weekday == "*" {
        return Ok(trigger("hourly", format!("00:{m:02}"), 1));
    }
    let Some(h) = number(hour, 23) else {
        return Err(unsupported());
    };
    let time = format!("{h:02}:{m:02}");
    if weekday == "*" {
        return Ok(trigger("daily", time, 1));
    }
    if weekday == "1-5" {
        return Ok(trigger("weekdays", time, 1));
    }
    let Some(d) = number(if weekday == "7" { "0" } else { weekday }, 6) else {
        return Err(unsupported());
    };
    Ok(trigger("weekly", time, d))
}

/// The cron equivalent of a trigger, for tools that speak cron.
pub fn trigger_to_cron(trigger: &Value) -> String {
    let time = trigger
        .get("time")
        .and_then(Value::as_str)
        .unwrap_or("09:00");
    let (hour, minute) = time.split_once(':').unwrap_or(("9", "0"));
    let (hour, minute) = (
        hour.parse::<u32>().unwrap_or(0),
        minute.parse::<u32>().unwrap_or(0),
    );
    match frequency_of(trigger) {
        "hourly" => format!("{minute} * * * *"),
        "weekdays" => format!("{minute} {hour} * * 1-5"),
        "weekly" => format!(
            "{minute} {hour} * * {}",
            trigger.get("weekday").and_then(Value::as_i64).unwrap_or(1)
        ),
        _ => format!("{minute} {hour} * * *"),
    }
}
