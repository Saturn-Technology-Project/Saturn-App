import { useCallback, useEffect, useState } from "react";
import { desktop } from "../../application/desktop.js";
import type { WorktreeStatus } from "../../application/catalog.js";
import { TASK_PREFIX, TASK_STATE_LABELS, taskState, type TaskState } from "../../domain/assistant.js";
import { isBusy } from "../../domain/conversation.js";
import { t } from "../../domain/i18n.js";
import type { Agent, Conversation } from "../../domain/model.js";
import { lockedPathOf, type ResearchEvent, type ResearchPolicy } from "../../domain/research.js";
import { askToConfirm } from "../../infrastructure/confirm.js";
import { Turn } from "../assistant/Turn.js";
import { useConversation } from "../assistant/useConversation.js";
import type { ScreenProps } from "../shell/ScreenSwitch.js";
import { Badge } from "../ui/base/Badge.js";
import { Button } from "../ui/base/Button.js";
import { Card } from "../ui/base/Card.js";
import { Field } from "../ui/base/Field.js";
import { Textarea } from "../ui/base/Textarea.js";
import { classes } from "../ui/base/classes.js";
import { Empty, messageOf } from "../ui/Parts.js";
import { useFollow } from "../ui/useFollow.js";
import { Split } from "../ui/Split.js";

