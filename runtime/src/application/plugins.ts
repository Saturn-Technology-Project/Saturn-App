import { execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { HttpError } from "../domain/errors.js";
import { fromClaudeHooks, hooksFingerprint, isHook, type Hook } from "./hooks.js";
import type { RuntimeKernel } from "./kernel.js";

const run = promisify(execFile);

/**
 * Plugins: a folder that bundles skills, prompt commands, hooks and MCP servers, installed once and turned on or
 * off as a unit. The layout is Claude Code's, so its plugins install as they are:
 *
 *   plugin.json (or .claude-plugin/plugin.json)   name, description, version, and optional `mcpServers`
 *   skills/<name>/SKILL.md                         skills, offered in every chat while the plugin is on
 *   commands/<name>.md                             "/" commands
 *   hooks/hooks.json (or `hooks` in plugin.json)   Saturn's `{ "hooks": [...] }` or Claude Code's event map
 *   .mcp.json (or `mcpServers` in plugin.json)     MCP servers: a command (stdio) or a url
 *
 * Plugins are copied (a local folder) or cloned (a git URL, no hooks or submodules run) into ~/.saturn-app/plugins.
 * Installing runs nothing: the plugin's hooks wait for the user's approval of that exact set, and its local MCP
 * servers are added as connections that wait for the usual per-command approval.
 */

export type PluginRecord = { name: string; source: string; installedAt: string; enabled: boolean; version?: string; approvedHooks?: string };

export type PluginView = PluginRecord & {
  description: string;
  path: string;
  skills: string[];
  commands: string[];
  hooks: Hook[];
  hooksFingerprint?: string;
  hooksApproved: boolean;
  mcpServers: { name: string; id?: string; kind: "command" | "url" }[];
};

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

type Manifest = { name?: unknown; description?: unknown; version?: unknown; mcpServers?: unknown; hooks?: unknown };

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function isDir(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isDirectory();
  } catch {
    return false;
  }
}

/** A plugin folder's manifest: plugin.json, or Claude Code's .claude-plugin/plugin.json. */
export async function readManifest(folder: string): Promise<Manifest | undefined> {
  return (await readJson(path.join(folder, "plugin.json"))) ?? (await readJson(path.join(folder, ".claude-plugin", "plugin.json")));
}

/** The plugin's hooks: Saturn's list or Claude Code's event map, from hooks/hooks.json or the manifest. */
export async function pluginHooks(folder: string, manifest: Manifest): Promise<Hook[]> {
  const file = (await readJson(path.join(folder, "hooks", "hooks.json")))?.hooks ?? manifest.hooks;
  if (Array.isArray(file)) return file.filter(isHook);
  return fromClaudeHooks(file).map((hook) => ({ ...hook, command: hook.command.split("${CLAUDE_PLUGIN_ROOT}").join(folder) }));
}

/** The plugin's MCP servers: `mcpServers` in .mcp.json or the manifest, as Claude Code writes them. */
export async function pluginMcpServers(folder: string, manifest: Manifest): Promise<{ name: string; command?: { program: string; args: string[]; env: Record<string, string> }; url?: string }[]> {
  const map = ((await readJson(path.join(folder, ".mcp.json")))?.mcpServers ?? manifest.mcpServers ?? {}) as Record<string, { command?: unknown; args?: unknown; env?: unknown; url?: unknown }>;
  const servers: { name: string; command?: { program: string; args: string[]; env: Record<string, string> }; url?: string }[] = [];
  for (const [name, spec] of Object.entries(map)) {
    const expand = (text: string) => text.split("${CLAUDE_PLUGIN_ROOT}").join(folder);
    if (typeof spec?.command === "string") {
      const env = spec.env && typeof spec.env === "object" ? Object.fromEntries(Object.entries(spec.env as Record<string, unknown>).filter(([, value]) => typeof value === "string").map(([key, value]) => [key, expand(value as string)])) : {};
      servers.push({ name, command: { program: expand(spec.command), args: Array.isArray(spec.args) ? spec.args.filter((arg): arg is string => typeof arg === "string").map(expand) : [], env } });
    } else if (typeof spec?.url === "string") {
      servers.push({ name, url: spec.url });
    }
  }
  return servers;
}

