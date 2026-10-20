import { useEffect, useRef, useState } from "react";
import { desktop } from "../application/desktop";
import { EFFORT_LABELS, supportsEffort, type Agent, type LaunchApp, type LlmProvider, type LogLine, type Mcp, type Model, type Profile, type Project, type Rag, type RuntimeInfo } from "../domain/model";
import type { CodexStatus } from "../application/admin";
import { UsageBilling } from "./UsageBilling";
import { Telemetry } from "./Telemetry";
import { ConfigureMcpModal } from "./ConfigureMcpModal";
import { About } from "./About";

export type SettingsPage =
  | "settings"
  | "usage"
  | "llm"
  | "mcp"
  | "telemetry"
  | "logs"
  | "information"
  | "shortcuts";

const GROUPS: { title: string; items: [SettingsPage, string, string][] }[] = [
  {
    title: "Settings",
    items: [
      ["settings", "General", "Execution, appearance, and workspace"],
      ["llm", "Models", "LLM providers & models"],
      ["mcp", "MCP & Skills", "Tool servers & knowledge sources"],
      ["usage", "Usage & Billing", "Token spend & costs"],
    ],
  },
  {
    title: "System",
    items: [
      ["telemetry", "Telemetry", "OpenTelemetry traces & logs"],
      ["logs", "Logs", "Live runtime event stream"],
      ["information", "About", "What Saturn is and how it fits together"],
    ],
  },
];

