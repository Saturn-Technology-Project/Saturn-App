import { useEffect, useState } from "react";
import { desktop } from "../../application/desktop";
import type { Plugin } from "../../domain/model";
import { askToConfirm } from "../../infrastructure/confirm";
import { Badge } from "../ui/base/Badge.js";
import { Button } from "../ui/base/Button.js";
import { Input } from "../ui/base/Input.js";
import { RowDescription, RowLabel, RuleCode, RuleEffect, RuleForm, RuleItem, RuleList, SectionTitle, SettingsCard, SettingsRow } from "./Parts";

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
    <div className="flex max-w-[760px] flex-col gap-5">
      <div>
        <SectionTitle>Install a plugin</SectionTitle>
        <SettingsCard className="flex flex-col gap-2.5">
          <p className="m-0 text-xs text-muted-foreground">
            A plugin bundles skills, <code>/</code> commands, hooks and MCP servers in one folder with a <code>plugin.json</code>; Claude Code plugins (<code>.claude-plugin/plugin.json</code>) install as they are. Installing copies the folder, or clones the git repository, into Saturn and runs nothing: its hooks and local MCP servers each wait for your approval.
          </p>
          <RuleForm onSubmit={(event) => { event.preventDefault(); if (source.trim()) void act("install", async () => { await desktop.admin.installPlugin(source.trim()); setSource(""); }); }}>
            <Input className="w-auto flex-[1_1_260px] font-mono" aria-label="Plugin folder or git URL" placeholder="/path/to/plugin or https://github.com/owner/plugin" value={source} onChange={(event) => setSource(event.target.value)} />
            <Button type="button" variant="outline" onClick={() => void pickFolder()}>Choose Folder…</Button>
            <Button type="submit" disabled={busy !== null || !source.trim()}>{busy === "install" ? "Installing…" : "Install"}</Button>
          </RuleForm>
        </SettingsCard>
      </div>

      <div>
        <SectionTitle>Installed</SectionTitle>
        <SettingsCard>
          {plugins.length ? plugins.map((plugin) => (
            <SettingsRow stacked key={plugin.name}>
              <div className="flex flex-wrap items-center gap-2">
                <RowLabel className="min-w-0 flex-1">
                  {plugin.name}
                  {plugin.version ? <span className="text-xs font-normal text-muted-foreground"> {plugin.version}</span> : null}
                </RowLabel>
                <Button type="button" variant="outline" size="small" disabled={busy !== null} onClick={() => void act(`toggle:${plugin.name}`, () => desktop.admin.setPluginEnabled(plugin.name, !plugin.enabled))}>
                  {plugin.enabled ? "Turn Off" : "Turn On"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  className="text-muted-foreground hover:bg-destructive/12 hover:text-destructive"
                  disabled={busy !== null}
                  onClick={async () => {
                    if (await askToConfirm(`Remove ${plugin.name}? Its files and its MCP servers are removed.`)) void act(`remove:${plugin.name}`, () => desktop.admin.removePlugin(plugin.name));
                  }}
                >
                  Remove
                </Button>
              </div>
              {plugin.description ? <RowDescription>{plugin.description}</RowDescription> : null}
              <RowDescription>
                {plugin.enabled ? "" : "Off · "}
                {[
                  plugin.skills.length ? `${plugin.skills.length} skill${plugin.skills.length === 1 ? "" : "s"} (${plugin.skills.join(", ")})` : "",
                  plugin.commands.length ? `${plugin.commands.length} command${plugin.commands.length === 1 ? "" : "s"} (${plugin.commands.map((name) => `/${name}`).join(", ")})` : "",
                  plugin.mcpServers.length ? `${plugin.mcpServers.length} MCP server${plugin.mcpServers.length === 1 ? "" : "s"} (allow each under MCP & Skills)` : "",
                ].filter(Boolean).join(" · ") || "Nothing Saturn can use yet"}
                {` · from ${plugin.source}`}
              </RowDescription>
              {plugin.hooks.length ? (
                <div className="flex flex-col gap-1.5 pt-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <RowDescription>{plugin.hooks.length} hook{plugin.hooks.length === 1 ? "" : "s"}</RowDescription>
                    <Badge tone={plugin.hooksApproved ? "good" : "wait"}>{plugin.hooksApproved ? "Allowed" : "Not running: needs your approval"}</Badge>
                    {!plugin.hooksApproved && plugin.enabled ? (
                      <Button type="button" size="small" disabled={busy !== null} onClick={() => void act(`hooks:${plugin.name}`, () => desktop.admin.approvePluginHooks(plugin.name, plugin.hooksFingerprint!))}>
                        Allow These Hooks
                      </Button>
                    ) : null}
                  </div>
                  <RuleList>
                    {plugin.hooks.map((hook, index) => (
                      <RuleItem key={index}>
                        <RuleEffect kind="hook">{hook.event.replace("_", " ")}</RuleEffect>
                        {hook.event !== "stop" ? <RuleCode>{hook.matcher || "any tool"}</RuleCode> : null}
                        <RuleCode pattern title={hook.command}>{hook.command}</RuleCode>
                      </RuleItem>
                    ))}
                  </RuleList>
                </div>
              ) : null}
            </SettingsRow>
          )) : <RowDescription>No plugins installed.</RowDescription>}
        </SettingsCard>
      </div>
    </div>
  );
}
