import { useEffect, useMemo, useState } from "react";
import { desktop } from "../application/desktop";
import type { Agent, Automation, AutomationFrequency, AutomationInput, AutomationTrigger, Model } from "../domain/model";

/**
 * Agents on Claude (via Claude Code) run on the user's Claude subscription, which Anthropic does not allow to run
 * unattended on a schedule; the runtime refuses them too.
 */
function onClaudePlan(agent: Agent, models: Model[]): boolean {
  return models.find((model) => model.id === agent.modelConnectionId)?.provider === "claude-code";
}

const FREQUENCIES: { id: AutomationFrequency; label: string }[] = [
  { id: "hourly", label: "Hourly" },
  { id: "daily", label: "Daily" },
  { id: "weekdays", label: "Weekdays" },
  { id: "weekly", label: "Weekly" },
];

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const TIMES = Array.from({ length: 48 }, (_, index) => {
  const hour = Math.floor(index / 2);
  const minute = index % 2 ? 30 : 0;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
});

const MINUTES = ["00", "15", "30", "45"];

const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return [];
  }
})();

function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function clockLabel(time: string): string {
  const [hour, minute] = time.split(":").map(Number);
  const suffix = hour < 12 ? "AM" : "PM";
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function scheduleLabel(trigger: AutomationTrigger): string {
  const minute = trigger.time.slice(3);
  if (trigger.frequency === "hourly") return `Hourly at :${minute}`;
  const time = clockLabel(trigger.time);
  if (trigger.frequency === "weekdays") return `Weekdays around ${time}`;
  if (trigger.frequency === "weekly") return `${WEEKDAYS[trigger.weekday]}s around ${time}`;
  return `Daily around ${time}`;
}

function nextRunLabel(next: string): string {
  const [date, time] = next.split(" ");
  return `${date} ${clockLabel(time)}`;
}

function relative(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

type FormState = AutomationInput & { id?: string };

/** Ready-made automations; a click fills the form, which can still be changed before saving. */
const TEMPLATES: { name: string; prompt: string; trigger: AutomationTrigger }[] = [
  {
    name: "Daily pull request review",
    prompt: "Review the open pull requests in this project's GitHub repository (list_pull_requests, then pull_request_read for each). For each one, look at the diff for bugs, missed cases, risky changes and simpler alternatives. Leave your findings as a pull request review (create_pull_request_review) with inline comments where a specific line is wrong; request changes only for real problems, otherwise comment. Skip pull requests you already reviewed today.",
    trigger: { frequency: "weekdays", time: "09:00", weekday: 1 },
  },
  {
    name: "Morning project summary",
    prompt: "Summarize what changed in this project since yesterday (git log and diff), note anything that looks unfinished or risky, and list the open questions a developer should look at first today.",
    trigger: { frequency: "weekdays", time: "08:30", weekday: 1 },
  },
  {
    name: "Weekly dependency check",
    prompt: "Check this project's dependencies for available updates and known problems (read the package manifest and lockfile; run the package manager's outdated/audit commands). Report what should be updated, what can wait, and anything that needs care.",
    trigger: { frequency: "weekly", time: "10:00", weekday: 1 },
  },
];

function blankForm(agents: Agent[], models: Model[] = []): FormState {
  return {
    name: "",
    agentId: (agents.find((agent) => !onClaudePlan(agent, models)) ?? agents[0])?.id ?? "",
    prompt: "",
    trigger: { frequency: "daily", time: "09:00", weekday: 1 },
    timeZone: localZone(),
  };
}

export function Automations(props: { agents: Agent[]; models: Model[]; onOpenAgent: (agentId: string) => void }) {
  const [items, setItems] = useState<Automation[]>([]);
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<FormState | null>(null);
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState("");

  async function reload() {
    try {
      setItems(await desktop.automations.list());
    } catch {
      // The runtime may still be starting; the next poll catches up.
    }
  }

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      [item.name, item.prompt, item.agentName].some((field) => field.toLowerCase().includes(needle)),
    );
  }, [items, query]);

  async function act(work: () => Promise<unknown>, failure: string) {
    try {
      await work();
      setNotice("");
      await reload();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : failure);
    }
  }

  return (
    <div className="automations">
      <div className="automations-inner">
        <header className="automations-head">
          <h2>Automations</h2>
          <div className="automations-actions">
            <button
              type="button"
              className="btn ghost"
              disabled={props.agents.length === 0}
              onClick={() => setAsking(true)}
            >
              <SparkleIcon />
              <span>Create with Prompt</span>
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={props.agents.length === 0}
              onClick={() => setForm(blankForm(props.agents, props.models))}
            >
              <PlusIcon />
              <span>New</span>
            </button>
          </div>
        </header>

        <label className="automations-search">
          <SearchIcon />
          <input
            aria-label="Search automations"
            placeholder="Search automations..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        {notice ? <p className="error">{notice}</p> : null}

        {items.length === 0 ? (
          <div className="automations-empty">
            <ClockIcon />
            <strong>No automations yet</strong>
            <p className="hint">
              {props.agents.length === 0
                ? "Create an agent first, then schedule prompts for it to run on its own."
                : "Schedule a prompt for an agent to run every hour, day, or week."}
            </p>
          </div>
        ) : visible.length === 0 ? (
          <p className="hint automations-none">No automations match “{query}”.</p>
        ) : (
          <ul className="automation-list">
            {visible.map((item) => (
              <li key={item.id} className={item.enabled ? "automation-row" : "automation-row paused"}>
                <button
                  type="button"
                  className="automation-main"
                  onClick={() => setForm({ ...item })}
                  title="Edit automation"
                >
                  <strong>{item.name}</strong>
                  <span className="automation-meta">
                    <span>{scheduleLabel(item.trigger)}</span>
                    <span className="sep">·</span>
                    <span>{item.agentName}</span>
                    <span className="sep">·</span>
                    <span>{item.enabled && item.nextRun ? `Next ${nextRunLabel(item.nextRun)}` : "Paused"}</span>
                  </span>
                  {item.lastError ? (
                    <span className="automation-status off">Last run failed: {item.lastError}</span>
                  ) : item.lastRunAt ? (
                    <span className="automation-status">Last ran {relative(item.lastRunAt)}</span>
                  ) : null}
                </button>
                <div className="automation-tools">
                  {item.lastRunId ? (
                    <button type="button" className="btn ghost tiny" onClick={() => props.onOpenAgent(item.agentId)}>
                      Open
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn ghost tiny"
                    onClick={() => void act(() => desktop.automations.runNow(item.id), "Could not run the automation")}
                  >
                    Run now
                  </button>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={item.enabled}
                    aria-label={item.enabled ? "Pause automation" : "Resume automation"}
                    className={item.enabled ? "switch on" : "switch"}
                    onClick={() =>
                      void act(
                        () => desktop.automations.update(item.id, { enabled: !item.enabled }),
                        "Could not update the automation",
                      )
                    }
                  >
                    <span />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {form ? (
        <AutomationDialog
          agents={props.agents}
          models={props.models}
          initial={form}
          onClose={() => setForm(null)}
          onSaved={async () => {
            setForm(null);
            await reload();
          }}
        />
      ) : null}

      {asking ? (
        <PromptDialog
          agents={props.agents}
          onClose={() => setAsking(false)}
          onDrafted={(draft) => {
            setAsking(false);
            setForm({ ...blankForm(props.agents, props.models), ...draft });
          }}
        />
      ) : null}
    </div>
  );
}

function AutomationDialog(props: {
  agents: Agent[];
  models: Model[];
  initial: FormState;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState<FormState>(props.initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const editing = Boolean(form.id);
  const trigger = form.trigger;
  const ready = form.name.trim() && form.prompt.trim() && form.agentId && form.timeZone.trim();

  function setTrigger(patch: Partial<AutomationTrigger>) {
    setForm((current) => ({ ...current, trigger: { ...current.trigger, ...patch } }));
  }

  async function save() {
    if (!ready || saving) return;
    setSaving(true);
    try {
      const input: AutomationInput = {
        name: form.name.trim(),
        agentId: form.agentId,
        prompt: form.prompt.trim(),
        trigger: form.trigger,
        timeZone: form.timeZone.trim(),
      };
      if (form.id) await desktop.automations.update(form.id, input);
      else await desktop.automations.create(input);
      await props.onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the automation");
      setSaving(false);
    }
  }

  async function remove() {
    if (!form.id) return;
    try {
      await desktop.automations.remove(form.id);
      await props.onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete the automation");
    }
  }

  return (
    <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <form
        className="modal-dialog automation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="automation-dialog-title"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") props.onClose();
        }}
      >
        <div className="modal-header">
          <h3 id="automation-dialog-title">{editing ? "Edit Automation" : "New Automation"}</h3>
          <button type="button" className="modal-close boxed" onClick={props.onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        {!form.id ? (
          <div className="automation-templates">
            {TEMPLATES.map((template) => (
              <button key={template.name} type="button" className="btn ghost tiny" title={template.prompt} onClick={() => setForm({ ...form, name: template.name, prompt: template.prompt, trigger: template.trigger })}>
                {template.name}
              </button>
            ))}
          </div>
        ) : null}
        <div className="automation-field">
          <label htmlFor="automation-name">Name</label>
          <input
            id="automation-name"
            autoFocus
            placeholder="Enter automation name..."
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </div>

        <div className="automation-field">
          <label>Trigger</label>
          <div className="trigger-row">
            <select
              className="chip-select"
              aria-label="Frequency"
              value={trigger.frequency}
              onChange={(event) => setTrigger({ frequency: event.target.value as AutomationFrequency })}
            >
              {FREQUENCIES.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
            {trigger.frequency === "weekly" ? (
              <>
                <span className="trigger-word">on</span>
                <select
                  className="chip-select"
                  aria-label="Weekday"
                  value={trigger.weekday}
                  onChange={(event) => setTrigger({ weekday: Number(event.target.value) })}
                >
                  {WEEKDAYS.map((day, index) => (
                    <option key={day} value={index}>{day}</option>
                  ))}
                </select>
              </>
            ) : null}
            {trigger.frequency === "hourly" ? (
              <>
                <span className="trigger-word">at</span>
                <select
                  className="chip-select"
                  aria-label="Minute"
                  value={trigger.time.slice(3)}
                  onChange={(event) => setTrigger({ time: `${trigger.time.slice(0, 2)}:${event.target.value}` })}
                >
                  {(MINUTES.includes(trigger.time.slice(3)) ? MINUTES : [trigger.time.slice(3), ...MINUTES]).map((minute) => (
                    <option key={minute} value={minute}>:{minute}</option>
                  ))}
                </select>
              </>
            ) : (
              <>
                <span className="trigger-word">around</span>
                <select
                  className="chip-select"
                  aria-label="Time"
                  value={trigger.time}
                  onChange={(event) => setTrigger({ time: event.target.value })}
                >
                  {(TIMES.includes(trigger.time) ? TIMES : [trigger.time, ...TIMES]).map((time) => (
                    <option key={time} value={time}>{clockLabel(time)}</option>
                  ))}
                </select>
              </>
            )}
          </div>
        </div>

        <div className="automation-field">
          <label htmlFor="automation-zone" className="small">Time Zone</label>
          <input
            id="automation-zone"
            list="automation-zones"
            value={form.timeZone}
            onChange={(event) => setForm({ ...form, timeZone: event.target.value })}
          />
          <datalist id="automation-zones">
            {ZONES.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </div>

        <div className="automation-field">
          <label>Agent</label>
          <div className="trigger-row">
            <select
              className="chip-select"
              aria-label="Agent"
              value={form.agentId}
              onChange={(event) => setForm({ ...form, agentId: event.target.value })}
            >
              {props.agents.map((agent) => {
                const blocked = onClaudePlan(agent, props.models);
                return (
                  <option key={agent.id} value={agent.id} disabled={blocked}>
                    {blocked ? `${agent.name} · Claude (via Claude Code)` : agent.name}
                  </option>
                );
              })}
            </select>
          </div>
          {props.agents.some((agent) => onClaudePlan(agent, props.models)) ? (
            <p className="automation-policy-note" title="Scheduled runs on a Claude subscription are automated access, which Anthropic allows only with an API key.">
              Agents on Claude (via Claude Code) are unavailable: Violation of Anthropic&apos;s policy
            </p>
          ) : null}
        </div>

        <div className="automation-field">
          <label htmlFor="automation-prompt">Prompt</label>
          <textarea
            id="automation-prompt"
            className="field automation-prompt"
            placeholder="Enter a prompt for the agent to run..."
            value={form.prompt}
            onChange={(event) => setForm({ ...form, prompt: event.target.value })}
          />
        </div>

        {error ? <p className="error">{error}</p> : null}

        <div className="automation-dialog-foot">
          {editing ? (
            confirmDelete ? (
              <div className="automation-delete">
                <button type="button" className="btn ghost tiny" onClick={() => setConfirmDelete(false)}>Cancel</button>
                <button type="button" className="btn danger tiny" onClick={() => void remove()}>Confirm Delete</button>
              </div>
            ) : (
              <button type="button" className="btn ghost tiny" onClick={() => setConfirmDelete(true)}>Delete</button>
            )
          ) : (
            <span />
          )}
          <button type="submit" className="btn blue" disabled={!ready || saving}>
            {editing ? "Save Automation" : "Add Automation"}
          </button>
        </div>
      </form>
    </div>
  );
}

function PromptDialog(props: {
  agents: Agent[];
  onClose: () => void;
  onDrafted: (draft: Pick<FormState, "name" | "prompt" | "trigger">) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const agentId = props.agents.find((agent) => agent.modelConnectionId)?.id;

  async function draft() {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      props.onDrafted(await desktop.automations.draft(text.trim(), agentId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not draft the automation");
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <form
        className="modal-dialog automation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="automation-prompt-title"
        onSubmit={(event) => {
          event.preventDefault();
          void draft();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") props.onClose();
        }}
      >
        <div className="modal-header">
          <h3 id="automation-prompt-title">Create with Prompt</h3>
          <button type="button" className="modal-close boxed" onClick={props.onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="automation-field">
          <label htmlFor="automation-describe">Describe the automation</label>
          <textarea
            id="automation-describe"
            className="field automation-prompt"
            autoFocus
            placeholder="e.g. Every weekday at 8:30 AM, summarize new files in the workspace"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void draft();
              }
            }}
          />
          {!agentId ? <p className="hint">Connect a model to an agent to draft automations from a prompt.</p> : null}
        </div>
        {error ? <p className="error">{error}</p> : null}
        <div className="automation-dialog-foot">
          <span />
          <button type="submit" className="btn blue" disabled={!text.trim() || busy || !agentId}>
            {busy ? "Drafting…" : "Draft Automation"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function ClockIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.8V8l2.2 1.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6.5 2.5l1.1 3.4 3.4 1.1-3.4 1.1-1.1 3.4-1.1-3.4L2 7l3.4-1.1 1.1-3.4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M12.2 9.6l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5.5-1.5z" fill="currentColor" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.2 10.2L13.5 13.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
