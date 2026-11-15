//! The Windows sandbox launcher's command line: any line is split or refused, any argument decoded or refused, and a
//! policy that decodes encodes back to the same argument.
#![no_main]
use libfuzzer_sys::fuzz_target;
use saturn_appcontainer::{Policy, split_command_line};

fuzz_target!(|data: &[u8]| {
    let line: Vec<u16> = data
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair))
        .collect();
    if let Some((argument, rest)) = split_command_line(&line) {
        assert!(rest <= line.len(), "the rest starts inside the line");
        if let Some(policy) = Policy::decoded(&argument) {
            assert_eq!(
                Policy::decoded(&policy.encoded()).map(|again| again.encoded()),
                Some(policy.encoded())
            );
        }
    }
    if let Ok(text) = std::str::from_utf8(data) {
        let _ = Policy::decoded(text);
    }
});
