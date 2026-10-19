import { HttpError } from "../domain/errors.js";
import { INSTALL_RECIPES, installRecipe, marketplaceConnectionId, type InstallRecipe } from "../domain/marketplace.js";
import type { McpConnection } from "../domain/model.js";
import { AuthorizationRequired } from "../infrastructure/mcp.js";
import { errorText } from "../infrastructure/logger.js";
import type { RuntimeKernel } from "./kernel.js";

export type InstallInput = {
  /** The product name shown in Customizations, used for the MCP connection. */
  name?: string;
  /** Bearer token for "token" integrations. */
  token?: string;
  /** OAuth client for "oauth-client" integrations (or GitHub without a token). */
  clientId?: string;
  clientSecret?: string;
  /** Attach the server to every agent (default) or to none. */
  attach?: "all" | "none";
};

export type MarketplaceEntry = {
  id: string;
  available: boolean;
  reason?: string;
  auth?: InstallRecipe["auth"];
  setupUrl?: string;
  setupHint?: string;
  tokenAlternative?: boolean;
  installed: null | {
    connectionId: string;
    status: NonNullable<McpConnection["status"]>;
    detail?: string;
    authorizationUrl?: string;
    tools: number;
    agents: number;
  };
};

/**
 * Installs Customizations integrations as real MCP connections: saves any credential, connects
 * (sending the browser to sign in when needed), discovers the tools and attaches them to agents.
 */
export class MarketplaceService {
  constructor(private readonly kernel: RuntimeKernel) {}

  list(): MarketplaceEntry[] {
    return INSTALL_RECIPES.map((recipe) => {
      const connection = this.connection(recipe.id);
      return {
        id: recipe.id,
        available: !recipe.unavailable,
        ...(recipe.unavailable ? { reason: recipe.unavailable } : {}),
        auth: recipe.auth,
        setupUrl: recipe.setupUrl,
        setupHint: recipe.setupHint,
        tokenAlternative: recipe.tokenAlternative,
        installed: connection
          ? {
              connectionId: connection.id,
              status: connection.status ?? "ready",
              detail: connection.statusDetail,
              authorizationUrl: connection.authorizationUrl,
              tools: connection.tools.length,
              agents: this.kernel.store.state.agents.filter((agent) => agent.mcpConnectionIds.includes(connection.id)).length,
            }
          : null,
      };
    });
  }

  /** One click: create the connection, connect (or start sign-in), discover tools, attach to agents. */
  async install(id: string, input: InstallInput = {}): Promise<MarketplaceEntry> {
    const recipe = installRecipe(id);
    if (!recipe) throw new HttpError(404, "Unknown integration");
    if (recipe.unavailable || !recipe.url) throw new HttpError(409, recipe.unavailable ?? "Not installable");
    const connectionId = marketplaceConnectionId(id);
    const token = input.token?.trim();
    const auth: McpConnection["auth"] = recipe.auth === "none" ? "none" : recipe.auth === "token" && token ? "token" : "oauth";
    if (recipe.auth === "token" && !token && !input.clientId?.trim()) {
      throw new HttpError(400, recipe.tokenAlternative ? "Paste a token, or an OAuth client ID" : "Paste a token");
    }
    if (recipe.auth === "oauth-client" && !input.clientId?.trim() && !this.kernel.store.secret(`mcp:${connectionId}:client`)) {
      throw new HttpError(400, "Paste the OAuth client ID you created with the provider");
    }

    const name = input.name?.trim() || this.kernel.store.state.mcp.find((item) => item.id === connectionId)?.name || displayName(id);
    await this.kernel.store.update((state) => {
      const existing = state.mcp.find((item) => item.id === connectionId);
      const next: McpConnection = {
        ...(existing ?? { id: connectionId, tools: [] }),
        name,
        url: recipe.url!,
        auth,
        marketplaceId: id,
        status: "connecting",
        statusDetail: undefined,
        authorizationUrl: undefined,
      };
      state.mcp = existing ? state.mcp.map((item) => (item.id === connectionId ? next : item)) : [...state.mcp, next];
    });
    if (token) await this.kernel.mcp.saveToken(connectionId, token);
    if (input.clientId?.trim()) await this.kernel.mcp.saveOAuthClient(connectionId, input.clientId, input.clientSecret);
    this.kernel.log("marketplace", "info", `Installing ${name} (${auth === "oauth" ? "browser sign-in" : auth === "token" ? "token" : "no sign-in"})`);

    try {
      await this.kernel.mcp.connect({ id: connectionId, url: recipe.url, auth });
    } catch (error) {
      if (error instanceof AuthorizationRequired) {
        await this.setStatus(connectionId, { status: "signing_in", authorizationUrl: error.authorizationUrl });
        this.kernel.log("marketplace", "info", `${name}: waiting for sign-in in the browser`);
        return this.entry(id);
      }
      await this.setStatus(connectionId, { status: "error", statusDetail: errorText(error) });
      this.kernel.log("marketplace", "warning", `${name} could not connect: ${errorText(error)}`);
      return this.entry(id);
    }
    await this.finish(connectionId, input.attach ?? "all");
    return this.entry(id);
  }

