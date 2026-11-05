//! The Saturn desktop app: starts the runtime and shows the interface in the system's web view.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod notify;
mod permissions;
mod runtime;
mod ui;
mod update;

use std::process::{Command, Stdio};
use std::sync::OnceLock;

use runtime::{Layout, Runtime, Status};
use serde::Deserialize;
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

pub(crate) const MAIN_WINDOW: &str = "main";
const BACKGROUND: tauri::window::Color = tauri::window::Color(0x1f, 0x1f, 0x1d, 0xff);

/// Where the interface is served, known once it is up.
static INTERFACE: OnceLock<u16> = OnceLock::new();

#[derive(Deserialize)]
struct FolderOptions {
    title: Option<String>,
    multiple: Option<bool>,
}

/// Workspace folders: the native picker, attached to the window that asked.
#[tauri::command]
async fn pick_folders(window: WebviewWindow, options: FolderOptions) -> Vec<String> {
    let dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title(options.title.unwrap_or_else(|| "Add Folder".to_owned()))
        .set_can_create_directories(true);
    let chosen = if options.multiple == Some(false) {
        dialog.blocking_pick_folder().map(|folder| vec![folder])
    } else {
        dialog.blocking_pick_folders()
    };
    chosen
        .unwrap_or_default()
        .iter()
        .filter_map(|folder| folder.as_path().map(|path| path.display().to_string()))
        .collect()
}

/// A yes or no question, in the system's own dialog attached to the window that asked.
#[tauri::command]
async fn confirm_action(window: WebviewWindow, message: String) -> bool {
    window
        .dialog()
        .message(message)
        .parent(&window)
        .title("Saturn")
        .buttons(MessageDialogButtons::OkCancel)
        .blocking_show()
}

/// Opens a web address in the user's browser. Links that open a new window end up here: the app has only its one window.
fn open_in_browser(address: &Url) {
    if !matches!(address.scheme(), "http" | "https") {
        return;
    }
    let (program, before): (&str, &[&str]) = if cfg!(target_os = "macos") {
        ("open", &[])
    } else if cfg!(windows) {
        ("rundll32", &["url.dll,FileProtocolHandler"])
    } else {
        ("xdg-open", &[])
    };
    let opened = Command::new(program)
        .args(before)
        .arg(address.as_str())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match opened {
        // Reaped in the background, since nothing waits for a browser to close.
        Ok(mut child) => {
            std::thread::spawn(move || child.wait());
        }
        Err(error) => eprintln!("Could not open the browser: {error}"),
    }
}

#[tauri::command]
fn start_dragging(window: WebviewWindow) -> tauri::Result<()> {
    window.start_dragging()
}

#[tauri::command]
fn toggle_maximize(window: WebviewWindow) -> tauri::Result<()> {
    if window.is_maximized()? {
        window.unmaximize()
    } else {
        window.maximize()
    }
}

#[tauri::command]
fn minimize_window(window: WebviewWindow) -> tauri::Result<()> {
    window.minimize()
}

#[tauri::command]
fn close_window(window: WebviewWindow) -> tauri::Result<()> {
    window.close()
}

/// A system notification; clicking it brings Saturn forward and opens the chat it names.
#[tauri::command]
fn notify(app: AppHandle, options: notify::Options) {
    notify::show(app, options);
}

/// Asks macOS for Accessibility or Screen Recording; elsewhere there is nothing to grant.
#[tauri::command]
fn request_permission(which: String) -> permissions::Answer {
    permissions::request(&which)
}

/// The window's title, which says the screen and project: it is what the system and computer use find the window by.
#[tauri::command]
fn set_window_title(window: WebviewWindow, title: String) -> tauri::Result<()> {
    let plain: String = title
        .chars()
        .filter(|item| !item.is_control())
        .take(200)
        .collect();
    window.set_title(&plain)
}

/// Where the runtime stands, for the interface's start-up screen and status line.
#[tauri::command]
fn runtime_status(app: AppHandle) -> Status {
    app.state::<Runtime>().status()
}

/// The user asks for the runtime to be started again.
#[tauri::command]
fn restart_runtime(app: AppHandle) {
    app.state::<Runtime>().restart();
}

/// The bridge script with this runtime's token and address filled in, for the interface at `interface` only.
fn bridge_script(runtime: &Runtime, interface: &Url) -> String {
    let quoted = |text: &str| serde_json::Value::from(text).to_string();
    include_str!("bridge.js")
        .replace(
            "__SATURN_INTERFACE__",
            &quoted(&interface.origin().ascii_serialization()),
        )
        .replace("__SATURN_TOKEN__", &quoted(&runtime.token()))
        .replace("__SATURN_ORIGIN__", &quoted(&runtime.origin()))
        .replace(
            "__SATURN_WINDOW_BUTTONS__",
            if cfg!(windows) { "true" } else { "false" },
        )
}

