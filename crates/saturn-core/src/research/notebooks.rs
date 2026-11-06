//! Kernels for the notebooks open in the Workspace. The person runs a cell the way they run a terminal command: this
//! records no run, is no research record, and no assistant tool reaches it. A small helper in the project's own Python
//! holds the kernel and speaks JSON lines; `docs/research-contract.md` says the routes and the events.
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use saturn_domain::new_id;
use saturn_tools::{force, in_own_group, launch_env, terminate};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex as AsyncMutex, mpsc, watch};
use tokio::task::JoinSet;

use crate::records::text;
use crate::{CoreError, Kernel, locked};

/// The helper that holds a kernel. It goes to the interpreter with `-c`, as its standard input carries commands.
const HELPER: &str = include_str!("notebook.py");
/// How much output one run of one cell keeps, as stored JSON. Past it, a note says what happened.
const MAX_CELL_OUTPUT: usize = 2 * 1024 * 1024;
/// The longest line read from the helper. Anything longer is left out like output past the limit.
const MAX_LINE: u64 = 8 * 1024 * 1024;
/// How many bytes of events are kept for a client reconnecting.
const KEPT_EVENTS: usize = 16 * 1024 * 1024;
/// How much of the helper's standard error is kept, to say why it ended.
const KEPT_ERRORS: usize = 4 * 1024;
/// How long the helper gets to end its kernel when asked, and then how long a signal gets before force.
const STOP_GRACE: Duration = Duration::from_secs(4);
const SIGNAL_GRACE: Duration = Duration::from_secs(1);

/// The kernels this runtime holds, by project and the notebook's path in it.
#[derive(Debug, Default)]
pub(super) struct Notebooks {
    open: Mutex<HashMap<(String, String), Arc<Held>>>,
}

/// One helper and what is known of its kernel.
#[derive(Debug)]
struct Held {
    id: String,
    pid: Option<u32>,
    input: AsyncMutex<Option<ChildStdin>>,
    log: Mutex<Log>,
    /// Moves on when the log does.
    moved: watch::Sender<u64>,
}

/// The kernel's state, and its events still kept for a client reconnecting.
#[derive(Debug)]
struct Log {
    state: &'static str,
    python: String,
    message: Option<String>,
    missing: Vec<String>,
    running: Option<String>,
    queued: Vec<String>,
    events: VecDeque<(u64, String)>,
    size: usize,
    next: u64,
    /// What the running cell's output has used of its limit, and whether it went past it.
    spent: usize,
    over: bool,
    /// The helper has ended, so nothing more will come.
    ended: bool,
}

impl Log {
    /// The log of a helper just started with `python`.
    fn new(python: String) -> Self {
        Self {
            state: "starting",
            python,
            message: None,
            missing: Vec::new(),
            running: None,
            queued: Vec::new(),
            events: VecDeque::new(),
            size: 0,
            next: 0,
            spent: 0,
            over: false,
            ended: false,
        }
    }

    /// Whether this helper can still take a cell. One that said a package is missing or failed is about to end.
    fn takes_cells(&self) -> bool {
        !self.ended && !matches!(self.state, "missing" | "failed")
    }

    /// Keeps an event, letting the oldest go past the limit: a client that missed them is told.
    fn push(&mut self, mut event: Value) {
        event["seq"] = json!(self.next);
        let line = event.to_string();
        self.size += line.len();
        self.events.push_back((self.next, line));
        self.next += 1;
        while self.size > KEPT_EVENTS && self.events.len() > 1 {
            if let Some((_, oldest)) = self.events.pop_front() {
                self.size -= oldest.len();
            }
        }
    }

    /// The kernel's state as clients see it.
    fn view(&self, id: &str) -> Value {
        json!({
            "kernel": id,
            "state": self.state,
            "python": self.python,
            "message": self.message,
            "missing": self.missing,
            "running": self.running,
            "queued": self.queued,
            "seq": self.next,
        })
    }

