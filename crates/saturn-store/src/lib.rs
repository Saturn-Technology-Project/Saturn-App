//! Saturn's data folder, readable and writable by this runtime and by `runtime/` alike: `state.json`, and `secrets.json`
//! with its key in the operating system's key store. `contract/cases` holds the files both must agree on.
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
use std::time::{SystemTime, UNIX_EPOCH};

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
        file_time(SystemTime::now())
    );
    fs::copy(file, file.with_file_name(&name)).ok()?;
    Some(name)
}

/// A UTC time in a form file names can hold, like `2026-11-03T05-37-09-916Z`.
fn file_time(time: SystemTime) -> String {
    let elapsed = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = elapsed.as_secs();
    let (year, month, day) = civil_date((seconds / 86_400) as i64);
    let clock = seconds % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}-{:02}-{:02}-{:03}Z",
        clock / 3600,
        clock % 3600 / 60,
        clock % 60,
        elapsed.subsec_millis()
    )
}

/// The calendar date of a day counted from 1970-01-01 (Howard Hinnant's `civil_from_days`).
fn civil_date(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * shifted_month + 2) / 5 + 1) as u32;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    } as u32;
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn file_times_are_utc_calendar_times() {
        let at = |millis| UNIX_EPOCH + Duration::from_millis(millis);
        assert_eq!(file_time(at(0)), "1970-01-01T00-00-00-000Z");
        assert_eq!(file_time(at(1_709_210_096_789)), "2024-02-29T12-34-56-789Z");
        assert_eq!(file_time(at(1_793_450_229_916)), "2026-10-31T12-37-09-916Z");
    }
}
