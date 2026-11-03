use std::fs;
use std::io::{self, Write};
use std::path::Path;

use subtle::ConstantTimeEq;

const MINIMUM_TOKEN_LENGTH: usize = 32;

/// The shared secret every local client must present, kept in the data folder where only this user can read it. A
/// token from the launcher wins; otherwise the saved one is reused, so a running client keeps working over restarts.
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
    // Not truncated on open: an existing file may have a looser mode, so it is tightened before anything is written.
    options.write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut opened = options.open(file)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        opened.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    opened.set_len(0)?;
    opened.write_all(contents.as_bytes())
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

    #[cfg(unix)]
    #[test]
    fn rewriting_a_loose_token_file_tightens_it_and_replaces_the_contents() {
        use std::os::unix::fs::PermissionsExt;

        let folder = std::env::temp_dir().join(format!("saturn-auth-test-{}", std::process::id()));
        fs::create_dir_all(&folder).unwrap();
        let file = folder.join("runtime-token");
        fs::write(&file, "a much longer value than the new one").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();

        write_private(&file, "new").unwrap();

        assert_eq!(fs::read_to_string(&file).unwrap(), "new");
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_dir_all(&folder).unwrap();
    }
}
