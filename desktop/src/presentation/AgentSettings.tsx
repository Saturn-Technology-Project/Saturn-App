import { useEffect, useState } from "react";
import { GUARDRAIL_MODES, normalizeGuardrailMode, actionSummary, actionTitle } from "../domain/conversation";
import type { Agent, Autonomy, Model, ResponseStyle, Run } from "../domain/model";
import type { SettingsPage } from "./Settings";
import { ModelSelector } from "./ModelSelector";

export type AgentModalTab = "agent" | "model" | "tools" | "activity";

const TABS: [AgentModalTab, string][] = [
  ["agent", "Agent Profile"],
  ["model", "Model & LLM"],
  ["tools", "MCP Tools & Skills"],
  ["activity", "Recent Activity"],
];

const STYLES: [ResponseStyle, string][] = [
  ["concise", "Concise"],
  ["professional", "Professional"],
  ["detailed", "Detailed"],
];

const BUILTIN_SKILLS: [string, string][] = [
  ["files", "Read, write, list, and patch workspace files"],
  ["code", "Execute shell commands in the workspace"],
  ["web", "Fetch and read public web pages"],
  ["multi_step", "Maintain structured step-by-step plans"],
  ["mcp", "Invoke connected external MCP tools"],
];

export function AgentSettings(props: {
  agent: Agent;
  models: Model[];
  mcp: { id: string; name: string; url?: string; tools?: { toolId: string }[] }[];
  rag: { id: string; name: string; url?: string }[];
  runs?: Run[];
  initialTab?: AgentModalTab;
  canEdit?: boolean;
  onClose: () => void;
  onOpenSettings?: (page: SettingsPage) => void;
  onSave: (patch: Partial<Agent>) => Promise<void>;
  onDelete?: () => void | Promise<void>;
}) {
  const [tab, setTab] = useState<AgentModalTab>(props.initialTab ?? "agent");
  const [name, setName] = useState(props.agent.name);
  const [description, setDescription] = useState(props.agent.description);
  const [instructions, setInstructions] = useState(props.agent.instructions);
  const [responseStyle, setResponseStyle] = useState<ResponseStyle>(props.agent.responseStyle ?? "professional");
  const [autonomy, setAutonomy] = useState<Autonomy>(props.agent.autonomy ?? "execute_when_allowed");
  const [mcpIds, setMcpIds] = useState(props.agent.mcpConnectionIds);
  const [ragIds, setRagIds] = useState(props.agent.ragConnectionIds);
  const [modelId, setModelId] = useState(props.agent.modelConnectionId ?? "");
  const [temperature, setTemperature] = useState(String(props.agent.temperature ?? 0.2));
  const [maxOutput, setMaxOutput] = useState(String(props.agent.maxOutput ?? 4000));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const canEdit = props.canEdit !== false;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") props.onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [props.onClose]);

  useEffect(() => {
    if (props.initialTab) setTab(props.initialTab);
  }, [props.initialTab]);

  useEffect(() => {
    setName(props.agent.name);
    setDescription(props.agent.description);
    setInstructions(props.agent.instructions);
    setResponseStyle(props.agent.responseStyle ?? "professional");
    setAutonomy(props.agent.autonomy ?? "execute_when_allowed");
    setMcpIds(props.agent.mcpConnectionIds);
    setRagIds(props.agent.ragConnectionIds);
    setModelId(props.agent.modelConnectionId ?? "");
    setTemperature(String(props.agent.temperature ?? 0.2));
    setMaxOutput(String(props.agent.maxOutput ?? 4000));
    setSaved(false);
    setDirty(false);
    setError("");
  }, [
    props.agent.id,
    props.agent.name,
    props.agent.description,
    props.agent.instructions,
    props.agent.responseStyle,
    props.agent.autonomy,
    props.agent.modelConnectionId,
    props.agent.temperature,
    props.agent.maxOutput,
    props.agent.mcpConnectionIds.join(","),
    props.agent.ragConnectionIds.join(","),
  ]);

  function markChange() {
    setSaved(false);
    setDirty(true);
  }

  function toggle(list: string[], id: string, setList: (next: string[]) => void) {
    setList(list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);
    markChange();
  }

  async function save() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await props.onSave({
        name: name.trim() || props.agent.name,
        description,
        instructions,
        responseStyle,
        autonomy,
        mcpConnectionIds: mcpIds,
        ragConnectionIds: ragIds,
        modelConnectionId: modelId || null,
        temperature: Number(temperature),
        maxOutput: Number(maxOutput),
      });
      setSaved(true);
      setDirty(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save this agent");
    } finally {
      setSaving(false);
    }
  }

  const externalMcp = props.mcp.filter((item) => item.id !== "general-skills");
  const recentActions = (props.runs ?? []).flatMap((run) =>
    run.actions.map((action, idx) => ({
      key: `${run.id}-${action.id ?? idx}`,
      prompt: run.input,
      action,
    })),
  ).reverse();

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        className="modal-dialog agent-customization-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-customization-title"
      >
        {/* Header */}
        <div className="modal-header agent-modal-header">
          <div className="agent-modal-title-row">
            <h3 id="agent-customization-title">Agent Customization</h3>
            <span className="agent-modal-badge">{props.agent.name}</span>
          </div>
          <button
            className="modal-close boxed"
            type="button"
            aria-label="Close dialog"
            onClick={props.onClose}
          >
            <CloseIcon />
          </button>
        </div>

        {/* Tab Navigation */}
        <nav className="agent-modal-tabs" role="tablist">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? "agent-modal-tab active" : "agent-modal-tab"}
              onClick={() => setTab(id)}
            >
              {label}
              {id === "activity" && recentActions.length > 0 ? (
                <span className="tab-badge">{recentActions.length}</span>
              ) : null}
            </button>
          ))}
        </nav>

        {error ? <p className="error inspector-alert">{error}</p> : null}

        {/* Scrollable Form Body */}
        <div className="agent-modal-scroll">
          <fieldset className="agent-modal-fieldset" disabled={!canEdit}>
            {tab === "agent" ? (
              <div className="inspector-section">
                <div className="field-group">
                  <label className="label" htmlFor="agent-name">Agent Name</label>
                  <input
                    id="agent-name"
                    value={name}
                    onChange={(event) => { setName(event.target.value); markChange(); }}
                  />
                </div>

                <div className="field-group">
                  <label className="label" htmlFor="agent-description">Role / Description</label>
                  <textarea
                    id="agent-description"
                    className="field compact"
                    rows={2}
                    placeholder="What is this agent specialized in?"
                    value={description}
                    onChange={(event) => { setDescription(event.target.value); markChange(); }}
                  />
                </div>

                <div className="field-group">
                  <label className="label" htmlFor="agent-instructions">System Instructions</label>
                  <textarea
                    id="agent-instructions"
                    className="field mono-field"
                    rows={5}
                    placeholder="System prompt, instructions, coding conventions, or custom personas…"
                    value={instructions}
                    onChange={(event) => { setInstructions(event.target.value); markChange(); }}
                  />
                </div>

              <div className="field-group">
                <div className="label">Response Style</div>
                <div className="segmented">
                  {STYLES.map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      className={responseStyle === id ? "seg-btn active" : "seg-btn"}
                      onClick={() => { setResponseStyle(id); markChange(); }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field-group">
                <div className="label">Autonomy & Guardrails</div>
                <div className="mode-cards">
                  {GUARDRAIL_MODES.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={normalizeGuardrailMode(autonomy) === option.id ? "mode-card active" : "mode-card"}
                      onClick={() => { setAutonomy(option.id); markChange(); }}
                    >
                      <div className="mode-card-top">
                        <strong>{option.title}</strong>
                        {option.badge && <span className="mode-card-badge">{option.badge}</span>}
                      </div>
                      <small>{option.description}</small>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {tab === "model" ? (
            <div className="inspector-section">
              <div className="field-group">
                <div className="section-row">
                  <label className="label" htmlFor="agent-model">Model Connection</label>
                  {props.onOpenSettings ? (
                    <button className="link-btn" type="button" onClick={() => props.onOpenSettings?.("llm")}>
                      Manage Models
                    </button>
                  ) : null}
                </div>
                <ModelSelector
                  variant="form"
                  models={props.models}
                  selectedModelId={modelId || null}
                  onChange={(id) => { setModelId(id ?? ""); markChange(); }}
                  onOpenUsage={() => props.onOpenSettings?.("usage")}
                  onOpenSettings={props.onOpenSettings}
                />
                <p className="hint">API keys are securely stored on this device.</p>
              </div>

              <div className="field-group">
                <div className="section-row">
                  <label className="label" htmlFor="agent-temperature">Temperature</label>
                  <code className="value-pill">{temperature}</code>
                </div>
                <input
                  id="agent-temperature"
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={temperature}
                  onChange={(event) => { setTemperature(event.target.value); markChange(); }}
                />
              </div>

              <div className="field-group">
                <label className="label" htmlFor="agent-max">Max Output Tokens</label>
                <input
                  id="agent-max"
                  type="number"
                  min={1}
                  max={128000}
                  step={1}
                  value={maxOutput}
                  onChange={(event) => { setMaxOutput(event.target.value); markChange(); }}
                />
              </div>
            </div>
          ) : null}

          {tab === "tools" ? (
            <div className="inspector-section">
              <div className="field-group">
                <div className="section-row">
                  <div className="label">Built-in General Skills</div>
                  <span className="pill-badge ok">Always On</span>
                </div>
                <div className="skill-grid">
                  {BUILTIN_SKILLS.map(([skillId, desc]) => (
                    <div className="skill-item" key={skillId}>
                      <code>{skillId}</code>
                      <span>{desc}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="field-group">
                <div className="section-row">
                  <div className="label">Connected MCP Servers & Tools</div>
                  {props.onOpenSettings ? (
                    <button className="link-btn" type="button" onClick={() => props.onOpenSettings?.("mcp")}>
                      + Connect MCP
                    </button>
                  ) : null}
                </div>
                {externalMcp.length === 0 ? (
                  <p className="empty-box">No external MCP servers connected yet.</p>
                ) : (
                  <div className="toggle-list">
                    {externalMcp.map((item) => {
                      const checked = mcpIds.includes(item.id);
                      return (
                        <label key={item.id} className={checked ? "toggle-card on" : "toggle-card"}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggle(mcpIds, item.id, setMcpIds)}
                          />
                          <div className="toggle-copy">
                            <strong>{item.name}</strong>
                            <small>{item.tools?.length ?? 0} tools{item.url ? ` · ${item.url}` : ""}</small>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="field-group">
                <div className="section-row">
                  <div className="label">Knowledge Sources (RAG)</div>
                  {props.onOpenSettings ? (
                    <button className="link-btn" type="button" onClick={() => props.onOpenSettings?.("mcp")}>
                      + Add Source
                    </button>
                  ) : null}
                </div>
                {props.rag.length === 0 ? (
                  <p className="empty-box">No knowledge sources attached.</p>
                ) : (
                  <div className="toggle-list">
                    {props.rag.map((item) => {
                      const checked = ragIds.includes(item.id);
                      return (
                        <label key={item.id} className={checked ? "toggle-card on" : "toggle-card"}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggle(ragIds, item.id, setRagIds)}
                          />
                          <div className="toggle-copy">
                            <strong>{item.name}</strong>
                            {item.url ? <small>{item.url}</small> : null}
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : null}

          {tab === "activity" ? (
            <div className="inspector-section">
              <div className="field-group">
                <div className="label">Session Summary</div>
                <div className="stat-grid">
                  <div className="stat-box">
                    <span>Turns</span>
                    <strong>{props.runs?.length ?? 0}</strong>
                  </div>
                  <div className="stat-box">
                    <span>Tool Calls</span>
                    <strong>{recentActions.length}</strong>
                  </div>
                  <div className="stat-box">
                    <span>MCP Active</span>
                    <strong>{mcpIds.length}</strong>
                  </div>
                </div>
              </div>

              <div className="field-group">
                <div className="label">Recent Tool Executions</div>
                {recentActions.length === 0 ? (
                  <p className="empty-box">Tool calls executed by {props.agent.name} will appear here.</p>
                ) : (
                  <div className="activity-feed">
                    {recentActions.slice(0, 20).map(({ key, prompt, action }) => (
                      <div className="activity-item" key={key}>
                        <div className="activity-head">
                          <span className={`dot ${action.status === "completed" ? "ok" : action.status === "waiting_approval" ? "wait" : "off"}`} />
                          <strong>{actionTitle(action.toolId)}</strong>
                          <code>{action.toolId}</code>
                        </div>
                        {actionSummary(action) ? (
                          <div className="activity-summary">{actionSummary(action)}</div>
                        ) : null}
                        <small className="activity-prompt">{prompt}</small>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </fieldset>
      </div>

        {/* Modal Footer Actions */}
        <div className="modal-actions agent-modal-actions">
          {props.onDelete ? (
            <button
              className="btn ghost danger tiny"
              type="button"
              style={{ marginRight: "auto" }}
              onClick={() => {
                if (window.confirm(`Are you sure you want to delete ${props.agent.name}?`)) {
                  void props.onDelete?.();
                }
              }}
            >
              Delete Agent
            </button>
          ) : null}
          <div className="agent-modal-status">
            {dirty ? (
              <span className="unsaved-dot">● Unsaved changes</span>
            ) : saved ? (
              <span className="saved-text">✓ Saved</span>
            ) : null}
          </div>
          <button className="btn ghost" type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button
            className="btn primary-btn"
            type="button"
            disabled={saving || !name.trim()}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
