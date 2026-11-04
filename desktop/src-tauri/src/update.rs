//! Updates from GitHub Releases: downloaded in the background and installed when Saturn quits. The package must carry a signature
//! from Saturn's updater key; a build made without that key has no updater at all (see `tauri.updater.json`).
use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// A checked download waiting for the app to quit.
#[derive(Default)]
pub struct Waiting(Mutex<Option<(Update, Vec<u8>)>>);

/// Looks for a newer version and downloads it. Only logs what happens: an offline Saturn works as usual.
pub async fn check(app: AppHandle) {
    if std::env::var_os("SATURN_NO_UPDATES").is_some() {
        return;
    }
    let found = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };
    let update = match found {
        Ok(Some(update)) => update,
        Ok(None) => return,
        Err(error) => {
            eprintln!("[updates] check failed: {error}");
            return;
        }
    };
    match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => {
            eprintln!(
                "[updates] {} downloaded; it installs when Saturn quits",
                update.version
            );
            *app.state::<Waiting>()
                .0
                .lock()
                .expect("the update lock is not poisoned") = Some((update, bytes));
        }
        Err(error) => eprintln!("[updates] download failed: {error}"),
    }
}

/// Installs what was downloaded, as the app quits. On Windows this hands over to the installer.
pub fn install_waiting(app: &AppHandle) {
    let waiting = app.try_state::<Waiting>().and_then(|state| {
        state
            .0
            .lock()
            .expect("the update lock is not poisoned")
            .take()
    });
    if let Some((update, bytes)) = waiting
        && let Err(error) = update.install(bytes)
    {
        eprintln!("[updates] install failed: {error}");
    }
}
