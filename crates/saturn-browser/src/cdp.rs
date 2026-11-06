//! One Chrome DevTools Protocol connection: numbered requests over a websocket, with session routing and events.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

/// How long a command may take; a page that never settles must not hold the agent for good.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
/// A full-page screenshot arrives as one message.
const LARGEST_MESSAGE: usize = 512 * 1024 * 1024;

type Waiter = oneshot::Sender<Result<Value, String>>;

/// Something the browser reported on its own.
pub(crate) struct CdpEvent {
    pub method: String,
    pub params: Value,
    pub session: Option<String>,
}

/// A connection to the browser. It ends when the browser does.
pub(crate) struct Cdp {
    next: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, Waiter>>>,
    outgoing: mpsc::UnboundedSender<Message>,
}

impl Cdp {
    /// Connects, and gives the events to handle alongside the connection.
    pub async fn connect(url: &str) -> Result<(Self, mpsc::UnboundedReceiver<CdpEvent>), String> {
        let config = WebSocketConfig::default()
            .max_message_size(Some(LARGEST_MESSAGE))
            .max_frame_size(Some(LARGEST_MESSAGE));
        let (socket, _) = tokio_tungstenite::connect_async_with_config(url, Some(config), false)
            .await
            .map_err(|_| "Could not connect to the browser".to_owned())?;
        let (mut sink, mut stream) = socket.split();
        let (outgoing, mut to_send) = mpsc::unbounded_channel::<Message>();
        let (events, received) = mpsc::unbounded_channel();
        let pending: Arc<Mutex<HashMap<u64, Waiter>>> = Arc::default();
        tokio::spawn(async move {
            while let Some(message) = to_send.recv().await {
                if sink.send(message).await.is_err() {
                    break;
                }
            }
        });
        let answers = Arc::clone(&pending);
        tokio::spawn(async move {
            while let Some(Ok(message)) = stream.next().await {
                let Message::Text(text) = message else {
                    continue;
                };
                let Ok(message) = serde_json::from_str::<Value>(text.as_str()) else {
                    continue;
                };
                if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    let waiter = lock(&answers).remove(&id);
                    if let Some(waiter) = waiter {
                        let _ = waiter.send(match message.get("error") {
                            Some(error) => Err(error
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("The browser refused a command")
                                .to_owned()),
                            None => Ok(message.get("result").cloned().unwrap_or(json!({}))),
                        });
                    }
                } else if let Some(method) = message.get("method").and_then(Value::as_str) {
                    let _ = events.send(CdpEvent {
                        method: method.to_owned(),
                        params: message.get("params").cloned().unwrap_or(json!({})),
                        session: message
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    });
                }
            }
            // Dropping the waiters tells whoever waits that the browser is gone.
            lock(&answers).clear();
        });
        Ok((
            Self {
                next: AtomicU64::new(1),
                pending,
                outgoing,
            },
            received,
        ))
    }

    /// Sends a command without waiting for its answer, for what must not hold up the events.
    pub fn post(&self, method: &str, params: Value, session: Option<&str>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let _ = self.outgoing.send(command(id, method, params, session));
    }

    /// Sends a command and waits for its answer.
    pub async fn send(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (waiter, answer) = oneshot::channel();
        lock(&self.pending).insert(id, waiter);
        if self
            .outgoing
            .send(command(id, method, params, session))
            .is_err()
        {
            lock(&self.pending).remove(&id);
            return Err("The browser has closed".to_owned());
        }
        match tokio::time::timeout(COMMAND_TIMEOUT, answer).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("The browser has closed".to_owned()),
            Err(_) => {
                lock(&self.pending).remove(&id);
                Err(format!("The browser did not answer {method} in time"))
            }
        }
    }
}

/// A command as the protocol has it.
fn command(id: u64, method: &str, params: Value, session: Option<&str>) -> Message {
    let mut body = json!({ "id": id, "method": method, "params": params });
    if let Some(session) = session {
        body["sessionId"] = json!(session);
    }
    Message::text(body.to_string())
}

/// Locks the table of waiters; a panic elsewhere leaves it usable.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