export function Settings(props: {
  initialPage?: SettingsPage;
  agents: { id: string; name: string; status: string }[];
  agent: Agent | null;
  models: Model[];
  mcp: Mcp[];
  rag: Rag[];
  projects?: Project[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  onPatchAgent: (patch: Partial<Agent>) => Promise<void>;
  onProfile: (profile: Profile) => void;
  theme?: "light" | "dark";
  onSetTheme?: (theme: "light" | "dark") => void;
  onToggleTheme?: () => void;
  /** Shown as its own window (opened from Saturn IDE) instead of a dialog over the Agent App. */
  standalone?: boolean;
}) {
  const [page, setPage] = useState<SettingsPage>(props.initialPage ?? "settings");
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [info, setInfo] = useState<RuntimeInfo | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (props.initialPage) {
      setPage(props.initialPage);
      setSelectedProjectId(null);
    }
  }, [props.initialPage]);

  // Each page starts at its top.
  useEffect(() => {
    paneRef.current?.scrollTo({ top: 0 });
  }, [page, selectedProjectId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        props.onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [props.onClose]);

  async function load() {
    const next = await desktop.admin.console();
    setProfile(next.profile);
    props.onProfile(next.profile);
    setInfo(next.information);
    setLogs(next.logs);
  }

  useEffect(() => {
    void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load settings"));
  }, [props.models, props.agents]);

  const selectedProject = selectedProjectId ? props.projects?.find((p) => p.id === selectedProjectId) : null;
  const currentMeta = selectedProject
    ? ["project", selectedProject.name, `Project configuration & custom rules (${selectedProject.path})`]
    : page === "shortcuts"
      ? ["shortcuts", "Shortcuts", "Quick keyboard shortcuts for Saturn"]
      : GROUPS.flatMap((group) => group.items).find(([id]) => id === page);

  return (
    <div className={props.standalone ? "settings-modal-overlay standalone" : "settings-modal-overlay"} onMouseDown={props.standalone ? undefined : props.onClose}>
      <div
        className="settings-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {props.standalone ? null : (
          <button
            className="settings-modal-close"
            type="button"
            onClick={props.onClose}
            title="Close (Esc)"
            aria-label="Close settings"
          >
            <CloseIcon />
          </button>
        )}

        <aside className="settings-rail">
          <div className="settings-rail-scroll">
            {GROUPS.map((group) => (
              <div className="settings-group" key={group.title}>
                <div className="settings-group-label">{group.title}</div>
                {group.items.map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={page === id && !selectedProjectId ? "settings-link active" : "settings-link"}
                    onClick={() => { setPage(id); setSelectedProjectId(null); setError(""); }}
                  >
                    <span>{label}</span>
                    {id === "llm" ? <small className="rail-count">{props.models.length}</small> : null}
                    {id === "mcp" ? <small className="rail-count">{props.mcp.length}</small> : null}
                  </button>
                ))}
              </div>
            ))}

            {props.projects && props.projects.length > 0 ? (
              <div className="settings-group">
                <div className="settings-group-label">Projects</div>
                {props.projects.map((proj) => (
                  <button
                    key={proj.id}
                    type="button"
                    className={selectedProjectId === proj.id ? "settings-link active" : "settings-link"}
                    onClick={() => { setSelectedProjectId(proj.id); setError(""); }}
                  >
                    <span>{proj.name}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="settings-rail-foot">
            <button
              type="button"
              className={page === "shortcuts" && !selectedProjectId ? "settings-link active" : "settings-link"}
              onClick={() => { setPage("shortcuts"); setSelectedProjectId(null); setError(""); }}
            >
              <span>Shortcuts</span>
            </button>
          </div>
        </aside>

        <div className="settings-Pane" ref={paneRef}>
          <header className="settings-pane-head">
            <div>
              <h2 id="settings-dialog-title">{currentMeta?.[1] ?? "Settings"}</h2>
              {currentMeta?.[2] ? <p className="hint">{currentMeta[2]}</p> : null}
            </div>
          </header>

          {error ? <p className="error">{error}</p> : null}

          <div className={page === "telemetry" ? "settings-body wide" : "settings-body"}>
            {selectedProject ? (
              <ProjectSettingsTab
                project={selectedProject}
                onError={setError}
              />
            ) : page === "shortcuts" ? (
              <ShortcutsTab />
            ) : (
              <>
                {page === "usage" ? <UsageBilling refreshOn={[props.models, props.agents]} /> : null}
                {page === "mcp" ? (
                  <McpPage
                    agent={props.agent}
                    mcp={props.mcp}
                    rag={props.rag}
                    onToggle={props.onPatchAgent}
                    onChanged={async () => { await props.onChanged(); await load(); }}
                    onError={setError}
                  />
                ) : null}
                {page === "llm" ? (
                  <LlmPage
                    models={props.models}
                    onChanged={async () => { await props.onChanged(); await load(); }}
                    onError={setError}
                  />
                ) : null}
                {page === "information" && info ? <About info={info} /> : null}
                {page === "logs" ? <Logs lines={logs} onReload={() => void load()} /> : null}
                {page === "telemetry" ? <Telemetry /> : null}
                {page === "settings" && profile ? (
                  <General
                    profile={profile}
                    models={props.models}
                    theme={props.theme}
                    onSetTheme={props.onSetTheme}
                    onToggleTheme={props.onToggleTheme}
                    onSaved={async (next) => { setProfile(next); props.onProfile(next); await load(); }}
                    onError={setError}
                  />
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Status({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`status-pill ${ok ? "ok" : "off"}`}>
      <span className={`dot ${ok ? "ok" : "off"}`} />
      {label}
    </span>
  );
}

function McpPage(props: {
  agent: Agent | null;
  mcp: Mcp[];
  rag: Rag[];
  onToggle: (patch: Partial<Agent>) => Promise<void>;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [ragUrl, setRagUrl] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [configuringServer, setConfiguringServer] = useState<Mcp | null>(null);

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

  const isBuiltin = (item: Mcp) =>
    item.url.startsWith("builtin:") ||
    ["general-skills", "computer-use", "origin", "automations", "cursor-computer-use", "cursor-origin", "antigravity-skills"].includes(item.id);

  const builtinServers = props.mcp.filter(isBuiltin);
  const installedServers = props.mcp.filter((item) => !isBuiltin(item));

  function renderMcpCard(item: Mcp) {
    const on = props.agent?.mcpConnectionIds.includes(item.id) ?? false;
    const builtin = isBuiltin(item);
    const removable = !builtin;
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
              <span className="hint">{item.tools.length} tools · {builtin ? "Built-in workspace skills" : item.url}</span>
            </span>
          </button>
          <span className="actions">
            <button
              className="btn ghost tiny"
              type="button"
              onClick={() => setConfiguringServer(item)}
              title={`Configure ${item.name}`}
            >
              Configure
            </button>
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
            {!builtin ? (
              <button
                className={on ? "btn tiny primary-btn" : "btn ghost tiny"}
                type="button"
                disabled={!props.agent}
                onClick={() =>
                  void props.onToggle({
                    mcpConnectionIds: on
                      ? props.agent!.mcpConnectionIds.filter((id) => id !== item.id)
                      : [...(props.agent?.mcpConnectionIds ?? []), item.id],
                  })
                }
              >
                {on ? "Enabled" : "Disabled"}
              </button>
            ) : null}
          </span>
        </div>
        {expanded ? (
          <div className="tool-chip-grid">
            {item.tools.map((tool) => (
              <code className="tool-chip" key={tool.toolId}>{tool.toolId}</code>
            ))}
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <>
      <section className="card">
        <div className="label">Connect MCP Server</div>
        <p className="hint">Register a local or HTTP MCP endpoint. Tools will be discovered automatically.</p>
        <div className="inline-form">
          <input value={url} placeholder="http://127.0.0.1:3000/mcp" onChange={(event) => setUrl(event.target.value)} />
          <button className="btn primary-btn" type="button" disabled={!url.trim()} onClick={() => void addMcp()}>
            Connect MCP
          </button>
        </div>
      </section>

      <div className="section-subtitle">Built in</div>
      {builtinServers.length === 0 ? (
        <p className="hint">No built-in skills available.</p>
      ) : (
        builtinServers.map(renderMcpCard)
      )}

      <div className="section-subtitle" style={{ marginTop: 24 }}>Installed MCP Servers</div>
      {installedServers.length === 0 ? (
        <p className="hint">No external MCP servers installed yet.</p>
      ) : (
        installedServers.map(renderMcpCard)
      )}

      {configuringServer && (
        <ConfigureMcpModal
          server={configuringServer}
          onClose={() => setConfiguringServer(null)}
          onSave={async (disabledTools) => {
            try {
              await desktop.admin.updateMcp(configuringServer.id, { disabledTools });
              props.onError("");
              await props.onChanged();
            } catch (reason) {
              props.onError(reason instanceof Error ? reason.message : "Could not save tool configuration");
            }
          }}
          onReload={async () => {
            try {
              await desktop.admin.discoverMcp(configuringServer.id);
              props.onError("");
              await props.onChanged();
            } catch (reason) {
              props.onError(reason instanceof Error ? reason.message : "Could not reload tools");
            }
          }}
        />
      )}

      <div className="section-subtitle" style={{ marginTop: 24 }}>Knowledge & RAG Endpoints</div>
      <section className="card">
        <div className="label">Connect Knowledge URL</div>
        <div className="inline-form">
          <input value={ragUrl} placeholder="http://127.0.0.1:4200/search" onChange={(event) => setRagUrl(event.target.value)} />
          <button className="btn primary-btn" type="button" disabled={!ragUrl.trim()} onClick={() => void addRag()}>
            Connect Knowledge
          </button>
        </div>
      </section>
      {props.rag.map((item) => {
        const on = props.agent?.ragConnectionIds.includes(item.id) ?? false;
        return (
          <section className="card" key={item.id}>
            <div className="row">
              <div>
                <strong>{item.name}</strong>
                <div className="hint">{item.url}</div>
              </div>
              <button
                className={on ? "btn tiny primary-btn" : "btn ghost tiny"}
                type="button"
                disabled={!props.agent}
                onClick={() =>
                  void props.onToggle({
                    ragConnectionIds: on
                      ? props.agent!.ragConnectionIds.filter((id) => id !== item.id)
                      : [...(props.agent?.ragConnectionIds ?? []), item.id],
                  })
                }
              >
                {on ? "Enabled" : "Disabled"}
              </button>
            </div>
          </section>
        );
      })}
    </>
  );
}

function LlmPage(props: {
  models: Model[];
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [providerId, setProviderId] = useState("openai");
  const [modelId, setModelId] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:1234");
  const [secret, setSecret] = useState("");
  const [effort, setEffort] = useState("");
  const [studioModels, setStudioModels] = useState<{ id: string; label: string }[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
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
        effort: supportsEffort(providerId) && effort ? effort : undefined,
      });
      setSecret("");
      props.onError("");
      await props.onChanged();
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not connect the model");
    }
  }

  async function bindKey(id: string) {
    try {
      await desktop.admin.updateModelKey(id, keyDraft.trim());
      setEditingKey(null);
      setKeyDraft("");
      props.onError("");
      await props.onChanged();
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not save the API key");
    }
  }

  const choices = providerId === "lmstudio" ? studioModels : provider?.models ?? [];
  const needsKey = provider?.needsKey ?? true;
  const savedKey = props.models.some((item) => item.provider === providerId && item.hasSecret);

  return (
    <>
      <div className="section-subtitle">Connected Models</div>
      {props.models.length === 0 ? (
        <p className="hint" style={{ marginBottom: 14 }}>No models connected yet. Add a cloud or local LM Studio model below.</p>
      ) : (
        props.models.map((item) => {
          return (
            <div
              key={item.id}
              className="card key-card"
            >
              <div className="row">
                <div>
                  <div className="model-card-title">
                    <strong>{item.name}</strong>
                  </div>
                  <div className="hint">{providerLabel(providers, item)}{item.model ? ` · ${item.model}` : ""}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {supportsEffort(item.provider) ? (
                    <select
                      className="input tiny model-effort"
                      aria-label={`Effort for ${item.name}`}
                      title={(item.provider && EFFORT_HINTS[item.provider]) || "How much the model reasons before answering"}
                      value={item.effort ?? ""}
                      onChange={async (event) => {
                        try {
                          await desktop.admin.updateModelEffort(item.id, event.target.value || null);
                          await props.onChanged();
                        } catch (err) {
                          props.onError(err instanceof Error ? err.message : "Could not change the effort");
                        }
                      }}
                    >
                      <option value="">Default effort</option>
                      {Object.entries(EFFORT_LABELS).map(([value, label]) => <option key={value} value={value}>{label} effort</option>)}
                    </select>
                  ) : null}
                  <Status
                    ok={item.provider === "lmstudio" || item.provider === "claude-code" || item.provider === "codex" || item.hasSecret}
                    label={item.provider === "lmstudio" ? "Local Server" : item.provider === "claude-code" ? "Claude plan" : item.provider === "codex" ? "ChatGPT plan" : item.hasSecret ? "Key stored" : "No key"}
                  />
                  {item.provider !== "lmstudio" && item.provider !== "claude-code" && item.provider !== "codex" && editingKey !== item.id ? (
                    <button
                      className="btn ghost tiny"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingKey(item.id);
                        setKeyDraft("");
                      }}
                    >
                      {item.hasSecret ? "Replace Key" : "Add Key"}
                    </button>
                  ) : null}
                  <button
                    className="btn ghost tiny danger"
                    type="button"
                    title="Remove model"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (!window.confirm(`Remove ${item.name}? Agents using it will need another model.`)) return;
                      try {
                        await desktop.admin.deleteModel(item.id);
                        await props.onChanged();
                      } catch (err) {
                        props.onError(err instanceof Error ? err.message : "Failed to remove model");
                      }
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
              {editingKey === item.id ? (
                <form
                  className="model-key-row"
                  onClick={(e) => e.stopPropagation()}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void bindKey(item.id);
                  }}
                >
                  <input
                    type="password"
                    autoFocus
                    autoComplete="off"
                    aria-label={`API key for ${item.name}`}
                    placeholder={`Paste ${providerLabel(providers, item)} API key…`}
                    value={keyDraft}
                    onChange={(event) => setKeyDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setEditingKey(null);
                    }}
                  />
                  <button className="btn ghost tiny" type="button" onClick={() => setEditingKey(null)}>Cancel</button>
                  <button className="btn primary-btn tiny" type="submit" disabled={!keyDraft.trim()}>Save Key</button>
                </form>
              ) : null}
            </div>
          );
        })
      )}

      <div className="section-subtitle" style={{ marginTop: 20 }}>Add Model Connection</div>
      <section className="card">
        <div className="form-grid-2">
          <div>
            <label className="label" htmlFor="llm-provider">Provider</label>
            <select id="llm-provider" value={providerId} onChange={(event) => chooseProvider(event.target.value)}>
              {providers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="llm-model">Model</label>
            {providerId === "lmstudio" && choices.length === 0 ? (
              <input id="llm-model" value={modelId} placeholder="Model identifier in LM Studio" onChange={(event) => setModelId(event.target.value)} />
            ) : (
              <select id="llm-model" value={modelId} onChange={(event) => setModelId(event.target.value)}>
                {choices.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            )}
          </div>
        </div>

        {supportsEffort(providerId) ? (
          <div>
            <label className="label" htmlFor="llm-effort">Effort</label>
            <select id="llm-effort" value={effort} onChange={(event) => setEffort(event.target.value)}>
              <option value="">Model default</option>
              {Object.entries(EFFORT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <p className="hint">
              {EFFORT_HINTS[providerId] ?? "How much the model reasons before answering. Higher is slower and costs more."}
              {providerId === "claude-code" ? " Runs through the official Claude Code on your own Claude login (Settings → General → Claude Code). No API key." : ""}
              {providerId === "codex" ? " Runs through the official Codex on your own ChatGPT login (Settings → General → Codex). No API key." : ""}
            </p>
          </div>
        ) : null}

        {providerId === "lmstudio" ? (
          <div>
            <label className="label" htmlFor="llm-host">LM Studio Endpoint</label>
            <input id="llm-host" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          </div>
        ) : null}

        {needsKey ? (
          <div>
            <label className="label" htmlFor="llm-key">API Key</label>
            <input
              id="llm-key"
              type="password"
              value={secret}
              placeholder={savedKey ? `Using your saved ${provider?.label ?? ""} key — paste to replace` : "Paste provider API key…"}
              autoComplete="off"
              onChange={(event) => setSecret(event.target.value)}
            />
          </div>
        ) : null}

        <div className="actions">
          <button
            className="btn primary-btn"
            type="button"
            disabled={!modelId.trim() || (needsKey && !savedKey && !secret.trim())}
            onClick={() => void add()}
          >
            Connect Model
          </button>
        </div>
      </section>
    </>
  );
}

/** What the effort setting does on each provider. Tab completion and next edit always run at low effort. */
const EFFORT_HINTS: Record<string, string> = {
  claude: "Claude's effort setting (output_config.effort). Models without effort support ignore it.",
  "claude-code": "Claude Code's effort level.",
  codex: "Codex reasoning effort.",
  openai: "OpenAI reasoning effort for o-series and GPT-5 models (Extra High and Max use High). Other models ignore it.",
  gemini: "Gemini thinking level (3.x and 4) or thinking budget (2.5).",
};

function providerLabel(providers: LlmProvider[], model: Model) {
  return providers.find((item) => item.id === model.provider)?.label ?? model.provider ?? "Model";
}

function Logs(props: { lines: LogLine[]; onReload: () => void }) {
  const [service, setService] = useState("");
  const [level, setLevel] = useState("");
  const services = [...new Set(props.lines.map((item) => item.service))].sort();
  const rank = { debug: 0, info: 1, warning: 2, error: 3 } as const;
  const shown = props.lines.filter((item) => {
    if (service && item.service !== service) return false;
    if (level && rank[item.level] < rank[level as keyof typeof rank]) return false;
    return true;
  });
  return (
    <>
      <div className="log-toolbar">
        <select value={service} onChange={(event) => setService(event.target.value)}>
          <option value="">All services</option>
          {services.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <select value={level} onChange={(event) => setLevel(event.target.value)}>
          <option value="">All levels</option>
          <option value="info">info+</option>
          <option value="warning">warning+</option>
          <option value="error">error</option>
        </select>
        <button className="btn ghost" type="button" onClick={props.onReload}>Refresh</button>
      </div>
      <div className="log-stream">
        {shown.length === 0 ? <div className="hint">No log lines matching filter.</div> : shown.map((item) => (
          <div className={`log-line ${item.level}`} key={item.seq}>
            <span className="log-ts">{item.ts.slice(11, 23)}</span>
            <span className="log-svc">{item.service}</span>
            <span className="log-lvl">{item.level}</span>
            <span className="log-msg">{item.message}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function General(props: {
  profile: Profile;
  models: Model[];
  onSaved: (profile: Profile) => Promise<void>;
  onError: (message: string) => void;
  theme?: "light" | "dark";
  onSetTheme?: (theme: "light" | "dark") => void;
  onToggleTheme?: () => void;
}) {
  const [name, setName] = useState(props.profile.name);
  const [logging, setLogging] = useState(props.profile.logging);
  const [launchApp, setLaunchApp] = useState<LaunchApp>(props.profile.launchApp ?? "agent");
  const [completionModelId, setCompletionModelId] = useState(props.profile.completionModelId ?? "");
  const [saved, setSaved] = useState(false);
  // Claude Code and Codex models run an agent loop on the user's plan; completions need a plain API call.
  const completionChoices = props.models.filter((item) => item.provider !== "claude-code" && item.provider !== "codex");

  async function chooseCompletionModel(next: string) {
    const previous = completionModelId;
    setCompletionModelId(next);
    try {
      await props.onSaved(await desktop.admin.updateSettings({ completionModelId: next || null }));
      props.onError("");
    } catch (reason) {
      setCompletionModelId(previous);
      props.onError(reason instanceof Error ? reason.message : "Could not save");
    }
  }

  // Saved on click, like the theme: it only matters at the next launch, so there is nothing to confirm.
  async function chooseLaunchApp(next: LaunchApp) {
    if (next === launchApp) return;
    const previous = launchApp;
    setLaunchApp(next);
    try {
      await props.onSaved(await desktop.admin.updateSettings({ launchApp: next }));
      props.onError("");
    } catch (reason) {
      setLaunchApp(previous);
      props.onError(reason instanceof Error ? reason.message : "Could not save");
    }
  }

  async function save() {
    try {
      const next = await desktop.admin.updateSettings({ name, logging });
      setSaved(true);
      props.onError("");
      await props.onSaved(next);
      setTimeout(() => setSaved(false), 2000);
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not save");
    }
  }

  const themeButtons = (
    <div className="segmented-pill" role="radiogroup" aria-label="Theme">
      {([["light", "Light", <SunIcon key="sun" />], ["dark", "Dark", <MoonIcon key="moon" />]] as const).map(([value, label, icon]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={props.theme === value}
          className={props.theme === value ? "active" : ""}
          onClick={() => {
            if (props.onSetTheme) props.onSetTheme(value);
            else if (props.theme !== value) props.onToggleTheme?.();
          }}
        >
          {icon}
          <span>{label}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div className="settings-section-list">
      <div className="settings-section">
        <div className="settings-section-title">General</div>
        <div className="settings-card">
          <div className="settings-card-row">
            <div className="settings-row-text">
              <span className="settings-row-label">Open at Launch</span>
              <span className="settings-row-desc">
                {launchApp === "ide"
                  ? "Saturn opens Saturn IDE when it starts and stays in the Dock; click the Dock icon for the Agent App."
                  : "Saturn opens the Agent App when it starts. Open IDE is always one click away."}
              </span>
            </div>
            <div className="segmented-pill" role="radiogroup" aria-label="Open at launch">
              {([["agent", "Agent App"], ["ide", "Saturn IDE"]] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={launchApp === value}
                  className={launchApp === value ? "active" : ""}
                  onClick={() => void chooseLaunchApp(value)}
                >
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="settings-card-row">
            <div className="settings-row-text">
              <span className="settings-row-label">Theme</span>
              <span className="settings-row-desc">Light or dark appearance for the Agent App.</span>
            </div>
            {themeButtons}
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Claude Code</div>
        <div className="settings-card">
          <ClaudeCodeLogin />
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Codex</div>
        <div className="settings-card">
          <CodexLogin />
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Saturn IDE</div>
        <div className="settings-card">
          <div className="settings-card-row">
            <div className="settings-row-text">
              <span className="settings-row-label">Completion Model</span>
              <span className="settings-row-desc">
                {completionModelId
                  ? "Serves Tab completion and Cmd+K inline edit in Saturn IDE. A small, fast model works best."
                  : completionChoices.length
                    ? "Choose a model to turn on Tab completion and Cmd+K inline edit in Saturn IDE."
                    : "Connect an API or LM Studio model in Models to use Tab completion and Cmd+K in Saturn IDE."}
              </span>
            </div>
            <select
              className="input tiny settings-select"
              aria-label="Completion model"
              value={completionModelId}
              disabled={!completionChoices.length && !completionModelId}
              onChange={(event) => void chooseCompletionModel(event.target.value)}
            >
              <option value="">Off</option>
              {completionChoices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Workspace</div>
        <div className="settings-card">
          <div className="settings-card-row">
            <div className="settings-row-text">
              <span className="settings-row-label">Workspace Name</span>
              <span className="settings-row-desc">Shown in the title bar and settings.</span>
            </div>
            <form
              className="settings-inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <input
                className="input tiny"
                aria-label="Workspace name"
                value={name}
                onChange={(event) => { setName(event.target.value); setSaved(false); }}
              />
              <button type="submit" className="btn tiny" disabled={!name.trim() || name === props.profile.name}>
                {saved ? "Saved ✓" : "Save"}
              </button>
            </form>
          </div>

          <div className="settings-card-row">
            <div className="settings-row-text">
              <span className="settings-row-label">Log Level</span>
              <span className="settings-row-desc">How much the runtime writes to Logs.</span>
            </div>
            <div className="segmented-pill" role="radiogroup" aria-label="Log level">
              {[["debug", "Debug"], ["info", "Info"], ["warning", "Warning"], ["error", "Error"]].map(([level, label]) => (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={logging === level}
                  className={logging === level ? "active" : ""}
                  onClick={() => {
                    const previous = logging;
                    setLogging(level);
                    desktop.admin.updateSettings({ logging: level }).then(props.onSaved, (reason: unknown) => {
                      setLogging(previous);
                      props.onError(reason instanceof Error ? reason.message : "Could not save");
                    });
                  }}
                >
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="settings-card-row">
            <div className="settings-row-text">
              <span className="settings-row-label">API Keys</span>
              <span className="settings-row-desc">Kept on this Mac in a file only your user account can read.</span>
            </div>
            <code className="settings-path">~/.saturn-app/secrets.json</code>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProjectSettingsTab(props: {
  project: Project;
  onError: (message: string) => void;
}) {
  const [rules, setRules] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    desktop.projects
      .getRules(props.project.id)
      .then((result) => {
        if (!active) return;
        setRules(result.content);
        setLoading(false);
      })
      .catch(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [props.project.id]);

  async function saveRules() {
    setSaving(true);
    try {
      await desktop.projects.saveRules(props.project.id, rules);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Failed to save project rules");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-section-list">
      <div className="settings-section">
        <div className="settings-section-title">Project Details</div>
        <div className="settings-card">
          <div className="settings-card-row">
            <div className="settings-row-text">
              <span className="settings-row-label">Project Name</span>
              <span className="settings-row-desc">{props.project.name}</span>
            </div>
          </div>
          <div className="settings-card-row">
            <div className="settings-row-text">
              <span className="settings-row-label">Workspace Path</span>
              <span className="settings-row-desc" style={{ fontFamily: "monospace" }}>{props.project.path}</span>
            </div>
          </div>
          {props.project.gitBranch ? (
            <div className="settings-card-row">
              <div className="settings-row-text">
                <span className="settings-row-label">Git Branch</span>
                <span className="settings-row-desc" style={{ fontFamily: "monospace" }}>{props.project.gitBranch}</span>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Project Rules & Custom Instructions</div>
        <div className="settings-card">
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <span className="settings-row-desc">Custom instructions for agents working in this project (.cursorrules / AGENTS.md).</span>
            <textarea
              className="input"
              rows={7}
              style={{ width: "100%", fontFamily: "monospace", fontSize: "12px", resize: "vertical" }}
              value={rules}
              disabled={loading}
              placeholder={loading ? "Loading project rules…" : "Add custom instructions for this project…"}
              onChange={(event) => {
                setRules(event.target.value);
                setSaved(false);
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" className="btn primary-btn tiny" disabled={saving || loading} onClick={() => void saveRules()}>
                {saving ? "Saving…" : saved ? "Saved ✓" : "Save Rules"}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Actions</div>
        <div className="settings-card" style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          <button type="button" className="btn ghost tiny" onClick={() => void desktop.projects.openInEditor(props.project.id)}>
            Open in Saturn IDE
          </button>
          <button type="button" className="btn ghost tiny" onClick={() => void desktop.projects.openInTerminal(props.project.id)}>
            Open in Terminal
          </button>
          <button type="button" className="btn ghost tiny" onClick={() => void desktop.projects.openInFolder(props.project.id)}>
            Reveal in Finder
          </button>
        </div>
      </div>
    </div>
  );
}

function ShortcutsTab() {
  const shortcuts = [
    ["⌘ ,", "Open Settings"],
    ["⌘ K", "Open Command Palette"],
    ["⌘ N", "New Conversation"],
    ["⌘ B", "Toggle Left Sidebar"],
    ["⌘ L", "Focus Chat Prompt Input"],
    ["Enter", "Send Message"],
    ["Shift + Enter", "New Line in Chat Prompt"],
    ["Esc", "Close Popups & Modals"],
  ];
  return (
    <div className="settings-section-list">
      <div className="settings-section">
        <div className="settings-section-title">Keyboard Shortcuts</div>
        <div className="settings-card">
          {shortcuts.map(([keys, label]) => (
            <div className="settings-card-row" key={keys}>
              <div className="settings-row-text">
                <span className="settings-row-label">{label}</span>
              </div>
              <kbd
                style={{
                  padding: "3px 8px",
                  background: "var(--card-active, rgba(255,255,255,0.08))",
                  border: "1px solid var(--line)",
                  borderRadius: "6px",
                  fontSize: "12px",
                  fontFamily: "monospace",
                }}
              >
                {keys}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

function Chevron(props: { open: boolean }) {
  return (
    <svg className={props.open ? "chevron open" : "chevron"} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Codex models run on the user's own ChatGPT login, made by the official `codex` program. The runtime starts
 * its `codex login` and relays what it prints: a one-time code to type at OpenAI (no localhost redirect), or
 * the sign-in page it opened in the browser. Saturn never handles the credential itself.
 */
function CodexLogin() {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [busy, setBusy] = useState<"checking" | "starting" | "signing_out" | null>("checking");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  async function run(kind: NonNullable<typeof busy>, action: () => Promise<CodexStatus>, failure: string) {
    setBusy(kind);
    setError("");
    try {
      setStatus(await action());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : failure);
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void run("checking", () => desktop.admin.codexStatus(), "Could not reach the runtime");
  }, []);

  // While a sign-in waits, follow it until Codex reports signed in or the sign-in ends.
  const signIn = status && !status.loggedIn ? status.signIn : undefined;
  const waiting = signIn?.state === "starting" || signIn?.state === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => {
      void desktop.admin.codexStatus().then(setStatus, () => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [waiting]);

  async function signOut() {
    if (!window.confirm("Sign Saturn out of Codex? Codex models stop working until you sign in again. Your own Codex setup stays signed in.")) return;
    await run("signing_out", () => desktop.admin.codexLogout(), "Could not sign out");
  }

  async function openPage() {
    try {
      await desktop.admin.codexOpenPage();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open the page");
    }
  }

  async function copyCode() {
    if (!signIn?.code) return;
    try {
      await navigator.clipboard.writeText(signIn.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  const method = status?.authMethod === "chatgpt" ? "ChatGPT plan" : status?.authMethod === "api-key" ? "API key" : "";
  return (
    <>
      <div className="settings-card-row">
        <div className="settings-row-text">
          <span className="settings-row-label">ChatGPT Account</span>
          <span className="settings-row-desc">
            {status === null
              ? busy ? "Checking…" : "Status unavailable."
              : status.loggedIn
                ? ["Signed in", method].filter(Boolean).join(" · ")
                : "Not signed in. Codex models run on your own ChatGPT login; Saturn never sees your credentials."}
          </span>
        </div>
        <div className="settings-row-actions">
          {status ? <Status ok={status.loggedIn} label={status.loggedIn ? "Signed in" : "Signed out"} /> : null}
          {status?.loggedIn ? (
            <button type="button" className="btn tiny" disabled={busy !== null} onClick={() => void signOut()}>
              {busy === "signing_out" ? "Signing out…" : "Sign Out"}
            </button>
          ) : waiting ? (
            <button type="button" className="btn ghost tiny" onClick={() => void run("checking", () => desktop.admin.codexCancelSignIn(), "Could not cancel")}>
              Cancel
            </button>
          ) : (
            <button type="button" className="btn tiny" disabled={busy !== null || status === null} onClick={() => void run("starting", () => desktop.admin.codexSignIn("device"), "Could not start sign-in")}>
              {busy === "starting" ? "Starting…" : "Sign In"}
            </button>
          )}
        </div>
      </div>
      {signIn && waiting ? (
        <div className="settings-card-row settings-card-stack">
          {signIn.mode === "device" ? (
            <>
              <span className="settings-row-desc">Open the OpenAI page, sign in, and enter this one-time code. It expires in 15 minutes; this card updates once you're done.</span>
              <div className="claude-login-command">
                <code className="codex-device-code">{signIn.code ?? "Waiting for a code…"}</code>
                {signIn.code ? <button type="button" className="btn ghost tiny" onClick={() => void copyCode()}>{copied ? "Copied" : "Copy"}</button> : null}
                {signIn.url ? (
                  <button type="button" className="btn tiny" onClick={() => void openPage()}>Open Page</button>
                ) : null}
              </div>
              <span className="settings-row-desc">
                Device codes must be allowed in your ChatGPT security settings. If they aren't,{" "}
                <button type="button" className="link-button" onClick={() => void run("starting", () => desktop.admin.codexSignIn("browser"), "Could not start sign-in")}>
                  sign in with the browser instead
                </button>.
              </span>
            </>
          ) : (
            <span className="settings-row-desc">
              Finish signing in on the page that opened in your browser. Saturn keeps Codex listening for it until you're done.
              {signIn.url ? <> <button type="button" className="link-button" onClick={() => void openPage()}>Open it again</button>.</> : null}
            </span>
          )}
        </div>
      ) : null}
      {error || status?.error || (signIn?.state === "failed" ? signIn.error : "") ? (
        <p className="settings-row-error">{error || status?.error || signIn?.error}</p>
      ) : null}
    </>
  );
}

/**
 * Claude Code models run on the user's own Claude login, made once with the official `claude` program in a
 * terminal. Saturn shows what that program reports, the command to run, and signing out through the same
 * program; it never handles the credential itself.
 */
function ClaudeCodeLogin() {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof desktop.admin.claudeCodeStatus>> | null>(null);
  const [busy, setBusy] = useState<"checking" | "signing_out" | null>("checking");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  async function check() {
    setBusy("checking");
    setError("");
    try {
      setStatus(await desktop.admin.claudeCodeStatus());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not reach the runtime");
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void check();
  }, []);

  // While signed out, ask again every few seconds, so finishing the terminal sign-in shows up on its own.
  const signedOut = status !== null && !status.loggedIn && Boolean(status.loginCommand);
  useEffect(() => {
    if (!signedOut) return;
    const timer = window.setInterval(() => {
      void desktop.admin.claudeCodeStatus().then(setStatus, () => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [signedOut]);

  async function signOut() {
    if (!window.confirm("Sign Saturn out of Claude Code? Claude Code models stop working until you sign in again. Your other Claude apps stay signed in.")) return;
    setBusy("signing_out");
    setError("");
    try {
      setStatus(await desktop.admin.claudeCodeLogout());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not sign out");
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    if (!status?.loginCommand) return;
    try {
      await navigator.clipboard.writeText(status.loginCommand);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  const plan = status?.subscriptionType ? `${status.subscriptionType.charAt(0).toUpperCase()}${status.subscriptionType.slice(1)} plan` : "";
  return (
    <>
      <div className="settings-card-row">
        <div className="settings-row-text">
          <span className="settings-row-label">Claude Account</span>
          <span className="settings-row-desc">
            {status === null
              ? busy ? "Checking…" : "Status unavailable."
              : status.loggedIn
                ? [status.email ?? "Signed in", plan].filter(Boolean).join(" · ")
                : "Not signed in. Claude Code models run on your own Claude login; Saturn never sees your credentials."}
          </span>
        </div>
        <div className="settings-row-actions">
          {status ? <Status ok={status.loggedIn} label={status.loggedIn ? "Signed in" : "Signed out"} /> : null}
          {status?.loggedIn ? (
            <button type="button" className="btn tiny" disabled={busy !== null} onClick={() => void signOut()}>
              {busy === "signing_out" ? "Signing out…" : "Sign Out"}
            </button>
          ) : (
            <button type="button" className="btn ghost tiny" disabled={busy !== null} onClick={() => void check()}>
              {busy === "checking" ? "Checking…" : "Check Again"}
            </button>
          )}
        </div>
      </div>
      {status && !status.loggedIn && status.loginCommand ? (
        <div className="settings-card-row settings-card-stack">
          <span className="settings-row-desc">
            To sign in, run this in Terminal and keep that window open until it says you're signed in. This card updates on its own.
            If the browser says it can't connect to localhost, that terminal sign-in had already ended: run the command again and use the new browser page.
          </span>
          <div className="claude-login-command">
            <code>{status.loginCommand}</code>
            <button type="button" className="btn ghost tiny" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
          </div>
        </div>
      ) : null}
      {error || status?.error ? <p className="settings-row-error">{error || status?.error}</p> : null}
    </>
  );
}
