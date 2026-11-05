import { useCallback, useEffect, useState } from "react";
import { desktop } from "../../application/desktop.js";
import type { WorktreeStatus } from "../../application/catalog.js";
import { TASK_PREFIX, TASK_STATE_LABELS, taskState, type TaskState } from "../../domain/assistant.js";
import { isBusy } from "../../domain/conversation.js";
import type { Agent, Conversation } from "../../domain/model.js";
import { lockedPathOf, type ResearchEvent, type ResearchPolicy } from "../../domain/research.js";
import { askToConfirm } from "../../infrastructure/confirm.js";
import { Turn } from "../assistant/Turn.js";
import { useConversation } from "../assistant/useConversation.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { Empty, messageOf } from "../ui/Parts.js";
import { Split } from "../ui/Split.js";

const research = desktop.research;
const STATES: TaskState[] = ["decision", "running", "review", "finished"];

/** Work handed to an agent in its own worktree: nothing reaches the project until it is merged here. */
export function Tasks(props: ScreenProps & { onOpenSettings: () => void }) {
  const { project, notify } = props;
  const [agent, setAgent] = useState<Agent | null>(null);
  const [ready, setReady] = useState(false);
  const [tasks, setTasks] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [starting, setStarting] = useState(false);
  const [policy, setPolicy] = useState<ResearchPolicy | null>(null);
  const [events, setEvents] = useState<ResearchEvent[]>([]);
  // What each task's chat last did, for grouping the list; the detail knows more once it is open.
  const [states, setStates] = useState<Record<string, TaskState>>({});

  const load = useCallback(async () => {
    try {
      const found = await desktop.assistant.agent();
      setAgent(found.agent);
      if (found.agent) setTasks(await desktop.assistant.tasks(found.agent, project.id));
      setPolicy(await research.policy(project.id));
      setEvents((await research.events(project.id)).items);
    } catch (error) {
      notify(messageOf(error));
    } finally {
      setReady(true);
    }
  }, [notify, project.id]);

  useEffect(() => {
    void load();
    return desktop.live.onChange(() => void load());
  }, [load]);
  useEffect(() => desktop.live.onResearchChange(() => void load()), [load]);

  const current = tasks.find((item) => item.id === selected) ?? tasks[0] ?? null;
  const stateOf = (task: Conversation) => states[task.id] ?? taskState(Boolean(task.worktree), undefined, false);

  async function start() {
    if (!agent || !prompt.trim()) return;
    setStarting(true);
    try {
      const thread = await desktop.assistant.startTask(agent, project.id, prompt.trim());
      setPrompt("");
      setSelected(thread.id);
      await load();
    } catch (error) {
      notify(messageOf(error));
    } finally {
      setStarting(false);
    }
  }

  if (ready && !agent) {
    return (
      <Empty title="Connect a model" action={<button type="button" className="lab-button primary" onClick={props.onOpenSettings}>Open Settings</button>}>
        Tasks need a model to run on.
      </Empty>
    );
  }

  const list = (
    <div className="lab-task-list">
      <form
        className="lab-task-new"
        data-tour="tasks-new"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <label className="lab-field">
          New task
          <textarea rows={3} value={prompt} placeholder="Clean up load_data.py and the data splits" onChange={(event) => setPrompt(event.target.value)} />
        </label>
        <button type="submit" className="lab-button primary" disabled={!prompt.trim() || starting}>
          {starting ? "Starting…" : "Start in its own worktree"}
        </button>
        <p className="lab-muted">Manual and locked files are refused, and nothing reaches the project until you merge it.</p>
      </form>
      {STATES.map((state) => {
        const group = tasks.filter((task) => stateOf(task) === state);
        if (!group.length) return null;
        return (
          <section key={state} className="lab-task-group">
            <div className="lab-pane-title">{TASK_STATE_LABELS[state]}</div>
            {group.map((task) => (
              <button type="button" key={task.id} aria-pressed={task.id === current?.id} className={task.id === current?.id ? "lab-list-item active" : "lab-list-item"} onClick={() => setSelected(task.id)}>
                {task.title?.slice(TASK_PREFIX.length)}
                <div className="lab-muted">{task.worktree ? `Worktree ${task.worktree.branch}` : "Worktree closed"}</div>
              </button>
            ))}
          </section>
        );
      })}
    </div>
  );

  return (
    <Split id="tasks" side="left" size={300} minimum={220} label="Tasks" pane={list}>
      <h1 className="lab-unseen">Tasks</h1>
      {current && agent ? (
        <TaskDetail
          key={current.id}
          task={current}
          agent={agent}
          projectId={project.id}
          policy={policy}
          events={events}
          notify={notify}
          go={props.go}
          onChanged={load}
          onState={(state) => setStates((known) => (known[current.id] === state ? known : { ...known, [current.id]: state }))}
        />
      ) : (
        <Empty title="No tasks yet">Hand off batch runs, cleanups and long work here, and keep writing what you want to write yourself.</Empty>
      )}
    </Split>
  );
}

