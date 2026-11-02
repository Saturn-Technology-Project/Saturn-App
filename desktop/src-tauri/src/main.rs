//! The Saturn desktop app: starts the runtime and shows the interface in the system's web view.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod runtime;
mod ui;

use std::sync::OnceLock;
use std::time::Duration;

use runtime::{Layout, Runtime};
use serde::Deserialize;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;

const MAIN_WINDOW: &str = "main";
const SETTINGS_WINDOW: &str = "settings";
const BACKGROUND: tauri::window::Color = tauri::window::Color(0x16, 0x16, 0x18, 0xff);

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
    chosen.unwrap_or_default().iter().filter_map(|folder| folder.as_path().map(|path| path.display().to_string())).collect()
}

#[tauri::command]
fn start_dragging(window: WebviewWindow) -> tauri::Result<()> {
    window.start_dragging()
}

#[tauri::command]
fn toggle_maximize(window: WebviewWindow) -> tauri::Result<()> {
    if window.is_maximized()? { window.unmaximize() } else { window.maximize() }
}

/// The bridge script with this runtime's token and address filled in.
fn bridge_script(runtime: &Runtime) -> String {
    let quoted = |text: &str| serde_json::Value::from(text).to_string();
    include_str!("bridge.js")
        .replace("__SATURN_TOKEN__", &quoted(&runtime.token()))
        .replace("__SATURN_ORIGIN__", &quoted(&runtime.origin()))
}

fn interface_url(fragment: Option<&str>) -> Url {
    let port = INTERFACE.get().copied().expect("the interface is up before any window opens");
    let mut url = Url::parse(&format!("http://127.0.0.1:{port}/")).expect("a loopback address is a valid URL");
    url.set_fragment(fragment);
    url
}

/// A window with Saturn's frame: on macOS, the traffic lights over the page's own title bar.
fn build_window<'a>(app: &'a AppHandle, label: &'a str, fragment: Option<&str>) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let script = bridge_script(&app.state::<Runtime>());
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(interface_url(fragment)))
        .title("Saturn")
        .background_color(BACKGROUND)
        .disable_drag_drop_handler()
        .initialization_script(script);
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);
    builder
}

fn show_main_window(app: &AppHandle, visible: bool) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        if visible {
            let _ = window.show();
            let _ = window.set_focus();
        }
        return;
    }
    let built = build_window(app, MAIN_WINDOW, None)
        .inner_size(1320.0, 840.0)
        .min_inner_size(940.0, 620.0)
        .visible(visible)
        .build();
    if let Err(error) = built {
        eprintln!("Could not open the Saturn window: {error}");
    }
}

/// Settings in a window of its own: what Saturn IDE's "Saturn Settings" opens (saturn://settings).
fn open_settings_window(app: &AppHandle, page: Option<&str>) {
    let fragment = page.map_or("settings".to_owned(), |page| format!("settings/{page}"));
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        if page.is_some() {
            let _ = window.navigate(interface_url(Some(&fragment)));
        }
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let built = build_window(app, SETTINGS_WINDOW, Some(&fragment))
        .title("Saturn Settings")
        .inner_size(980.0, 700.0)
        .min_inner_size(760.0, 520.0)
        .build();
    if let Err(error) = built {
        eprintln!("Could not open Saturn Settings: {error}");
    }
}

/// The page of a saturn://settings or saturn://settings/<page> link (`Some(None)` for the first); other links are not ours.
fn settings_link(link: &str) -> Option<Option<String>> {
    let url = Url::parse(link).ok()?;
    if url.scheme() != "saturn" || url.host_str() != Some("settings") {
        return None;
    }
    let page = url.path().trim_start_matches('/').split('/').next().unwrap_or_default();
    Some((!page.is_empty() && page.bytes().all(|byte| byte.is_ascii_lowercase())).then(|| page.to_owned()))
}

/// Allows the commands to Saturn's own pages, at the exact port the interface got.
fn allow_interface_commands(app: &AppHandle, port: u16) -> tauri::Result<()> {
    let capability = serde_json::json!({
        "identifier": "interface",
        "windows": [MAIN_WINDOW, SETTINGS_WINDOW],
        "remote": { "urls": [format!("http://127.0.0.1:{port}/*")] },
        "permissions": ["allow-pick-folders", "allow-start-dragging", "allow-toggle-maximize"],
    });
    app.add_capability(capability.to_string())
}

