import type { InstallRequest, MarketplaceEntry } from "../domain/model.js";
import type { RuntimeClient } from "../infrastructure/runtime-client.js";

/** Installs Customizations integrations as real MCP connections in the runtime. */
export class MarketplaceService {
  constructor(private readonly runtime: RuntimeClient) {}

  list(): Promise<MarketplaceEntry[]> {
    return this.runtime.request<MarketplaceEntry[]>("/marketplace");
  }

  /** Connects, starts browser sign-in when the provider needs it, discovers tools and attaches them to agents. */
  install(id: string, request: InstallRequest = {}): Promise<MarketplaceEntry> {
    return this.runtime.request<MarketplaceEntry>(`/marketplace/${id}/install`, { method: "POST", body: JSON.stringify(request) });
  }


  uninstall(id: string): Promise<void> {
    return this.runtime.request(`/marketplace/${id}`, { method: "DELETE" });
  }
}
