/**
 * How each Customizations integration installs. Endpoints come from the MCP registry or the vendor's own
 * docs, and the sign-in method from probing each endpoint on 2026-10-18 (an unauthenticated `initialize`,
 * then its OAuth protected-resource and authorization-server metadata):
 * - "none": the server answers without sign-in.
 * - "oauth": OAuth in the browser; the server supports dynamic client registration, so nothing to set up.
 * - "oauth-client": OAuth, but the provider does not let apps self-register. The user creates an OAuth
 *   client with the provider (redirect URI http://127.0.0.1:4700/oauth/callback) and pastes its ID.
 * - "token": a bearer token the user creates (GitHub accepts a personal access token).
 * Entries with `unavailable` have no official MCP server Saturn can use; the reason is shown instead of Install.
 */

export type InstallAuth = "none" | "oauth" | "oauth-client" | "token";

export type InstallRecipe = {
  id: string;
  url?: string;
  auth?: InstallAuth;
  /** For "token": where to create one. For "oauth-client": where to register the OAuth client. */
  setupUrl?: string;
  setupHint?: string;
  /** Also accepts a token instead of OAuth (GitHub). */
  tokenAlternative?: boolean;
  unavailable?: string;
};

const GOOGLE_CLIENT = {
  auth: "oauth-client" as const,
  setupUrl: "https://console.cloud.google.com/apis/credentials",
  setupHint: "Create an OAuth client ID (type: Web application) with redirect URI http://127.0.0.1:4700/oauth/callback, and enable the product's API.",
};