/// True while a Saturn IDE window uses the runtime (it reports in every 15 s, and counts while starting up).
async fn ide_open(app: &AppHandle) -> bool {
    let clients = app.state::<Runtime>().request("GET", "/runtime/clients", Duration::from_secs(5)).await;
    clients.as_ref().and_then(|clients| clients.as_array()).is_some_and(|clients| clients.iter().any(|client| client["kind"] == "ide"))
}

/// Starts everything in order: the runtime, the default app (which may be Saturn IDE), then the window.
async fn start_up(app: AppHandle, layout: Layout, links: Vec<String>) {
    app.state::<Runtime>().ensure_started(&layout).await;
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
    let link = links.iter().find_map(|link| settings_link(link));
    // The runtime opens Saturn IDE and says whether it did; the first run may also install the bundled IDE, hence the
    // long timeout. A settings link came from Saturn IDE, which is already open, so nothing is woken then.
    let wakeup = if link.is_some() {
        None
    } else {
        app.state::<Runtime>().request("POST", "/runtime/wakeup", Duration::from_secs(180)).await
    };
    // The window hides only when the IDE really opened (or for a settings link): a launch never ends with nothing on screen.
    let ide_took_over = link.is_some() || wakeup.is_some_and(|wakeup| wakeup["target"] == "ide" && wakeup["opened"] == true);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        show_main_window(&handle, !ide_took_over);
        if let Some(page) = link {
            open_settings_window(&handle, page.as_deref());
        }
    });
}

/// With no window on screen, the app only keeps the runtime alive for Saturn IDE: it quits once no IDE is open.
async fn quit_when_unused(app: AppHandle) {
    if app.state::<Runtime>().owned() {
        while ide_open(&app).await {
            tokio::time::sleep(Duration::from_secs(10)).await;
            if !app.webview_windows().is_empty() {
                return;
            }
        }
    }
    app.exit(0);
}

fn main() {
    let app = tauri::Builder::default()
        // First, so a second launch stops here and hands over its links.
        .plugin(tauri_plugin_single_instance::init(|app, arguments, _| {
            if !INTERFACE.get().is_some() {
                return;
            }
            match arguments.iter().find_map(|argument| settings_link(argument)) {
                Some(page) => open_settings_window(app, page.as_deref()),
                None => show_main_window(app, true),
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Runtime::new())
        .invoke_handler(tauri::generate_handler![pick_folders, start_dragging, toggle_maximize])
        .setup(|app| {
            let layout = if cfg!(debug_assertions) {
                Layout::Development { repository: concat!(env!("CARGO_MANIFEST_DIR"), "/../..").into() }
            } else {
                Layout::Packaged { resources: app.path().resource_dir()? }
            };
            // Saturn IDE opens saturn:// links; on macOS they arrive here, also when the link is what launched Saturn.
            let links: Vec<String> = app.deep_link().get_current().ok().flatten().unwrap_or_default().iter().map(ToString::to_string).collect();
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                if INTERFACE.get().is_none() {
                    return;
                }
                if let Some(page) = event.urls().iter().find_map(|url| settings_link(url.as_str())) {
                    open_settings_window(&handle, page.as_deref());
                }
            });
            tauri::async_runtime::spawn(start_up(app.handle().clone(), layout, links));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the Saturn app builds");

    app.run(|app, event| match event {
        // The last window closed: Saturn IDE may still need the runtime.
        RunEvent::ExitRequested { code: None, api, .. } => {
            api.prevent_exit();
            tauri::async_runtime::spawn(quit_when_unused(app.clone()));
        }
        RunEvent::Exit => app.state::<Runtime>().stop(),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } if INTERFACE.get().is_some() => show_main_window(app, true),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_settings_links() {
        assert_eq!(settings_link("saturn://settings"), Some(None));
        assert_eq!(settings_link("saturn://settings/general"), Some(Some("general".to_owned())));
        assert_eq!(settings_link("saturn://settings/Bad-Page"), Some(None));
        assert_eq!(settings_link("saturn://other"), None);
        assert_eq!(settings_link("https://settings/general"), None);
        assert_eq!(settings_link("--flag"), None);
    }
}
