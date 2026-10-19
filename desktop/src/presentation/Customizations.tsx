import { useEffect, useMemo, useState } from "react";
import type { Agent, InstallRequest, MarketplaceEntry, Mcp } from "../domain/model";
import { BrandIcon } from "./BrandIcon";
import { desktop } from "../application/desktop";
import { ConfigureMcpModal } from "./ConfigureMcpModal";
import {
  MCP_CATEGORIES,
  MCP_MARKETPLACE_ITEMS,
  SATURN_MCP_ITEM,
  type McpCategory,
  type McpMarketplaceItem,
} from "../domain/marketplace";

const BUILTIN_SKILLS_AND_RULES = [
  {
    name: "/agy-customizations",
    badge: "Built In",
    desc: "Comprehensive guide and reference for the Antigravity Customization System. Use to explain how customizations work, their loading priority, discovery mechanisms, and to guide the creation of skills, rules, plugins, hooks, and MCP servers.",
  },
  {
    name: "/antigravity-guide",
    badge: "Built In",
    desc: "Provides a comprehensive guide, quick reference, and sitemap for Google Antigravity (AGY), including the Antigravity CLI (agy), Antigravity 2.0, Antigravity IDE, Python SDK, slash commands, keybindings, and customizations (skills, rules, MCP, sidecars).",
  },
  {
    name: "/automation",
    badge: "Built In",
    desc: "Interactive guide to design and create a scheduled background automation. Use this skill when the user wants to create an automated or recurring scheduled task (e.g. \"summarize my emails every morning\", \"every Monday send me a to-do list\").",
  },
  {
    name: "/generative_ui",
    badge: "Built In",
    desc: "How to render rich interactive HTML widgets inline in the chat or as standalone artifacts.",
  },
  {
    name: "/migrate-workflows",
    badge: "Built In",
    desc: "Automatically migrate legacy workflows to modern skills across global and workspace configurations. Scans for existing workflows, creates target SKILL.md files, and safely archives old workflow files.",
  },
  {
    name: "/plugin",
    badge: "Built In",
    desc: "How to manage and create plugins — namespaced bundles of skills, agents, rules, MCP servers and hooks that install, enable and disable as a single unit.",
  },
  {
    name: "/ui-plugin-navigation",
    badge: "Built In",
    desc: "Discover UI plugin panels relevant to the current task and surface a one-click pill in chat to open (toggle) them in the side pane.",
  },
];

