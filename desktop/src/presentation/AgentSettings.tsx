import { useEffect, useState } from "react";
import type { Agent, Autonomy, ResponseStyle } from "../domain/model";

type Tab = "overview" | "behavior" | "tools" | "knowledge" | "model";

const TABS: [Tab, string][] = [
  ["overview", "Overview"],
  ["behavior", "Behavior"],
  ["tools", "Tools"],
  ["knowledge", "Knowledge"],
  ["model", "Model"],
];

const STYLES: [ResponseStyle, string][] = [
  ["concise", "Concise"],
  ["professional", "Professional"],
  ["detailed", "Detailed"],
];

const AUTONOMY: [Autonomy, string][] = [
  ["suggest_only", "Suggest only"],
  ["execute_when_allowed", "Execute when allowed"],
  ["fully_autonomous", "Fully autonomous"],
];

export function AgentSettings(props: {
  agent: Agent;
  models: { id: string; name: string; model?: string }[];
  mcp: { id: string; name: string }[];
  rag: { id: string; name: string }[];
  canEdit?: boolean;
  onClose: () => void;
  onSave: (patch: Partial<Agent>) => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>("overview");
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
  const canEdit = props.canEdit !== false;

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
  }, [props.agent.id]);

  function toggle(list: string[], id: string, setList: (next: string[]) => void) {
    setList(list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);
    setSaved(false);
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
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save this agent");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings">
      <div className="settings-head">
        <h2>{props.agent.name}</h2>
        <button className="btn ghost" type="button" onClick={props.onClose}>Back to chat</button>
      </div>
      <nav className="settings-nav">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>
      {error ? <p className="error">{error}</p> : null}
      {canEdit ? null : <p className="hint">You can view this agent. You cannot change its settings.</p>}
      <fieldset className="settings-body" disabled={!canEdit}>
        {tab === "overview" ? (
          <div className="card">
            <label className="label" htmlFor="agent-name">Name</label>
            <input id="agent-name" value={name} onChange={(event) => { setName(event.target.value); setSaved(false); }} />
            <label className="label" htmlFor="agent-description">Description</label>
            <textarea id="agent-description" className="field" rows={4} value={description} onChange={(event) => { setDescription(event.target.value); setSaved(false); }} />
          </div>
        ) : null}
        {tab === "behavior" ? (
          <div className="card">
            <label className="label" htmlFor="agent-instructions">Instructions</label>
            <textarea id="agent-instructions" className="field" rows={10} value={instructions} onChange={(event) => { setInstructions(event.target.value); setSaved(false); }} />
            <div className="label">Response style</div>
            {STYLES.map(([id, label]) => (
              <label key={id} className="check">
                <input type="radio" name="style" checked={responseStyle === id} onChange={() => { setResponseStyle(id); setSaved(false); }} />
                {label}
              </label>
            ))}
            <div className="label">Autonomy</div>
            {AUTONOMY.map(([id, label]) => (
              <label key={id} className="check">
                <input type="radio" name="autonomy" checked={autonomy === id} onChange={() => { setAutonomy(id); setSaved(false); }} />
                {label}
              </label>
            ))}
            <p className="hint">Autonomy is a behavior preference. It does not override policy on Saturn MCP.</p>
          </div>
        ) : null}
        {tab === "tools" ? (
          <div className="card">
            <div className="label">MCP tools</div>
            <p className="hint">Your own MCP is called directly. Saturn MCP applies organization policy when a tool set is assigned.</p>
            {props.mcp.length === 0 ? <p className="hint">No MCP servers yet.</p> : props.mcp.map((item) => (
              <label key={item.id} className="check">
                <input type="checkbox" checked={item.id === "general-skills" || mcpIds.includes(item.id)} disabled={item.id === "general-skills"} onChange={() => { if (item.id !== "general-skills") toggle(mcpIds, item.id, setMcpIds); }} />
                {item.name}
              </label>
            ))}
          </div>
        ) : null}
        {tab === "knowledge" ? (
          <div className="card">
            <div className="label">Sources</div>
            <p className="hint">Knowledge connections this agent may use.</p>
            {props.rag.length === 0 ? <p className="hint">No knowledge sources yet.</p> : props.rag.map((item) => (
              <label key={item.id} className="check">
                <input type="checkbox" checked={ragIds.includes(item.id)} onChange={() => toggle(ragIds, item.id, setRagIds)} />
                {item.name}
              </label>
            ))}
          </div>
        ) : null}
        {tab === "model" ? (
          <div className="card">
            <label className="label" htmlFor="agent-model">Model</label>
            <select id="agent-model" value={modelId} onChange={(event) => { setModelId(event.target.value); setSaved(false); }}>
              <option value="">No model</option>
              {props.models.map((item) => (
                <option key={item.id} value={item.id}>{item.name}{item.model ? ` · ${item.model}` : ""}</option>
              ))}
            </select>
            <p className="hint">Uses a model connection from LLM settings. The API key stays in the Credential Broker.</p>
            <label className="label" htmlFor="agent-temperature">Temperature</label>
            <input id="agent-temperature" type="number" min={0} max={2} step={0.1} value={temperature} onChange={(event) => { setTemperature(event.target.value); setSaved(false); }} />
            <label className="label" htmlFor="agent-max">Max output</label>
            <input id="agent-max" type="number" min={1} max={128000} step={1} value={maxOutput} onChange={(event) => { setMaxOutput(event.target.value); setSaved(false); }} />
          </div>
        ) : null}
        {canEdit ? (
          <div className="actions">
            <button className="btn" type="button" disabled={saving || !name.trim()} onClick={() => void save()}>Save</button>
            {saved ? <p className="hint">Saved.</p> : null}
          </div>
        ) : null}
      </fieldset>
    </section>
  );
}
