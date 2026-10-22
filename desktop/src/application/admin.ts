import type { AgentBrowser, LaunchApp, LlmChoice, LlmProvider, LogLine, Mcp, CliStatus, Hook, HookSet, PermissionLayer, Plugin, PermissionRule, PermissionScope, Profile, RuntimeInfo, SandboxSettings, UsageSummary, EmbeddingSource } from "../domain/model.js";
import type { RuntimeClient } from "../infrastructure/runtime-client.js";
import { userAction } from "../infrastructure/telemetry.js";

export type ConsoleSnapshot = {
  profile: Profile;
  information: RuntimeInfo;
  logs: LogLine[];
};

/** Local settings, logs, and model or MCP connections edited from Settings. */
export type CodexStatus = {
  loggedIn: boolean;
  authMethod: string;
  configDir: string;
  signIn?: { mode: "device" | "browser"; state: "starting" | "waiting" | "failed"; url?: string; code?: string; error?: string };
  error?: string;
};

/** Claude Code or Codex: whether it is installed, where from, and a download in progress. */
export type ProgramStatus = {
  id: "claude-code" | "codex";
  label: string;
  installed: boolean;
  source: "saturn" | "bundled" | "system" | null;
  path: string | null;
  version: string | null;
  downloadVersion: string | null;
  downloadSize: number;
  install?: { state: "downloading" | "verifying" | "unpacking" | "done" | "failed"; received: number; total: number; error?: string };
};

export class AdminService {
  constructor(private readonly runtime: RuntimeClient) {}

  async console(): Promise<ConsoleSnapshot> {
    const [profile, information, logs] = await Promise.all([
      this.runtime.request<Profile>("/settings"),
      this.runtime.request<RuntimeInfo>("/information"),
      this.runtime.request<LogLine[]>("/logs"),
    ]);
    return { profile, information, logs };
  }

  program(id: ProgramStatus["id"]): Promise<ProgramStatus> {
    return this.runtime.request(`/programs/${id}`);
  }

  /** Starts downloading Saturn's tested copy of the program; the status reports progress. */
  installProgram(id: ProgramStatus["id"]): Promise<ProgramStatus> {
    return userAction("program.install", { "saturn.program": id }, () => this.runtime.request<ProgramStatus>(`/programs/${id}/install`, { method: "POST" }));
  }

  removeProgram(id: ProgramStatus["id"]): Promise<ProgramStatus> {
    return this.runtime.request(`/programs/${id}`, { method: "DELETE" });
  }

  /** Claude Code's login, as the official `claude` program reports it; Saturn never handles the credential. */
  claudeCodeStatus(): Promise<{ loggedIn: boolean; authMethod: string; email?: string; subscriptionType?: string; loginCommand: string; configDir: string; error?: string }> {
    return this.runtime.request("/claude-code/status");
  }

  /** Signs Saturn's Claude Code out through the official program; returns the new status. */
  claudeCodeLogout(): Promise<Awaited<ReturnType<AdminService["claudeCodeStatus"]>>> {
    return this.runtime.request("/claude-code/logout", { method: "POST" });
  }

  /** Codex's login, as the official `codex` program reports it, plus any sign-in in progress. */
  codexStatus(): Promise<CodexStatus> {
    return this.runtime.request("/codex/status");
  }

  /** Starts the official `codex login`: "device" shows a one-time code; "browser" opens the sign-in page. */
  codexSignIn(mode: "device" | "browser"): Promise<CodexStatus> {
    return this.runtime.request("/codex/sign-in", { method: "POST", body: JSON.stringify({ mode }) });
  }

  /** Opens the page Codex printed for the sign-in in progress in the default browser. */
  codexOpenPage(): Promise<{ opened: boolean }> {
    return this.runtime.request("/codex/sign-in/open", { method: "POST" });
  }

  codexCancelSignIn(): Promise<CodexStatus> {
    return this.runtime.request("/codex/sign-in", { method: "DELETE" });
  }

  codexLogout(): Promise<CodexStatus> {
    return this.runtime.request("/codex/logout", { method: "POST" });
  }

  /** Saturn's notes about the user (scope "global") or a project (its id), as editable text. */
  memory(scope: string): Promise<{ scope: string; content: string }> {
    return this.runtime.request(`/memory/${encodeURIComponent(scope)}`);
  }

  saveMemory(scope: string, content: string): Promise<{ scope: string; content: string }> {
    return this.runtime.request(`/memory/${encodeURIComponent(scope)}`, { method: "PUT", body: JSON.stringify({ content }) });
  }

