//! What a hook program wrote to stdout: any text is read as a decision or as none, never a panic.
#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|text: &str| {
    let _ = workbench_domain::hooks::parse_answer(text);
});
