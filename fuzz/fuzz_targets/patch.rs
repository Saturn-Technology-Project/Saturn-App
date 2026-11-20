//! An agent's apply_patch document: any text is refused or read, never a panic.
#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|text: &str| {
    let _ = workbench_domain::skills::patch::parse_patch(text);
});