export function Customizations(props: {
  agents: Agent[];
  mcp: Mcp[];
  onOpenMcp: () => void;
  onOpenAgent: (agentId: string) => void;
}) {
  const [tab, setTab] = useState<"marketplace" | "installed">("marketplace");
  const [query, setQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<McpCategory | "All">("All");

  // Install state lives in the runtime: real MCP connections, their sign-in and tools.
  const [entries, setEntries] = useState<Record<string, MarketplaceEntry>>({});
  /** null until the first answer; false when the runtime did not respond; "outdated" when it runs an older version. */
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<McpMarketplaceItem | null>(null);
  const [notice, setNotice] = useState("");

  const [pluginsOpen, setPluginsOpen] = useState(true);
  const [configuringServer, setConfiguringServer] = useState<Mcp | null>(null);
  const [skillsOpen, setSkillsOpen] = useState(true);
  const [agentsOpen, setAgentsOpen] = useState(true);

  async function reload() {
    try {
      const list = await desktop.marketplace.list();
      setEntries(Object.fromEntries(list.map((entry) => [entry.id, entry])));
    } catch {
      // The runtime may be restarting; the next poll catches up.
    }
  }

  const waiting = Object.values(entries).some((entry) => entry.installed?.status === "connecting" || entry.installed?.status === "signing_in");
  useEffect(() => {
    void reload();
    // Poll faster while a sign-in is open in the browser, so the card flips to Installed when it finishes.
    const timer = window.setInterval(() => void reload(), waiting ? 3000 : 10000);
    return () => window.clearInterval(timer);
  }, [waiting]);

  const installedIds = Object.values(entries).filter((entry) => entry.installed).map((entry) => entry.id);

  async function install(item: McpMarketplaceItem, request: InstallRequest = {}) {
    setBusy(item.id);
    setNotice("");
    try {
      const entry = await desktop.marketplace.install(item.id, { name: item.name, ...request });
      setEntries((current) => ({ ...current, [item.id]: entry }));
      if (entry.installed?.status === "error") setNotice(`${item.name}: ${entry.installed.detail ?? "could not connect"}`);
    } catch (reason) {
      setNotice(`${item.name}: ${reason instanceof Error ? reason.message : "could not install"}`);
    } finally {
      setBusy(null);
    }
  }

  async function uninstall(item: McpMarketplaceItem) {
    setBusy(item.id);
    try {
      await desktop.marketplace.uninstall(item.id);
      await reload();
    } catch (reason) {
      setNotice(`${item.name}: ${reason instanceof Error ? reason.message : "could not uninstall"}`);
    } finally {
      setBusy(null);
    }
  }

  /** One click when nothing is needed; the dialog when the user must paste a token or their own OAuth client. */
  function start(item: McpMarketplaceItem) {
    const entry = entries[item.id];
    if (!entry?.available) return;
    if (entry.auth === "token" || entry.auth === "oauth-client") setDialog(item);
    else void install(item);
  }

  // Filter marketplace items
  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return MCP_MARKETPLACE_ITEMS.filter((item) => {
      const matchesCategory = selectedCategory === "All" || item.category === selectedCategory;
      if (!matchesCategory) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.subtitle.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.categoryName.toLowerCase().includes(q)
      );
    });
  }, [query, selectedCategory]);

  // Group items by category for rendering sections
  const groupedSections = useMemo(() => {
    const sections: { category: McpCategory; label: string; items: McpMarketplaceItem[] }[] = [];
    for (const cat of MCP_CATEGORIES) {
      if (selectedCategory !== "All" && selectedCategory !== cat.id) continue;
      const items = filteredItems.filter((item) => item.category === cat.id);
      if (items.length > 0) {
        sections.push({ category: cat.id, label: cat.label, items });
      }
    }
    return sections;
  }, [filteredItems, selectedCategory]);

  // Installed items list
  const installedItems = useMemo(() => {
    return [SATURN_MCP_ITEM, ...MCP_MARKETPLACE_ITEMS].filter((item) => entries[item.id]?.installed);
  }, [entries]);

  const q = query.trim().toLowerCase();
  const showPinned = !q || `${SATURN_MCP_ITEM.name} ${SATURN_MCP_ITEM.description}`.toLowerCase().includes(q);
  const pinnedEntry = entries[SATURN_MCP_ITEM.id];

  const filteredSkills = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return BUILTIN_SKILLS_AND_RULES;
    return BUILTIN_SKILLS_AND_RULES.filter(
      (item) => item.name.toLowerCase().includes(q) || item.desc.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <div className="customizations-page">

      {/* ==================================================================== */}
      {/* Header with Title and Segmented Tabs (Marketplace / Installed)      */}
      {/* ==================================================================== */}
      <div className="customizations-header">
        <div>
          <h1 className="customizations-title">Customizations</h1>
          <p className="customizations-lead">Saturn Web Console: MCP Service Marketplace (44 Services)</p>
        </div>
        <div className="customizations-pill-toggle" role="tablist">
          <button
            type="button"
            className={tab === "marketplace" ? "pill-btn active" : "pill-btn"}
            onClick={() => setTab("marketplace")}
          >
            Marketplace (44)
          </button>
          <button
            type="button"
            className={tab === "installed" ? "pill-btn active" : "pill-btn"}
            onClick={() => setTab("installed")}
          >
            Installed ({installedIds.length})
          </button>
        </div>
      </div>

      {/* Search Input Bar */}
      <div className="customizations-search-wrap">
        <svg className="search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          type="text"
          className="customizations-search-input"
          placeholder="Search 44 MCP services (e.g. Stripe, Notion, GitHub, Gmail, Supabase)..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query ? (
          <button
            type="button"
            className="search-clear-btn"
            onClick={() => setQuery("")}
            aria-label="Clear search"
          >
            ✕
          </button>
        ) : null}
      </div>

      {notice ? (
        <p className="error customizations-notice" role="alert">
          {notice}
          <button type="button" className="search-clear-btn" onClick={() => setNotice("")} aria-label="Dismiss">✕</button>
        </p>
      ) : null}

      {/* Category Filter Pills (Marketplace only) */}
      {tab === "marketplace" ? (
        <div className="mcp-category-filter-bar">
          <button
            type="button"
            className={selectedCategory === "All" ? "cat-filter-pill active" : "cat-filter-pill"}
            onClick={() => setSelectedCategory("All")}
          >
            All (44)
          </button>
          {MCP_CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              className={selectedCategory === cat.id ? "cat-filter-pill active" : "cat-filter-pill"}
              onClick={() => setSelectedCategory(cat.id)}
            >
              {cat.pillLabel} ({cat.count})
            </button>
          ))}
        </div>
      ) : null}

      {/* ==================================================================== */}
      {/* Content Area                                                         */}
      {/* ==================================================================== */}
      <div className="customizations-content">
        {tab === "marketplace" ? (
          <>
            {/* Pinned: Saturn MCP, an external MCP server installed through this app's MCP client. */}
            {showPinned && selectedCategory === "All" ? (
              <section className="pinned-mcp">
                <div className="customization-card mcp-service-card pinned">
                  <div className="customization-icon-wrap brand">
                    <BrandIcon id={SATURN_MCP_ITEM.id} name={SATURN_MCP_ITEM.name} />
                  </div>
                  <div className="customization-info">
                    <div className="customization-name-row">
                      <span className="customization-name">{SATURN_MCP_ITEM.name}</span>
                      <InstallState entry={pinnedEntry} />
                    </div>
                    <div className="customization-desc">
                      {SATURN_MCP_ITEM.description}{" "}
                      <button type="button" className="link-btn" onClick={() => void desktop.workspace.openNativeBrowser("https://saturn-core.com/mcp")}>
                        Learn more ↗
                      </button>
                    </div>
                  </div>
                  <InstallAction
                    item={SATURN_MCP_ITEM}
                    entry={pinnedEntry}
                    busy={busy === SATURN_MCP_ITEM.id}
                    onInstall={() => start(SATURN_MCP_ITEM)}
                    onOpenSignIn={(url) => void desktop.workspace.openNativeBrowser(url)}
                  />
                </div>
              </section>
            ) : null}
            {groupedSections.length > 0 ? (
              groupedSections.map((section, idx) => (
                <section key={section.category} className="customizations-section">
                  <div className="customizations-section-head">
                    <h2 className="section-title">
                      {idx + 1}. {section.label} ({section.items.length})
                    </h2>
                    <p className="section-subtitle">
                      Mount governed external MCP tools for agents.
                    </p>
                  </div>

                  <div className="customizations-grid">
                    {section.items.map((item) => {
                      const entry = entries[item.id];
                      return (
                        <div key={item.id} className={entry && !entry.available ? "customization-card mcp-service-card unavailable" : "customization-card mcp-service-card"}>
                          <div className="customization-icon-wrap brand">
                            <BrandIcon id={item.id} name={item.name} />
                          </div>
                          <div className="customization-info">
                            <div className="customization-name-row">
                              <span className="customization-name">{item.name}</span>
                              <InstallState entry={entry} />
                            </div>
                            <div className="customization-desc">{entry && !entry.available ? entry.reason : item.description}</div>
                          </div>
                          <InstallAction
                            item={item}
                            entry={entry}
                            busy={busy === item.id}
                            onInstall={() => start(item)}
                            onOpenSignIn={(url) => void desktop.workspace.openNativeBrowser(url)}
                          />
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))
            ) : (
              <div className="customizations-empty-search">
                <p>No MCP services found matching "{query}".</p>
                <button
                  type="button"
                  className="btn ghost tiny"
                  style={{ marginTop: 8 }}
                  onClick={() => {
                    setQuery("");
                    setSelectedCategory("All");
                  }}
                >
                  Clear Search
                </button>
              </div>
            )}
          </>
        ) : (
          /* Installed Tab */
          <div className="installed-view">
            {/* Installed MCP Services Group */}
            <div className="installed-group">
              <div className="installed-group-head">
                <button
                  type="button"
                  className="accordion-toggle"
                  onClick={() => setPluginsOpen((v) => !v)}
                >
                  <span className="accordion-label">Mounted MCP Tools</span>
                  <span className="count-badge">{installedItems.length}</span>
                  <ChevronDownIcon open={pluginsOpen} />
                </button>
              </div>

              {pluginsOpen ? (
                installedItems.length === 0 ? (
                  <div className="plugins-empty-box">
                    <p className="empty-subtext">No external MCP services mounted yet. Select tools from the marketplace to mount.</p>
                    <button
                      type="button"
                      className="browse-marketplace-btn"
                      onClick={() => setTab("marketplace")}
                    >
                      <MarketplaceBoxIcon />
                      <span>Browse 44 MCP Services</span>
                    </button>
                  </div>
                ) : (
                  <div className="customizations-grid installed-grid">
                    {installedItems.map((item) => {
                      const installed = entries[item.id]?.installed;
                      return (
                        <div key={item.id} className="customization-card mcp-service-card">
                          <div className="customization-icon-wrap brand">
                            <BrandIcon id={item.id} name={item.name} />
                          </div>
                          <div className="customization-info">
                            <div className="customization-name-row">
                              <span className="customization-name">{item.name}</span>
                              <InstallState entry={entries[item.id]} />
                            </div>
                            <div className="customization-desc">
                              {installed?.status === "ready"
                                ? `${installed.tools} tools · on ${installed.agents} ${installed.agents === 1 ? "agent" : "agents"}`
                                : installed?.detail ?? item.description}
                            </div>
                          </div>
                          {installed?.status === "error" || installed?.status === "signing_in" ? (
                            <button type="button" className="btn ghost tiny" disabled={busy === item.id} onClick={() => start(item)}>
                              {installed.status === "error" ? "Retry" : "Sign in again"}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="btn ghost tiny danger"
                            disabled={busy === item.id}
                            onClick={() => void uninstall(item)}
                            title="Remove the connection and its saved sign-in"
                          >
                            Uninstall
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )
              ) : null}
            </div>

            {/* Skills & Rules Group */}
            <div className="installed-group">
              <div className="installed-group-head">
                <button
                  type="button"
                  className="accordion-toggle"
                  onClick={() => setSkillsOpen((v) => !v)}
                >
                  <span className="accordion-label">Built-in Skills & Rules</span>
                  <span className="count-badge">{filteredSkills.length}</span>
                  <ChevronDownIcon open={skillsOpen} />
                </button>
                {props.mcp.find((m) => m.id === "automations" || m.id === "antigravity-skills") ? (
                  <button
                    type="button"
                    className="btn ghost tiny configure-mcp-btn"
                    onClick={() => {
                      const ag = props.mcp.find((m) => m.id === "automations" || m.id === "antigravity-skills");
                      if (ag) setConfiguringServer(ag);
                    }}
                    title="Configure Automations"
                  >
                    Configure
                  </button>
                ) : null}
              </div>

              {skillsOpen ? (
                <div className="skills-rules-list">
                  {filteredSkills.map((item) => (
                    <div key={item.name} className="skill-rule-row">
                      <div className="skill-rule-head">
                        <strong className="skill-rule-name">{item.name}</strong>
                        <span className="builtin-pill">{item.badge}</span>
                      </div>
                      <p className="skill-rule-desc">{item.desc}</p>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            {/* Custom Agents Group */}
            <div className="installed-group">
              <div className="installed-group-head">
                <button
                  type="button"
                  className="accordion-toggle"
                  onClick={() => setAgentsOpen((v) => !v)}
                >
                  <span className="accordion-label">Custom Agents</span>
                  <span className="count-badge">{props.agents.length}</span>
                  <ChevronDownIcon open={agentsOpen} />
                </button>
              </div>

              {agentsOpen ? (
                props.agents.length === 0 ? (
                  <div className="empty-inline-hint">No custom agents created yet.</div>
                ) : (
                  <div className="installed-agents-list">
                    {props.agents.map((agent) => (
                      <div key={agent.id} className="installed-agent-card">
                        <div>
                          <strong>{agent.name}</strong>
                          <div className="hint">{agent.description || "Workspace local agent"}</div>
                        </div>
                        <button
                          type="button"
                          className="btn ghost tiny"
                          onClick={() => props.onOpenAgent(agent.id)}
                        >
                          Open Agent →
                        </button>
                      </div>
                    ))}
                  </div>
                )
              ) : null}
            </div>

            {/* External MCP Servers Connection Link */}
            <div className="installed-group">
              <button
                type="button"
                className="mcp-nav-row"
                onClick={props.onOpenMcp}
              >
                <div className="mcp-nav-left">
                  <span className="accordion-label">External MCP Connections</span>
                  <span className="count-badge">{props.mcp.length}</span>
                </div>
                <div className="mcp-nav-right">
                  <span className="hint-label">Configure in Settings</span>
                  <ChevronRightIcon />
                </div>
              </button>
              {props.mcp.length > 0 && (
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                  {props.mcp.map((server) => (
                    <div
                      key={server.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "8px 12px",
                        background: "rgba(255, 255, 255, 0.03)",
                        border: "1px solid rgba(255, 255, 255, 0.06)",
                        borderRadius: 6,
                      }}
                    >
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <span style={{ fontSize: 13, fontWeight: 500, color: "#f4f4f5" }}>{server.name}</span>
                        <span style={{ fontSize: 11, color: "#a1a1aa" }}>{server.tools.length} tools</span>
                      </div>
                      <button
                        type="button"
                        className="btn ghost tiny"
                        onClick={() => setConfiguringServer(server)}
                      >
                        Configure
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {dialog ? (
        <InstallDialog
          item={dialog}
          entry={entries[dialog.id]}
          onClose={() => setDialog(null)}
          onOpen={(url) => void desktop.workspace.openNativeBrowser(url)}
          onSubmit={async (request) => {
            setDialog(null);
            await install(dialog, request);
          }}
        />
      ) : null}

      {configuringServer && (
        <ConfigureMcpModal
          server={configuringServer}
          onClose={() => setConfiguringServer(null)}
          onSave={async (disabledTools) => {
            await desktop.admin.updateMcp(configuringServer.id, { disabledTools });
          }}
          onReload={async () => {
            await desktop.admin.discoverMcp(configuringServer.id);
          }}
        />
      )}
    </div>
  );
}

// ==========================================================================
// Monochrome SVGs (Clean Single-Color Icons)
// ==========================================================================



/** A small pill next to the name: what the runtime says about this integration right now. */
function InstallState(props: { entry: MarketplaceEntry | undefined }) {
  const installed = props.entry?.installed;
  if (!props.entry) return null;
  if (!props.entry.available) return <span className="install-pill off">No official server</span>;
  if (!installed) return null;
  if (installed.status === "ready") return <span className="install-pill ok">Installed · {installed.tools} tools</span>;
  if (installed.status === "signing_in") return <span className="install-pill wait">Sign in in your browser</span>;
  if (installed.status === "connecting") return <span className="install-pill wait">Connecting…</span>;
  return <span className="install-pill err" title={installed.detail}>Error</span>;
}

function InstallAction(props: {
  item: McpMarketplaceItem;
  entry: MarketplaceEntry | undefined;
  busy: boolean;
  onInstall: () => void;
  onOpenSignIn: (url: string) => void;
}) {
  const { item, entry } = props;
  const installed = entry?.installed;
  if (!entry || !entry.available) {
    return (
      <button type="button" className="customization-action-btn" disabled title={entry?.reason ?? "Loading…"} aria-label={`${item.name} is not available`}>
        <PlusIcon />
      </button>
    );
  }
  if (props.busy || installed?.status === "connecting") {
    return <span className="customization-action-btn busy" aria-label={`Installing ${item.name}`}><span className="install-spinner" /></span>;
  }
  if (installed?.status === "signing_in" && installed.authorizationUrl) {
    return (
      <button type="button" className="btn ghost tiny" onClick={() => props.onOpenSignIn(installed.authorizationUrl!)} title="Open the provider's sign-in page again">
        Sign in
      </button>
    );
  }
  if (installed?.status === "ready") {
    return (
      <span className="customization-action-btn installed" title={`Installed with ${installed.tools} tools`} aria-label={`${item.name} installed`}>
        <CheckIcon />
      </span>
    );
  }
  const label = installed?.status === "error" ? `Retry installing ${item.name}` : `Install ${item.name}`;
  const how = entry.auth === "oauth" ? "Install — opens the sign-in page in your browser" : entry.auth === "none" ? "Install — no sign-in needed" : "Install — needs a token or your own OAuth client";
  return (
    <button type="button" className={installed?.status === "error" ? "customization-action-btn error" : "customization-action-btn"} onClick={props.onInstall} title={installed?.status === "error" ? installed.detail : how} aria-label={label}>
      <PlusIcon />
    </button>
  );
}

/** For providers that do not let apps self-register: paste a token, or the OAuth client you created with them. */
function InstallDialog(props: {
  item: McpMarketplaceItem;
  entry: MarketplaceEntry | undefined;
  onClose: () => void;
  onOpen: (url: string) => void;
  onSubmit: (request: InstallRequest) => Promise<void>;
}) {
  const entry = props.entry;
  const tokenMode = entry?.auth === "token";
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [useClient, setUseClient] = useState(!tokenMode);
  const ready = useClient ? clientId.trim().length > 0 : token.trim().length > 0;

  return (
    <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <form
        className="modal-dialog install-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-dialog-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) void props.onSubmit(useClient ? { clientId, clientSecret: clientSecret || undefined } : { token });
        }}
      >
        <div className="modal-header">
          <div className="install-dialog-title">
            <BrandIcon id={props.item.id} name={props.item.name} size={22} />
            <h3 id="install-dialog-title">Install {props.item.name}</h3>
          </div>
          <button type="button" className="modal-close" onClick={props.onClose} aria-label="Close">✕</button>
        </div>
        <p className="hint">
          {useClient
            ? `${props.item.name} doesn't let apps register themselves, so sign-in uses an OAuth client you create with them. Saturn then opens their sign-in page in your browser.`
            : `${props.item.name} signs in with a token you create. It is stored only in this computer's Saturn secrets file.`}
        </p>
        {entry?.setupHint ? <p className="hint">{entry.setupHint}</p> : null}
        {entry?.setupUrl ? (
          <button type="button" className="btn ghost tiny install-setup-link" onClick={() => props.onOpen(entry.setupUrl!)}>
            Open {new URL(entry.setupUrl).host} ↗
          </button>
        ) : null}
        <div className="modal-body">
          {useClient ? (
            <>
              <label className="label" htmlFor="install-client-id">OAuth client ID</label>
              <input id="install-client-id" autoFocus autoComplete="off" value={clientId} onChange={(event) => setClientId(event.target.value)} />
              <label className="label" htmlFor="install-client-secret">Client secret (if the provider issued one)</label>
              <input id="install-client-secret" type="password" autoComplete="off" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} />
            </>
          ) : (
            <>
              <label className="label" htmlFor="install-token">Token</label>
              <input id="install-token" type="password" autoFocus autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} />
            </>
          )}
          {entry?.tokenAlternative ? (
            <button type="button" className="btn ghost tiny" onClick={() => setUseClient((value) => !value)}>
              {useClient ? "Use a token instead" : "Use my own OAuth client instead"}
            </button>
          ) : null}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button>
          <button type="submit" className="btn primary-btn" disabled={!ready}>Install</button>
        </div>
      </form>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 8.5l3 3 6-6" />
    </svg>
  );
}

function ChevronDownIcon(props: { open: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: props.open ? "rotate(0deg)" : "rotate(-90deg)",
        transition: "transform 0.15s ease",
      }}
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

function MarketplaceBoxIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M2.5 5.5l5.5-3 5.5 3v6l-5.5 3-5.5-3v-6z" />
      <path d="M2.5 5.5l5.5 3 5.5-3M8 8.5v6" />
    </svg>
  );
}

export function PuzzleIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.2" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1.2" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1.2" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1.2" />
    </svg>
  );
}