fn interface_url() -> Url {
    let port = INTERFACE
        .get()
        .copied()
        .expect("the interface is up before any window opens");
    Url::parse(&format!("http://127.0.0.1:{port}/")).expect("a loopback address is a valid URL")
}

/// Brings the window forward, opening it if it was closed.
pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let interface = interface_url();
    let script = bridge_script(&app.state::<Runtime>(), &interface);
    let builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::External(interface))
        .title("Saturn")
        .background_color(BACKGROUND)
        .disable_drag_drop_handler()
        // A hidden window keeps running: chats update and notifications arrive with Saturn in the background.
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .initialization_script(script)
        .on_new_window(|address, _| {
            open_in_browser(&address);
            NewWindowResponse::Deny
        })
        .inner_size(1320.0, 840.0)
        .min_inner_size(940.0, 620.0);
    // On macOS the traffic lights sit over the page's own title bar; on Windows the bridge draws the buttons.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 18.0))
        .hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);
    if let Err(error) = builder.build() {
        eprintln!("Could not open the Saturn window: {error}");
    }
}

/// Allows the commands to Saturn's own pages, at the exact port the interface got.
fn allow_interface_commands(app: &AppHandle, port: u16) -> tauri::Result<()> {
    let capability = serde_json::json!({
        "identifier": "interface",
        "windows": [MAIN_WINDOW],
        "remote": { "urls": [format!("http://127.0.0.1:{port}/*")] },
        "permissions": [
            "allow-pick-folders", "allow-confirm-action", "allow-start-dragging", "allow-toggle-maximize", "allow-minimize-window",
            "allow-close-window", "allow-notify", "allow-request-permission", "allow-runtime-status", "allow-restart-runtime", "allow-set-window-title",
        ],
    });
    app.add_capability(capability.to_string())
}

/// Starts everything in order: the runtime, the interface, then the window.
async fn start_up(app: AppHandle, layout: Layout) {
    // The runtime is kept up for as long as the app runs. The window opens as soon as it answers, or after a moment
    // anyway, and shows the runtime's state until it does.
    let supervised = app.clone();
    tauri::async_runtime::spawn(
        async move { supervised.state::<Runtime>().supervise(&layout).await },
    );
    let began = std::time::Instant::now();
    while began.elapsed() < std::time::Duration::from_secs(3) && !app.state::<Runtime>().is_ready()
    {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let port = if cfg!(debug_assertions) {
        Ok(5174)
    } else {
        ui::serve(app.clone()).await
    };
    let port = match port {
        Ok(port) => port,
        Err(error) => {
            eprintln!("Could not serve the interface: {error}");
            app.exit(1);
            return;
        }
    };
    let _ = INTERFACE.set(port);
    if let Err(error) = allow_interface_commands(&app, port) {
        eprintln!("Could not allow the interface's commands: {error}");
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || show_main_window(&handle));
}

fn main() {
    let context = tauri::generate_context!();
    // Only a build made with Saturn's updater key has this setting, and only such a build looks for updates.
    let updates = context.config().plugins.0.contains_key("updater");
    let mut builder = tauri::Builder::default();
    if updates {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .manage(update::Waiting::default());
    }
    let app = builder
        // First, so a second launch stops here and brings this one forward.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if INTERFACE.get().is_some() {
                show_main_window(app);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(Runtime::new())
        .invoke_handler(tauri::generate_handler![
            pick_folders,
            confirm_action,
            start_dragging,
            toggle_maximize,
            minimize_window,
            close_window,
            notify,
            request_permission,
            runtime_status,
            restart_runtime,
            set_window_title
        ])
        .setup(move |app| {
            let layout = if cfg!(debug_assertions) {
                Layout::Development {
                    repository: concat!(env!("CARGO_MANIFEST_DIR"), "/../..").into(),
                }
            } else {
                Layout::Packaged {
                    resources: app.path().resource_dir()?,
                }
            };
            tauri::async_runtime::spawn(start_up(app.handle().clone(), layout));
            if updates {
                tauri::async_runtime::spawn(update::check(app.handle().clone()));
            }
            Ok(())
        })
        .build(context)
        .expect("the Saturn app builds");

    app.run(|app, event| match event {
        RunEvent::Exit => {
            app.state::<Runtime>().stop();
            update::install_waiting(app);
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } if INTERFACE.get().is_some() => show_main_window(app),
        _ => {}
    });
}
