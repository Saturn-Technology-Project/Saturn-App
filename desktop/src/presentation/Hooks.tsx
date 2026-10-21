import { useEffect, useState } from "react";
import { desktop } from "../application/desktop";
import type { Hook, HookEvent, HookSet, Project } from "../domain/model";

const EVENTS: { id: HookEvent; label: string; hint: string }[] = [
  { id: "pre_tool", label: "Before a tool", hint: "Exit 2 blocks the call (stderr goes to the agent). Print {\"decision\": \"allow\" | \"ask\" | \"deny\"} to skip the card, ask, or refuse." },
  { id: "post_tool", label: "After a tool", hint: "Exit 2 adds stderr to the result as feedback for the agent (a linter, a formatter's complaint)." },
  { id: "stop", label: "When a turn ends", hint: "Exit 2 sends stderr back to the agent as a follow-up, at most twice per message (insist on green tests)." },
];

function HookList(props: { hooks: Hook[]; onRemove?: (index: number) => void }) {
  if (!props.hooks.length) return <p className="settings-row-desc">No hooks.</p>;
  return (
    <ul className="permission-rules">
      {props.hooks.map((hook, index) => (
        <li key={`${hook.event}:${hook.command}:${index}`} className="permission-rule">
          <span className="permission-effect hook">{hook.event.replace("_", " ")}</span>
          {hook.event !== "stop" ? <code className="permission-tool">{hook.matcher || "any tool"}</code> : null}
          <code className="permission-pattern" title={hook.command}>{hook.command}</code>
          {props.onRemove ? (
            <button type="button" className="btn ghost tiny danger" onClick={() => props.onRemove!(index)} aria-label={`Remove ${hook.command}`}>Remove</button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Settings → Hooks: the user's own hooks, then each project's file hooks, which run only once allowed. */
export function HooksPage(props: { projects: Project[]; onError: (message: string) => void }) {
  const [userHooks, setUserHooks] = useState<Hook[]>([]);
  const [projectSets, setProjectSets] = useState<Record<string, HookSet[]>>({});
  const [event, setEvent] = useState<HookEvent>("pre_tool");
  const [matcher, setMatcher] = useState("");
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void desktop.admin.hooks().then((sets) => { if (active) setUserHooks(sets.find((set) => set.source === "user")?.hooks ?? []); }, (reason) => props.onError(reason instanceof Error ? reason.message : "Could not load hooks"));
    for (const project of props.projects) {
      void desktop.admin.hooks(project.id).then((sets) => { if (active) setProjectSets((prev) => ({ ...prev, [project.id]: sets.filter((set) => set.source === "project-file" || set.source === "claude-file") })); }, () => undefined);
    }
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.projects.map((project) => project.id).join(",")]);

  async function save(next: Hook[]) {
    setBusy(true);
    try {
      const sets = await desktop.admin.setUserHooks(next);
      setUserHooks(sets.find((set) => set.source === "user")?.hooks ?? []);
      props.onError("");
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not save hooks");
    } finally {
      setBusy(false);
    }
  }

  async function allow(projectId: string, set: HookSet, allowed: boolean) {
    try {
      const sets = allowed ? await desktop.admin.approveHooks(projectId, set.path!, set.fingerprint!) : await desktop.admin.revokeHooks(projectId, set.path!);
      setProjectSets((prev) => ({ ...prev, [projectId]: sets.filter((item) => item.source === "project-file" || item.source === "claude-file") }));
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not change the approval");
    }
  }

  const withFiles = props.projects.filter((project) => (projectSets[project.id] ?? []).length);
  return (
    <div className="settings-section-list">
      <div className="settings-section">
        <div className="settings-section-title">How hooks work</div>
        <div className="settings-card">
          <p className="settings-row-desc">
            A hook is a shell command that runs around an agent's tool calls, or when its turn ends, in the chat's project folder. It gets the event as JSON on stdin (the tool, its arguments and result, the turn's answer). Your hooks below run in every project. A project can bring its own in <code>.saturn/hooks.json</code>, and the hooks of its <code>.claude/settings.json</code> are read too (PreToolUse, PostToolUse and Stop); those run only after you allow them here, and any change to the file asks again.
          </p>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Your hooks</div>
        <div className="settings-card">
          <div className="settings-card-row settings-card-stack">
            <HookList hooks={userHooks} onRemove={(index) => void save(userHooks.filter((_, at) => at !== index))} />
            <form
              className="permission-form"
              onSubmit={(formEvent) => {
                formEvent.preventDefault();
                if (!command.trim()) return;
                void save([...userHooks, { event, ...(event !== "stop" && matcher.trim() ? { matcher: matcher.trim() } : {}), command: command.trim() }]).then(() => { setCommand(""); setMatcher(""); });
              }}
            >
              <select className="input tiny settings-select-fit" aria-label="Hook event" value={event} onChange={(changeEvent) => setEvent(changeEvent.target.value as HookEvent)}>
                {EVENTS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
              {event !== "stop" ? <input className="input tiny hook-matcher-input" aria-label="Tools" placeholder="tools: code, files, github_* (empty: all)" value={matcher} onChange={(changeEvent) => setMatcher(changeEvent.target.value)} /> : null}
              <input className="input tiny permission-pattern-input" aria-label="Command" placeholder="./scripts/check.sh" value={command} onChange={(changeEvent) => setCommand(changeEvent.target.value)} />
              <button type="submit" className="btn tiny" disabled={busy || !command.trim()}>Add hook</button>
              <span className="permission-hint">{EVENTS.find((item) => item.id === event)?.hint}</span>
            </form>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Project hooks</div>
        <div className="settings-card">
          {withFiles.length ? withFiles.map((project) => (projectSets[project.id] ?? []).map((set) => (
            <div className="settings-card-row settings-card-stack" key={`${project.id}:${set.path}`}>
              <div className="hook-set-head">
                <span className="settings-row-label">{project.name} · <code>{set.path}</code></span>
                <span className={set.approved ? "hook-state allowed" : "hook-state waiting"}>{set.approved ? "Allowed" : "Not running: needs your approval"}</span>
                <button type="button" className={set.approved ? "btn ghost tiny" : "btn primary-btn tiny"} onClick={() => void allow(project.id, set, !set.approved)}>
                  {set.approved ? "Stop allowing" : "Allow these hooks"}
                </button>
              </div>
              <HookList hooks={set.hooks} />
              {!set.approved ? <p className="settings-row-desc">These commands come with the folder and run with your permissions. Read them before allowing.</p> : null}
            </div>
          ))) : <p className="settings-row-desc">No project has a <code>.saturn/hooks.json</code> or hooks in <code>.claude/settings.json</code>.</p>}
        </div>
      </div>
    </div>
  );
}
