//! Puts the `saturn` command on the user's PATH: a small launcher in ~/.local/bin that runs the `saturn` program next to this
//! runtime, so it needs no separate install and always matches the app's version.
use std::path::PathBuf;

use serde_json::{Value, json};

use crate::CoreError;

const DEFAULT_PORT: &str = "4700";

fn home() -> Result<PathBuf, CoreError> {
    std::env::home_dir().ok_or_else(|| CoreError::new(500, "No home folder"))
}

fn launcher_folder() -> Result<PathBuf, CoreError> {
    Ok(home()?.join(".local").join("bin"))
}

fn launcher_path() -> Result<PathBuf, CoreError> {
    Ok(launcher_folder()?.join(if cfg!(windows) {
        "saturn.cmd"
    } else {
        "saturn"
    }))
}

/// The `saturn` program next to this runtime.
fn program() -> Result<PathBuf, CoreError> {
    let this = std::env::current_exe().map_err(|error| CoreError::new(500, error.to_string()))?;
    let folder = this
        .parent()
        .ok_or_else(|| CoreError::new(500, "The runtime has no folder"))?;
    Ok(folder.join(if cfg!(windows) {
        "saturn.exe"
    } else {
        "saturn"
    }))
}

/// What a runtime on another port or data folder (a second Saturn, a test copy) adds, so the launcher points at it.
fn extra_environment() -> Vec<(&'static str, String)> {
    let mut extra = Vec::new();
    if let Ok(port) = std::env::var("SATURN_RUNTIME_PORT")
        && !port.is_empty()
        && port != DEFAULT_PORT
    {
        extra.push(("SATURN_RUNTIME_PORT", port));
    }
    if let Ok(folder) = std::env::var("SATURN_DATA_DIR")
        && !folder.is_empty()
    {
        extra.push(("SATURN_DATA_DIR", folder));
    }
    extra
}

/// The launcher's text for this system and this runtime.
fn launcher_script() -> Result<String, CoreError> {
    let program = program()?;
    let program = program.to_string_lossy();
    let extra = extra_environment();
    if cfg!(windows) {
        let sets: String = extra
            .iter()
            .map(|(key, value)| format!("@set \"{key}={value}\"\r\n"))
            .collect();
        return Ok(format!(
            "@rem Saturn command line: runs the Saturn app's own CLI. Written by Saturn (Settings → General).\r\n@setlocal\r\n{sets}@\"{program}\" %*\r\n"
        ));
    }
    let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
    let exports: String = extra
        .iter()
        .map(|(key, value)| format!("export {key}={}\n", quote(value)))
        .collect();
    Ok(format!(
        "#!/bin/sh\n# Saturn command line: runs the Saturn app's own CLI. Written by Saturn (Settings → General).\n{exports}exec {} \"$@\"\n",
        quote(&program)
    ))
}

/// Whether the launcher is installed, current and reachable.
pub async fn cli_status() -> Result<Value, CoreError> {
    let file = launcher_path()?;
    let folder = launcher_folder()?;
    let written = tokio::fs::read_to_string(&file).await;
    let installed = tokio::fs::metadata(&file).await.is_ok();
    let current = written.is_ok_and(|text| launcher_script().is_ok_and(|wanted| wanted == text));
    let on_path = std::env::var_os("PATH")
        .is_some_and(|path| std::env::split_paths(&path).any(|entry| entry == folder));
    Ok(json!({
        "path": file.to_string_lossy(),
        "installed": installed,
        "current": current,
        "onPath": on_path,
        "folder": folder.to_string_lossy(),
    }))
}

/// Writes the launcher.
pub async fn install_cli() -> Result<Value, CoreError> {
    let file = launcher_path()?;
    let unwritable = |error: std::io::Error| CoreError::new(500, error.to_string());
    if let Some(parent) = file.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(unwritable)?;
    }
    tokio::fs::write(&file, launcher_script()?)
        .await
        .map_err(unwritable)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755))
            .await
            .map_err(unwritable)?;
    }
    cli_status().await
}
