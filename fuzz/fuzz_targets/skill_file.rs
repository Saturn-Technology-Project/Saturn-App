//! A project's SKILL.md: any text is read as a skill, never a panic.
#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|text: &str| {
    let _ = workbench_domain::skill_files::parse_skill(text, "fallback");
});
