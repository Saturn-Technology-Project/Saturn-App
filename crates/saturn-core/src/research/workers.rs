//! Saturn's worker on an SSH host: finding the one that matches this Saturn, and installing it when the person asks.
//! A worker is this version's `saturn-server`, kept at `~/.saturn/worker/<version>/saturn-server` on the host. It comes
//! from this computer when the host is the same kind of system, and otherwise from this version's release, checked
//! against the hash built into this Saturn before it is sent; the host then hashes what arrived. Nothing is installed
//! without the person asking, and nothing needs administrator rights on the host.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use saturn_domain::research::sha256_hex;
use saturn_telemetry::network::{SendNoted, client_builder};
use saturn_tools::run_captured;
use serde_json::{Value, json};

use super::remote::{check_target, quoted, rpc, ssh, ssh_env};
use crate::records::text;
use crate::{CoreError, Kernel};

/// This Saturn's version: a worker must be the same.
pub(super) const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The workers' hashes the release workflow builds in, as `linux-x64=<sha256>,linux-arm64=<sha256>`. A build without
/// them (a developer's) reads `SATURN_WORKER_SHA256` instead; a release never does.
const PINNED: Option<&str> = option_env!("SATURN_WORKER_SHA256");

/// Where a release's workers are downloaded from, unless `SATURN_WORKER_DOWNLOAD` names a mirror. What arrives is checked
/// against the pinned hash either way.
const RELEASES: &str = "https://github.com/Saturn-Technology-Project/Saturn-App/releases/download";

/// How long probing a host may take.
const PROBE_LIMIT: Duration = Duration::from_secs(20);
/// How long sending a worker may take; it is tens of megabytes.
const UPLOAD_LIMIT: Duration = Duration::from_secs(15 * 60);
/// The largest worker accepted from a download. A release's is tens of megabytes; a developer's build with its debug
/// information can be hundreds.
const LARGEST: u64 = 1024 * 1024 * 1024;

/// The kind of system a worker is built for, from what `uname -s` and `uname -m` say on the host.
fn target_of(system: &str, machine: &str) -> Option<&'static str> {
    match (system, machine) {
        ("Linux", "x86_64" | "amd64") => Some("linux-x64"),
        ("Linux", "aarch64" | "arm64") => Some("linux-arm64"),
        ("Darwin", "arm64") => Some("macos-arm64"),
        _ => None,
    }
}

/// The kind of system this computer is, as a worker's target.
fn this_target() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("macos", "aarch64") => Some("macos-arm64"),
        _ => None,
    }
}

/// The hash each target's worker must have.
fn pins() -> HashMap<String, String> {
    let given = PINNED
        .map(str::to_owned)
        .or_else(|| std::env::var("SATURN_WORKER_SHA256").ok())
        .unwrap_or_default();
    given
        .split(',')
        .filter_map(|pair| pair.split_once('='))
        .map(|(target, hash)| (target.trim().to_owned(), hash.trim().to_ascii_lowercase()))
        .filter(|(_, hash)| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .collect()
}

/// What a probe of the host found.
struct Found {
    target: Option<&'static str>,
    system: String,
    machine: String,
    path: String,
    present: bool,
}

/// The shell script a host runs, wrapped so it is the POSIX shell that runs it whatever the user's login shell is.
fn script(body: &str) -> String {
    format!("exec /bin/sh -c {}", quoted(body))
}

/// Asks the host what it is and whether this version's worker is there, in one SSH exchange.
async fn probe(host: &str) -> Result<Found, CoreError> {
    let body = format!(
        "p=\"$HOME/.saturn/worker/{VERSION}/saturn-server\"; uname -s; uname -m; printf '%s\\n' \"$p\"; if [ -x \"$p\" ]; then echo present; else echo missing; fi"
    );
    let answer = run_captured(
        &ssh(host, script(&body)),
        Path::new("."),
        &ssh_env(),
        b"",
        PROBE_LIMIT,
        64 * 1024,
    )
    .await;
    let lines: Vec<&str> = answer.stdout.lines().map(str::trim).collect();
    if answer.timed_out || answer.code != Some(0) || lines.len() < 4 {
        return Err(CoreError::new(
            502,
            "SSH did not answer. Check the host name, that you can sign in with `ssh` in a terminal without a password prompt, and that the host is in known_hosts.",
        ));
    }
    Ok(Found {
        target: target_of(lines[0], lines[1]),
        system: lines[0].to_owned(),
        machine: lines[1].to_owned(),
        path: lines[2].to_owned(),
        present: lines[3] == "present",
    })
}

/// Where the worker for a target comes from: this computer's own program when the host is the same kind, or the
/// release's checked download; none when neither is possible here.
fn source_for(target: &str) -> Option<&'static str> {
    if this_target() == Some(target) {
        Some("this computer")
    } else if pins().contains_key(target) {
        Some("release")
    } else {
        None
    }
}

