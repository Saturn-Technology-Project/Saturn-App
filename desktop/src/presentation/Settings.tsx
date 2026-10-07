import { Fragment, useEffect, useState } from "react";
import { desktop } from "../application/desktop";
import type { Agent, Check, CloudLink, Key, LlmProvider, LogLine, Mcp, Model, Profile, Rag, RuntimeInfo } from "../domain/model";

type Page = "overview" | "runtime" | "mcp" | "keys" | "llm" | "information" | "logs" | "diagnostics" | "settings";

const PAGES: [Page, string][] = [
  ["overview", "Overview"],
  ["runtime", "Runtime"],
  ["mcp", "MCP"],
  ["keys", "API Keys"],
  ["llm", "LLM"],
  ["information", "Information"],
  ["logs", "Logs"],
  ["diagnostics", "Diagnostics"],
  ["settings", "Settings"],
];

export function Settings(props: {
  agents: { id: string; name: string; status: string }[];
  agent: Agent | null;
  models: Model[];
  mcp: Mcp[];
  rag: Rag[];
  cloud: CloudLink;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onPatchAgent: (patch: Partial<Agent>) => Promise<void>;
  onCloud: (health: CloudLink) => void;
  onLogout: () => void;
  onProfile: (profile: Profile) => void;
  canRemove?: boolean;
}) {
  const [page, setPage] = useState<Page>("overview");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [keys, setKeys] = useState<Key[]>([]);
  const [info, setInfo] = useState<RuntimeInfo | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [error, setError] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  async function load() {
    const next = await desktop.admin.console();
    setProfile(next.profile);
    props.onProfile(next.profile);
    setKeys(next.keys);
    setInfo(next.information);
    setLogs(next.logs);
    setChecks(next.checks);
  }

  useEffect(() => {
    void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load settings"));
  }, [props.models, props.agents]);

  const cloudLabel = props.cloud.connected ? "Connected" : props.cloud.paired ? "Paused" : "Not connected";
  const cloudOk = props.cloud.connected;

  return (
    <section className="settings">
      <div className="settings-head">
        <h2>Settings</h2>
        <button className="btn ghost" type="button" onClick={props.onClose}>Back to chat</button>
      </div>
      <nav className="settings-nav">
        {PAGES.map(([id, label]) => (
          <button key={id} type="button" className={page === id ? "active" : ""} onClick={() => setPage(id)}>{label}</button>
        ))}
      </nav>
      {error ? <p className="error">{error}</p> : null}
      <div className="settings-body">
        {page === "overview" ? <Overview cloudLabel={cloudLabel} cloudOk={cloudOk} profile={profile} agents={props.agents.length} models={props.models.length} mcp={props.mcp.length} tools={props.mcp.reduce((sum, item) => sum + item.tools.length, 0)} checks={checks} /> : null}
        {page === "runtime" ? <Runtime agents={props.agents} /> : null}
        {page === "mcp" ? (
          <McpPage
            agent={props.agent}
            mcp={props.mcp}
            rag={props.rag}
            canRemove={props.canRemove === true}
            onToggle={props.onPatchAgent}
            onChanged={async () => { await props.onChanged(); await load(); }}
            onError={setError}
          />
        ) : null}
        {page === "keys" ? (
          <KeysPage
            keys={keys}
            selected={selectedKey}
            onSelect={setSelectedKey}
            onChanged={async () => { await load(); await props.onChanged(); }}
            onError={setError}
          />
        ) : null}
        {page === "llm" ? (
          <LlmPage
            agent={props.agent}
            models={props.models}
            onPatch={props.onPatchAgent}
            onChanged={async () => { await props.onChanged(); await load(); }}
            onError={setError}
          />
        ) : null}
        {page === "information" && info ? <Information info={info} /> : null}
        {page === "logs" ? <Logs lines={logs} onReload={() => void load()} /> : null}
        {page === "diagnostics" ? <Diagnostics checks={checks} onRun={() => void load()} /> : null}
        {page === "settings" && profile ? (
          <General
            profile={profile}
            info={info}
            cloud={props.cloud}
            onCloud={props.onCloud}
            onLogout={props.onLogout}
            onSaved={async (next) => { setProfile(next); props.onProfile(next); await load(); }}
            onError={setError}
          />
        ) : null}
      </div>
    </section>
  );
}