  /** Called by the OAuth redirect: finish sign-in, then discover tools and attach. */
  async completeSignIn(state: string, code: string): Promise<string> {
    const target = await this.kernel.mcp.finishSignIn(state, code);
    await this.finish(target.id, "all");
    return this.kernel.store.state.mcp.find((item) => item.id === target.id)?.name ?? "the integration";
  }

  async uninstall(id: string): Promise<void> {
    const connectionId = marketplaceConnectionId(id);
    const connection = this.connection(id);
    if (!connection) return;
    await this.kernel.store.update((state) => {
      state.mcp = state.mcp.filter((item) => item.id !== connectionId);
      for (const agent of state.agents) agent.mcpConnectionIds = agent.mcpConnectionIds.filter((item) => item !== connectionId);
    });
    await this.kernel.mcp.forget(connectionId);
    this.kernel.log("marketplace", "info", `${connection.name} uninstalled and its sign-in removed`);
  }

  private async finish(connectionId: string, attach: "all" | "none"): Promise<void> {
    try {
      const server = await this.kernel.catalog.discoverMcp(connectionId);
      await this.kernel.store.update((state) => {
        const current = state.mcp.find((item) => item.id === connectionId);
        if (current) Object.assign(current, { status: "ready", statusDetail: undefined, authorizationUrl: undefined });
        if (attach === "all") {
          for (const agent of state.agents) {
            if (!agent.mcpConnectionIds.includes(connectionId)) agent.mcpConnectionIds = [...agent.mcpConnectionIds, connectionId];
          }
        }
      });
      this.kernel.log("marketplace", "info", `${server?.name ?? connectionId} installed with ${server?.tools.length ?? 0} tools${attach === "all" ? " and attached to every agent" : ""}`);
    } catch (error) {
      await this.setStatus(connectionId, { status: "error", statusDetail: errorText(error) });
      this.kernel.log("marketplace", "warning", `${connectionId} connected but its tools could not be listed: ${errorText(error)}`);
    }
  }

  private async setStatus(connectionId: string, patch: Partial<McpConnection>): Promise<void> {
    await this.kernel.store.update((state) => {
      const current = state.mcp.find((item) => item.id === connectionId);
      if (current) Object.assign(current, { statusDetail: undefined, authorizationUrl: undefined, ...patch });
    });
  }

  private connection(id: string): McpConnection | undefined {
    return this.kernel.store.state.mcp.find((item) => item.id === marketplaceConnectionId(id));
  }

  private entry(id: string): MarketplaceEntry {
    return this.list().find((item) => item.id === id)!;
  }
}

function displayName(id: string): string {
  return id.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
