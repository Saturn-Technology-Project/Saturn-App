import { useCallback, useEffect, useState } from "react";
import { desktop } from "../../application/desktop.js";
import type { WorktreeStatus } from "../../application/catalog.js";
import { TASK_PREFIX } from "../../domain/assistant.js";
import { isBusy } from "../../domain/conversation.js";
import type { Agent, Conversation } from "../../domain/model.js";
import { askToConfirm } from "../../infrastructure/confirm.js";
import { Turn } from "../assistant/Turn.js";
import { useConversation } from "../assistant/useConversation.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { Empty, messageOf } from "../ui/Parts.js";
import { Split } from "../ui/Split.js";

/** Work handed to an agent in its own worktree: nothing reaches the project until it is merged here. */
export function Tasks(props: ScreenProps & { onOpenSettings: () => void }) {
  const { project, notify } = props;
  const [agent, setAgent] = useState<Agent | null>(null);
  const [ready, setReady] = useState(false);
  const [tasks, setTasks] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      const found = await desktop.assistant.agent();
      setAgent(found.agent);
      if (found.agent) setTasks(await desktop.assistant.tasks(found.agent, project.id));
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

  const current = tasks.find((item) => item.id === selected) ?? tasks[0] ?? null;

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
      {tasks.map((task) => (
        <button type="button" key={task.id} aria-pressed={task.id === current?.id} className={task.id === current?.id ? "lab-list-item active" : "lab-list-item"} onClick={() => setSelected(task.id)}>
          {task.title?.slice(TASK_PREFIX.length)}
          <div className="lab-muted">{task.worktree ? task.worktree.branch : "Finished"}</div>
        </button>
      ))}
    </div>
  );

  return (
    <Split id="tasks" side="left" size={300} minimum={220} label="Tasks" pane={list}>
      {current && agent ? <TaskDetail key={current.id} task={current} agent={agent} notify={notify} onChanged={load} /> : <Empty title="No tasks yet">Hand off batch runs, cleanups and long work here, and keep writing what you want to write yourself.</Empty>}
    </Split>
  );
}

/** One task: what it did, what waits for you, and what becomes of its worktree. */
function TaskDetail(props: { task: Conversation; agent: Agent; notify: (message: string) => void; onChanged: () => Promise<void> }) {
  const { task, agent, notify, onChanged } = props;
  const conversation = useConversation(agent.id, task.id, notify);
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const [followUp, setFollowUp] = useState("");

  const running = isBusy(conversation.latest);
  useEffect(() => {
    if (!task.worktree) return;
    desktop.catalog.worktreeStatus(task.id).then(setStatus).catch(() => setStatus(null));
  }, [conversation.runs.length, running, task.id, task.worktree]);

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

  return (
    <div className="lab-task">
      <header className="lab-toolbar">
        <strong className="lab-task-title">{task.title?.slice(TASK_PREFIX.length)}</strong>
        {task.worktree ? <span className="lab-tag">{task.worktree.branch}</span> : <span className="lab-tag good">Worktree closed</span>}
        {conversation.latest?.status === "waiting_approval" ? <span className="lab-tag warn">Needs your decision</span> : null}
        {running ? <span className="lab-tag active">Running</span> : null}
        <div className="lab-rail-space" />
        {running && conversation.latest ? (
          <button type="button" className="lab-button" onClick={() => void conversation.stop(conversation.latest!)}>
            Stop
          </button>
        ) : null}
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
      {status?.changedFiles.length ? <div className="lab-muted lab-task-status">{status.changedFiles.length} files changed: {status.changedFiles.join(", ")}</div> : null}
      <div className="lab-conversation">
        {conversation.runs.map((run) => (
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