/** One task: what it may change, what it did, what waits for you, and what becomes of its worktree. */
function TaskDetail(props: {
  task: Conversation;
  agent: Agent;
  projectId: string;
  policy: ResearchPolicy | null;
  events: ResearchEvent[];
  notify: (message: string) => void;
  go: ScreenProps["go"];
  onChanged: () => Promise<void>;
  onState: (state: TaskState) => void;
}) {
  const { task, agent, projectId, policy, events, notify, onChanged, onState } = props;
  const conversation = useConversation(agent.id, task.id, notify);
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const [followUp, setFollowUp] = useState("");
  const [log, setLog] = useState(false);

  const running = isBusy(conversation.latest);
  const state = taskState(Boolean(task.worktree), conversation.latest?.status, running);
  useEffect(() => onState(state), [onState, state]);
  useEffect(() => {
    if (!task.worktree) return;
    desktop.catalog.worktreeStatus(task.id).then(setStatus).catch(() => setStatus(null));
  }, [conversation.runs.length, running, task.id, task.worktree]);

  const runIds = new Set(conversation.runs.map((run) => run.id));
  const own = events.filter((event) => runIds.has(event.runId));
  const refusals = own.filter((event) => event.kind === "refused" && lockedPathOf(event) && !(policy?.released ?? []).includes(lockedPathOf(event)!));
  const canChange = Object.entries(policy?.modes ?? {}).filter(([, mode]) => mode === "delegate").map(([path]) => path);
  const refused = Object.entries(policy?.modes ?? {}).filter(([, mode]) => mode === "manual").map(([path]) => path);

  async function finish(how: "merge" | "discard") {
    const question = how === "merge" ? `Merge ${task.worktree?.branch} into ${task.worktree?.base}?` : "Discard this task's worktree and everything in it?";
    if (!(await askToConfirm(question))) return;
    try {
      await desktop.catalog.finishWorktree(task.id, how);
      await onChanged();
    } catch (error) {
      notify(messageOf(error));
    }
  }

  async function release(path: string) {
    if (!policy) return;
    try {
      await research.releaseLock(projectId, policy, path);
      await onChanged();
      await conversation.send(`${path} is released for the next version: change it, and the next run freezes a new version with it.`, "agent");
    } catch (error) {
      notify(messageOf(error));
    }
  }

  return (
    <div className="lab-task">
      <header className="lab-toolbar">
        <strong className="lab-task-title">{task.title?.slice(TASK_PREFIX.length)}</strong>
        {task.worktree ? <span className="lab-tag">{task.worktree.branch}</span> : <span className="lab-tag good">Worktree closed</span>}
        {state === "decision" ? <span className="lab-tag warn">Needs your decision</span> : null}
        {state === "running" ? <span className="lab-tag active">Running</span> : null}
        {state === "review" ? <span className="lab-tag">Ready for review</span> : null}
        <div className="lab-rail-space" />
        {running && conversation.latest ? (
          <button type="button" className="lab-button" onClick={() => void conversation.stop(conversation.latest!)}>
            Stop task
          </button>
        ) : null}
        <button type="button" className="lab-button quiet" aria-pressed={log} onClick={() => setLog((on) => !on)}>
          {log ? "Hide full log" : "View full log"}
        </button>
        {task.worktree && !running ? (
          <>
            <button type="button" className="lab-button" onClick={() => void finish("discard")}>
              Discard
            </button>
            <button type="button" className="lab-button primary" onClick={() => void finish("merge")}>
              Merge
            </button>
          </>
        ) : null}
      </header>

      <div className="lab-task-scope">
        <div>
          <div className="lab-muted">Can change</div>
          <div>{canChange.length ? canChange.join(", ") : "Every file not set to Manual"}</div>
        </div>
        <div>
          <div className="lab-muted">Locked</div>
          <div>{[...(policy?.locked ?? []), ...refused].length ? [...(policy?.locked ?? []), ...refused].join(", ") : "Nothing"}</div>
        </div>
        <div>
          <div className="lab-muted">Limits</div>
          <div>{task.worktree ? `Sandboxed to worktree ${task.worktree.branch}` : "Worktree closed"}</div>
          <div>Network: not restricted by Saturn</div>
          <div>Budget: none set</div>
        </div>
      </div>

      {refusals.map((event, index) => {
        const path = lockedPathOf(event)!;
        return (
          <div className="lab-card attention" key={`${event.at}-${index}`}>
            <div style={{ fontWeight: 500 }}>This task wants to change a locked item</div>
            <div>{event.kind === "refused" ? event.reason : path}</div>
            <div className="lab-muted">The current version keeps its results. Releasing the lock lets the next run freeze a new version with the changed file, and the two can be compared.</div>
            <div className="lab-form">
              <button type="button" className="lab-button primary" onClick={() => void release(path)}>Release {path} for the next version</button>
              <button type="button" className="lab-button" onClick={() => void conversation.send(`Keep ${path} as it is and continue without changing it.`, "agent")}>Keep it and continue</button>
              <button type="button" className="lab-button" onClick={() => { research.open(projectId, { kind: "file", path }); props.go("Workspace"); }}>Edit it myself</button>
            </div>
          </div>
        );
      })}

      {status?.changedFiles.length ? <div className="lab-muted lab-task-status">Changed: {status.changedFiles.join(", ")}</div> : null}

      {!log ? (
        <div className="lab-task-activity">
          <div className="lab-pane-title">Activity</div>
          {task.worktree ? <div className="lab-muted">Created worktree {task.worktree.branch} from {task.worktree.base}</div> : null}
          {conversation.runs.map((run) => (
            <div key={run.id} className="lab-muted">
              {run.status === "waiting_approval" ? "Paused: waiting for your decision" : isBusy(run) ? "Working" : `Turn ${run.status}`}
              {run.status === "waiting_approval" ? "" : ` · ${run.id}`}
            </div>
          ))}
          {own.map((event, index) => (
            <div key={`${event.at}-${index}`} className={event.kind === "refused" ? "lab-warning" : "lab-muted"}>
              {event.kind === "refused" ? `Refused: ${event.reason}` : event.kind === "integrity_changed" ? `Changed outside its tools: ${event.paths.join(", ")}` : `Changed ${event.path} with your approval`}
            </div>
          ))}
        </div>
      ) : null}

      <div className="lab-conversation" role="log" aria-label="What this task did" hidden={!log && conversation.runs.length === 0}>
        {(log ? conversation.runs : conversation.runs.slice(-1)).map((run) => (
          <Turn key={run.id} run={run} onComment={(text) => void conversation.send(text, "agent")} />
        ))}
      </div>
      {task.worktree ? (
        <form
          className="lab-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void conversation.send(followUp.trim(), "agent").then((sent) => {
              if (sent) setFollowUp("");
            });
          }}
        >
          <textarea aria-label="Follow-up for this task" rows={2} value={followUp} placeholder="Tell it what to do next" onChange={(event) => setFollowUp(event.target.value)} />
          <div className="lab-composer-actions">
            <div className="lab-rail-space" />
            <button type="submit" className="lab-button" disabled={!followUp.trim() || conversation.busy}>
              Send
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
