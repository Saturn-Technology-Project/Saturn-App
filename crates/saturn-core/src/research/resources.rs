//! What a run costs while it lives: its process group's processor time and memory, the GPUs when `nvidia-smi` can
//! say, and how fast its samples file grows. Sampled every two seconds into the run's folder, never interpreted.
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use saturn_domain::research::is_id;
use saturn_domain::time::{iso_time, now_millis};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
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

/// What the samples file has said so far: how far it was read, how many lines, the tokens the program reported under
/// `usage`, and the device memory it last reported holding.
#[derive(Clone, Copy, Default)]
struct Counted {
    read: u64,
    lines: u64,
    input_tokens: u64,
    output_tokens: u64,
    device_memory: Option<u64>,
    stamp: Option<FileStamp>,
    prefix: [u8; 32],
    rewrites: u64,
}

/// Metadata lets an unchanged file skip reading; a changed file's consumed prefix is verified before reusing counts.
#[derive(Clone, Copy, PartialEq, Eq)]
struct FileStamp {
    size: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

impl FileStamp {
    /// The metadata that changes when samples are edited or the file is replaced.
    fn from(metadata: &std::fs::Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            size: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            identity: (
                metadata.dev(),
                metadata.ino(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            ),
        }
    }
}

/// Counts appended complete lines; truncation or a changed prefix starts fresh and records the protocol violation.
fn count_lines(path: &Path, mut counted: Counted) -> Counted {
    let Ok(mut file) = std::fs::File::open(path) else {
        return counted;
    };
    let Ok(metadata) = file.metadata() else {
        return counted;
    };
    let stamp = FileStamp::from(&metadata);
    if counted.stamp == Some(stamp) {
        return counted;
    }
    let mut hash = Sha256::new();
    let mut remaining = counted.read;
    let mut chunk = [0_u8; 64 * 1024];
    while remaining > 0 {
        let room = remaining.min(chunk.len() as u64) as usize;
        let Ok(read) = file.read(&mut chunk[..room]) else {
            return counted;
        };
        if read == 0 {
            break;
        }
        hash.update(&chunk[..read]);
        remaining -= read as u64;
    }
    if counted.stamp.is_some()
        && (remaining > 0 || <[u8; 32]>::from(hash.clone().finalize()) != counted.prefix)
    {
        counted = Counted {
            rewrites: counted.rewrites + 1,
            ..Counted::default()
        };
        if file.seek(SeekFrom::Start(0)).is_err() {
            return counted;
        }
        hash = Sha256::new();
    }
    let mut reader = BufReader::new(file);
    let mut buffer = Vec::new();
    while let Ok(bytes) = reader.read_until(b'\n', &mut buffer) {
        if bytes == 0 || buffer.last() != Some(&b'\n') {
            break;
        }
        counted.lines += 1;
        counted.read += bytes as u64;
        hash.update(&buffer);
        if let Ok(line) = serde_json::from_slice::<Value>(&buffer)
            && let Some(usage) = line.get("usage").and_then(Value::as_object)
        {
            let count = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
            counted.input_tokens += count("inputTokens");
            counted.output_tokens += count("outputTokens");
            if let Some(held) = usage.get("deviceMemoryBytes").and_then(Value::as_u64) {
                counted.device_memory = Some(held);
            }
        }
        buffer.clear();
    }
    counted.stamp = Some(stamp);
    counted.prefix = hash.finalize().into();
    counted
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
            let mut counted = Counted::default();
            let mut gpu_present = true;
            loop {
                if !group_exists(pid) {
                    break;
                }
                let usage = group_usage(pid).await;
                let gpu = if gpu_present { gpus().await } else { None };
                gpu_present = gpu.is_some();
                let path = samples.clone();
                let before = counted;
                counted = tokio::task::spawn_blocking(move || count_lines(&path, before))
                    .await
                    .unwrap_or(counted);
                let point = json!({
                    "at": iso_time(now_millis()),
                    "elapsedMs": started.elapsed().as_millis() as u64,
                    "cpuPercent": usage.map(|(cpu, _, _)| cpu),
                    "memoryBytes": usage.map(|(_, memory, _)| memory),
                    "processes": usage.map(|(_, _, count)| count),
                    "samplesBytes": counted.read,
                    "samplesLines": counted.lines,
                    "samplesRewrites": counted.rewrites,
                    "inputTokens": counted.input_tokens,
                    "outputTokens": counted.output_tokens,
                    "deviceMemoryBytes": counted.device_memory,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn counts_follow_truncation_same_size_and_larger_rewrites() {
        let folder = std::env::temp_dir().join(saturn_domain::new_id("research_counts").unwrap());
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join("samples.jsonl");
        let line = |name, tokens| {
            format!(
                "{}\n",
                json!({"sampleId": name, "usage": {"inputTokens": tokens, "outputTokens": tokens, "deviceMemoryBytes": tokens}})
            )
        };
        std::fs::write(&path, line("a", 10).repeat(3)).unwrap();
        let before = count_lines(&path, Counted::default());
        assert_eq!((before.lines, before.input_tokens), (3, 30));
        std::fs::write(&path, line("b", 90)).unwrap();
        let shorter = count_lines(&path, before);
        assert_eq!(
            (shorter.lines, shorter.input_tokens, shorter.device_memory),
            (1, 90, Some(90))
        );
        std::fs::write(&path, line("c", 70)).unwrap();
        let same_size = count_lines(&path, shorter);
        assert_eq!((same_size.lines, same_size.input_tokens), (1, 70));
        std::fs::write(&path, line("d", 50).repeat(5)).unwrap();
        let larger = count_lines(&path, same_size);
        assert_eq!((larger.lines, larger.input_tokens), (5, 250));
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        let last = line("e", 20);
        file.write_all(&last.as_bytes()[..last.len() - 1]).unwrap();
        let partial = count_lines(&path, larger);
        assert_eq!((partial.lines, partial.input_tokens), (5, 250));
        file.write_all(b"\n").unwrap();
        let appended = count_lines(&path, partial);
        assert_eq!((appended.lines, appended.input_tokens), (6, 270));
        std::fs::remove_dir_all(folder).unwrap();
    }
}