    /// Tells clients the state moved.
    fn push_state(&mut self, id: &str) {
        let mut event = self.view(id);
        event["type"] = json!("state");
        self.push(event);
    }

    /// The state of a kernel that can run: busy with what it has been given, or idle.
    fn working_state(&self) -> &'static str {
        if self.running.is_some() || !self.queued.is_empty() {
            "busy"
        } else {
            "idle"
        }
    }

    /// Output past the limit is dropped, with one note saying so where the output would have been.
    fn note_cut(&mut self, cell: &str) {
        self.over = true;
        let limit = MAX_CELL_OUTPUT / (1024 * 1024);
        let note = format!(
            "Saturn kept the first {limit} MB of this cell's output and left out the rest. The cell itself went on. To keep more, write it to a file."
        );
        self.push(json!({
            "type": "output",
            "cell": cell,
            "output": {
                "output_type": "display_data",
                "data": { "text/plain": note },
                "metadata": { "saturn": { "truncated": true } },
            },
        }));
    }

    /// One output of the running cell, cut to what its limit leaves.
    fn keep_output(&mut self, cell: &str, mut output: Value) {
        if self.over {
            return;
        }
        let size = output.to_string().len();
        let room = MAX_CELL_OUTPUT.saturating_sub(self.spent);
        if size <= room {
            self.spent += size;
            self.push(json!({ "type": "output", "cell": cell, "output": output }));
            return;
        }
        // Text can keep its start. An image or a table is left out whole.
        if text(&output, "output_type") == "stream" {
            let whole = text(&output, "text");
            let mut end = room.min(whole.len());
            while !whole.is_char_boundary(end) {
                end -= 1;
            }
            if end > 0 {
                output["text"] = json!(whole[..end]);
                self.push(json!({ "type": "output", "cell": cell, "output": output }));
            }
        }
        self.note_cut(cell);
    }

    /// One line from the helper. A line that is not an event is not the helper's, and is ignored.
    fn hear(&mut self, id: &str, line: &[u8]) {
        let Ok(message) = serde_json::from_slice::<Value>(line) else {
            return;
        };
        let cell = text(&message, "cell").to_owned();
        match text(&message, "event") {
            "ready" => {
                self.python = text(&message, "python").to_owned();
                self.state = self.working_state();
                self.push_state(id);
            }
            "missing" => {
                self.missing = message
                    .get("packages")
                    .and_then(Value::as_array)
                    .map(|names| {
                        names
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
                self.state = "missing";
                self.message = Some(format!(
                    "{} does not have {}, so cells cannot run. The notebook still opens, edits and saves. Install the Notebooks kit under Environment, then run again.",
                    self.python,
                    self.missing.join(" or ")
                ));
                // Nothing will run, so what waited is let go now, in the same step: the state never says missing
                // while cells still look queued.
                self.let_go();
                self.push_state(id);
            }
            "failed" => {
                self.state = "failed";
                self.message = Some(text(&message, "message").to_owned());
                self.let_go();
                self.push_state(id);
            }
            "started" => {
                self.queued.retain(|item| item != &cell);
                self.running = Some(cell.clone());
                self.spent = 0;
                self.over = false;
                self.state = "busy";
                self.push(json!({ "type": "started", "cell": cell }));
                self.push_state(id);
            }
            "output" => {
                let output = message.get("output").cloned().unwrap_or(Value::Null);
                self.keep_output(&cell, output);
            }
            "clear" => {
                self.spent = 0;
                self.over = false;
                self.push(json!({ "type": "clear", "cell": cell, "wait": message.get("wait") }));
            }
            "finished" => {
                self.queued.retain(|item| item != &cell);
                if self.running.as_deref() == Some(cell.as_str()) {
                    self.running = None;
                }
                if self.state == "busy" {
                    self.state = self.working_state();
                }
                self.push(json!({
                    "type": "finished",
                    "cell": cell,
                    "status": text(&message, "status"),
                    "count": message.get("count"),
                }));
                self.push_state(id);
            }
            "restarted" => {
                self.state = self.working_state();
                self.message = None;
                self.push_state(id);
            }
            "dead" => {
                self.state = "dead";
                self.running = None;
                self.message = Some(
                    "The kernel stopped by itself, and what it held in memory is gone. Restart it to run cells again."
                        .to_owned(),
                );
                self.push_state(id);
            }
            _ => {}
        }
    }

    /// Cells that were waiting when the helper ended do not run. Whoever watches is told, so none stays waiting.
    fn let_go(&mut self) {
        let cells: Vec<(String, &str)> = self
            .running
            .take()
            .map(|cell| (cell, "aborted"))
            .into_iter()
            .chain(self.queued.drain(..).map(|cell| (cell, "skipped")))
            .collect();
        for (cell, status) in cells {
            self.push(json!({ "type": "finished", "cell": cell, "status": status, "count": null }));
        }
    }

    /// The helper has ended. Unless it said why, what it wrote last says.
    fn end(&mut self, id: &str, errors: &[u8]) {
        self.let_go();
        if !matches!(self.state, "missing" | "failed") {
            if !matches!(self.state, "stopping") {
                let said = String::from_utf8_lossy(errors);
                let said = said.trim();
                self.message = Some(if said.is_empty() {
                    "The kernel's helper ended.".to_owned()
                } else {
                    format!("The kernel's helper ended:\n{said}")
                });
            }
            self.state = "stopped";
        } else if self.state == "failed" && !errors.is_empty() {
            let said = String::from_utf8_lossy(errors);
            let reason = self.message.take().unwrap_or_default();
            self.message = Some(format!("{reason}\n{}", said.trim()));
        }
        self.ended = true;
        self.push_state(id);
        self.push(json!({ "type": "ended" }));
    }
}

impl Held {
    /// Runs `change` on the log and tells whoever watches.
    fn with_log<T>(&self, change: impl FnOnce(&mut Log) -> T) -> T {
        let answer = change(&mut locked(&self.log));
        self.moved.send_modify(|count| *count += 1);
        answer
    }

    /// The kernel's state as clients see it.
    fn view(&self) -> Value {
        locked(&self.log).view(&self.id)
    }

    /// Whether this helper can still take a cell.
    fn usable(&self) -> bool {
        locked(&self.log).takes_cells()
    }

    /// Sends one command. A helper that has gone cannot take it, and its end says so to whoever watches.
    async fn tell(&self, command: &Value) {
        let mut input = self.input.lock().await;
        if let Some(pipe) = input.as_mut() {
            let line = format!("{command}\n");
            if pipe.write_all(line.as_bytes()).await.is_err() || pipe.flush().await.is_err() {
                input.take();
            }
        }
    }

    /// Waits for the helper to end, for up to `time`, and says whether it did.
    async fn ended_within(&self, time: Duration) -> bool {
        let mut moved = self.moved.subscribe();
        tokio::time::timeout(time, async {
            while !locked(&self.log).ended {
                if moved.changed().await.is_err() {
                    return;
                }
            }
        })
        .await
        .is_ok()
    }

    /// Ends the helper and with it the kernel: asked, then signalled, then by force.
    async fn end(&self) {
        self.with_log(|log| {
            if log.takes_cells() {
                log.state = "stopping";
            }
        });
        self.tell(&json!({ "op": "stop" })).await;
        if self.ended_within(STOP_GRACE).await {
            return;
        }
        let Some(pid) = self.pid else { return };
        terminate(pid);
        if !self.ended_within(SIGNAL_GRACE).await {
            force(pid);
            self.ended_within(SIGNAL_GRACE).await;
        }
    }

    /// The events from `cursor`, where to read next, whether some were let go first, and whether the helper has ended.
    fn events_from(&self, cursor: u64) -> (Vec<String>, u64, bool, bool) {
        let log = locked(&self.log);
        let first = log.events.front().map_or(log.next, |(seq, _)| *seq);
        let lines = log
            .events
            .iter()
            .filter(|(seq, _)| *seq >= cursor)
            .map(|(_, line)| line.clone())
            .collect();
        (lines, log.next, cursor < first, log.ended)
    }
}

/// The rest of a line too long to take, up to and including its end.
async fn skip_line(reader: &mut BufReader<ChildStdout>) {
    loop {
        let Ok(chunk) = reader.fill_buf().await else {
            return;
        };
        if chunk.is_empty() {
            return;
        }
        let (used, found) = match chunk.iter().position(|byte| *byte == b'\n') {
            Some(at) => (at + 1, true),
            None => (chunk.len(), false),
        };
        reader.consume(used);
        if found {
            return;
        }
    }
}

/// Keeps the end of what a stream writes, for as long as it stays open. A kernel's own stderr ends up here too.
async fn keep_tail(mut stream: impl AsyncRead + Unpin, tail: Arc<Mutex<Vec<u8>>>) {
    let mut chunk = [0_u8; 4096];
    while let Ok(read) = stream.read(&mut chunk).await {
        if read == 0 {
            return;
        }
        let mut kept = locked(&tail);
        kept.extend_from_slice(&chunk[..read]);
        let extra = kept.len().saturating_sub(KEPT_ERRORS);
        kept.drain(..extra);
    }
}

/// Reads the helper's events until it ends, and then reaps it.
async fn follow(held: Arc<Held>, mut child: Child, stdout: ChildStdout, tail: Arc<Mutex<Vec<u8>>>) {
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = (&mut reader)
            .take(MAX_LINE)
            .read_until(b'\n', &mut line)
            .await;
        match read {
            Ok(0) | Err(_) => break,
            Ok(_) if line.last() == Some(&b'\n') => {
                held.with_log(|log| log.hear(&held.id, &line));
            }
            Ok(_) => {
                skip_line(&mut reader).await;
                held.with_log(|log| {
                    if let Some(cell) = log.running.clone()
                        && !log.over
                    {
                        log.note_cut(&cell);
                    }
                });
            }
        }
    }
    held.input.lock().await.take();
    if tokio::time::timeout(SIGNAL_GRACE, child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
    }
    let errors = locked(&tail).clone();
    held.with_log(|log| log.end(&held.id, &errors));
}

