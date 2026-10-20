import { useEffect, useRef, useState } from "react";
import { desktop } from "../application/desktop";
import type { Agent, Group, GroupMessage, GroupTranscript, Run, GroupAutonomy } from "../domain/model";
import { FormattedOutput } from "./FormattedOutput";
import { RunSteps } from "./RunSteps";

/** dataTransfer type for an agent dragged from the sidebar onto a group. */
export const AGENT_DRAG_TYPE = "application/x-saturn-agent";

const SETTLED = ["completed", "failed", "cancelled"];
const PASS = /^\W*pass\W*$/i;

/** The agent id being dragged, when the drag carries one. */
function draggedAgent(event: React.DragEvent): string | null {
  return event.dataTransfer.types.includes(AGENT_DRAG_TYPE) ? event.dataTransfer.getData(AGENT_DRAG_TYPE) || "" : null;
}

/** Sidebar section: the groups, each a drop target for agents dragged from the Agents list. */
/** What each group approval setting means, shown on hover. */
const AUTONOMY_HINTS: Record<string, string> = {
  "": "Each agent asks for approval the way it does in its own chats (Claude Code agents ask before every edit or command).",
  default: "Agents edit files in their folder and run commands on their own; they still ask before destructive commands or edits outside the folder.",
  bypass: "Agents use every tool without asking. Only for groups you trust with your files.",
  review: "Agents ask before every action that is not read-only.",
};

export function GroupsNav(props: {
  groups: Group[];
  activeGroupId: string | null;
  onOpen: (id: string) => void;
  onCreate: (agentId?: string) => void;
  onAddAgent: (groupId: string, agentId: string) => void;
}) {
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  function dropProps(target: string, onDrop: (agentId: string) => void) {
    return {
      onDragOver: (event: React.DragEvent) => {
        if (draggedAgent(event) === null) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDropTarget(target);
      },
      onDragLeave: () => setDropTarget((current) => (current === target ? null : current)),
      onDrop: (event: React.DragEvent) => {
        const agentId = draggedAgent(event);
        setDropTarget(null);
        if (!agentId) return;
        event.preventDefault();
        onDrop(agentId);
      },
    };
  }

  return (
    <section className="nav-group">
      <div className={dropTarget === "new" ? "nav-group-head group-drop" : "nav-group-head"} {...dropProps("new", (agentId) => props.onCreate(agentId))}>
        <h2>Groups</h2>
        <button type="button" className="agent-folder-action-btn group-new" title="New group" aria-label="New Group" onClick={() => props.onCreate()}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {props.groups.length === 0 ? (
        <p className={dropTarget === "new" ? "group-nav-hint group-drop" : "group-nav-hint"} {...dropProps("new", (agentId) => props.onCreate(agentId))}>
          Drag agents here to start a group
        </p>
      ) : (
        props.groups.map((group) => (
          <button
            key={group.id}
            type="button"
            className={[
              "agent-thread-item group-nav-item",
              group.id === props.activeGroupId ? "active" : "",
              dropTarget === group.id ? "group-drop" : "",
            ].filter(Boolean).join(" ")}
            onClick={() => props.onOpen(group.id)}
            {...dropProps(group.id, (agentId) => props.onAddAgent(group.id, agentId))}
          >
            <span className="agent-thread-icon"><GroupIcon /></span>
            <span className="agent-thread-title" title={group.name}>{group.name}</span>
            <span className="group-nav-count">{group.agentIds.length}</span>
          </button>
        ))
      )}
    </section>
  );
}

/**
 * One group chat. The user's messages go to every member (or only the ones @mentioned); each agent
 * reads the conversation and replies or passes. Agents hand work to each other with @mentions.
 */