  updateSettings(patch: { name?: string; environment?: string; logging?: string; launchApp?: LaunchApp; completionModelId?: string | null; memory?: boolean; planApproval?: boolean; embeddingSource?: EmbeddingSource; embeddingModel?: string; embeddingConnectionId?: string; onboardedAt?: string | null; sandbox?: SandboxSettings | null; claudeProjectSettings?: boolean; browser?: AgentBrowser }): Promise<Profile> {
    return this.runtime.request<Profile>("/settings", { method: "PATCH", body: JSON.stringify(patch) });
  }

  /** The permission layers that apply to an agent in a project (both optional). */
  permissions(target: { projectId?: string; agentId?: string } = {}): Promise<PermissionLayer[]> {
    const query = new URLSearchParams();
    if (target.projectId) query.set("projectId", target.projectId);
    if (target.agentId) query.set("agentId", target.agentId);
    const suffix = query.toString();
    return this.runtime.request<PermissionLayer[]>(`/permissions${suffix ? `?${suffix}` : ""}`);
  }

  addPermissionRule(scope: PermissionScope, rule: PermissionRule, target: { projectId?: string; agentId?: string } = {}): Promise<PermissionLayer[]> {
    return this.runtime.request<PermissionLayer[]>("/permissions/rules", { method: "POST", body: JSON.stringify({ scope, rule, ...target }) });
  }

  removePermissionRule(scope: PermissionScope, rule: PermissionRule, target: { projectId?: string; agentId?: string } = {}): Promise<PermissionLayer[]> {
    return this.runtime.request<PermissionLayer[]>("/permissions/rules", { method: "DELETE", body: JSON.stringify({ scope, rule, ...target }) });
  }