impl Kernel {
    /// The notebook a request names, as its place on disk and how the runtime keys it. Paths that lead out of the
    /// project or into its records are refused as they are for the editor.
    async fn notebook_file(
        &self,
        project: &str,
        requested: &str,
    ) -> Result<(PathBuf, String), CoreError> {
        let (target, relative) = self.source_path(project, requested, None).await?;
        if !relative.to_ascii_lowercase().ends_with(".ipynb") {
            return Err(CoreError::new(400, "This is not a notebook."));
        }
        if !tokio::fs::metadata(&target)
            .await
            .is_ok_and(|info| info.is_file())
        {
            return Err(CoreError::new(404, "No such notebook."));
        }
        Ok((target, relative))
    }

    /// The kernel held for a notebook, whatever state it is in.
    fn notebook_held(&self, project: &str, relative: &str) -> Option<Arc<Held>> {
        locked(&self.research.notebooks.open)
            .get(&(project.to_owned(), relative.to_owned()))
            .cloned()
    }

    /// The kernel held for a notebook, as `state` and the rest, or a state of "none".
    pub async fn research_notebook_status(
        &self,
        project: &str,
        requested: &str,
    ) -> Result<Value, CoreError> {
        let (_, relative) = self.notebook_file(project, requested).await?;
        Ok(self.notebook_held(project, &relative).map_or_else(
            || json!({ "kernel": null, "state": "none", "missing": [], "queued": [], "seq": 0 }),
            |held| held.view(),
        ))
    }