export function GroupChat(props: { groupId: string; agents: Agent[]; onChanged: () => void; onDeleted: () => void }) {
  const [transcript, setTranscript] = useState<GroupTranscript | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastCount = useRef(0);

  const group = transcript?.group;
  const members = (group?.agentIds ?? []).map((id) => props.agents.find((agent) => agent.id === id)).filter((agent): agent is Agent => Boolean(agent));
  const working = (transcript?.runs ?? []).filter((run) => !SETTLED.includes(run.status));

  async function refresh() {
    try {
      setTranscript(await desktop.groups.transcript(props.groupId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load the group");
    }
  }

  useEffect(() => {
    setTranscript(null);
    setError("");
    setText("");
    lastCount.current = 0;
    void refresh();
  }, [props.groupId]);

  // Poll quickly while an agent is working, slowly otherwise.
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), working.length ? 1000 : 4000);
    return () => window.clearInterval(timer);
  }, [props.groupId, working.length]);

  useEffect(() => {
    const count = (transcript?.messages.length ?? 0) + working.length;
    if (count !== lastCount.current) endRef.current?.scrollIntoView({ block: "end" });
    lastCount.current = count;
  }, [transcript, working.length]);

  async function save(patch: { name?: string; agentIds?: string[]; autonomy?: GroupAutonomy | null }) {
    try {
      await desktop.groups.update(props.groupId, patch);
      await refresh();
      props.onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update the group");
    }
  }

  function addMember(agentId: string) {
    if (!group || group.agentIds.includes(agentId)) return;
    void save({ agentIds: [...group.agentIds, agentId] });
  }

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError("");
    try {
      setTranscript(await desktop.groups.post(props.groupId, body));
      setText("");
      setMention(null);
      props.onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not send");
    } finally {
      setSending(false);
    }
  }

  async function remove() {
    if (!group || !window.confirm(`Delete the group "${group.name}" and its messages? The agents themselves stay.`)) return;
    await desktop.groups.remove(props.groupId);
    props.onDeleted();
  }

  /** Tracks an "@name" being typed at the caret, for the mention menu. */
  function onType(value: string, caret: number) {
    setText(value);
    const match = value.slice(0, caret).match(/(^|\s)@([^\s@]*)$/);
    setMention(match ? { query: match[2].toLowerCase(), start: caret - match[2].length - 1 } : null);
  }

  function insertMention(name: string) {
    if (!mention) return;
    const caret = inputRef.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, mention.start)}@${name} ${text.slice(caret)}`;
    setText(next);
    setMention(null);
    window.requestAnimationFrame(() => {
      const position = mention.start + name.length + 2;
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(position, position);
    });
  }

  const mentionChoices = mention
    ? [...members.map((agent) => agent.name), "all"].filter((name) => name.toLowerCase().startsWith(mention.query))
    : [];

  if (!group) {
    return (
      <section className="thread">
        <div className="column empty">{error ? <p className="error">{error}</p> : <p className="hint">Loading…</p>}</div>
      </section>
    );
  }

  const nameOf = (agentId?: string) => props.agents.find((agent) => agent.id === agentId)?.name ?? "Agent";
  const runOf = (runId?: string) => transcript?.runs.find((run) => run.id === runId);
  const passedOn = (message: GroupMessage) =>
    (transcript?.runs ?? []).filter((run) => run.groupMessageId === message.id && run.status === "completed" && PASS.test(run.output.trim()));

  return (
    <div
      className={dropping ? "group-chat group-drop" : "group-chat"}
      onDragOver={(event) => {
        if (draggedAgent(event) === null) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(event) => {
        const agentId = draggedAgent(event);
        setDropping(false);
        if (!agentId) return;
        event.preventDefault();
        addMember(agentId);
      }}
    >
      <header className="group-head">
        <div className="group-head-title">
          {renaming !== null ? (
            <input
              className="group-name-input"
              value={renaming}
              autoFocus
              aria-label="Group name"
              onChange={(event) => setRenaming(event.target.value)}
              onBlur={() => {
                if (renaming.trim() && renaming.trim() !== group.name) void save({ name: renaming.trim() });
                setRenaming(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") setRenaming(null);
              }}
            />
          ) : (
            <button type="button" className="group-name" title="Rename" onClick={() => setRenaming(group.name)}>
              {group.name}
            </button>
          )}
          <div className="group-head-actions">
            <select
              className="input tiny group-autonomy"
              aria-label="What agents may do without asking"
              title={AUTONOMY_HINTS[group.autonomy ?? ""]}
              value={group.autonomy ?? ""}
              onChange={(event) => void save({ autonomy: (event.target.value || null) as GroupAutonomy | null })}
            >
              <option value="">Each agent's own approvals</option>
              <option value="default">Ask only for risky actions</option>
              <option value="bypass">Full autonomy, never ask</option>
              <option value="review">Ask before every action</option>
            </select>
            <button type="button" className="btn ghost tiny group-delete" onClick={() => void remove()}>
              Delete
            </button>
          </div>
        </div>
        <div className="group-members">
          {members.map((agent) => (
            <span key={agent.id} className="group-member" title={agent.description || agent.name}>
              <Avatar name={agent.name} />
              <span>{agent.name}</span>
              <button
                type="button"
                className="group-member-remove"
                aria-label={`Remove ${agent.name}`}
                title={`Remove ${agent.name} from the group`}
                onClick={() => void save({ agentIds: group.agentIds.filter((id) => id !== agent.id) })}
              >
                ×
              </button>
            </span>
          ))}
          <div className="group-add-wrap">
            <button type="button" className="group-add" onClick={() => setAdding((value) => !value)} aria-expanded={adding}>
              + Add agent
            </button>
            {adding ? (
              <div className="group-add-menu" role="menu" onMouseLeave={() => setAdding(false)}>
                {props.agents.filter((agent) => !group.agentIds.includes(agent.id)).length === 0 ? (
                  <p className="hint">Every agent is already here.</p>
                ) : (
                  props.agents
                    .filter((agent) => !group.agentIds.includes(agent.id))
                    .map((agent) => (
                      <button
                        key={agent.id}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          addMember(agent.id);
                          setAdding(false);
                        }}
                      >
                        <Avatar name={agent.name} />
                        <span>{agent.name}</span>
                      </button>
                    ))
                )}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <section className="thread">
        <div className={transcript.messages.length ? "column" : "column empty"}>
          {transcript.messages.length === 0 ? (
            <div className="mission-empty">
              <div className="mission-hero">
                <span className="mission-kicker">Group</span>
                <h2>{group.name}</h2>
                <p className="hint">
                  {members.length === 0
                    ? "Drag agents here from the sidebar, or use + Add agent."
                    : "Every agent reads each message and decides whether it needs them. @mention an agent to ask only them; agents @mention each other to hand off work."}
                </p>
              </div>
            </div>
          ) : (
            transcript.messages.map((message) => {
              const passed = passedOn(message);
              if (!message.agentId) {
                return (
                  <article className="turn group-turn" key={message.id}>
                    <div className="user">
                      <div className="user-block">
                        <p>{message.text}</p>
                      </div>
                    </div>
                    <PassedLine runs={passed} nameOf={nameOf} />
                  </article>
                );
              }
              const run = runOf(message.runId);
              return (
                <article className="turn group-turn" key={message.id}>
                  <div className="group-agent-msg">
                    <Avatar name={nameOf(message.agentId)} />
                    <div className="group-agent-body">
                      <div className="group-agent-name">
                        {nameOf(message.agentId)}
                        <time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                      </div>
                      {run ? <RunSteps run={run} busy={false} /> : null}
                      {message.error ? (
                        <div className="run-state-line failed">
                          <span className="dot off" />
                          <span>Couldn’t reply: {message.text}</span>
                        </div>
                      ) : (
                        <div className="assistant-body">
                          <FormattedOutput text={message.text} />
                        </div>
                      )}
                    </div>
                  </div>
                  <PassedLine runs={passed} nameOf={nameOf} />
                </article>
              );
            })
          )}
          {working.map((run) => (
            <WorkingTurn key={run.id} run={run} name={nameOf(run.agentId)} />
          ))}
          <div ref={endRef} />
        </div>
      </section>

      <div className="dock">
        <form
          className="column composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {error ? <p className="error composer-notice">{error}</p> : null}
          {mentionChoices.length ? (
            <div className="group-mention-menu" role="listbox">
              {mentionChoices.map((name) => (
                <button key={name} type="button" role="option" onMouseDown={(event) => { event.preventDefault(); insertMention(name); }}>
                  {name === "all" ? <span className="group-mention-all">@all</span> : <><Avatar name={name} /><span>{name}</span></>}
                </button>
              ))}
            </div>
          ) : null}
          <textarea
            ref={inputRef}
            rows={2}
            value={text}
            disabled={sending || members.length === 0}
            placeholder={members.length ? "Message the group — @mention an agent to ask only them" : "Add an agent to the group first"}
            onChange={(event) => onType(event.target.value, event.target.selectionStart)}
            onKeyDown={(event) => {
              if (mentionChoices.length && (event.key === "Tab" || event.key === "Enter")) {
                event.preventDefault();
                insertMention(mentionChoices[0]);
                return;
              }
              if (event.key === "Escape") setMention(null);
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-bar">
            <div className="composer-controls">
              <span className="group-composer-hint">
                {working.length ? `${working.map((run) => nameOf(run.agentId)).join(", ")} ${working.length === 1 ? "is" : "are"} working…` : `${members.length} agent${members.length === 1 ? "" : "s"}`}
              </span>
            </div>
            <div className="composer-submit-group">
              <button className="send" type="submit" disabled={sending || !text.trim() || members.length === 0} aria-label="Send">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

/** An agent still on its turn: reading, working with tools, or waiting for the user's approval. */
function WorkingTurn(props: { run: Run; name: string }) {
  const { run } = props;
  const label =
    run.status === "waiting_approval" ? "needs your approval" : run.status === "sleeping" ? "is waiting" : run.actions.length ? "is working…" : "is reading…";
  return (
    <article className="turn group-turn">
      <div className="group-agent-msg working">
        <Avatar name={props.name} />
        <div className="group-agent-body">
          <div className="group-agent-name">
            {props.name} <span className={run.status === "waiting_approval" ? "group-status warn" : "group-status"}>{label}</span>
          </div>
          {run.actions.length || run.thoughts?.length || run.status === "waiting_approval" ? <RunSteps run={run} busy={run.status === "running"} /> : null}
        </div>
      </div>
    </article>
  );
}

function PassedLine(props: { runs: Run[]; nameOf: (agentId?: string) => string }) {
  if (!props.runs.length) return null;
  return <p className="group-passed">{props.runs.map((run) => props.nameOf(run.agentId)).join(", ")} passed</p>;
}

const AVATAR_HUES = [210, 265, 330, 25, 160, 45, 190, 290];

function Avatar(props: { name: string }) {
  let hash = 0;
  for (const char of props.name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const hue = AVATAR_HUES[Math.abs(hash) % AVATAR_HUES.length];
  const initials = props.name.trim().split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
  return (
    <span className="group-avatar" style={{ "--avatar-hue": hue } as React.CSSProperties} aria-hidden="true">
      {initials}
    </span>
  );
}

export function GroupIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="6" cy="5.5" r="2.25" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1.75 13c.4-2.2 2.1-3.5 4.25-3.5s3.85 1.3 4.25 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M10.5 3.6a2.1 2.1 0 010 3.9M12 9.8c1.2.5 2 1.6 2.25 3.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