async function listNames(dir: string, file: (name: string) => string | undefined): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((entry) => file(entry.isDirectory() ? `${entry.name}/` : entry.name)).filter((name): name is string => Boolean(name)).sort();
  } catch {
    return [];
  }
}

export class PluginService {
  constructor(private readonly kernel: RuntimeKernel) {}

  dir(): string {
    return path.join(this.kernel.store.root, "plugins");
  }

  private records(): PluginRecord[] {
    return this.kernel.store.state.settings.plugins ?? [];
  }

  /** The folders of the plugins that are on: where skills and commands are read from. */
  enabledFolders(): string[] {
    return this.records().filter((record) => record.enabled).map((record) => path.join(this.dir(), record.name));
  }

  async view(record: PluginRecord): Promise<PluginView> {
    const folder = path.join(this.dir(), record.name);
    const manifest = (await readManifest(folder)) ?? {};
    const hooks = await pluginHooks(folder, manifest);
    const fingerprint = hooks.length ? hooksFingerprint(hooks) : undefined;
    const servers = await pluginMcpServers(folder, manifest);
    return {
      ...record,
      description: typeof manifest.description === "string" ? manifest.description : "",
      path: folder,
      skills: await listNames(path.join(folder, "skills"), (name) => (name.endsWith("/") ? name.slice(0, -1) : undefined)),
      commands: await listNames(path.join(folder, "commands"), (name) => (name.endsWith(".md") ? name.slice(0, -3) : undefined)),
      hooks,
      ...(fingerprint ? { hooksFingerprint: fingerprint } : {}),
      hooksApproved: Boolean(fingerprint) && record.approvedHooks === fingerprint,
      mcpServers: servers.map((server) => ({
        name: server.name,
        kind: server.command ? ("command" as const) : ("url" as const),
        ...(this.kernel.store.state.mcp.find((item) => item.pluginName === record.name && item.name === `${record.name}: ${server.name}`) ? { id: this.kernel.store.state.mcp.find((item) => item.pluginName === record.name && item.name === `${record.name}: ${server.name}`)!.id } : {}),
      })),
    };
  }

  async list(): Promise<PluginView[]> {
    return Promise.all(this.records().map((record) => this.view(record)));
  }