impl Kernel {
    /// Finds this version's worker on the project's SSH host and says whether it is ready, missing or another version,
    /// and whether it can be installed from here. With `save`, a ready worker becomes the target's program, so runs use
    /// it; the assistant's look saves nothing.
    pub async fn research_remote_pair(
        &self,
        project: &str,
        save: bool,
    ) -> Result<Value, CoreError> {
        let settings = self.research_remote(project, None).await?;
        let mut target = settings["target"].clone();
        if !target.is_object() {
            return Err(CoreError::new(
                409,
                "Set the SSH host and the remote project folder in Environment first.",
            ));
        }
        // The host goes to ssh as it is, so it is checked as every SSH exchange checks it.
        check_target(&target)?;
        let host = text(&target, "host").to_owned();
        let found = probe(&host).await?;
        let mut answer = json!({
            "host": host,
            "system": found.system,
            "machine": found.machine,
            "target": found.target,
            "path": found.path,
            "version": VERSION,
        });
        let Some(kind) = found.target else {
            answer["state"] = json!("unsupported");
            answer["reason"] = json!(format!(
                "Saturn's worker runs on Linux (x86-64 or ARM) and Apple Silicon Macs, and this host is {} {}.",
                found.system, found.machine
            ));
            return Ok(answer);
        };
        answer["source"] = json!(source_for(kind));
        if !found.present {
            answer["state"] = json!("missing");
            if source_for(kind).is_none() {
                answer["reason"] = json!(
                    "This build of Saturn has no checked worker for that system. Install saturn-server of the same version on the host yourself, or use a released Saturn."
                );
            }
            return Ok(answer);
        }
        target["program"] = json!(found.path);
        match rpc(
            &target,
            &json!({ "action": "check", "workdir": target["workdir"] }),
        )
        .await
        {
            Ok(check) if text(&check, "version") == VERSION => {
                answer["state"] = json!("ready");
                answer["workdir"] = check["workdir"].clone();
                if save {
                    self.research_remote(project, Some(&target)).await?;
                }
            }
            Ok(check) => {
                answer["state"] = json!("wrong_version");
                answer["found"] = check["version"].clone();
            }
            Err(error) => {
                answer["state"] = json!("broken");
                answer["reason"] = json!(error.to_string());
            }
        }
        Ok(answer)
    }