  /** The user's hooks, and a project's file hooks with whether each set is allowed. */
  hooks(projectId?: string): Promise<HookSet[]> {
    return this.runtime.request<HookSet[]>(`/hooks${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
  }

  setUserHooks(hooks: Hook[]): Promise<HookSet[]> {
    return this.runtime.request<HookSet[]>("/hooks", { method: "PUT", body: JSON.stringify({ hooks }) });
  }

  /** Allows a project file's allow rules: the exact set the user saw, named by its fingerprint. */
  approvePermissionFile(projectId: string, file: string, fingerprint: string): Promise<PermissionLayer[]> {
    return this.runtime.request<PermissionLayer[]>(`/projects/${encodeURIComponent(projectId)}/permissions/approve`, { method: "POST", body: JSON.stringify({ file, fingerprint }) });
  }

  revokePermissionFile(projectId: string, file: string): Promise<PermissionLayer[]> {
    return this.runtime.request<PermissionLayer[]>(`/projects/${encodeURIComponent(projectId)}/permissions/approve`, { method: "DELETE", body: JSON.stringify({ file }) });
  }

  approveHooks(projectId: string, file: string, fingerprint: string): Promise<HookSet[]> {
    return this.runtime.request<HookSet[]>(`/projects/${encodeURIComponent(projectId)}/hooks/approve`, { method: "POST", body: JSON.stringify({ file, fingerprint }) });
  }

  revokeHooks(projectId: string, file: string): Promise<HookSet[]> {
    return this.runtime.request<HookSet[]>(`/projects/${encodeURIComponent(projectId)}/hooks/approve`, { method: "DELETE", body: JSON.stringify({ file }) });
  }

  /** The `saturn` command's launcher in ~/.local/bin: installed, current, and whether that folder is on PATH. */
  cliStatus(): Promise<CliStatus> {
    return this.runtime.request<CliStatus>("/cli");
  }

  installCli(): Promise<CliStatus> {
    return this.runtime.request<CliStatus>("/cli/install", { method: "POST" });
  }

  plugins(): Promise<Plugin[]> {
    return this.runtime.request<Plugin[]>("/plugins");
  }

  installPlugin(source: string): Promise<Plugin> {
    return this.runtime.request<Plugin>("/plugins", { method: "POST", body: JSON.stringify({ source }) });
  }

  setPluginEnabled(name: string, enabled: boolean): Promise<Plugin> {
    return this.runtime.request<Plugin>(`/plugins/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
  }

  approvePluginHooks(name: string, fingerprint: string): Promise<Plugin> {
    return this.runtime.request<Plugin>(`/plugins/${encodeURIComponent(name)}/hooks/approve`, { method: "POST", body: JSON.stringify({ fingerprint }) });
  }

  removePlugin(name: string): Promise<void> {
    return this.runtime.request<void>(`/plugins/${encodeURIComponent(name)}`, { method: "DELETE" });
  }

  providers(): Promise<LlmProvider[]> {
    return this.runtime.request<LlmProvider[]>("/llm/providers");
  }

  lmStudioModels(baseUrl: string): Promise<LlmChoice[]> {
    return this.runtime.request<LlmChoice[]>(`/llm/lmstudio/models?baseUrl=${encodeURIComponent(baseUrl)}`);
  }

  /** Totals for calls made at or after `from` and before `to` (ISO times); leave both out for all time. */
  usageSummary(range: { from?: string; to?: string } = {}): Promise<UsageSummary> {
    const query = new URLSearchParams();
    if (range.from) query.set("from", range.from);
    if (range.to) query.set("to", range.to);
    const suffix = query.toString();
    return this.runtime.request<UsageSummary>(`/usage/summary${suffix ? `?${suffix}` : ""}`);
  }

  createModel(input: { provider: string; model: string; baseUrl?: string; secret?: string; effort?: string }): Promise<void> {
    const attributes = { "gen_ai.provider.name": input.provider, "gen_ai.request.model": input.model };
    return userAction("ui.connect_model", attributes, () =>
      this.runtime.request("/connections/models", { method: "POST", body: JSON.stringify(input) }),
    );
  }

  updateModelKey(id: string, secret: string): Promise<void> {
    return userAction("ui.save_model_key", { "saturn.model.id": id }, () =>
      this.runtime.request(`/connections/models/${id}`, { method: "PATCH", body: JSON.stringify({ secret }) }),
    );
  }

  /** Sets a model connection's reasoning effort; null returns it to the model's default. */
  updateModelEffort(id: string, effort: string | null): Promise<void> {
    return this.runtime.request(`/connections/models/${id}`, { method: "PATCH", body: JSON.stringify({ effort }) });
  }

  deleteModel(id: string): Promise<void> {
    return this.runtime.request(`/connections/models/${id}`, { method: "DELETE" });
  }

  createMcp(url: string): Promise<Mcp> {
    return this.runtime.request<Mcp>("/connections/mcp", { method: "POST", body: JSON.stringify({ name: "MCP", url }) });
  }

  /** Adds a local (stdio) MCP server. It does not start until approveMcp allows its exact command. */
  createLocalMcp(input: { name: string; program: string; args: string[]; env: Record<string, string> }): Promise<Mcp> {
    return this.runtime.request<Mcp>("/connections/mcp", { method: "POST", body: JSON.stringify({ name: input.name, command: { program: input.program, args: input.args, env: input.env } }) });
  }

  /** Allows a local server to run the command the user was shown (by its fingerprint). */
  approveMcp(id: string, fingerprint: string): Promise<Mcp> {
    return this.runtime.request<Mcp>(`/connections/mcp/${id}/approve`, { method: "POST", body: JSON.stringify({ fingerprint }) });
  }

  discoverMcp(id: string): Promise<void> {
    return this.runtime.request(`/connections/mcp/${id}/discover`, { method: "POST" });
  }

  deleteMcp(id: string): Promise<void> {
    return this.runtime.request(`/mcp/${id}`, { method: "DELETE" });
  }

  updateMcp(id: string, patch: { name?: string; url?: string; disabledTools?: string[] }): Promise<Mcp> {
    return this.runtime.request<Mcp>(`/connections/mcp/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
  }

  createRag(url: string): Promise<void> {
    return this.runtime.request("/connections/rag", { method: "POST", body: JSON.stringify({ name: "RAG", url }) });
  }

  /** Whether this computer lets Saturn control it (macOS Accessibility and Screen Recording). */
  computerPermissions(): Promise<{ platform: string; required: boolean; accessibility: boolean; screenRecording: boolean; error?: string }> {
    return this.runtime.request("/computer/permissions");
  }

  /** The private snapshots Saturn keeps of project folders outside git, with their size on disk. */
  snapshotStorage(): Promise<{ folders: { id: string; folder: string | null; bytes: number }[]; bytes: number }> {
    return this.runtime.request("/storage/snapshots");
  }

  /** Deletes one folder's snapshots, or all of them. */
  deleteSnapshots(id?: string): Promise<{ deleted: boolean }> {
    return this.runtime.request(id ? `/storage/snapshots/${encodeURIComponent(id)}` : "/storage/snapshots", { method: "DELETE" });
  }

  /** Opens the System Settings pane where the user grants one of those permissions. */
  openPermissionPane(which: "accessibility" | "screenRecording"): Promise<{ ok: boolean }> {
    return this.runtime.request("/computer/permissions/open", { method: "POST", body: JSON.stringify({ which }) });
  }

}
