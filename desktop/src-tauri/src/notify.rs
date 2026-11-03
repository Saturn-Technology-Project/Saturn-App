//! System notifications from the interface: an agent finished, failed, or needs an approval.
use serde::Deserialize;
use tauri::{AppHandle, Manager};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    title: Option<String>,
    body: Option<String>,
    silent: Option<bool>,
    agent_id: Option<String>,
    thread_id: Option<String>,
}

/// The script that tells the interface which chat to open; JSON, so nothing in an id can become code.
fn open_thread_script(options: &Options) -> Option<String> {
    let thread_id = options.thread_id.as_ref()?;
    let payload = serde_json::json!({ "agentId": options.agent_id, "threadId": thread_id });
    Some(format!("window.__saturnOpenThread({payload})"))
}

/// What a click does: brings the window forward and opens the chat.
fn clicked(app: &AppHandle, options: &Options) {
    let handle = app.clone();
    let script = open_thread_script(options);
    let _ = app.run_on_main_thread(move || {
        crate::show_main_window(&handle);
        if let (Some(window), Some(script)) =
            (handle.get_webview_window(crate::MAIN_WINDOW), script)
        {
            let _ = window.eval(script);
        }
    });
}

/// Shows it from its own thread: waiting for the click blocks there, not the app.
pub fn show(app: AppHandle, options: Options) {
    std::thread::spawn(move || {
        if let Err(error) = deliver(&app, &options) {
            eprintln!("Could not show a notification: {error}");
        }
    });
}

#[cfg(target_os = "macos")]
fn deliver(app: &AppHandle, options: &Options) -> Result<(), Box<dyn std::error::Error>> {
    use mac_notification_sys::{Notification, NotificationResponse, set_application};
    // Already set after the first notification; the library only allows it once.
    let _ = set_application(&app.config().identifier);
    let title = options.title.as_deref().unwrap_or("Saturn");
    let body = options.body.as_deref().unwrap_or("");
    let mut notification = Notification::new();
    notification.title(title).message(body).wait_for_click(true);
    if options.silent != Some(true) {
        notification.default_sound();
    }
    if matches!(notification.send()?, NotificationResponse::Click) {
        clicked(app, options);
    }
    Ok(())
}

#[cfg(windows)]
fn deliver(app: &AppHandle, options: &Options) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_winrt_notification::{Sound, Toast};
    let handle = app.clone();
    let chosen = options.clone();
    Toast::new(&app.config().identifier)
        .title(options.title.as_deref().unwrap_or("Saturn"))
        .text1(options.body.as_deref().unwrap_or(""))
        .sound(if options.silent == Some(true) {
            None
        } else {
            Some(Sound::Default)
        })
        .on_activated(move |_| {
            clicked(&handle, &chosen);
            Ok(())
        })
        .show()?;
    Ok(())
}

/// Saturn ships for macOS and Windows; other builds have no notifications yet.
#[cfg(not(any(target_os = "macos", windows)))]
fn deliver(_app: &AppHandle, _options: &Options) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chat_id_cannot_become_code() {
        let options = Options {
            title: None,
            body: None,
            silent: None,
            agent_id: None,
            thread_id: Some("\");alert(1);(\"".to_owned()),
        };
        let script = open_thread_script(&options).expect("a thread id gives a script");
        assert_eq!(
            script,
            r#"window.__saturnOpenThread({"agentId":null,"threadId":"\");alert(1);(\""})"#
        );
        let none = Options {
            title: None,
            body: None,
            silent: None,
            agent_id: None,
            thread_id: None,
        };
        assert_eq!(open_thread_script(&none), None);
    }
}
