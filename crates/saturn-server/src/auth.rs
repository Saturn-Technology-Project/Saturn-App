use std::fs;
use std::io::{self, Write};
use std::path::Path;

use subtle::ConstantTimeEq;

const MINIMUM_TOKEN_LENGTH: usize = 32;

/// The shared secret every local client must present, kept in the data folder where only this user can read it. A
/// token from the launcher wins; otherwise the saved one is reused, so a running Saturn IDE keeps working over restarts.
pub fn load_or_create_token(data_dir: &Path, from_launcher: Option<&str>) -> io::Result<String> {
    let file = data_dir.join("runtime-token");
    if let Some(token) = from_launcher
        .map(str::trim)
        .filter(|token| token.len() >= MINIMUM_TOKEN_LENGTH)
    {
        // The launcher's token still works if it cannot be mirrored to disk.
        let _ = fs::create_dir_all(data_dir).and_then(|()| write_private(&file, token));
        return Ok(token.to_owned());
    }
    if let Ok(saved) = fs::read_to_string(&file) {
        let saved = saved.trim();
        if saved.len() >= MINIMUM_TOKEN_LENGTH {
            return Ok(saved.to_owned());
        }
    }
    fs::create_dir_all(data_dir)?;
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(io::Error::other)?;
    let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    write_private(&file, &token)?;
    Ok(token)
}

/// Writes a file only this user can read, on the platforms that have such a mode.
fn write_private(file: &Path, contents: &str) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(file)?.write_all(contents.as_bytes())?;
    // An existing file keeps its old mode through open, so set it as well.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(file, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Compares in constant time, so a wrong token cannot be guessed byte by byte from timing.
pub fn token_matches(expected: &str, provided: Option<&str>) -> bool {
    provided.is_some_and(|provided| expected.as_bytes().ct_eq(provided.as_bytes()).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_only_the_exact_token() {
        assert!(token_matches("secret", Some("secret")));
        assert!(!token_matches("secret", Some("secreT")));
        assert!(!token_matches("secret", Some("secret2")));
        assert!(!token_matches("secret", None));
    }
}
