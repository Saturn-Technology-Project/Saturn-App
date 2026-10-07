import { useEffect, useRef, useState } from "react";
import { desktop } from "../application/desktop";
import { SATURN_CLOUD } from "../infrastructure/runtime-client";
import { ProfilePage, TeamPage } from "./Account";
import { AgentSettings } from "./AgentSettings";
import { Settings } from "./Settings";
import { SATURN_AGENT_ID, agentStatusLabel, canCreateAgent, canSeeTeam, customAgents, signedOut } from "../domain/agent";
import { avatarInitial, isBusy, modelLabel, replaceRevised, upsertRun, visibleThread } from "../domain/conversation";
import type { Agent, CloudLink, Mcp, Model, PendingTask, Profile, Rag, Run, Session } from "../domain/model";

export function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<PendingTask[]>([]);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [mcp, setMcp] = useState<Mcp[]>([]);
  const [rag, setRag] = useState<Rag[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [threads, setThreads] = useState<Record<string, Run[]>>({});
  const [task, setTask] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [cloud, setCloud] = useState<CloudLink>({ paired: false, connected: false });
  const [notice, setNotice] = useState("");
  const [confirmingAgent, setConfirmingAgent] = useState<string | null>(null);
  const [panel, setPanel] = useState<"chat" | "profile" | "team" | "settings" | "agent">("chat");
  const [accountMenu, setAccountMenu] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const [profile, setProfile] = useState<Profile>({ name: "Saturn", environment: "production", heartbeatSeconds: 25, logging: "info" });
  const [session, setSession] = useState<Session | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(storedTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("saturn-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!accountMenu) return;
    function close(event: MouseEvent) {
      if (!accountRef.current?.contains(event.target as Node)) setAccountMenu(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [accountMenu]);

  async function reload() {
    const next = await desktop.catalog.snapshot();
    setAgents(next.agents);
    setTasks(next.tasks);
    setModels(next.models);
    setMcp(next.mcp);
    setRag(next.rag);
    setProfile(next.profile);
    setSelected((current) => current ?? next.agents[0]?.id ?? null);
  }

  useEffect(() => {
    let stop = false;
    void (async () => {
      try {
        const next = await desktop.session.current();
        if (stop) return;
        setSession(next);
        setCloud({ paired: next.paired, connected: next.connected });
        if (next.loggedIn) await reload();
      } catch {
        if (!stop) {
          setNotice("Runtime is not running");
          setSession(signedOut);
        }
        return;
      }
      try {
        const refreshed = await desktop.session.refresh(AbortSignal.timeout(8_000));
        if (stop) return;
        setSession(refreshed);
        setCloud({ paired: refreshed.paired, connected: refreshed.connected });
        if (refreshed.loggedIn) await reload();
      } catch {
        // The shell is already showing the local session.
      }
    })();
    return () => {
      stop = true;
    };
  }, []);

  useEffect(() => {
    if (!session?.loggedIn) return;
    const timer = window.setInterval(() => {
      void desktop.session.current()
        .then(async (next) => {
          setSession(next);
          setCloud({ paired: next.paired, connected: next.connected });
          if (!next.loggedIn) {
            setNotice("");
            return;
          }
          setNotice((current) => (current === "Runtime is not running" ? "" : current));
          await reload();
        })
        .catch(() => setNotice("Runtime is not running"));
    }, 2000);
    return () => window.clearInterval(timer);
  }, [session?.loggedIn]);

  useEffect(() => {
    setThreads({});
  }, [session?.email]);

  useEffect(() => {
    if (!session?.loggedIn || !selected) return;
    const agentId = selected;
    let stop = false;
    async function pull() {
      try {
        const list = await desktop.catalog.messages(agentId);
        if (!stop) setThreads((current) => ({ ...current, [agentId]: list }));
      } catch {
        // The local thread stays until Cloud can be reached.
      }
    }
    void pull();
    const timer = window.setInterval(() => void pull(), 2000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [session?.loggedIn, session?.email, selected]);

  const agent = agents.find((item) => item.id === selected) ?? null;
  const thread = agent ? threads[agent.id] ?? [] : [];
  const { visible, editIndex } = visibleThread(thread, editing);
  const latest = thread.at(-1);
  const busy = isBusy(latest);
  const initial = avatarInitial(session?.name || profile.name);

  function remember(run: Run, agentId: string) {
    setThreads((current) => ({ ...current, [agentId]: upsertRun(current[agentId] ?? [], run) }));
  }

  async function createAgent() {
    try {
      const created = await desktop.catalog.createAgent({
        name: name.trim() || "New agent",
        modelConnectionId: models[0]?.id ?? null,
      });
      setSelected(created.id);
      setName("");
      setCreating(false);
      setNotice("");
      setTask("");
      await reload();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Could not create the agent");
    }
  }

  function watch(runId: string, agentId: string) {
    const timer = window.setInterval(() => {
      void desktop.runs.get(runId)
        .then((current) => {
          setThreads((existing) => {
            const list = existing[agentId] ?? [];
            if (!list.some((item) => item.id === runId)) return existing;
            return { ...existing, [agentId]: upsertRun(list, current) };
          });
          if (current.status === "completed" || current.status === "failed" || current.status === "cancelled" || current.status === "waiting_approval") {
            window.clearInterval(timer);
          }
        })
        .catch((error: unknown) => {
          window.clearInterval(timer);
          if (!(error instanceof Error) || error.message !== "Run not found") return;
          setThreads((existing) => {
            const list = existing[agentId] ?? [];
            if (!list.some((item) => item.id === runId)) return existing;
            return { ...existing, [agentId]: list.filter((item) => item.id !== runId) };
          });
        });
    }, 400);
  }

  async function send() {
    if (!agent || !task.trim() || busy || editing) return;
    const input = task.trim();
    let started: Run;
    try {
      started = await desktop.runs.start(agent.id, input);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Run failed");
      return;
    }
    setNotice("");
    setTask("");
    remember(started, agent.id);
    watch(started.id, agent.id);
  }

  async function stopRun(run: Run) {
    try {
      const stopped = await desktop.runs.stop(run.id);
      if (!agent) return;
      setThreads((current) => ({
        ...current,
        [agent.id]: (current[agent.id] ?? []).map((item) => (item.id === stopped.id ? stopped : item)),
      }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not stop the agent");
    }
  }

  async function revise(run: Run) {
    if (!agent || !draft.trim()) return;
    const input = draft.trim();
    let revised: { run: Run; removed: string[] };
    try {
      revised = await desktop.runs.revise(run.id, input);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not edit the message");
      return;
    }
    setNotice("");
    setEditing(null);
    setDraft("");
    const agentId = agent.id;
    setThreads((current) => ({ ...current, [agentId]: replaceRevised(current[agentId] ?? [], revised.run, revised.removed) }));
    watch(revised.run.id, agentId);
  }

  async function removeAgent(id: string) {
    try {
      await desktop.catalog.deleteAgent(id);
      setThreads((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setConfirmingAgent(null);
      setNotice("");
      setPanel("chat");
      const rest = agents.filter((item) => item.id !== id);
      setSelected(rest[0]?.id ?? null);
      await reload();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Could not remove the agent");
    }
  }

  async function patchAgent(patch: Partial<Agent>) {
    if (!agent) return;
    await desktop.catalog.updateAgent(agent.id, patch);
    await reload();
  }

  function toggleTheme() {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }

  async function signOut() {
    setAccountMenu(false);
    try {
      await desktop.session.logout();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Could not sign out");
      return;
    }
    setPanel("chat");
    setSession(signedOut);
    setCloud({ paired: false, connected: false });
    setNotice("");
  }

  if (!session) {
    return (
      <main className="login">
        <div className="login-panel">
          <img className="login-mark" src="/saturn-logo.jpg" alt="" />
          <h1>Saturn</h1>
          <p className="hint">Loading…</p>
          <ThemeButton theme={theme} onToggle={toggleTheme} />
        </div>
      </main>
    );
  }

  if (!session.loggedIn) {
    return <Login notice={notice} theme={theme} onToggleTheme={toggleTheme} onSignedIn={async (next) => {
      setSession(next);
      setCloud({ paired: next.paired, connected: next.connected });
      setNotice(next.cloudError ? "Signed in. Organization and agents are loaded. Cloud session is not connected yet." : "");
      await reload();
    }} />;
  }
  return (
    <div className="app">
      <aside className="nav">
        <div className="brand">
          <div className="brand-id">
            <img className="brand-mark" src="/saturn-logo.jpg" alt="" />
            <h1>{session.organization?.name ?? "Saturn"}</h1>
          </div>
        </div>
        <div className="nav-scroll">
          <section className="nav-group">
            <h2>Task</h2>
            {tasks.length === 0 ? <p className="nav-empty">Nothing waiting</p> : tasks.map((item) => (
              <button
                key={item.id}
                type="button"
                className={item.id === selectedTask ? "agent active" : "agent"}
                onClick={() => {
                  setSelected(item.agentId);
                  setSelectedTask(item.id);
                  setPanel("chat");
                  setTask("");
                  setEditing(null);
                  setDraft("");
                }}
              >
                <strong>{item.input}</strong>
                <small>{item.toolId ? `${item.agentName} · ${item.toolId}` : item.agentName}</small>
              </button>
            ))}
          </section>
          <section className="nav-group">
            <h2>Agents</h2>
            <div className="agents">
              {agents.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={item.id === selected && selectedTask === null ? "agent active" : "agent"}
                  onClick={() => { setSelected(item.id); setSelectedTask(null); setPanel("chat"); setTask(""); setEditing(null); setDraft(""); }}
                >
                  <strong>{item.name}</strong>
                  <small>{agentStatusLabel(item)}</small>
                </button>
              ))}
            </div>
          </section>
        </div>
        {canCreateAgent(session) ? (
          creating ? (
            <form className="new-agent" onSubmit={(event) => { event.preventDefault(); void createAgent(); }}>
              <input autoFocus value={name} placeholder="Agent name" onChange={(event) => setName(event.target.value)} />
              <button className="btn" type="submit">Add</button>
            </form>
          ) : (
            <button className="btn block" type="button" onClick={() => setCreating(true)}>New agent</button>
          )
        ) : null}
        <div className="nav-foot" ref={accountRef}>
          {accountMenu ? (
            <div className="account-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setAccountMenu(false); setPanel("profile"); }}>Profile</button>
              {canSeeTeam(session) ? (
                <button type="button" role="menuitem" onClick={() => { setAccountMenu(false); setPanel("team"); }}>Team</button>
              ) : null}
              <button type="button" role="menuitem" onClick={() => { setAccountMenu(false); setPanel("settings"); }}>Settings</button>
              <button type="button" role="menuitem" onClick={() => void signOut()}>Sign out</button>
            </div>
          ) : null}
          <div className="account">
            <button className="account-main" type="button" aria-expanded={accountMenu} onClick={() => setAccountMenu((open) => !open)}>
              <span className="avatar">{initial}</span>
              <span className="account-copy">
                <strong>{session.name}</strong>
                <small>{session.email}</small>
              </span>
            </button>
            <button className="gear" type="button" aria-label={theme === "dark" ? "Light mode" : "Dark mode"} onClick={toggleTheme}>
              <ThemeIcon theme={theme} />
            </button>
          </div>
        </div>
      </aside>

      <main className="stage">
        {panel === "profile" ? (
          <ProfilePage
            onClose={() => setPanel("chat")}
            onSaved={(next) => setSession((current) => current ? { ...current, name: next.name } : current)}
          />
        ) : panel === "team" && canSeeTeam(session) ? (
          <TeamPage canWrite={session.team === "write"} agents={customAgents(agents)} onClose={() => setPanel("chat")} />
        ) : panel === "agent" && agent ? (
          <AgentSettings
            agent={agent}
            models={models}
            mcp={mcp}
            rag={rag}
            onClose={() => setPanel("chat")}
            canEdit={agent.canEdit !== false}
            onSave={patchAgent}
          />
        ) : panel === "settings" ? (
          <Settings
            agents={agents}
            agent={agent}
            models={models}
            mcp={mcp}
            rag={rag}
            cloud={cloud}
            onClose={() => setPanel("chat")}
            onChanged={reload}
            onPatchAgent={patchAgent}
            onCloud={setCloud}
            onLogout={() => void signOut()}
            onProfile={setProfile}
            canRemove={session.team === "write"}
          />
        ) : (
        <>
        {agent ? (
          <header className="topbar">
            <h2>{agent.name}</h2>
            <div className="actions">
              {session.team === "write" && agent.id !== SATURN_AGENT_ID ? (
                confirmingAgent === agent.id ? (
                  <>
                    <button className="btn ghost" type="button" onClick={() => setConfirmingAgent(null)}>Cancel</button>
                    <button className="btn danger" type="button" onClick={() => void removeAgent(agent.id)}>Remove agent</button>
                  </>
                ) : (
                  <button className="btn ghost" type="button" onClick={() => setConfirmingAgent(agent.id)}>Remove</button>
                )
              ) : null}
              <button className="btn ghost" type="button" onClick={() => setPanel("agent")}>Configure</button>
            </div>
          </header>
        ) : null}

        <section className="thread">
          <div className={thread.length ? "column" : "column empty"}>
            {thread.length === 0 ? (
              <>
                <h2>{agent ? agent.name : "Your agents, on your machine"}</h2>
                <p className="hint">{agent ? "Ask it to use a connected tool." : "The runtime calls the model. This window only sends the task."}</p>
              </>
            ) : (
              visible.map((run) => (
                <article className="turn" key={run.id}>
                  <div className="user">
                    {editing === run.id ? (
                      <form className="edit-bubble" onSubmit={(event) => { event.preventDefault(); void revise(run); }}>
                        <textarea
                          aria-label="Edit message"
                          rows={Math.min(8, Math.max(2, draft.split("\n").length))}
                          value={draft}
                          autoFocus
                          onChange={(event) => setDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.preventDefault();
                              setEditing(null);
                            }
                            if (event.key === "Enter" && !event.shiftKey) {
                              event.preventDefault();
                              void revise(run);
                            }
                          }}
                        />
                        <p className="hint">
                          {editIndex < thread.length - 1
                            ? "Sending replaces this reply and the messages after it."
                            : "Sending replaces this reply."}
                        </p>
                        <div className="edit-actions">
                          <button className="btn ghost tiny" type="button" onClick={() => setEditing(null)}>Cancel</button>
                          <button className="btn tiny" type="submit" disabled={!draft.trim()}>Send</button>
                        </div>
                      </form>
                    ) : (
                      <div className="user-block">
                        <p>{run.input}</p>
                        {run.status === "running" || run.status === "queued" ? null : (
                          <button
                            className="edit"
                            type="button"
                            aria-label="Edit message"
                            onClick={() => { setEditing(run.id); setDraft(run.input); }}
                          >
                            <Pencil />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="assistant">
                    {run.thinking ? <Thinking text={run.thinking} /> : null}
                    {run.output || (run.status === "running" || run.status === "queued" ? "Working…" : run.status === "cancelled" ? "Stopped" : run.error || run.status)}
                    {run.actions.length > 0 ? (
                      <div className="tools">
                        {run.actions.map((action) => (
                          <span className="chip" key={`${run.id}-${action.toolId}`}>
                            <span className={`dot ${action.status === "completed" ? "ok" : action.status === "waiting_approval" ? "wait" : action.status === "denied" || action.status === "failed" ? "off" : ""}`} />
                            {action.toolId}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </article>
              ))
            )}
          </div>
        </section>

        <div className="dock">
          <form
            className="column composer"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy && latest) {
                void stopRun(latest);
                return;
              }
              void send();
            }}
          >
            {notice ? <p className="error">{notice}</p> : null}
            <textarea
              rows={2}
              value={task}
              disabled={!agent || busy || editing !== null}
              placeholder={agent ? `Message ${agent.name}` : "Choose an agent"}
              onChange={(event) => setTask(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-bar">
              <span className="hint">{modelLabel(models, agent)}</span>
              <button className="send" type="submit" disabled={!agent || editing !== null || (!busy && !task.trim())} aria-label={busy ? "Stop" : "Send"}>
                {busy ? <Square /> : <Arrow />}
              </button>
            </div>
          </form>
        </div>
        </>
        )}
      </main>
    </div>
  );
}

function storedTheme(): "light" | "dark" {
  const saved = localStorage.getItem("saturn-theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function ThemeButton(props: { theme: "light" | "dark"; onToggle: () => void }) {
  return (
    <button className="text-btn" type="button" onClick={props.onToggle}>
      {props.theme === "dark" ? "Light mode" : "Dark mode"}
    </button>
  );
}

function Login(props: {
  notice: string;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onSignedIn: (session: Session) => Promise<void>;
}) {
  const [local, setLocal] = useState(false);
  const [localBase, setLocalBase] = useState("http://127.0.0.1:8000");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(props.notice);
  const [pending, setPending] = useState(false);
  const apiBase = local ? localBase.trim() : SATURN_CLOUD;

  async function submit() {
    setPending(true);
    setError("");
    try {
      const next = await desktop.session.login(apiBase, email, password);
      await props.onSignedIn(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Email or password is incorrect");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="login">
      <form className="login-panel" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <img className="login-mark" src="/saturn-logo.jpg" alt="" />
        <h1>Welcome back</h1>
        <p className="hint">Sign in to load your organization and its agents.</p>
        <input
          type="email"
          aria-label="Email"
          placeholder="Email address"
          autoComplete="username"
          autoFocus
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <input
          type="password"
          aria-label="Password"
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error ? <p className="error">{error}</p> : null}
        <button className="btn login-submit" type="submit" disabled={pending || !email || !password || !apiBase}>
          {pending ? "Signing in…" : "Continue"}
        </button>
        <button className="text-btn" type="button" onClick={() => setLocal((current) => !current)}>
          {local ? "Use Saturn Cloud" : "Use a local backend"}
        </button>
        <ThemeButton theme={props.theme} onToggle={props.onToggleTheme} />
        {local ? (
          <input
            aria-label="Local backend"
            placeholder="http://127.0.0.1:8000"
            value={localBase}
            onChange={(event) => setLocalBase(event.target.value)}
            spellCheck={false}
          />
        ) : null}
      </form>
    </main>
  );
}

function Thinking(props: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking">
      <button className="thinking-toggle" type="button" onClick={() => setOpen((current) => !current)}>
        {open ? "Hide thinking" : "Thinking"}
      </button>
      {open ? <p>{props.text}</p> : null}
    </div>
  );
}

function ThemeIcon(props: { theme: "light" | "dark" }) {
  if (props.theme === "dark") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="2.4" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.3 3.3l1.2 1.2M11.5 11.5l1.2 1.2M12.7 3.3l-1.2 1.2M4.5 11.5l-1.2 1.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9.2 2.2a4.8 4.8 0 1 0 4.6 6.2 3.8 3.8 0 0 1-4.6-6.2z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function Pencil() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9.2 3.4l3.4 3.4M2.8 13.2l.6-3.2L11.4 2.6a1.2 1.2 0 0 1 1.7 0l.3.3a1.2 1.2 0 0 1 0 1.7L5.4 12.6l-3.2.6z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function Arrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 12.5V3.5M8 3.5L4 7.5M8 3.5L12 7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Square() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5" y="5" width="6" height="6" rx="1" fill="currentColor" />
    </svg>
  );
}