function Status({ ok, label }: { ok: boolean; label: string }) {
  return <span className="status"><span className={`dot ${ok ? "ok" : "off"}`} />{label}</span>;
}

function Overview(props: {
  cloudLabel: string;
  cloudOk: boolean;
  profile: Profile | null;
  agents: number;
  models: number;
  mcp: number;
  tools: number;
  checks: Check[];
}) {
  return (
    <>
      <section className="card">
        <div className="label">Connection</div>
        <Status ok={props.cloudOk} label={props.cloudLabel} />
        <div className="kv" style={{ marginTop: 12 }}>
          <span>Environment</span><div>{props.profile?.environment ?? "—"}</div>
          <span>Name</span><div>{props.profile?.name ?? "—"}</div>
        </div>
      </section>
      <section className="card">
        <div className="label">Components</div>
        {props.checks.map((item) => (
          <div className="row" key={item.name}><span>{item.name}</span><Status ok={item.ok} label={item.ok ? "Healthy" : "Offline"} /></div>
        ))}
      </section>
      <section className="card">
        <div className="label">Resources</div>
        <div className="kv">
          <span>Agents</span><div>{props.agents}</div>
          <span>LLM</span><div>{props.models}</div>
          <span>MCP servers</span><div>{props.mcp}</div>
          <span>Tools</span><div>{props.tools}</div>
        </div>
      </section>
    </>
  );
}

function Runtime(props: { agents: { id: string; name: string; status: string }[] }) {
  return (
    <>
      <h3 className="page-title">Agent Runtime</h3>
      {props.agents.length === 0 ? <p className="hint">No agent yet.</p> : props.agents.map((item) => (
        <section className="card" key={item.id}>
          <div className="row">
            <strong>{item.name}</strong>
            <Status ok={item.status !== "paused"} label={item.status === "paused" ? "Paused" : "Healthy"} />
          </div>
          <div className="hint">{item.id}</div>
        </section>
      ))}
    </>
  );
}

