//! macOS permissions for computer use, asked by Saturn itself: macOS shows its own prompt and lists Saturn in System
//! Settings, so there is nothing to find or add by hand.
use serde::Serialize;

#[derive(Serialize)]
pub struct Answer {
    granted: bool,
}

#[cfg(target_os = "macos")]
pub fn request(which: &str) -> Answer {
    let granted = match which {
        "accessibility" => {
            macos_accessibility_client::accessibility::application_is_trusted_with_prompt()
        }
        "screenRecording" => {
            let access = core_graphics::access::ScreenCaptureAccess;
            access.preflight() || access.request()
        }
        _ => false,
    };
    Answer { granted }
}

#[cfg(not(target_os = "macos"))]
pub fn request(_which: &str) -> Answer {
    Answer { granted: true }
}