    /// Starts a kernel for a notebook if it has none that can take a cell. A helper that said a package is missing is
    /// replaced, so that installing the package and running again is enough.
    pub async fn research_notebook_start(
        &self,
        project: &str,
        requested: &str,
    ) -> Result<Value, CoreError> {
        let (_, relative) = self.notebook_file(project, requested).await?;
        Ok(self.notebook_kernel(project, &relative).await?.view())
    }

    /// The kernel that takes a notebook's cells, started when needed.
    async fn notebook_kernel(&self, project: &str, relative: &str) -> Result<Arc<Held>, CoreError> {
        if cfg!(windows) {
            return Err(CoreError::new(
                501,
                "Running a notebook is not supported on Windows yet.",
            ));
        }
        if let Some(held) = self.notebook_held(project, relative)
            && held.usable()
        {
            return Ok(held);
        }
        let python = self.research_python(project).await?;
        let (target, _) = self.notebook_file(project, relative).await?;
        let source = self.research_source(project, None)?;
        let folder = target.parent().map_or(source.clone(), PathBuf::from);
        let mut command = Command::new(&python);
        launch_env(&mut command);
        for (name, _) in std::env::vars_os() {
            if name.to_string_lossy().starts_with("SATURN_") {
                command.env_remove(&name);
            }
        }
        command
            .args(["-u", "-c", HELPER])
            .arg(&folder)
            .current_dir(&source)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        in_own_group(&mut command);

        // One start at a time for a notebook: the check and the insert are one step.
        let mut open = locked(&self.research.notebooks.open);
        let key = (project.to_owned(), relative.to_owned());
        if let Some(held) = open.get(&key)
            && held.usable()
        {
            return Ok(Arc::clone(held));
        }
        let mut child = command.spawn().map_err(|error| {
            CoreError::new(
                422,
                format!("{python} could not start: {error}. Choose the project's Python under Environment."),
            )
        })?;
        let held = Arc::new(Held {
            id: new_id("kernel")?,
            pid: child.id(),
            input: AsyncMutex::new(child.stdin.take()),
            log: Mutex::new(Log::new(python)),
            moved: watch::channel(0).0,
        });
        let tail = Arc::new(Mutex::new(Vec::new()));
        if let Some(errors) = child.stderr.take() {
            tokio::spawn(keep_tail(errors, Arc::clone(&tail)));
        }
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(follow(Arc::clone(&held), child, stdout, tail));
        }
        open.insert(key, Arc::clone(&held));
        Ok(held)
    }

    /// Queues cells to run in order, starting the kernel when needed. Each names its `cell` and `code`.
    pub async fn research_notebook_run(
        &self,
        project: &str,
        requested: &str,
        cells: &Value,
    ) -> Result<Value, CoreError> {
        let (_, relative) = self.notebook_file(project, requested).await?;
        let cells: Vec<(&str, &str)> = cells
            .as_array()
            .map(|list| {
                list.iter()
                    .map(|item| (text(item, "cell"), text(item, "code")))
                    .collect()
            })
            .unwrap_or_default();
        if cells.is_empty() || cells.iter().any(|(cell, _)| cell.is_empty()) {
            return Err(CoreError::new(
                400,
                "Name the cells to run, each with \"cell\" and \"code\".",
            ));
        }
        let held = self.notebook_kernel(project, &relative).await?;
        for (cell, code) in cells {
            held.with_log(|log| {
                if log.takes_cells() {
                    log.queued.push(cell.to_owned());
                    if log.state == "idle" {
                        log.state = "busy";
                    }
                    log.push_state(&held.id);
                }
            });
            held.tell(&json!({ "op": "run", "cell": cell, "code": code }))
                .await;
        }
        // A helper that ended meanwhile cannot take them, and nothing else would say so.
        held.with_log(|log| {
            if log.ended {
                log.let_go();
                log.push_state(&held.id);
            }
        });
        Ok(held.view())
    }

    /// The kernel a command is for, which has to be there.
    async fn notebook_running(
        &self,
        project: &str,
        requested: &str,
    ) -> Result<Arc<Held>, CoreError> {
        let (_, relative) = self.notebook_file(project, requested).await?;
        self.notebook_held(project, &relative)
            .filter(|held| held.usable())
            .ok_or_else(|| CoreError::new(409, "No kernel is running for this notebook."))
    }

    /// Interrupts the running cell. Cells waiting after it do not run.
    pub async fn research_notebook_interrupt(
        &self,
        project: &str,
        requested: &str,
    ) -> Result<Value, CoreError> {
        let held = self.notebook_running(project, requested).await?;
        held.tell(&json!({ "op": "interrupt" })).await;
        Ok(held.view())
    }

    /// Restarts the kernel in the same Python. What it held in memory goes, and what was running or waiting stops.
    pub async fn research_notebook_restart(
        &self,
        project: &str,
        requested: &str,
    ) -> Result<Value, CoreError> {
        let held = self.notebook_running(project, requested).await?;
        held.with_log(|log| {
            log.state = "restarting";
            log.push_state(&held.id);
        });
        held.tell(&json!({ "op": "restart" })).await;
        Ok(held.view())
    }

    /// Stops a notebook's kernel, if it has one. Its notebook was closed, or the person asked.
    pub async fn research_notebook_stop(
        &self,
        project: &str,
        requested: &str,
    ) -> Result<Value, CoreError> {
        let (_, relative) = self.source_path(project, requested, None).await?;
        let held = locked(&self.research.notebooks.open).remove(&(project.to_owned(), relative));
        if let Some(held) = &held {
            held.end().await;
        }
        Ok(json!({ "stopped": held.is_some() }))
    }

    /// A notebook's events from `after`, or from now, as lines of JSON, ending when its kernel does. A client that was
    /// away too long first hears `gap`.
    pub async fn research_notebook_events(
        &self,
        project: &str,
        requested: &str,
        kernel: Option<&str>,
        after: Option<u64>,
    ) -> Result<mpsc::Receiver<String>, CoreError> {
        let (_, relative) = self.notebook_file(project, requested).await?;
        let held = self
            .notebook_held(project, &relative)
            .filter(|held| kernel.is_none_or(|id| id == held.id))
            .ok_or_else(|| CoreError::new(404, "This notebook's kernel has ended."))?;
        let mut cursor = after.unwrap_or_else(|| locked(&held.log).next);
        let (sender, receiver) = mpsc::channel(32);
        let mut moved = held.moved.subscribe();
        tokio::spawn(async move {
            loop {
                moved.borrow_and_update();
                let (lines, next, gap, ended) = held.events_from(cursor);
                cursor = next;
                if gap
                    && sender
                        .send(json!({ "type": "gap" }).to_string())
                        .await
                        .is_err()
                {
                    return;
                }
                for line in lines {
                    if sender.send(line).await.is_err() {
                        return;
                    }
                }
                if ended || moved.changed().await.is_err() {
                    return;
                }
            }
        });
        Ok(receiver)
    }

    /// Stops every kernel of a project: it is going, or Saturn lost access to it.
    pub(crate) async fn research_notebooks_stop_project(&self, project: &str) {
        let going: Vec<Arc<Held>> = {
            let mut open = locked(&self.research.notebooks.open);
            let keys: Vec<(String, String)> = open
                .keys()
                .filter(|(owner, _)| owner == project)
                .cloned()
                .collect();
            keys.iter().filter_map(|key| open.remove(key)).collect()
        };
        end_all(going).await;
    }

    /// Stops every kernel: the runtime is stopping.
    pub async fn research_notebooks_stop_all(&self) {
        let going: Vec<Arc<Held>> = locked(&self.research.notebooks.open)
            .drain()
            .map(|(_, held)| held)
            .collect();
        end_all(going).await;
    }
}

/// Ends several helpers at once, so one that will not stop does not hold up the rest.
async fn end_all(going: Vec<Arc<Held>>) {
    let mut ending = JoinSet::new();
    for held in going {
        ending.spawn(async move { held.end().await });
    }
    while ending.join_next().await.is_some() {}
}