function McpPage(props: {
  agent: Agent | null;
  mcp: Mcp[];
  rag: Rag[];
  canRemove: boolean;
  onToggle: (patch: Partial<Agent>) => Promise<void>;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [ragUrl, setRagUrl] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  async function removeServer(id: string) {
    try {
      await desktop.admin.deleteMcp(id);
      setConfirming(null);
      props.onError("");
      await props.onChanged();
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not remove the MCP server");
    }
  }
  async function addMcp() {
    try {
      const created = await desktop.admin.createMcp(url);
      await desktop.admin.discoverMcp(created.id);
      setUrl("");
      props.onError("");
      await props.onChanged();
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not connect MCP");
    }
  }
  async function addRag() {
    try {
      await desktop.admin.createRag(ragUrl);
      setRagUrl("");
      props.onError("");
      await props.onChanged();
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not connect knowledge");
    }
  }
  return (
    <>
      <h3 className="page-title">MCP Servers</h3>
      <p className="hint">Connect your own MCP. The agent calls it directly. Saturn MCP is added only when the organization assigns a tool set.</p>
      {props.mcp.length === 0 ? <p className="hint">No MCP server has registered yet.</p> : props.mcp.map((item) => {
        const on = props.agent?.mcpConnectionIds.includes(item.id) ?? false;
        const builtin = item.url.startsWith("builtin:");
        const saturn = item.origin === "saturn" || item.id.startsWith("saturn:");
        const removable = !builtin && !saturn && (item.origin !== "organization" || props.canRemove);
        const expanded = open[item.id] ?? false;
        return (
          <section className="card mcp-card" key={item.id}>
            <div className="row">
              <button
                className="fold"
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpen((current) => ({ ...current, [item.id]: !current[item.id] }))}
              >
                <Chevron open={expanded} />
                <span>
                  <strong>{item.name}</strong>
                  <span className="hint">{item.tools.length} tools · {builtin ? "Built in" : item.url}</span>
                </span>
              </button>
              <span className="actions">
                {removable ? (
                  confirming === item.id ? (
                    <>
                      <button className="btn ghost tiny" type="button" onClick={() => setConfirming(null)}>Cancel</button>
                      <button className="btn danger tiny" type="button" onClick={() => void removeServer(item.id)}>Remove</button>
                    </>
                  ) : (
                    <button className="btn ghost tiny" type="button" onClick={() => setConfirming(item.id)}>Remove</button>
                  )
                ) : null}
                {builtin ? (
                  <button className="btn tiny" type="button" disabled>On</button>
                ) : (
                  <button className={on ? "btn tiny" : "btn ghost tiny"} type="button" disabled={!props.agent} onClick={() => void props.onToggle({ mcpConnectionIds: on ? props.agent!.mcpConnectionIds.filter((id) => id !== item.id) : [...(props.agent?.mcpConnectionIds ?? []), item.id] })}>{on ? "On" : "Off"}</button>
                )}
              </span>
            </div>
            {expanded ? (
              <ul className="tool-list">
                {item.tools.map((tool) => <li key={tool.toolId}>{tool.toolId}</li>)}
              </ul>
            ) : null}
          </section>
        );
      })}
      <section className="card">
        <div className="label">MCP URL</div>
        <input value={url} placeholder="http://127.0.0.1:3000/mcp" onChange={(event) => setUrl(event.target.value)} />
        <div className="actions"><button className="btn" type="button" disabled={!url.trim()} onClick={() => void addMcp()}>Connect MCP</button></div>
      </section>
      <h3 className="page-title">Knowledge</h3>
      {props.rag.map((item) => {
        const on = props.agent?.ragConnectionIds.includes(item.id) ?? false;
        return (
          <section className="card" key={item.id}>
            <div className="row">
              <div><strong>{item.name}</strong><div className="hint">{item.url}</div></div>
              <button className={on ? "btn tiny" : "btn ghost tiny"} type="button" disabled={!props.agent} onClick={() => void props.onToggle({ ragConnectionIds: on ? props.agent!.ragConnectionIds.filter((id) => id !== item.id) : [...(props.agent?.ragConnectionIds ?? []), item.id] })}>{on ? "On" : "Off"}</button>
            </div>
          </section>
        );
      })}
      <section className="card">
        <div className="label">RAG URL</div>
        <input value={ragUrl} onChange={(event) => setRagUrl(event.target.value)} />
        <div className="actions"><button className="btn" type="button" disabled={!ragUrl.trim()} onClick={() => void addRag()}>Connect knowledge</button></div>
      </section>
    </>
  );
}

