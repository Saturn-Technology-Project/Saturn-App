//! Spans: one unit of work with a name, attributes and a place in a trace. The active span follows the task it runs in, and
//! `carry` takes it along to a spawned one.
use std::future::Future;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};

use crate::{SCOPE, VERSION, export, locked, now_ms, recording, schedule_save};

tokio::task_local! {
    static ACTIVE: Context;
}

/// Where in a trace something happens.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Context {
    pub trace: String,
    pub span: String,
}

impl Context {
    /// The W3C `traceparent` value, or the context one says; zeros and anything else malformed say nothing.
    pub fn parse(traceparent: &str) -> Option<Self> {
        let mut parts = traceparent.trim().split('-');
        let (version, trace, span, flags) =
            (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
        let hex = |text: &str, length: usize| {
            text.len() == length
                && text
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        };
        let nonzero = |text: &str| text.bytes().any(|byte| byte != b'0');
        (hex(version, 2)
            && version != "ff"
            && hex(trace, 32)
            && hex(span, 16)
            && hex(flags, 2)
            && nonzero(trace)
            && nonzero(span))
        .then(|| Self {
            trace: trace.to_owned(),
            span: span.to_owned(),
        })
    }

    /// As the header sends it.
    pub fn traceparent(&self) -> String {
        format!("00-{}-{}-01", self.trace, self.span)
    }
}

/// What a span does in relation to the runtime.
#[derive(Clone, Copy)]
pub enum Kind {
    Internal,
    Server,
    Client,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Internal => "internal",
            Self::Server => "server",
            Self::Client => "client",
        }
    }
}

struct Open {
    name: String,
    attributes: Map<String, Value>,
    status: &'static str,
    message: Option<String>,
    events: Vec<Value>,
    failed: bool,
}

struct Live {
    context: Context,
    parent: Option<String>,
    kind: Kind,
    start: f64,
    open: Mutex<Open>,
}

/// A span. It ends when the last handle goes, which a stopped run's task does too.
#[derive(Clone)]
pub struct Span(Option<Arc<Live>>);

/// A random id of `bytes` bytes, in hex.
fn random_id(bytes: usize) -> String {
    let mut id = String::with_capacity(bytes * 2);
    while id.len() < bytes * 2 {
        // new_id gives 8 random bytes; only a machine without randomness fails it, and then the clock has to do.
        let part = saturn_domain::new_id("s").map_or_else(
            |_| format!("{:016x}", now_ms().to_bits()),
            |text| text[2..].to_owned(),
        );
        id.push_str(&part);
    }
    id.truncate(bytes * 2);
    id
}

/// A record of `attributes` as an object.
fn fields(attributes: Value) -> Map<String, Value> {
    match attributes {
        Value::Object(fields) => fields,
        _ => Map::new(),
    }
}

impl Span {
    /// Starts a span under the active one.
    pub fn start(name: impl Into<String>, kind: Kind, attributes: Value) -> Self {
        Self::under(current(), name, kind, attributes)
    }

    /// Starts a span under `parent`, which may be in another program; without one it begins a new trace.
    pub fn under(
        parent: Option<Context>,
        name: impl Into<String>,
        kind: Kind,
        attributes: Value,
    ) -> Self {
        if !recording() {
            return Self(None);
        }
        let (trace, parent) = match parent {
            Some(parent) => (parent.trace, Some(parent.span)),
            None => (random_id(16), None),
        };
        Self(Some(Arc::new(Live {
            context: Context {
                trace,
                span: random_id(8),
            },
            parent,
            kind,
            start: now_ms(),
            open: Mutex::new(Open {
                name: name.into(),
                attributes: fields(attributes),
                status: "unset",
                message: None,
                events: Vec::new(),
                failed: false,
            }),
        })))
    }

    /// Where this span is, for what it starts and for other programs.
    pub fn context(&self) -> Option<Context> {
        self.0.as_ref().map(|live| live.context.clone())
    }

    /// Sets an attribute.
    pub fn set(&self, key: &str, value: impl Into<Value>) {
        if let Some(live) = &self.0 {
            locked(&live.open)
                .attributes
                .insert(key.to_owned(), value.into());
        }
    }

    /// Names the span, once what it is has become clear.
    pub fn rename(&self, name: impl Into<String>) {
        if let Some(live) = &self.0 {
            locked(&live.open).name = name.into();
        }
    }

    /// Marks the span failed, once: a later call for the same span is ignored.
    pub fn fail(&self, message: &str, kind: &str) {
        let Some(live) = &self.0 else {
            return;
        };
        let mut open = locked(&live.open);
        if open.failed {
            return;
        }
        open.failed = true;
        open.events.push(json!({
            "name": "exception",
            "timeMs": now_ms(),
            "attributes": { "exception.type": kind, "exception.message": message },
        }));
        open.attributes.insert("error.type".to_owned(), json!(kind));
        open.status = "error";
        open.message = Some(message.to_owned());
    }

    /// Marks the span as an error with no more to say.
    pub fn error_status(&self) {
        if let Some(live) = &self.0 {
            locked(&live.open).status = "error";
        }
    }

    /// Runs `work` with this span active. On the heap: the agent loop's futures are large and nest deep, and a worker
    /// thread's stack is small.
    pub async fn scope<F: Future>(&self, work: F) -> F::Output {
        let work = Box::pin(work);
        match self.context() {
            Some(context) => ACTIVE.scope(context, work).await,
            None => work.await,
        }
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        let open = locked(&self.open);
        let now = now_ms();
        let mut record = json!({
            "traceId": self.context.trace,
            "spanId": self.context.span,
            "parentSpanId": self.parent,
            "name": open.name,
            "kind": self.kind.name(),
            "scope": SCOPE,
            "scopeVersion": VERSION,
            "startMs": self.start,
            "durationMs": now - self.start,
            "status": open.status,
        });
        if let Some(message) = &open.message {
            record["statusMessage"] = json!(message);
        }
        record["attributes"] = Value::Object(open.attributes.clone());
        record["events"] = Value::Array(open.events.clone());
        export::queue_span(&record);
        let worth_saving = locked(&crate::GLOBAL.buffer).add_span(record);
        if worth_saving {
            schedule_save();
        }
    }
}

/// The active span's place, if any.
pub fn current() -> Option<Context> {
    ACTIVE.try_with(Clone::clone).ok()
}

/// A future that runs with the span active now, for handing to a spawned task.
pub fn carry<F: Future>(work: F) -> impl Future<Output = F::Output> {
    let active = current();
    let work = Box::pin(work);
    async move {
        match active {
            Some(context) => ACTIVE.scope(context, work).await,
            None => work.await,
        }
    }
}
