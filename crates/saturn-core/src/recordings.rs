//! The screencasts a run recorded with the browser tools: JPEG or PNG frames under `<data>/workspace/recordings/<name>/`.
//! The apps play the frames themselves; ffmpeg, when installed, turns one into an MP4.
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use crate::records::text;
use crate::{CoreError, Kernel};

/// How long an export may take.
const EXPORT_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// A path with `.` and `..` worked out by its spelling.
fn normalized(path: &Path) -> PathBuf {
    let mut plain = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                plain.pop();
            }
            other => plain.push(other.as_os_str()),
        }
    }
    plain
}

/// Whether a file name is a frame's.
fn is_frame(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("frame-") else {
        return false;
    };
    let digits = rest
        .strip_suffix(".jpg")
        .or_else(|| rest.strip_suffix(".png"));
    digits.is_some_and(|digits| {
        !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
    })
}

impl Kernel {
    fn recordings_root(&self) -> PathBuf {
        self.store.root().join("workspace").join("recordings")
    }

    /// A recording folder from a tool result, only when it is one of Saturn's own under the data directory.
    fn recording_folder(&self, recorded: &str) -> Option<PathBuf> {
        let full = normalized(Path::new(recorded));
        let root = self.recordings_root();
        (full.parent() == Some(root.as_path()) && full.is_dir()).then_some(full)
    }

    /// The folders of the recordings a run's completed browser_record_stop results point at.
    fn recording_folders(&self, run_id: &str) -> Result<Vec<PathBuf>, CoreError> {
        let run = self.get_run(run_id)?;
        Ok(run["actions"]
            .as_array()
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .filter(|action| {
                text(action, "toolId") == "browser_record_stop"
                    && text(action, "status") == "completed"
            })
            .filter_map(|action| {
                action["result"]["recording"]
                    .as_str()
                    .and_then(|recorded| self.recording_folder(recorded))
            })
            .collect())
    }

    /// The recordings a run's browser_record_stop results point at, with their frame counts.
    pub fn recordings(&self, run_id: &str) -> Result<Vec<Value>, CoreError> {
        let run = self.get_run(run_id)?;
        let mut found: Vec<Value> = Vec::new();
        for action in run["actions"].as_array().map_or(&[][..], Vec::as_slice) {
            if text(action, "toolId") != "browser_record_stop"
                || text(action, "status") != "completed"
            {
                continue;
            }
            let result = &action["result"];
            let Some(folder) = result["recording"]
                .as_str()
                .and_then(|recorded| self.recording_folder(recorded))
            else {
                continue;
            };
            let name = folder
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            if found.iter().any(|item| item["name"] == name.as_str()) {
                continue;
            }
            let frames = std::fs::read_dir(&folder).map_or(0, |entries| {
                entries
                    .flatten()
                    .filter(|entry| is_frame(&entry.file_name().to_string_lossy()))
                    .count()
            });
            let mut item = json!({ "name": name, "frames": frames });
            if result["seconds"].is_number() {
                item["seconds"] = result["seconds"].clone();
            }
            item["exported"] = json!(folder.join("out.mp4").exists());
            found.push(item);
        }
        Ok(found)
    }

    /// A recording of the run by name, or why not.
    fn recording(&self, run_id: &str, name: &str) -> Result<Value, CoreError> {
        self.recordings(run_id)?
            .into_iter()
            .find(|item| item["name"] == name)
            .ok_or_else(|| CoreError::new(404, "This run has no such recording"))
    }

    /// The path of one frame (1-based index) of a run's recording.
    pub fn recording_frame(
        &self,
        run_id: &str,
        name: &str,
        index: &str,
    ) -> Result<PathBuf, CoreError> {
        let recording = self.recording(run_id, name)?;
        let total = recording["frames"].as_u64().unwrap_or(0);
        // The folder as found among the run's own recordings: the name asked for is only compared, never joined.
        let folder = self
            .recording_folders(run_id)?
            .into_iter()
            .find(|folder| folder.file_name().is_some_and(|found| found == name))
            .ok_or_else(|| CoreError::new(404, "This run has no such recording"))?;
        let index = index
            .parse::<u64>()
            .ok()
            .filter(|index| (1..=total).contains(index))
            .ok_or_else(|| CoreError::new(404, "No such frame"))?;
        // Chrome records JPEGs, Safari PNGs.
        let base = folder.join(format!("frame-{index:05}"));
        let jpeg = base.with_extension("jpg");
        Ok(if jpeg.exists() {
            jpeg
        } else {
            base.with_extension("png")
        })
    }

    /// Writes out.mp4 next to the frames with ffmpeg (10 fps), or says ffmpeg is missing.
    pub async fn export_recording(
        self: &Arc<Self>,
        run_id: &str,
        name: &str,
    ) -> Result<Value, CoreError> {
        self.recording(run_id, name)?;
        let folder = self.recordings_root().join(name);
        let target = folder.join("out.mp4");
        if !target.exists() {
            let mut command = tokio::process::Command::new("ffmpeg");
            command
                .args([
                    "-y",
                    "-f",
                    "concat",
                    "-safe",
                    "0",
                    "-i",
                    "frames.txt",
                    "-r",
                    "10",
                    "-pix_fmt",
                    "yuv420p",
                    "-vf",
                    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                    "out.mp4",
                ])
                .current_dir(&folder)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            let output = match command.spawn() {
                Ok(child) => tokio::time::timeout(EXPORT_TIMEOUT, child.wait_with_output()).await,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Err(CoreError::new(
                        409,
                        "ffmpeg is not installed; install it (brew install ffmpeg) to export MP4s. The frames play in the app without it.",
                    ));
                }
                Err(error) => return Err(CoreError::new(500, format!("ffmpeg failed: {error}"))),
            };
            match output {
                Ok(Ok(finished)) if finished.status.success() => {}
                Ok(Ok(finished)) => {
                    let said = String::from_utf8_lossy(&finished.stderr);
                    let last = said.lines().last().unwrap_or_default();
                    return Err(CoreError::new(500, format!("ffmpeg failed: {last}")));
                }
                Ok(Err(error)) => {
                    return Err(CoreError::new(500, format!("ffmpeg failed: {error}")));
                }
                Err(_) => return Err(CoreError::new(500, "ffmpeg failed: it took too long")),
            }
        }
        Ok(json!({ "path": target.to_string_lossy() }))
    }
}