function KeysPage(props: {
  keys: Key[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const current = props.keys.find((item) => item.id === props.selected) ?? null;
  const [value, setValue] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", secretName: "", baseUrl: "", paths: "", value: "" });
  const emptyForm = { name: "", secretName: "", baseUrl: "", paths: "", value: "" };
  async function save() {
    if (!current) return;
    try {
      await desktop.admin.rotateKey(current.id, value);
      setValue("");
      props.onError("");
      await props.onChanged();
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not save the key");
    }
  }
  async function clear() {
    if (!current) return;
    await desktop.admin.clearKey(current.id);
    await props.onChanged();
  }
  async function remove() {
    if (!current) return;
    try {
      await desktop.admin.deleteKey(current.id);
      props.onSelect(null);
      await props.onChanged();
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not remove the key");
    }
  }
  async function add() {
    try {
      const created = await desktop.admin.createKey({
        name: form.name,
        secretName: form.secretName,
        baseUrl: form.baseUrl,
        allowedPaths: form.paths,
        value: form.value,
      });
      setForm(emptyForm);
      setAdding(false);
      props.onError("");
      props.onSelect(created.id);
      await props.onChanged();
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not add the key");
    }
  }
  if (current) {
    return (
      <>
        <button className="btn ghost tiny" type="button" onClick={() => props.onSelect(null)}>← API Keys</button>
        <h3 className="page-title">{current.name}</h3>
        <section className="card">
          <div className="kv">
            <span>Key</span><div><code>{current.secretName}</code></div>
            <span>Status</span><div><Status ok={current.status === "configured"} label={current.status === "configured" ? "Configured" : "Missing"} /></div>
            <span>Used by</span><div>{current.allowedCallers.join(", ") || "—"}</div>
            <span>Host</span><div>{current.baseUrl || "—"}</div>
          </div>
          <hr />
          <div className="label">{current.hasSecret ? "Rotate" : "Configure"} {current.secretName}</div>
          <input type="password" value={value} autoComplete="off" placeholder="Value" onChange={(event) => setValue(event.target.value)} />
          <p className="hint">The value is written to the Credential Broker only. It is never shown again.</p>
          <div className="actions">
            <button className="btn" type="button" disabled={!value} onClick={() => void save()}>Save</button>
            <button className="btn ghost" type="button" onClick={() => void clear()}>Clear</button>
            {current.native ? null : <button className="btn danger" type="button" onClick={() => void remove()}>Remove</button>}
          </div>
        </section>
      </>
    );
  }
  return (
    <>
      <h3 className="page-title">API Keys</h3>
      <p className="hint">API keys are shared with your organization. They stay in the Credential Broker and are never returned to the chat.</p>
      {props.keys.map((item) => (
        <button key={item.id} type="button" className="card key-card" onClick={() => props.onSelect(item.id)}>
          <div className="row">
            <div>
              <strong>{item.name}</strong>
              <div className="hint"><code>{item.secretName}</code>{item.required ? " · required" : " · optional"}</div>
            </div>
            <Status ok={item.status === "configured"} label={item.status === "configured" ? "Configured" : item.required ? "Missing" : "Not set"} />
          </div>
        </button>
      ))}
      {adding ? (
        <section className="card">
          <div className="label">Name</div>
          <input value={form.name} placeholder="ERP" onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
          <div className="label">Key name</div>
          <input value={form.secretName} placeholder="ERP_API_KEY" onChange={(event) => setForm((current) => ({ ...current, secretName: event.target.value }))} />
          <div className="label">Base URL</div>
          <input value={form.baseUrl} placeholder="https://erp.example.com" onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))} />
          <div className="label">Allowed paths</div>
          <input value={form.paths} placeholder="/v1/*, /orders/*" onChange={(event) => setForm((current) => ({ ...current, paths: event.target.value }))} />
          <div className="label">Value</div>
          <input type="password" value={form.value} autoComplete="off" onChange={(event) => setForm((current) => ({ ...current, value: event.target.value }))} />
          <p className="hint">The value is stored in-process and is not shown again.</p>
          <div className="actions">
            <button className="btn ghost" type="button" onClick={() => { setForm(emptyForm); setAdding(false); }}>Cancel</button>
            <button className="btn" type="button" disabled={!form.secretName.trim()} onClick={() => void add()}>Save</button>
          </div>
        </section>
      ) : (
        <button className="btn" type="button" onClick={() => setAdding(true)}>Add</button>
      )}
    </>
  );
}

