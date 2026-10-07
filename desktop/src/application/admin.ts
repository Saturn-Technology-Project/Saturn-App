import type { Check, Key, LlmChoice, LlmProvider, LogLine, Mcp, Profile, RuntimeInfo } from "../domain/model.js";
import type { RuntimeClient } from "../infrastructure/runtime-client.js";

export type ConsoleSnapshot = {
  profile: Profile;
  keys: Key[];
  information: RuntimeInfo;
  logs: LogLine[];
  checks: Check[];
};

/** Local settings, keys, logs, and model or MCP connections edited from Settings. */
export class AdminService {
  constructor(private readonly runtime: RuntimeClient) {}

  async console(): Promise<ConsoleSnapshot> {
    const [profile, keys, information, logs, diagnostics] = await Promise.all([
      this.runtime.request<Profile>("/settings"),
      this.runtime.request<Key[]>("/keys"),
      this.runtime.request<RuntimeInfo>("/information"),
      this.runtime.request<LogLine[]>("/logs"),
      this.runtime.request<{ checks: Check[] }>("/diagnostics"),
    ]);
    return { profile, keys, information, logs, checks: diagnostics.checks };
  }

  updateSettings(patch: { name: string; environment: string; heartbeatSeconds: number; logging: string }): Promise<Profile> {
    return this.runtime.request<Profile>("/settings", { method: "PATCH", body: JSON.stringify(patch) });
  }

  createKey(input: { name: string; secretName: string; baseUrl: string; allowedPaths: string; value: string }): Promise<Key> {
    return this.runtime.request<Key>("/keys", { method: "POST", body: JSON.stringify(input) });
  }

  rotateKey(id: string, value: string): Promise<void> {
    return this.runtime.request(`/keys/${id}/secret`, { method: "PUT", body: JSON.stringify({ value }) });
  }

  clearKey(id: string): Promise<void> {
    return this.runtime.request(`/keys/${id}/secret`, { method: "DELETE" });
  }

  deleteKey(id: string): Promise<void> {
    return this.runtime.request(`/keys/${id}`, { method: "DELETE" });
  }

  providers(): Promise<LlmProvider[]> {
    return this.runtime.request<LlmProvider[]>("/llm/providers");
  }

  lmStudioModels(baseUrl: string): Promise<LlmChoice[]> {
    return this.runtime.request<LlmChoice[]>(`/llm/lmstudio/models?baseUrl=${encodeURIComponent(baseUrl)}`);
  }

  createModel(input: { provider: string; model: string; baseUrl?: string; secret?: string }): Promise<void> {
    return this.runtime.request("/connections/models", { method: "POST", body: JSON.stringify(input) });
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

  createRag(url: string): Promise<void> {
    return this.runtime.request("/connections/rag", { method: "POST", body: JSON.stringify({ name: "RAG", url }) });
  }
}