const research = desktop.research;
const PANE_TITLE = "mb-1.5 px-1.5 text-[11px] font-semibold text-muted-foreground [overflow-wrap:anywhere]";
const STATES: TaskState[] = ["decision", "running", "review", "finished"];
const MUTED = "text-xs text-muted-foreground";

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
      <Empty title={t("Connect a model")} action={<Button onClick={props.onOpenSettings}>{t("Open Settings")}</Button>}>
        {t("Tasks need a model to run on.")}
      </Empty>
    );
  }

  const list = (
    <div className="flex flex-1 flex-col gap-1 overflow-auto bg-panel p-2.5">
      <form
        className="mb-2.5 flex flex-col gap-2 border-b border-border pb-3"
        data-tour="tasks-new"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <Field label={t("New task")}>
          <Textarea rows={3} value={prompt} placeholder={t("Clean up load_data.py and the data splits")} onChange={(event) => setPrompt(event.target.value)} />
        </Field>
        <Button type="submit" disabled={!prompt.trim() || starting}>
          {starting ? t("Starting…") : t("Start in its own worktree")}
        </Button>
        <p className={MUTED}>{t("Locked files are refused, and nothing reaches the project until you merge it.")}</p>
      </form>
      {STATES.map((state) => {
        const group = tasks.filter((task) => stateOf(task) === state);
        if (!group.length) return null;
        return (
          <section key={state} className="mt-2.5 flex flex-col gap-0.5">
            <div className={PANE_TITLE}>{TASK_STATE_LABELS[state]}</div>
            {group.map((task) => (
              <Button variant="ghost" key={task.id} aria-pressed={task.id === current?.id} className={classes("h-auto min-h-10 w-full flex-col items-start justify-start px-2.5 py-1.5 text-left whitespace-normal [overflow-wrap:anywhere]", task.id === current?.id && "bg-muted")} onClick={() => setSelected(task.id)}>
                {task.title?.slice(TASK_PREFIX.length)}
                <div className={classes(MUTED, "font-normal")}>{task.worktree ? t("Worktree {branch}", { branch: task.worktree.branch }) : t("Worktree closed")}</div>
              </Button>
            ))}
          </section>
        );
      })}
    </div>
  );

  return (
    <Split id="tasks" side="left" size={300} minimum={220} label={t("Tasks")} pane={list}>
      <h1 className="sr-only">{t("Tasks")}</h1>
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
        <Empty title={t("No tasks yet")}>{t("Hand off batch runs, cleanups and long work here, and keep writing what you want to write yourself.")}</Empty>
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

  const activity = useFollow<HTMLDivElement>(`${task.id}:${String(log)}`);
  const runIds = new Set(conversation.runs.map((run) => run.id));
  const own = events.filter((event) => runIds.has(event.runId));
  const refusals = own.filter((event) => event.kind === "refused" && lockedPathOf(event) && !(policy?.released ?? []).includes(lockedPathOf(event)!));

  async function finish(how: "merge" | "discard") {
    const question = how === "merge" ? t("Merge {branch} into {base}?", { branch: task.worktree?.branch ?? "", base: task.worktree?.base ?? "" }) : t("Discard this task's worktree and everything in it?");
    if (!(await askToConfirm(question))) return;
    try {
      await desktop.catalog.finishWorktree(task.id, how);
      await onChanged();
    } catch (error) {
      notify(messageOf(error));
    }
  }

  /** Deletes the task's conversation; an open worktree, with whatever was not merged, is discarded with it. */
  async function remove() {
    const question = task.worktree
      ? t("Delete this task? Its worktree and branch {branch} are discarded with it, including anything not merged.", { branch: task.worktree.branch })
      : t("Delete this task? Its conversation is removed; its worktree was already merged or discarded.");
    if (!(await askToConfirm(question))) return;
    try {
      await desktop.catalog.deleteThread(task.id);
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
      await conversation.send(t("{path} is released for the next version: change it, and the next run freezes a new version with it.", { path }), "agent");
    } catch (error) {
      notify(messageOf(error));
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex min-h-[42px] flex-none flex-wrap items-center gap-2.5 border-b border-border px-2.5 py-1.5">
        <strong className="min-w-0 truncate">{task.title?.slice(TASK_PREFIX.length)}</strong>
        {task.worktree ? <Badge>{task.worktree.branch}</Badge> : <Badge tone="good">{t("Worktree closed")}</Badge>}
        {state === "decision" ? <Badge tone="wait">{t("Needs your decision")}</Badge> : null}
        {state === "running" ? <Badge tone="info">{t("Running")}</Badge> : null}
        {state === "review" ? <Badge tone="accent">{t("Ready for review")}</Badge> : null}
        <div className="flex-1" />
        {running && conversation.latest ? (
          <Button variant="outline" onClick={() => void conversation.stop(conversation.latest!)}>
            {t("Stop task")}
          </Button>
        ) : null}
        <Button variant="ghost" aria-pressed={log} onClick={() => setLog((on) => !on)}>
          {log ? t("Hide full log") : t("View full log")}
        </Button>
        {running ? null : (
          <Button variant="ghost" className="text-muted-foreground" onClick={() => void remove()}>
            {t("Delete task")}
          </Button>
        )}
        {task.worktree && !running ? (
          <>
            <Button variant="outline" onClick={() => void finish("discard")}>
              {t("Discard")}
            </Button>
            <Button onClick={() => void finish("merge")}>
              {t("Merge")}
            </Button>
          </>
        ) : null}
      </header>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-x-4 gap-y-2 border-b border-border px-3.5 py-2.5 text-xs">
        <div>
          <div className="text-muted-foreground">{t("Can change")}</div>
          <div>{t("Every file that is not locked")}</div>
        </div>
        <div>
          <div className="text-muted-foreground">{t("Locked")}</div>
          <div>{policy?.locked.length ? policy.locked.join(", ") : t("Nothing named; a frozen version also locks its data and scorer")}</div>
        </div>
        <div>
          <div className="text-muted-foreground">{t("Limits")}</div>
          <div>{task.worktree ? t("Sandboxed to worktree {branch}", { branch: task.worktree.branch }) : t("Worktree closed")}</div>
          <div>{t("Network: not restricted by Saturn")}</div>
          <div>{t("Budget: none set")}</div>
        </div>
      </div>

      {refusals.map((event, index) => {
        const path = lockedPathOf(event)!;
        return (
          <Card className="mx-3.5 my-2.5 gap-1.5 border-wait bg-panel px-3.5 py-3" key={`${event.at}-${index}`}>
            <div className="font-medium">{t("This task wants to change a locked item")}</div>
            <div>{event.kind === "refused" ? event.reason : path}</div>
            <div className={MUTED}>{t("The current version keeps its results. Releasing the lock lets the next run freeze a new version with the changed file, and the two can be compared.")}</div>
            <div className="flex flex-wrap items-end gap-2">
              <Button onClick={() => void release(path)}>{t("Release {path} for the next version", { path })}</Button>
              <Button variant="outline" onClick={() => void conversation.send(t("Keep {path} as it is and continue without changing it.", { path }), "agent")}>{t("Keep it and continue")}</Button>
              <Button variant="outline" onClick={() => { research.open(projectId, { kind: "file", path }); props.go("Workspace"); }}>{t("Edit it myself")}</Button>
            </div>
          </Card>
        );
      })}

      {status?.changedFiles.length ? <div className={classes(MUTED, "px-3 py-1")}>{t("Changed: {files}", { files: status.changedFiles.join(", ") })}</div> : null}

      {!log ? (
        <div className="flex flex-col gap-[3px] border-b border-border px-3.5 py-2.5 text-xs">
          <div className={PANE_TITLE}>{t("Activity")}</div>
          {task.worktree ? <div className="text-muted-foreground">{t("Created worktree {branch} from {base}", { branch: task.worktree.branch, base: task.worktree.base })}</div> : null}
          {conversation.runs.map((run) => (
            <div key={run.id} className="text-muted-foreground">
              {run.status === "waiting_approval" ? t("Paused: waiting for your decision") : isBusy(run) ? t("Working") : t("Turn {status}", { status: run.status })}
              {run.status === "waiting_approval" ? "" : ` · ${run.id}`}
            </div>
          ))}
          {own.map((event, index) => (
            <div key={`${event.at}-${index}`} className={event.kind === "refused" ? "text-wait" : "text-muted-foreground"}>
              {event.kind === "refused" ? t("Refused: {reason}", { reason: event.reason }) : event.kind === "integrity_changed" ? t("Changed outside its tools: {paths}", { paths: event.paths.join(", ") }) : t("Changed {path} with your approval", { path: event.path })}
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-3 py-3.5 [&[hidden]]:hidden" ref={activity} role="log" aria-label={t("What this task did")} hidden={!log && conversation.runs.length === 0}>
        {(log ? conversation.runs : conversation.runs.slice(-1)).map((run) => (
          <Turn key={run.id} run={run} onComment={(text) => void conversation.send(text, "agent")} />
        ))}
      </div>
      {task.worktree ? (
        <form
          className="flex flex-none flex-col gap-1.5 border-t border-border px-3 py-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            void conversation.send(followUp.trim(), "agent").then((sent) => {
              if (sent) setFollowUp("");
            });
          }}
        >
          <Textarea aria-label={t("Follow-up for this task")} className="resize-none" rows={2} value={followUp} placeholder={t("Tell it what to do next")} onChange={(event) => setFollowUp(event.target.value)} />
          <div className="flex items-center gap-2">
            <div className="flex-1" />
            <Button type="submit" variant="outline" disabled={!followUp.trim() || conversation.busy}>
              {t("Send")}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
