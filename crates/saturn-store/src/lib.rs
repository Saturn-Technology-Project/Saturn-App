//! Saturn's data folder, in the format earlier versions wrote, so their data stays readable: `state.json`, and `secrets.json`
//! with its key in the operating system's key store. `contract/cases` holds files written by those versions.
pub mod json;
pub mod key_store;
pub mod secrets;
pub mod state;
pub mod store;

pub use secrets::{Secrets, SecretsFile, SecretsProtection};
pub use state::AppState;
pub use store::FileStore;

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

use saturn_domain::time::{iso_time, now_millis};

/// A file only this user can read, replaced whole so a crash leaves the old one or the new one and never half of either.
pub(crate) fn write_private(file: &Path, contents: &[u8]) -> io::Result<()> {
    let mut temporary = file.as_os_str().to_owned();
    temporary.push(".tmp");
    let temporary = Path::new(&temporary);
    // A leftover from a crash may have other permissions, and opening it would keep them.
    match fs::remove_file(temporary) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut output = options.open(temporary)?;
    output.write_all(contents)?;
    drop(output);
    fs::rename(temporary, file)
}

/// Copies a file Saturn cannot use next to itself, named `<file>.<reason>-<time>`, so that starting fresh loses nothing.
/// Returns the copy's name for the log.
pub(crate) fn set_aside(file: &Path, reason: &str) -> Option<String> {
    let name = format!(
        "{}.{reason}-{}",
        file.file_name()?.to_string_lossy(),
        iso_time(now_millis()).replace([':', '.'], "-")
    );
    fs::copy(file, file.with_file_name(&name)).ok()?;
    Some(name)
}
