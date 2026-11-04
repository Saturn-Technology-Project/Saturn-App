//! The runtime's log: the recent lines for Settings → Logs, and warnings and errors on stderr. Lines below the level set in
//! Settings are dropped. Log what happened and why, never secrets, full prompts or command arguments.
use std::collections::VecDeque;
use std::sync::{LazyLock, Mutex};

use saturn_domain::time::{iso_time, now_millis};
use serde_json::{Value, json};

use crate::locked;

const LIMIT: usize = 500;

struct Lines {
    floor: u8,
    seq: u64,
    lines: VecDeque<Value>,
}

static LOG: LazyLock<Mutex<Lines>> = LazyLock::new(|| {
    Mutex::new(Lines {
        floor: 1,
        seq: 0,
        lines: VecDeque::new(),
    })
});

pub(crate) fn rank(level: &str) -> u8 {
    match level {
        "debug" => 0,
        "info" => 1,
        "warning" => 2,
        "error" => 3,
        _ => 1,
    }
}

/// Sets the lowest level that is kept.
pub fn set_level(level: &str) {
    locked(&LOG).floor = rank(level);
}

/// Writes one line. Say which credential was used, never its value.
pub fn log(service: &str, level: &str, message: &str) {
    {
        let mut log = locked(&LOG);
        if rank(level) < log.floor {
            return;
        }
        log.seq += 1;
        let line = json!({ "seq": log.seq, "ts": iso_time(now_millis()), "service": service, "level": level, "message": message });
        log.lines.push_back(line);
        if log.lines.len() > LIMIT {
            log.lines.pop_front();
        }
    }
    saturn_telemetry::emit_log(service, level, message);
    if rank(level) >= 2 {
        eprintln!("[{service}] {message}");
    }
}

/// The recent lines, oldest first.
pub fn recent() -> Vec<Value> {
    locked(&LOG).lines.iter().cloned().collect()
}