    /// Installs this version's worker on the project's SSH host, as the person asked, and pairs with it. The worker is
    /// this computer's own program when the host is the same kind, or the release's download checked against the hash
    /// built into Saturn; the host hashes what arrived, and only an exact match is kept.
    pub async fn research_remote_install(&self, project: &str) -> Result<Value, CoreError> {
        let paired = self.research_remote_pair(project, true).await?;
        match text(&paired, "state") {
            "ready" => return Ok(paired),
            "missing" | "wrong_version" | "broken" => {}
            _ => {
                return Err(CoreError::new(409, text(&paired, "reason").to_owned()));
            }
        }
        let kind = text(&paired, "target").to_owned();
        let (program, expected) = match source_for(&kind) {
            Some("this computer") => {
                let program = std::env::current_exe()?;
                let bytes = tokio::fs::read(&program).await?;
                let hash = sha256_hex(&bytes);
                (bytes, hash)
            }
            Some(_) => {
                let expected = pins().remove(&kind).unwrap_or_default();
                let path = self.downloaded_worker(&kind, &expected).await?;
                (tokio::fs::read(&path).await?, expected)
            }
            None => {
                return Err(CoreError::new(409, text(&paired, "reason").to_owned()));
            }
        };
        let host = text(&paired, "host");
        // Written beside the place it goes, then moved there whole, so a dropped connection leaves no half program.
        let body = format!(
            "set -e; umask 077; d=\"$HOME/.saturn/worker/{VERSION}\"; mkdir -p \"$d\"; cat > \"$d/saturn-server.part\"; chmod 700 \"$d/saturn-server.part\"; mv -f \"$d/saturn-server.part\" \"$d/saturn-server\"; if command -v sha256sum >/dev/null 2>&1; then sha256sum \"$d/saturn-server\"; else shasum -a 256 \"$d/saturn-server\"; fi"
        );
        let answer = run_captured(
            &ssh(host, script(&body)),
            Path::new("."),
            &ssh_env(),
            &program,
            UPLOAD_LIMIT,
            64 * 1024,
        )
        .await;
        let arrived = answer
            .stdout
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if answer.timed_out || answer.code != Some(0) {
            return Err(CoreError::new(
                502,
                format!(
                    "The worker could not be sent to {host}: {}",
                    answer.stderr.trim().lines().last().unwrap_or("SSH failed")
                ),
            ));
        }
        if arrived != expected {
            let _ = run_captured(
                &ssh(
                    host,
                    script(&format!(
                        "rm -f \"$HOME/.saturn/worker/{VERSION}/saturn-server\""
                    )),
                ),
                Path::new("."),
                &ssh_env(),
                b"",
                PROBE_LIMIT,
                1024,
            )
            .await;
            return Err(CoreError::new(
                502,
                format!(
                    "What arrived on {host} is not the worker that was sent, so it was removed. Try again."
                ),
            ));
        }
        let mut done = self.research_remote_pair(project, true).await?;
        done["installed"] = json!(true);
        done["sha256"] = json!(expected);
        Ok(done)
    }

    /// The release's worker for a target, downloaded once into Saturn's data folder and kept only if its hash is the
    /// one built in.
    async fn downloaded_worker(&self, kind: &str, expected: &str) -> Result<PathBuf, CoreError> {
        let folder = self.store.root().join("workers").join(VERSION);
        let path = folder.join(format!("saturn-worker-{kind}"));
        if let Ok(bytes) = tokio::fs::read(&path).await
            && sha256_hex(&bytes) == expected
        {
            return Ok(path);
        }
        tokio::fs::create_dir_all(&folder).await?;
        let base = std::env::var("SATURN_WORKER_DOWNLOAD").unwrap_or_else(|_| RELEASES.to_owned());
        let url = format!(
            "{}/v{VERSION}/saturn-worker-{VERSION}-{kind}",
            base.trim_end_matches('/')
        );
        let client = client_builder()
            .read_timeout(Duration::from_secs(60))
            .build()
            .map_err(|error| CoreError::new(502, error.to_string()))?;
        let part = path.with_extension("part");
        let mut last = String::new();
        for attempt in 1..=3_u64 {
            match fetch(&client, &url, &part).await {
                Ok(hash) if hash == expected => {
                    tokio::fs::rename(&part, &path).await?;
                    return Ok(path);
                }
                Ok(_) => {
                    let _ = tokio::fs::remove_file(&part).await;
                    return Err(CoreError::new(
                        502,
                        "The downloaded worker is not the one this Saturn was built with, so it was not used.",
                    ));
                }
                Err(error) => last = error,
            }
            tokio::time::sleep(Duration::from_secs(2 * attempt)).await;
        }
        let _ = tokio::fs::remove_file(&part).await;
        Err(CoreError::new(
            502,
            format!("The worker could not be downloaded ({last})."),
        ))
    }
}

/// One whole download into `into`, bounded in size and hashed as it arrives, so even a large one is never held in memory.
/// Its SHA-256.
async fn fetch(client: &reqwest::Client, url: &str, into: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;
    let mut response = client
        .get(url)
        .send_noted()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "the release answered {}",
            response.status().as_u16()
        ));
    }
    let mut file = tokio::fs::File::create(into)
        .await
        .map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut received = 0_u64;
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        received += chunk.len() as u64;
        if received > LARGEST {
            return Err("the download is larger than any worker".to_owned());
        }
        hash.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|error| error.to_string())?;
    }
    file.flush().await.map_err(|error| error.to_string())?;
    Ok(saturn_domain::research::hex(&hash.finalize()))
}