function LlmPage(props: {
  agent: Agent | null;
  models: Model[];
  onPatch: (patch: Partial<Agent>) => Promise<void>;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [providerId, setProviderId] = useState("openai");
  const [modelId, setModelId] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:1234");
  const [secret, setSecret] = useState("");
  const [studioModels, setStudioModels] = useState<{ id: string; label: string }[]>([]);
  const provider = providers.find((item) => item.id === providerId) ?? providers[0];

  useEffect(() => {
    void desktop.admin.providers().then((next) => {
      setProviders(next);
      const first = next[0];
      if (!first) return;
      setProviderId(first.id);
      setModelId(first.models[0]?.id ?? "");
      setBaseUrl(first.baseUrl);
    }).catch((reason: unknown) => props.onError(reason instanceof Error ? reason.message : "Could not load models"));
  }, []);

  useEffect(() => {
    if (providerId !== "lmstudio") return;
    const url = baseUrl.trim();
    void desktop.admin.lmStudioModels(url)
      .then((next) => {
        setStudioModels(next);
        setModelId((current) => current || next[0]?.id || "");
      })
      .catch(() => setStudioModels([]));
  }, [providerId, baseUrl]);

  function chooseProvider(id: string) {
    const next = providers.find((item) => item.id === id);
    setProviderId(id);
    setModelId(next?.models[0]?.id ?? "");
    setBaseUrl(next?.baseUrl ?? "");
    setSecret("");
  }

  async function add() {
    try {
      await desktop.admin.createModel({
        provider: providerId,
        model: modelId,
        baseUrl: providerId === "lmstudio" ? baseUrl : undefined,
        secret: secret || undefined,
      });
      setSecret("");
      props.onError("");
      await props.onChanged();
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not connect the model");
    }
  }

  const choices = providerId === "lmstudio" ? studioModels : provider?.models ?? [];
  const needsKey = provider?.needsKey ?? true;

  return (
    <>
      <h3 className="page-title">LLM</h3>
      <p className="hint">Model connections and their keys are shared with your organization. The chat never receives the key.</p>
      {props.models.map((item) => (
        <button
          key={item.id}
          type="button"
          className={props.agent?.modelConnectionId === item.id ? "card key-card on" : "card key-card"}
          onClick={() => void props.onPatch({ modelConnectionId: item.id })}
        >
          <div className="row">
            <div>
              <strong>{item.name}</strong>
              <div className="hint">{providerLabel(providers, item)}{item.model ? ` · ${item.model}` : ""}</div>
            </div>
            <Status ok={item.provider === "lmstudio" || item.hasSecret} label={item.provider === "lmstudio" ? "Local" : item.hasSecret ? "Key stored" : "No key"} />
          </div>
        </button>
      ))}
      <section className="card">
        <label className="label" htmlFor="llm-provider">Provider</label>
        <select id="llm-provider" value={providerId} onChange={(event) => chooseProvider(event.target.value)}>
          {providers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
        {providerId === "lmstudio" ? (
          <>
            <label className="label" htmlFor="llm-host">LM Studio</label>
            <input id="llm-host" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          </>
        ) : null}
        <label className="label" htmlFor="llm-model">Model</label>
        {providerId === "lmstudio" && choices.length === 0 ? (
          <input id="llm-model" value={modelId} placeholder="Model key in LM Studio" onChange={(event) => setModelId(event.target.value)} />
        ) : (
          <select id="llm-model" value={modelId} onChange={(event) => setModelId(event.target.value)}>
            {choices.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        )}
        {needsKey ? (
          <>
            <label className="label" htmlFor="llm-key">API key</label>
            <input id="llm-key" type="password" value={secret} autoComplete="off" onChange={(event) => setSecret(event.target.value)} />
          </>
        ) : null}
        <div className="actions">
          <button className="btn" type="button" disabled={!modelId.trim() || (needsKey && !secret.trim())} onClick={() => void add()}>Connect model</button>
        </div>
      </section>
    </>
  );
}

function providerLabel(providers: LlmProvider[], model: Model) {
  return providers.find((item) => item.id === model.provider)?.label ?? model.provider ?? "Model";
}

function Information(props: { info: RuntimeInfo }) {
  const rows: [string, string][] = [
    ["Listen", props.info.listen],
    ["Runtime", props.info.runtimeId],
    ["Version", props.info.version],
    ["Name", props.info.name],
    ["Environment", props.info.environment],
    ["Organization", props.info.organizationId || "—"],
    ["Session", props.info.sessionId || "—"],
    ["Saturn", props.info.saturnEndpoint || "—"],
    ["Credential Broker", props.info.broker],
    ["MCP servers", props.info.mcpServers.join(", ") || "—"],
  ];
  return (
    <section className="card">
      <div className="label">Identity</div>
      <div className="kv">
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <span>{label}</span>
            <div><code>{value}</code></div>
          </Fragment>
        ))}
      </div>
    </section>
  );
}

