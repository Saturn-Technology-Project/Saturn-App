//! What the contract tests cannot wait for or reach: the idle timer, and the rules for where files go.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::routing::any;
use saturn_browser::{Browser, Mode};
use serde_json::json;

/// A WebDriver server that answers everything and counts the sessions ended.
async fn fake_driver() -> (String, Arc<Mutex<u32>>) {
    let ended = Arc::new(Mutex::new(0));
    let counted = Arc::clone(&ended);
    let app = Router::new().fallback(any(move |request: axum::extract::Request| {
        let counted = Arc::clone(&counted);
        async move {
            if request.method() == "DELETE" && request.uri().path() == "/session/s1" {
                *counted.lock().unwrap() += 1;
            }
            let value = if request.uri().path() == "/session" {
                json!({ "sessionId": "s1" })
            } else {
                json!("ok")
            };
            axum::Json(json!({ "value": value }))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}"), ended)
}

#[tokio::test]
async fn an_idle_browser_closes_itself_and_each_call_starts_the_time_over() {
    let folder = tempfile::tempdir().unwrap();
    let (endpoint, ended) = fake_driver().await;
    let browser = Browser::with_idle(folder.path(), Some(endpoint), Duration::from_millis(1500));
    browser.set_mode(Mode::Safari).await;
    browser.run("browser_snapshot", &json!({})).await.unwrap();
    assert_eq!(browser.state()["open"], true);
    tokio::time::sleep(Duration::from_millis(900)).await;
    browser.run("browser_snapshot", &json!({})).await.unwrap();
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert_eq!(
        browser.state()["open"],
        true,
        "the second call started the time over"
    );
    assert_eq!(*ended.lock().unwrap(), 0);
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(browser.state()["open"], false);
    assert_eq!(*ended.lock().unwrap(), 1);
}

#[tokio::test]
async fn a_recording_in_progress_is_finished_when_the_browser_closes() {
    let folder = tempfile::tempdir().unwrap();
    let (endpoint, _) = fake_driver().await;
    let browser = Browser::new(folder.path(), Some(endpoint));
    browser.set_mode(Mode::Safari).await;
    browser
        .run("browser_record_start", &json!({ "name": "left-open" }))
        .await
        .unwrap();
    browser.close().await;
    assert!(
        folder
            .path()
            .join("workspace/recordings/left-open/frames.txt")
            .exists()
    );
    let error = browser
        .run("browser_record_stop", &json!({}))
        .await
        .unwrap_err();
    assert_eq!(error, "Not recording.");
}