export const INSTALL_RECIPES: InstallRecipe[] = [
  // Saturn MCP (saturn-core.com/mcp), pinned first in Customizations. OAuth 2.1 with dynamic client
  // registration and PKCE (checked 2026-10-18), so it installs with one click and a browser sign-in.
  { id: "saturn-mcp", url: "https://api.saturn-core.com/mcp", auth: "oauth" },

  // Finance & E-Commerce
  { id: "stripe", url: "https://mcp.stripe.com/", auth: "oauth" },
  { id: "shopify", url: "https://setup.shopify.com/mcp", auth: "none" },
  { id: "mercury", url: "https://mcp.mercury.com/mcp", auth: "oauth" },
  { id: "brex", url: "https://api.brex.com/mcp", auth: "oauth" },
  { id: "ramp", url: "https://ramp-mcp-remote.ramp.com/mcp", auth: "oauth" },
  {
    id: "xero",
    url: "https://mcp.xero.com/mcp",
    auth: "oauth-client",
    setupUrl: "https://developer.xero.com/app/manage",
    setupHint: "Create a Xero app with redirect URI http://127.0.0.1:4700/oauth/callback.",
  },
  { id: "carta", url: "https://mcp.app.carta.com/mcp", auth: "oauth" },
  { id: "ibkr", url: "https://api.ibkr.com/v1/api/mcp", auth: "oauth" },
  { id: "dukascopy", unavailable: "Dukascopy has no official MCP server." },
  { id: "etherscan", url: "https://mcp-keyless.etherscan.io/mcp", auth: "none" },
  { id: "plaid", url: "https://api.dashboard.plaid.com/mcp/sse", auth: "oauth" },
  { id: "northwest", unavailable: "Northwest Registered Agent has no official MCP server." },
  { id: "factset", url: "https://mcp.factset.com/content/v1", auth: "oauth" },
  { id: "financial-datasets", url: "https://mcp.financialdatasets.ai/", auth: "oauth" },
  { id: "twelve-data", url: "https://mcp.twelvedata.com/mcp", auth: "oauth" },
  { id: "seeking-alpha", unavailable: "Seeking Alpha has no official MCP server." },
  { id: "sec-api", unavailable: "SEC-API.io has no official MCP server." },
  { id: "finance-foundation", unavailable: "No official MCP server was found for Finance Foundation." },

  // Productivity & Collaboration
  { id: "google-calendar", url: "https://calendarmcp.googleapis.com/mcp/v1", ...GOOGLE_CLIENT },
  { id: "notion", url: "https://mcp.notion.com/mcp", auth: "oauth" },
  { id: "google-docs", url: "https://docsmcp.googleapis.com/mcp/v1", ...GOOGLE_CLIENT },
  { id: "google-sheets", url: "https://sheetsmcp.googleapis.com/mcp/v1", ...GOOGLE_CLIENT },
  { id: "google-slides", url: "https://slidesmcp.googleapis.com/mcp/v1", ...GOOGLE_CLIENT },
  { id: "google-drive", url: "https://drivemcp.googleapis.com/mcp/v1", ...GOOGLE_CLIENT },
  { id: "microsoft-365", unavailable: "Microsoft's hosted MCP server is only offered inside Claude." },
  { id: "figma", url: "https://mcp.figma.com/mcp", auth: "oauth" },
  { id: "canva", url: "https://mcp.canva.com/mcp", auth: "oauth" },
  { id: "adobe", url: "https://adobe-creativity.adobe.io/mcp", auth: "oauth" },
  { id: "indeed", url: "https://mcp.indeed.com/claude/mcp", auth: "oauth" },
  { id: "booking", unavailable: "Booking.com's MCP server is limited to approved partners." },
  {
    id: "spotify",
    url: "https://mcp-gateway-external-pilot.spotify.net/mcp",
    auth: "oauth-client",
    setupUrl: "https://developer.spotify.com/dashboard",
    setupHint: "Create a Spotify app with redirect URI http://127.0.0.1:4700/oauth/callback.",
  },

  // Development & DevOps
  {
    id: "github",
    url: "https://api.githubcopilot.com/mcp/",
    auth: "token",
    tokenAlternative: true,
    setupUrl: "https://github.com/settings/personal-access-tokens/new",
    setupHint: "Paste a fine-grained personal access token. GitHub's hosted MCP server may require a Copilot seat.",
  },
  { id: "linear", url: "https://mcp.linear.app/mcp", auth: "oauth" },
  { id: "atlassian", url: "https://mcp.atlassian.com/v2/mcp", auth: "oauth" },
  { id: "vercel", url: "https://mcp.vercel.com/", auth: "oauth" },
  { id: "context7", url: "https://mcp.context7.com/mcp", auth: "none" },
  { id: "deepwiki", url: "https://mcp.deepwiki.com/mcp", auth: "none" },

  // Databases & Cloud Infrastructure
  { id: "supabase", url: "https://mcp.supabase.com/mcp", auth: "oauth" },
  { id: "neon", url: "https://mcp.neon.tech/mcp", auth: "oauth" },
  { id: "huggingface", url: "https://huggingface.co/mcp", auth: "none" },

  // Team Communication
  { id: "gmail", url: "https://gmailmcp.googleapis.com/mcp/v1", ...GOOGLE_CLIENT },
  {
    id: "slack",
    url: "https://mcp.slack.com/mcp",
    auth: "oauth-client",
    setupUrl: "https://api.slack.com/apps",
    setupHint: "Create a Slack app with redirect URL http://127.0.0.1:4700/oauth/callback.",
  },

  // Security & Observability
  { id: "sumsub", url: "https://api.sumsub.com/mcp/", auth: "oauth" },
  { id: "sentry", url: "https://mcp.sentry.dev/mcp", auth: "oauth" },
];

export function installRecipe(id: string): InstallRecipe | undefined {
  return INSTALL_RECIPES.find((item) => item.id === id);
}

/** The MCP connection id an installed integration uses. */
export function marketplaceConnectionId(id: string): string {
  return `mkt-${id}`;
}

/** Remote tool names, prefixed per server so two servers' `search` tools never collide; safe for every LLM API. */
export function namespacedTool(serverId: string, name: string): string {
  return `${serverId}__${name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}