function Logs(props: { lines: LogLine[]; onReload: () => void }) {
  const [service, setService] = useState("");
  const [level, setLevel] = useState("");
  const shown = props.lines.filter((item) => {
    if (service && item.service !== service) return false;
    if (level === "error" && item.level !== "error") return false;
    if (level === "warning" && item.level === "info") return false;
    return true;
  });
  return (
    <>
      <div className="log-toolbar">
        <select value={service} onChange={(event) => setService(event.target.value)}>
          <option value="">All services</option>
          <option value="agent">agent</option>
          <option value="runtime">runtime</option>
          <option value="broker">broker</option>
          <option value="cloud">cloud</option>
        </select>
        <select value={level} onChange={(event) => setLevel(event.target.value)}>
          <option value="">All levels</option>
          <option value="warning">warning+</option>
          <option value="error">error</option>
        </select>
        <button className="btn ghost" type="button" onClick={props.onReload}>Refresh</button>
      </div>
      <div className="log-stream">
        {shown.length === 0 ? <div className="hint">No log lines yet.</div> : shown.map((item) => (
          <div className={`log-line ${item.level}`} key={item.seq}>
            <span>{item.ts.slice(11, 23)}</span>
            <span>{item.service}</span>
            <span>{item.level}</span>
            <span>{item.message}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function Diagnostics(props: { checks: Check[]; onRun: () => void }) {
  return (
    <>
      <div className="row"><h3 className="page-title">Diagnostics</h3><button className="btn" type="button" onClick={props.onRun}>Run Diagnostics</button></div>
      <section className="card">
        {props.checks.map((item) => (
          <div className="row" key={item.name}>
            <div>
              <div>{item.ok ? "✓" : "✗"} {item.name}</div>
              <div className="hint">{item.detail}</div>
            </div>
            <Status ok={item.ok} label={item.ok ? "Pass" : "Fail"} />
          </div>
        ))}
      </section>
    </>
  );
}

function General(props: {
  profile: Profile;
  info: RuntimeInfo | null;
  cloud: CloudLink;
  onCloud: (health: CloudLink) => void;
  onLogout: () => void;
  onSaved: (profile: Profile) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(props.profile.name);
  const [environment, setEnvironment] = useState(props.profile.environment);
  const [heartbeat, setHeartbeat] = useState(String(props.profile.heartbeatSeconds));
  const [logging, setLogging] = useState(props.profile.logging);
  const [saved, setSaved] = useState(false);
  async function save() {
    try {
      const next = await desktop.admin.updateSettings({ name, environment, heartbeatSeconds: Number(heartbeat), logging });
      setSaved(true);
      props.onError("");
      await props.onSaved(next);
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not save");
    }
  }
  async function reconnect() {
    try {
      const next = await desktop.session.refresh();
      props.onCloud(next);
      props.onError(next.connected ? "" : "Saturn Cloud is not connected");
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not reconnect");
    }
  }
  async function unpair() {
    props.onLogout();
  }
  return (
    <section className="card">
      <div className="label">App</div>
      <div className="label">Name</div>
      <input value={name} onChange={(event) => setName(event.target.value)} />
      <div className="label">Environment</div>
      <input value={environment} onChange={(event) => setEnvironment(event.target.value)} />
      <div className="label">Saturn</div>
      <div>{props.cloud.connected ? "Paired" : props.cloud.paired ? "Paused" : "Not paired"}</div>
      <p className="hint">Signing in pairs this app. The connection token stays in the runtime.</p>
      <div className="label">Credential Broker</div>
      <div><code>in-process</code></div>
      <p className="hint">Signed-in keys are shared with your organization. The chat never receives them.</p>
      <div className="label">Heartbeat</div>
      <input type="number" min={5} value={heartbeat} onChange={(event) => setHeartbeat(event.target.value)} />
      <p className="hint">Seconds</p>
      <div className="label">Logging</div>
      <select value={logging} onChange={(event) => setLogging(event.target.value)}>
        {["debug", "info", "warning", "error"].map((level) => <option key={level} value={level}>{level}</option>)}
      </select>
      <div className="actions">
        <button className="btn" type="button" onClick={() => void save()}>Save Changes</button>
        {props.cloud.connected ? null : (
          <button className="btn ghost" type="button" onClick={() => void reconnect()}>Reconnect</button>
        )}
        <button className="btn ghost" type="button" onClick={() => void unpair()}>Sign out</button>
      </div>
      {saved ? <p className="hint">Saved.</p> : null}
    </section>
  );
}

function Chevron(props: { open: boolean }) {
  return (
    <svg className={props.open ? "chevron open" : "chevron"} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
