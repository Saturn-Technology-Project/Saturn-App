import { useEffect, useState } from "react";
import { desktop } from "../../application/desktop";
import { t } from "../../domain/i18n";
import type { HookEvent, Plugin } from "../../domain/model";
import { askToConfirm } from "../../infrastructure/confirm";
import { Badge } from "../ui/base/Badge.js";
import { Button } from "../ui/base/Button.js";
import { Input } from "../ui/base/Input.js";
import { RowDescription, RowLabel, RuleCode, RuleEffect, RuleForm, RuleItem, RuleList, SectionTitle, SettingsCard, SettingsRow } from "./Parts";

/** Each event as its word on a hook's badge. */
const EVENT_WORDS: Record<HookEvent, string> = { pre_tool: t("pre tool"), post_tool: t("post tool"), stop: t("stop") };

/** Settings → Plugins: install from a folder or a git URL, turn on or off, allow a plugin's hooks, remove it. */
export function PluginsPage(props: { onError: (message: string) => void; onChanged?: () => void }) {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try {
      setPlugins(await desktop.admin.plugins());
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : t("Could not load plugins"));
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
      props.onError(reason instanceof Error ? reason.message : t("Something went wrong"));
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
        <SectionTitle>{t("Install a plugin")}</SectionTitle>
        <SettingsCard className="flex flex-col gap-2.5">
          <p className="m-0 text-xs text-muted-foreground">
            {t("A plugin bundles skills, slash commands, hooks and MCP servers in one folder with a plugin.json; Claude Code plugins (.claude-plugin/plugin.json) install as they are. Installing copies the folder, or clones the git repository, into Saturn and runs nothing: its hooks and local MCP servers each wait for your approval.")}
          </p>
          <RuleForm onSubmit={(event) => { event.preventDefault(); if (source.trim()) void act("install", async () => { await desktop.admin.installPlugin(source.trim()); setSource(""); }); }}>
            <Input className="w-auto flex-[1_1_260px] font-mono" aria-label={t("Plugin folder or git URL")} placeholder={t("/path/to/plugin or https://github.com/owner/plugin")} value={source} onChange={(event) => setSource(event.target.value)} />
            <Button type="button" variant="outline" onClick={() => void pickFolder()}>{t("Choose Folder…")}</Button>
            <Button type="submit" disabled={busy !== null || !source.trim()}>{busy === "install" ? t("Installing…") : t("Install")}</Button>
          </RuleForm>
        </SettingsCard>
      </div>

      <div>
        <SectionTitle>{t("Installed")}</SectionTitle>
        <SettingsCard>
          {plugins.length ? plugins.map((plugin) => (
            <SettingsRow stacked key={plugin.name}>
              <div className="flex flex-wrap items-center gap-2">
                <RowLabel className="min-w-0 flex-1">
                  {plugin.name}
                  {plugin.version ? <span className="text-xs font-normal text-muted-foreground"> {plugin.version}</span> : null}
                </RowLabel>
                <Button type="button" variant="outline" size="small" disabled={busy !== null} onClick={() => void act(`toggle:${plugin.name}`, () => desktop.admin.setPluginEnabled(plugin.name, !plugin.enabled))}>
                  {plugin.enabled ? t("Turn Off") : t("Turn On")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  className="text-muted-foreground hover:bg-destructive/12 hover:text-destructive"
                  disabled={busy !== null}
                  onClick={async () => {
                    if (await askToConfirm(t("Remove {name}? Its files and its MCP servers are removed.", { name: plugin.name }))) void act(`remove:${plugin.name}`, () => desktop.admin.removePlugin(plugin.name));
                  }}
                >
                  {t("Remove")}
                </Button>
              </div>
              {plugin.description ? <RowDescription>{plugin.description}</RowDescription> : null}
              <RowDescription>
                {plugin.enabled ? "" : `${t("Off")} · `}
                {[
                  plugin.skills.length ? `${plugin.skills.length === 1 ? t("1 skill") : t("{count} skills", { count: plugin.skills.length })} (${plugin.skills.join(", ")})` : "",
                  plugin.commands.length ? `${plugin.commands.length === 1 ? t("1 command") : t("{count} commands", { count: plugin.commands.length })} (${plugin.commands.map((name) => `/${name}`).join(", ")})` : "",
                  plugin.mcpServers.length ? (plugin.mcpServers.length === 1 ? t("1 MCP server (allow it under MCP & Skills)") : t("{count} MCP servers (allow each under MCP & Skills)", { count: plugin.mcpServers.length })) : "",
                ].filter(Boolean).join(" · ") || t("Nothing Saturn can use yet")}
                {` · ${t("from {source}", { source: plugin.source })}`}
              </RowDescription>
              {plugin.hooks.length ? (
                <div className="flex flex-col gap-1.5 pt-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <RowDescription>{plugin.hooks.length === 1 ? t("1 hook") : t("{count} hooks", { count: plugin.hooks.length })}</RowDescription>
                    <Badge tone={plugin.hooksApproved ? "good" : "wait"}>{plugin.hooksApproved ? t("Allowed") : t("Not running: needs your approval")}</Badge>
                    {!plugin.hooksApproved && plugin.enabled ? (
                      <Button type="button" size="small" disabled={busy !== null} onClick={() => void act(`hooks:${plugin.name}`, () => desktop.admin.approvePluginHooks(plugin.name, plugin.hooksFingerprint!))}>
                        {t("Allow These Hooks")}
                      </Button>
                    ) : null}
                  </div>
                  <RuleList>
                    {plugin.hooks.map((hook, index) => (
                      <RuleItem key={index}>
                        <RuleEffect kind="hook">{EVENT_WORDS[hook.event] ?? hook.event}</RuleEffect>
                        {hook.event !== "stop" ? <RuleCode>{hook.matcher || t("any tool")}</RuleCode> : null}
                        <RuleCode pattern title={hook.command}>{hook.command}</RuleCode>
                      </RuleItem>
                    ))}
                  </RuleList>
                </div>
              ) : null}
            </SettingsRow>
          )) : <RowDescription>{t("No plugins installed.")}</RowDescription>}
        </SettingsCard>
      </div>
    </div>
  );
}
