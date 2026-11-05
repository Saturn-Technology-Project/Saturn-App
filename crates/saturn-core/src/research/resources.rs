//! What a run costs while it lives: its process group's processor time and memory, the GPUs when `nvidia-smi` can
//! say, and how fast its samples file grows. Sampled every two seconds into the run's folder, never interpreted.
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use saturn_domain::research::is_id;
use saturn_domain::time::{iso_time, now_millis};
use serde_json::{Value, json};
use tokio::process::Command;

use super::runs::group_exists;
use crate::records::text;
use crate::{CoreError, Kernel};

/// How often a run is sampled.
const EVERY: Duration = Duration::from_secs(2);
/// The file in a run's folder that holds its samples.
const FILE: &str = "resources.jsonl";
/// How many of the newest points a reading gives.
const POINTS_KEPT: usize = 900;

/// The processor share and memory of every process in a group, added up.
async fn group_usage(pgid: u32) -> Option<(f64, u64, u64)> {
    let output = Command::new("ps")
        .args(["-axo", "pid=,pgid=,%cpu=,rss="])
        .output()
        .await
        .ok()?;
    let mut cpu = 0.0;
    let mut memory = 0;
    let mut processes = 0;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line.split_whitespace();
        let (Some(_pid), Some(group), Some(share), Some(resident)) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        if group.parse::<u32>().ok() != Some(pgid) {
            continue;
        }
        processes += 1;
        cpu += share.parse::<f64>().unwrap_or(0.0);
        memory += resident.parse::<u64>().unwrap_or(0) * 1024;
    }
    Some((cpu, memory, processes))
}

/// Each GPU's load and memory, when `nvidia-smi` is on this computer. `None` when it is not or it fails.
async fn gpus() -> Option<Vec<Value>> {
    let output = Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,utilization.gpu,memory.used,memory.total",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let mebibyte = 1024 * 1024;
    Some(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let fields: Vec<&str> = line.split(',').map(str::trim).collect();
                let [name, load, used, total] = fields[..] else {
                    return None;
                };
                Some(json!({
                    "name": name,
                    "utilizationPercent": load.parse::<f64>().ok(),
                    "memoryUsedBytes": used.parse::<u64>().ok().map(|value| value * mebibyte),
                    "memoryTotalBytes": total.parse::<u64>().ok().map(|value| value * mebibyte),
                }))
            })
            .collect(),
    )
}

/// How many sample lines a file holds, counted from where the last count stopped.
fn count_lines(path: &Path, from: u64, known: u64) -> (u64, u64) {
    let Ok(file) = std::fs::File::open(path) else {
        return (from, known);
    };
    let size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    if size <= from {
        return (from, known);
    }
    let mut reader = BufReader::new(file);
    if std::io::Seek::seek(&mut reader, std::io::SeekFrom::Start(from)).is_err() {
        return (from, known);
    }
    let mut lines = known;
    let mut read = from;
    let mut buffer = Vec::new();
    while let Ok(bytes) = reader.read_until(b'\n', &mut buffer) {
        if bytes == 0 || buffer.last() != Some(&b'\n') {
            break;
        }
        lines += 1;
        read += bytes as u64;
        buffer.clear();
    }
    (read, lines)
}

/// This computer, as the readings are measured against it.
fn system() -> Value {
    json!({
        "cpus": std::thread::available_parallelism().map(usize::from).unwrap_or(0),
        "platform": std::env::consts::OS,
    })
}

impl Kernel {
    /// Samples a run's group until it is gone, appending to the run's folder. Started when the run starts.
    pub(super) fn sample_resources(self: &Arc<Self>, pid: u32, directory: PathBuf) {
        let started = Instant::now();
        let samples = directory.join("samples.jsonl");
        let file = directory.join(FILE);
        tokio::spawn(async move {
            let mut counted = (0, 0);
            let mut gpu_present = true;
            loop {
                if !group_exists(pid) {
                    break;
                }
                let usage = group_usage(pid).await;
                let gpu = if gpu_present { gpus().await } else { None };
                gpu_present = gpu.is_some();
                let path = samples.clone();
                let (from, known) = counted;
                counted = tokio::task::spawn_blocking(move || count_lines(&path, from, known))
                    .await
                    .unwrap_or(counted);
                let point = json!({
                    "at": iso_time(now_millis()),
                    "elapsedMs": started.elapsed().as_millis() as u64,
                    "cpuPercent": usage.map(|(cpu, _, _)| cpu),
                    "memoryBytes": usage.map(|(_, memory, _)| memory),
                    "processes": usage.map(|(_, _, count)| count),
                    "samplesBytes": counted.0,
                    "samplesLines": counted.1,
                    "gpus": gpu,
                });
                let line = format!("{point}\n");
                let target = file.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    use std::io::Write;
                    std::fs::OpenOptions::new()
                        .append(true)
                        .create(true)
                        .open(target)
                        .and_then(|mut handle| handle.write_all(line.as_bytes()))
                })
                .await;
                tokio::time::sleep(EVERY).await;
            }
        });
    }

    /// What a run has cost so far, or cost in all: the newest points, and this computer.
    pub async fn research_resources(&self, project: &str, run: &str) -> Result<Value, CoreError> {
        if !is_id(run) {
            return Err(CoreError::new(404, "No such run"));
        }
        let record = self.research_run(project, run).await?;
        let records = self.records_folder(project).await?;
        let path = records.join("runs").join(run).join(FILE);
        let points = tokio::task::spawn_blocking(move || {
            let Ok(file) = std::fs::File::open(&path) else {
                return Vec::new();
            };
            let mut points: Vec<Value> = BufReader::new(file)
                .lines()
                .map_while(Result::ok)
                .filter_map(|line| serde_json::from_str(&line).ok())
                .collect();
            if points.len() > POINTS_KEPT {
                points.drain(..points.len() - POINTS_KEPT);
            }
            points
        })
        .await
        .map_err(|error| CoreError::new(500, error.to_string()))?;
        Ok(json!({
            "runId": run,
            "status": text(&record, "status"),
            "system": system(),
            "points": points,
        }))
    }
}
