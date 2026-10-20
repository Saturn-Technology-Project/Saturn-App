import { useState } from "react";
import { desktop } from "../application/desktop";
import type { Agent, RunSummary } from "../domain/model";

const ACTIVE = new Set(["running", "queued", "waiting_approval", "sleeping"]);

const STATE_LABEL: Record<string, string> = {
  running: "Working",
  queued: "Queued",
  waiting_approval: "Needs your approval",
  sleeping: "Waiting",
  completed: "Done",
  failed: "Failed",
  cancelled: "Stopped",
};

/**
 * Every agent at work, in one place: what needs you (approvals, failures) first, then what is running, then what
 * finished lately. A row opens its chat; approvals can be answered right here. The list comes from the App's
 * poll of GET /runs, so it is as fresh as the chats.
 */
export function AgentsBoard(props: {
  runs: RunSummary[];
  agents: Agent[];
  projectNames: Record<string, string>;
  unread: Set<string>;
  onOpen: (run: RunSummary) => void;
  onDispatch: (agentId: string, text: string, projectId: string | null) => Promise<void>;
  projects: { id: string; name: string; access: boolean }[];
}) {
  const [text, setText] = useState("");
  const [agentId, setAgentId] = useState(props.agents[0]?.id ?? "");
  const [projectId, setProjectId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const needs = props.runs.filter((run) => run.status === "waiting_approval" || run.status === "failed");
  const working = props.runs.filter((run) => ACTIVE.has(run.status) && run.status !== "waiting_approval");
  const done = props.runs.filter((run) => !ACTIVE.has(run.status) && run.status !== "failed");
  const agent = props.agents.find((item) => item.id === agentId) ?? props.agents[0];

  async function dispatch() {
    const task = text.trim();
    if (!task || !agent) return;
    setBusy(true);
    setError("");
    try {
      await props.onDispatch(agent.id, task, projectId || null);
      setText("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start the agent");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="agents-board">
      <header className="agents-board-head">
        <div>
          <h2>Agents</h2>
          <p className="hint">{working.length ? `${working.length} working` : "Nothing running"}{needs.length ? ` · ${needs.length} need${needs.length === 1 ? "s" : ""} you` : ""}</p>
        </div>
      </header>

      <form
        className="agents-dispatch"
        onSubmit={(event) => {
          event.preventDefault();
          void dispatch();
        }}
      >
        <textarea
          rows={2}
          value={text}
          placeholder="Hand a task to an agent: it works in its own chat (on its own branch in a project) while you keep going…"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void dispatch();
            }
          }}
        />
        <div className="agents-dispatch-bar">
          <select className="input tiny" aria-label="Agent" value={agent?.id ?? ""} onChange={(event) => setAgentId(event.target.value)}>
            {props.agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <select className="input tiny" aria-label="Project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">No project (sandbox)</option>
            {props.projects.filter((item) => item.access).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <button type="submit" className="btn primary-btn tiny" disabled={busy || !text.trim() || !agent}>Run in the background</button>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </form>

      <Section title="Needs you" runs={needs} empty="Nothing waiting on you." projectNames={props.projectNames} unread={props.unread} onOpen={props.onOpen} />
      <Section title="Working" runs={working} empty="No agent is working right now." projectNames={props.projectNames} unread={props.unread} onOpen={props.onOpen} />
      <Section title="Recent" runs={done} empty="No finished runs yet." projectNames={props.projectNames} unread={props.unread} onOpen={props.onOpen} />
    </div>
  );
}

function Section(props: {
  title: string;
  runs: RunSummary[];
  empty: string;
  projectNames: Record<string, string>;
  unread: Set<string>;
  onOpen: (run: RunSummary) => void;
}) {
  return (
    <section className="agents-section">
      <h3>{props.title}{props.runs.length ? <span className="count-pill">{props.runs.length}</span> : null}</h3>
      {props.runs.length === 0 ? <p className="hint">{props.empty}</p> : null}
      <ul>
        {props.runs.map((run) => <Row key={run.id} run={run} projectName={run.projectId ? props.projectNames[run.projectId] : undefined} unread={props.unread.has(run.id)} onOpen={() => props.onOpen(run)} />)}
      </ul>
    </section>
  );
}

function Row(props: { run: RunSummary; projectName?: string; unread: boolean; onOpen: () => void }) {
  const { run } = props;
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState("");

  async function decide(allow: boolean) {
    setDeciding(true);
    setError("");
    try {
      // The waiting action is the last one of the run; the chat shows the full card.
      const full = await desktop.runs.get(run.id);
      const waiting = full.actions.find((action) => action.status === "waiting_approval");
      if (waiting?.id) await desktop.runs.decide(run.id, waiting.id, allow);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not answer");
    } finally {
      setDeciding(false);
    }
  }

  async function stop() {
    setDeciding(true);
    try {
      await desktop.runs.stop(run.id);
    } finally {
      setDeciding(false);
    }
  }

  return (
    <li className={`agents-row ${run.status}${props.unread ? " unread" : ""}`}>
      <button type="button" className="agents-row-main" onClick={props.onOpen}>
        <span className={`agents-dot ${run.status}`} aria-hidden="true" />
        <span className="agents-row-text">
          <strong>{run.threadTitle.replace(/^⧉ /, "")}</strong>
          <span className="hint">
            {run.agentName}
            {props.projectName ? ` · ${props.projectName}` : ""}
            {run.branch ? ` · ${run.branch.replace(/^saturn\//, "⎇ ")}` : ""}
            {run.changedFiles ? ` · ${run.changedFiles} file${run.changedFiles === 1 ? "" : "s"}` : ""}
            {run.updatedAt ? ` · ${ago(run.updatedAt)}` : ""}
          </span>
          <span className="agents-row-input">{run.input}</span>
        </span>
        <span className={`agents-state ${run.status}`}>{STATE_LABEL[run.status] ?? run.status}</span>
      </button>
      {run.status === "waiting_approval" ? (
        <span className="agents-row-actions">
          <button type="button" className="btn ghost tiny" disabled={deciding} onClick={() => void decide(false)}>Deny</button>
          <button type="button" className="btn tiny" disabled={deciding} onClick={() => void decide(true)}>Approve</button>
        </span>
      ) : run.status === "running" || run.status === "queued" || run.status === "sleeping" ? (
        <span className="agents-row-actions">
          <button type="button" className="btn ghost tiny" disabled={deciding} onClick={() => void stop()}>Stop</button>
        </span>
      ) : null}
      {error ? <span className="error">{error}</span> : null}
    </li>
  );
}

function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}
