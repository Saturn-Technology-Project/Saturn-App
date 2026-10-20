import type { LaunchApp, LlmChoice, LlmProvider, LogLine, Mcp, Profile, RuntimeInfo, UsageSummary } from "../domain/model.js";
import type { RuntimeClient } from "../infrastructure/runtime-client.js";
import { userAction } from "../infrastructure/telemetry.js";

export type ConsoleSnapshot = {
  profile: Profile;
  information: RuntimeInfo;
  logs: LogLine[];
};

/** Local settings, logs, and model or MCP connections edited from Settings. */
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

  updateSettings(patch: { name?: string; environment?: string; logging?: string; launchApp?: LaunchApp; completionModelId?: string | null }): Promise<Profile> {
    return this.runtime.request<Profile>("/settings", { method: "PATCH", body: JSON.stringify(patch) });
  }

  providers(): Promise<LlmProvider[]> {
    return this.runtime.request<LlmProvider[]>("/llm/providers");
  }

  lmStudioModels(baseUrl: string): Promise<LlmChoice[]> {
    return this.runtime.request<LlmChoice[]>(`/llm/lmstudio/models?baseUrl=${encodeURIComponent(baseUrl)}`);
  }

  usageSummary(): Promise<UsageSummary> {
    return this.runtime.request<UsageSummary>("/usage/summary");
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
}
