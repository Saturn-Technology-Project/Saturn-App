//! A stand-in for another program, for the contract tests on Windows. On macOS and Linux a test's stand-in for
//! `claude`, `codex`, `uv` or `python` is a script with the program's name. Windows starts only `.exe` files by a bare
//! name, so there a test copies this program under the name it needs and puts the script beside it: `claude.exe` runs
//! `claude.cjs` with Node, hands it its own arguments, input and output, and ends with its exit code. The Node to use
//! is named in `claude.node`, since the runtime does not hand every program its PATH. Nothing in Saturn uses this.
use std::process::{Command, exit};

fn main() {
    let own = match std::env::current_exe() {
        Ok(own) => own,
        Err(error) => {
            eprintln!("the stand-in cannot tell where it is: {error}");
            exit(127);
        }
    };
    let script = own.with_extension("cjs");
    let node = std::fs::read_to_string(own.with_extension("node"))
        .map(|named| named.trim().to_owned())
        .unwrap_or_else(|_| "node".to_owned());
    match Command::new(&node)
        .arg(&script)
        .args(std::env::args_os().skip(1))
        .status()
    {
        Ok(status) => exit(status.code().unwrap_or(1)),
        Err(error) => {
            eprintln!(
                "the stand-in could not start {node} for {}: {error}",
                script.display()
            );
            exit(127);
        }
    }
}