  /** Installs from a local folder (copied) or a git URL (cloned shallowly, with no hooks and no submodules). */
  async install(source: string): Promise<PluginView> {
    const from = source.trim();
    if (!from) throw new HttpError(400, "Give a folder or a git URL");
    const staging = path.join(this.dir(), `.staging-${Date.now()}`);
    await mkdir(this.dir(), { recursive: true });
    try {
      if (/^(https:\/\/|git@|ssh:\/\/)/.test(from)) {
        await run("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", "clone", "--depth", "1", "--no-recurse-submodules", from, staging], { timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
        await rm(path.join(staging, ".git"), { recursive: true, force: true });
      } else if (path.isAbsolute(from) && (await isDir(from))) {
        await cp(from, staging, { recursive: true, filter: (file) => !file.split(path.sep).includes(".git") && !file.split(path.sep).includes("node_modules") });
      } else {
        throw new HttpError(400, "A plugin comes from an absolute folder path or an https/ssh git URL");
      }
      const manifest = await readManifest(staging);
      if (!manifest) throw new HttpError(400, "No plugin.json (or .claude-plugin/plugin.json) in that folder");
      const name = typeof manifest.name === "string" ? manifest.name.trim().toLowerCase() : "";
      if (!NAME.test(name)) throw new HttpError(400, "plugin.json needs a name: lowercase letters, digits, dashes or underscores");
      if (this.records().some((record) => record.name === name)) throw new HttpError(409, `A plugin named ${name} is installed already; remove it first to reinstall`);
      await rm(path.join(this.dir(), name), { recursive: true, force: true });
      await cp(staging, path.join(this.dir(), name), { recursive: true });
      const record: PluginRecord = { name, source: from, installedAt: new Date().toISOString(), enabled: true, ...(typeof manifest.version === "string" ? { version: manifest.version } : {}) };
      await this.kernel.store.update((state) => {
        state.settings.plugins = [...(state.settings.plugins ?? []), record];
      });
      await this.syncMcp(record);
      this.kernel.log("runtime", "info", `Plugin ${name} installed from ${from}`);
      return this.view(this.records().find((item) => item.name === name)!);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, `Could not install the plugin: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async setEnabled(name: string, enabled: boolean): Promise<PluginView> {
    const record = this.find(name);
    await this.kernel.store.update((state) => {
      const item = (state.settings.plugins ?? []).find((entry) => entry.name === name);
      if (item) item.enabled = enabled;
    });
    await this.syncMcp({ ...record, enabled });
    return this.view(this.find(name));
  }

  async approveHooks(name: string, fingerprint: string): Promise<PluginView> {
    const view = await this.view(this.find(name));
    if (!view.hooksFingerprint) throw new HttpError(400, `${name} has no hooks`);
    if (view.hooksFingerprint !== fingerprint) throw new HttpError(409, `The hooks of ${name} changed since you looked; review them again.`);
    await this.kernel.store.update((state) => {
      const item = (state.settings.plugins ?? []).find((entry) => entry.name === name);
      if (item) item.approvedHooks = fingerprint;
    });
    this.kernel.log("runtime", "info", `Hooks of the plugin ${name} allowed (${view.hooks.length})`);
    return this.view(this.find(name));
  }

  async uninstall(name: string): Promise<void> {
    this.find(name);
    for (const server of this.kernel.store.state.mcp.filter((item) => item.pluginName === name)) await this.kernel.catalog.deleteMcpServer(server.id);
    await this.kernel.store.update((state) => {
      state.settings.plugins = (state.settings.plugins ?? []).filter((entry) => entry.name !== name);
    });
    await rm(path.join(this.dir(), name), { recursive: true, force: true });
    this.kernel.log("runtime", "info", `Plugin ${name} removed`);
  }

  /** The hook sets of the plugins that are on, approved or not (HookService runs the approved ones). */
  async hookSets(): Promise<{ name: string; hooks: Hook[]; fingerprint: string; approved: boolean }[]> {
    const sets: { name: string; hooks: Hook[]; fingerprint: string; approved: boolean }[] = [];
    for (const record of this.records().filter((item) => item.enabled)) {
      const view = await this.view(record);
      if (view.hooks.length && view.hooksFingerprint) sets.push({ name: record.name, hooks: view.hooks, fingerprint: view.hooksFingerprint, approved: view.hooksApproved });
    }
    return sets;
  }

  /** A plugin that is on has its MCP servers as connections (local ones still wait for approval); off removes them. */
  private async syncMcp(record: PluginRecord): Promise<void> {
    const existing = this.kernel.store.state.mcp.filter((item) => item.pluginName === record.name);
    if (!record.enabled) {
      for (const server of existing) await this.kernel.catalog.deleteMcpServer(server.id);
      return;
    }
    const folder = path.join(this.dir(), record.name);
    for (const server of await pluginMcpServers(folder, (await readManifest(folder)) ?? {})) {
      const name = `${record.name}: ${server.name}`;
      if (existing.some((item) => item.name === name)) continue;
      try {
        const created = (await this.kernel.catalog.createMcp(server.command ? { name, command: server.command } : { name, url: server.url })) as { id: string };
        await this.kernel.store.update((state) => {
          const item = state.mcp.find((entry) => entry.id === created.id);
          if (item) item.pluginName = record.name;
        });
      } catch (error) {
        this.kernel.log("runtime", "warning", `Plugin ${record.name}: MCP server ${server.name} not added: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private find(name: string): PluginRecord {
    const record = this.records().find((item) => item.name === name);
    if (!record) throw new HttpError(404, `No plugin named ${name}`);
    return record;
  }
}
