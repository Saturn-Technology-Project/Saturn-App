use tauri_build::{AppManifest, Attributes};

/// Listing the commands makes each one need a permission, so only Saturn's own pages can call them. Otherwise any page
/// the app shows in an iframe could.
const COMMANDS: &[&str] = &[
    "pick_folders",
    "start_dragging",
    "toggle_maximize",
    "minimize_window",
    "close_window",
    "notify",
    "request_permission",
];

fn main() {
    tauri_build::try_build(Attributes::new().app_manifest(AppManifest::new().commands(COMMANDS)))
        .expect("the Tauri build step runs");
}
