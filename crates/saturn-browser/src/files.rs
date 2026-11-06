//! Where the browser's screenshots and recordings go.
use std::path::{Component, Path, PathBuf};

use saturn_domain::js;
use saturn_domain::time::now_millis;
use serde_json::Value;

/// A folder name for a recording: one plain name under recordings, or a new one when none is given.
pub(crate) fn recording_name(raw: Option<&Value>) -> String {
    let given = raw
        .and_then(Value::as_str)
        .map(js::trim)
        .unwrap_or_default();
    let plain: String = given
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect();
    let plain = plain.trim_start_matches('.');
    if plain.is_empty() {
        format!("recording-{:x}", now_millis())
    } else {
        plain.to_owned()
    }
}

/// `file` resolved against `root` by its spelling alone, without touching the disk.
fn resolved(root: &Path, file: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    for part in Path::new(file).components() {
        match part {
            Component::Prefix(_) | Component::RootDir => {
                path = PathBuf::from(part.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                path.pop();
            }
            Component::Normal(name) => path.push(name),
        }
    }
    path
}

/// Where a screenshot goes: under the workspace, also after following links, or refused.
pub async fn screenshot_path(data_dir: &Path, file: &str) -> Result<PathBuf, String> {
    let workspace = data_dir.join("workspace");
    let target = resolved(&workspace, file);
    let refused = || {
        format!(
            "A screenshot can only be saved in the workspace ({}).",
            workspace.display()
        )
    };
    if target == workspace || !target.starts_with(&workspace) {
        return Err(refused());
    }
    // The nearest part of the path that exists says where it really leads; a link to nowhere leads nowhere allowed.
    let root = tokio::fs::canonicalize(&workspace)
        .await
        .unwrap_or_else(|_| workspace.clone());
    let mut current = target.as_path();
    while current.starts_with(&workspace) {
        if tokio::fs::symlink_metadata(current).await.is_ok() {
            let real = tokio::fs::canonicalize(current)
                .await
                .map_err(|_| refused())?;
            if !real.starts_with(&root) {
                return Err(refused());
            }
            break;
        }
        let Some(parent) = current.parent() else {
            break;
        };
        current = parent;
    }
    Ok(target)
}

/// Saves a screenshot and says where.
pub(crate) async fn save_screenshot(
    data_dir: &Path,
    file: &str,
    bytes: &[u8],
) -> Result<Value, String> {
    let target = screenshot_path(data_dir, file).await?;
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    tokio::fs::write(&target, bytes)
        .await
        .map_err(|error| error.to_string())?;
    Ok(serde_json::json!({ "file": target.to_string_lossy(), "bytes": bytes.len() }))
}
