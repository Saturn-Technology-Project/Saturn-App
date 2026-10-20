import type { LaunchApp, LlmChoice, LlmProvider, LogLine, Mcp, Profile, RuntimeInfo, UsageSummary, EmbeddingSource } from "../domain/model.js";
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

  updateSettings(patch: { name?: string; environment?: string; logging?: string; launchApp?: LaunchApp; completionModelId?: string | null; memory?: boolean; planApproval?: boolean; embeddingSource?: EmbeddingSource; embeddingModel?: string; embeddingConnectionId?: string; onboardedAt?: string | null }): Promise<Profile> {
    return this.runtime.request<Profile>("/settings", { method: "PATCH", body: JSON.stringify(patch) });
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

  /** Opens the System Settings pane where the user grants one of those permissions. */
  openPermissionPane(which: "accessibility" | "screenRecording"): Promise<{ ok: boolean }> {
    return this.runtime.request("/computer/permissions/open", { method: "POST", body: JSON.stringify({ which }) });
  }

}
