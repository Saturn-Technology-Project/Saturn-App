import { useEffect, useState } from "react";
import { desktop } from "../application/desktop";
import type { Plugin } from "../domain/model";

/** Settings → Plugins: install from a folder or a git URL, turn on or off, allow a plugin's hooks, remove it. */
export function PluginsPage(props: { onError: (message: string) => void; onChanged?: () => void }) {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try {
      setPlugins(await desktop.admin.plugins());
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Could not load plugins");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function act(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    try {
      await action();
      props.onError("");
      await load();
      props.onChanged?.();
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  async function pickFolder() {
    const picked = await (globalThis as { saturnDesktop?: { pickFolders?: () => Promise<string[]> } }).saturnDesktop?.pickFolders?.();
    if (picked?.[0]) setSource(picked[0]);
  }

  return (
    <div className="settings-section-list">
      <div className="settings-section">
        <div className="settings-section-title">Install a plugin</div>
        <div className="settings-card">
          <p className="settings-row-desc">
            A plugin bundles skills, <code>/</code> commands, hooks and MCP servers in one folder with a <code>plugin.json</code>; Claude Code plugins (<code>.claude-plugin/plugin.json</code>) install as they are. Installing copies the folder, or clones the git repository, into Saturn and runs nothing: its hooks and local MCP servers each wait for your approval.
          </p>
          <form className="permission-form plugin-install" onSubmit={(event) => { event.preventDefault(); if (source.trim()) void act("install", async () => { await desktop.admin.installPlugin(source.trim()); setSource(""); }); }}>
            <input className="input tiny permission-pattern-input plugin-source" aria-label="Plugin folder or git URL" placeholder="/path/to/plugin or https://github.com/owner/plugin" value={source} onChange={(event) => setSource(event.target.value)} />
            <button type="button" className="btn ghost tiny" onClick={() => void pickFolder()}>Choose Folder…</button>
            <button type="submit" className="btn tiny" disabled={busy !== null || !source.trim()}>{busy === "install" ? "Installing…" : "Install"}</button>
          </form>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Installed</div>
        <div className="settings-card">
          {plugins.length ? plugins.map((plugin) => (
            <div className="settings-card-row settings-card-stack" key={plugin.name}>
              <div className="hook-set-head">
                <span className="settings-row-label">
                  {plugin.name}
                  {plugin.version ? <span className="plugin-version"> {plugin.version}</span> : null}
                </span>
                <button type="button" className="btn ghost tiny" disabled={busy !== null} onClick={() => void act(`toggle:${plugin.name}`, () => desktop.admin.setPluginEnabled(plugin.name, !plugin.enabled))}>
                  {plugin.enabled ? "Turn Off" : "Turn On"}
                </button>
                <button
                  type="button"
                  className="btn ghost tiny danger"
                  disabled={busy !== null}
                  onClick={() => {
                    if (window.confirm(`Remove ${plugin.name}? Its files and its MCP servers are removed.`)) void act(`remove:${plugin.name}`, () => desktop.admin.removePlugin(plugin.name));
                  }}
                >
                  Remove
                </button>
              </div>
              {plugin.description ? <span className="settings-row-desc">{plugin.description}</span> : null}
              <span className="settings-row-desc plugin-parts">
                {plugin.enabled ? "" : "Off · "}
                {[
                  plugin.skills.length ? `${plugin.skills.length} skill${plugin.skills.length === 1 ? "" : "s"} (${plugin.skills.join(", ")})` : "",
                  plugin.commands.length ? `${plugin.commands.length} command${plugin.commands.length === 1 ? "" : "s"} (${plugin.commands.map((name) => `/${name}`).join(", ")})` : "",
                  plugin.mcpServers.length ? `${plugin.mcpServers.length} MCP server${plugin.mcpServers.length === 1 ? "" : "s"} (allow each under MCP & Skills)` : "",
                ].filter(Boolean).join(" · ") || "Nothing Saturn can use yet"}
                {` · from ${plugin.source}`}
              </span>
              {plugin.hooks.length ? (
                <div className="plugin-hooks">
                  <div className="hook-set-head">
                    <span className="settings-row-desc">{plugin.hooks.length} hook{plugin.hooks.length === 1 ? "" : "s"}</span>
                    <span className={plugin.hooksApproved ? "hook-state allowed" : "hook-state waiting"}>{plugin.hooksApproved ? "Allowed" : "Not running: needs your approval"}</span>
                    {!plugin.hooksApproved && plugin.enabled ? (
                      <button type="button" className="btn primary-btn tiny" disabled={busy !== null} onClick={() => void act(`hooks:${plugin.name}`, () => desktop.admin.approvePluginHooks(plugin.name, plugin.hooksFingerprint!))}>
                        Allow These Hooks
                      </button>
                    ) : null}
                  </div>
                  <ul className="permission-rules">
                    {plugin.hooks.map((hook, index) => (
                      <li key={index} className="permission-rule">
                        <span className="permission-effect hook">{hook.event.replace("_", " ")}</span>
                        {hook.event !== "stop" ? <code className="permission-tool">{hook.matcher || "any tool"}</code> : null}
                        <code className="permission-pattern" title={hook.command}>{hook.command}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          )) : <p className="settings-row-desc">No plugins installed.</p>}
        </div>
      </div>
    </div>
  );
}
