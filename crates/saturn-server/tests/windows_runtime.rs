//! On Windows the runtime must start on a computer that has no Visual C++ runtime installed.
#![cfg(windows)]

/// The built runtime names no Visual C++ runtime library to load. A program that does shows "VCRUNTIME140.dll was not
/// found" on a clean Windows instead of starting, as the packaged runtime did up to 0.6.1.
#[test]
fn the_runtime_needs_no_visual_c_runtime() {
    let program = std::fs::read(env!("CARGO_BIN_EXE_saturn-server")).expect("the built runtime");
    let upper = program.to_ascii_uppercase();
    for library in ["vcruntime140", "msvcp140"] {
        let name = library.to_ascii_uppercase();
        assert!(
            !upper
                .windows(name.len())
                .any(|part| part == name.as_bytes()),
            "saturn-server.exe loads {library}.dll, which Windows does not have unless something installed it"
        );
    }
}
