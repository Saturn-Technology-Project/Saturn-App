import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { ToolRoute } from "../domain/model.js";
import { errorText, logger } from "./logger.js";
import { SpanKind, failSpan, instruments, markHandled, seconds, traced } from "./telemetry.js";

/** MCP answers with these to steer the run, not because something broke; spans keep them as outcomes. */
const CONTROL = new Set(["approval_required", "policy_denied", "approval_rejected", "Agent is not allowed to call this tool"]);

/** What the client needs to reach one MCP server. A bare URL means an unauthenticated server. */
export type McpTarget = {
  id: string;
  url: string;
  /** "oauth": sign in through the browser; "token": a bearer token the user pasted; "none": open server. */
  auth?: "none" | "oauth" | "token";
  /** A local server to start and talk to over stdio (already approved by the user), instead of the URL. */
  command?: { program: string; args: string[]; env: Record<string, string>; cwd?: string };
};

export type McpVault = {
  secret(id: string): string | undefined;
  putSecret(id: string, value: string): Promise<void>;
  deleteSecret(id: string): Promise<void>;
};

export type McpClientOptions = {
  vault?: McpVault;
  /** Where providers send the browser back after sign-in, e.g. http://127.0.0.1:4700/oauth/callback. */
  redirectUrl?: string;
  /** Opens the provider's sign-in page in the user's browser. */
  openBrowser?: (url: string) => void;
};

/** Raised when a server needs the user to sign in; the browser has been sent to `authorizationUrl`. */
export class AuthorizationRequired extends Error {
  constructor(readonly authorizationUrl: string) {
    super("Sign-in required");
    this.name = "AuthorizationRequired";
  }
}

/** The server answered `initialize` with plain JSON-RPC (no protocolVersion): it does not speak MCP's transports. */
class PlainJsonRpcServer extends Error {}

/** Seconds a server gets to finish the MCP handshake before Saturn gives up on it. */
const HANDSHAKE_MS = 15_000;

/** Spots a plain JSON-RPC server from its `initialize` reply, instead of waiting out the SDK's request timeout. */
const detectingFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const initialize = typeof init?.body === "string" && init.body.includes('"method":"initialize"');
  if (initialize && response.ok && (response.headers.get("content-type") ?? "").includes("application/json")) {
    const body = (await response.clone().json().catch(() => null)) as { result?: { protocolVersion?: unknown } } | null;
    if (body?.result && !body.result.protocolVersion) throw new PlainJsonRpcServer();
  }
  return response;
};

type Session = { client: Client; transport: StreamableHTTPClientTransport | SSEClientTransport | StdioClientTransport } | { legacy: true };

const secretKey = (id: string, part: "client" | "tokens" | "verifier" | "token") => `mcp:${id}:${part}`;

/**
 * Per-connection OAuth state for the MCP SDK: dynamic client registration (or a client the user
 * registered), PKCE, tokens and their refresh. Everything is kept in the runtime's secrets file.
 */
class OAuthState implements OAuthClientProvider {
  authorizationUrl: string | null = null;
  readonly stateValue = randomBytes(16).toString("hex");

  constructor(
    private readonly target: McpTarget,
    private readonly vault: McpVault,
    private readonly redirect: string,
    private readonly openBrowser: (url: string) => void,
  ) {}

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Saturn",
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.stateValue;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const saved = this.vault.secret(secretKey(this.target.id, "client"));
    return saved ? (JSON.parse(saved) as OAuthClientInformationMixed) : undefined;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.vault.putSecret(secretKey(this.target.id, "client"), JSON.stringify(info));
  }

  tokens(): OAuthTokens | undefined {
    const saved = this.vault.secret(secretKey(this.target.id, "tokens"));
    return saved ? (JSON.parse(saved) as OAuthTokens) : undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.vault.putSecret(secretKey(this.target.id, "tokens"), JSON.stringify(tokens));
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url.toString();
    this.openBrowser(this.authorizationUrl);
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.vault.putSecret(secretKey(this.target.id, "verifier"), verifier);
  }

  codeVerifier(): string {
    const verifier = this.vault.secret(secretKey(this.target.id, "verifier"));
    if (!verifier) throw new Error("Sign-in expired; start it again");
    return verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    const parts = scope === "all" ? (["client", "tokens", "verifier"] as const) : scope === "discovery" ? [] : [scope];
    for (const part of parts) await this.vault.deleteSecret(secretKey(this.target.id, part));
  }
}

/**
 * An MCP client built on the official SDK. It speaks Streamable HTTP, falls back to the older SSE
 * transport, and finally to plain JSON-RPC POSTs for simple local servers. Sessions are reused per server.
 */
export class McpClient {
  private readonly sessions = new Map<string, Promise<Session>>();
  /** OAuth sign-ins waiting for the browser to come back, by `state`. */
  private readonly pending = new Map<string, { target: McpTarget; oauth: OAuthState; transport: StreamableHTTPClientTransport }>();

  constructor(private readonly options: McpClientOptions = {}) {}

  async listTools(server: string | McpTarget): Promise<ToolRoute[]> {
    const target = asTarget(server);
    const payload = await this.rpc(target, "tools/list", {});
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    return tools.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as { name?: unknown; description?: unknown; inputSchema?: unknown };
      if (typeof record.name !== "string") return [];
      return [
        {
          toolId: record.name,
          serverId: "",
          description: typeof record.description === "string" ? record.description : "",
          inputSchema:
            record.inputSchema && typeof record.inputSchema === "object"
              ? (record.inputSchema as Record<string, unknown>)
              : { type: "object", properties: {} },
          environments: ["production"],
        },
      ];
    });
  }

  async call(
    server: string | McpTarget,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    headers: Record<string, string>,
  ): Promise<unknown> {
    return this.rpc(asTarget(server), "tools/call", { name: toolName, arguments: args }, headers, signal);
  }

  /** Connects (signing in if needed). Throws AuthorizationRequired when the user must sign in in the browser. */
  async connect(target: McpTarget): Promise<void> {
    await this.session(target);
  }

  /** Completes a browser sign-in from the provider's redirect. Returns the server that was signed in to. */
  async finishSignIn(state: string, code: string): Promise<McpTarget> {
    const waiting = this.pending.get(state);
    if (!waiting) throw new Error("This sign-in is unknown or has already finished. Start it again from Customizations.");
    this.pending.delete(state);
    await waiting.transport.finishAuth(code);
    this.sessions.delete(waiting.target.id);
    await this.session(waiting.target);
    logger.info("mcp", `Signed in to ${hostOf(waiting.target.url)}`);
    return waiting.target;
  }

  /** Ends a server's session (stopping a local server's process) without touching its credentials. */
  async close(id: string): Promise<void> {
    const session = await this.sessions.get(id)?.catch(() => null);
    if (session && "client" in session) await session.client.close().catch(() => undefined);
    this.sessions.delete(id);
  }

  /** Drops the session and every stored credential for a server. */
  async forget(id: string): Promise<void> {
    const session = await this.sessions.get(id)?.catch(() => null);
    if (session && "client" in session) await session.client.close().catch(() => undefined);
    this.sessions.delete(id);
    for (const [state, waiting] of this.pending) if (waiting.target.id === id) this.pending.delete(state);
    const vault = this.options.vault;
    if (vault) for (const part of ["client", "tokens", "verifier", "token"] as const) await vault.deleteSecret(secretKey(id, part));
  }

  async saveToken(id: string, token: string): Promise<void> {
    if (!this.options.vault) throw new Error("No secret store for tokens");
    await this.options.vault.putSecret(secretKey(id, "token"), token.trim());
    this.sessions.delete(id);
  }

  /** Registers a client the user created with the provider, for servers that do not allow self-registration. */
  async saveOAuthClient(id: string, clientId: string, clientSecret?: string): Promise<void> {
    if (!this.options.vault) throw new Error("No secret store for OAuth clients");
    const info = { client_id: clientId.trim(), ...(clientSecret?.trim() ? { client_secret: clientSecret.trim() } : {}) };
    await this.options.vault.putSecret(secretKey(id, "client"), JSON.stringify(info));
    this.sessions.delete(id);
  }

  private session(target: McpTarget): Promise<Session> {
    let session = this.sessions.get(target.id);
    if (!session) {
      session = this.open(target);
      this.sessions.set(target.id, session);
      session.catch(() => this.sessions.delete(target.id));
    }
    return session;
  }

  private async open(target: McpTarget): Promise<Session> {
    if (target.command) return await this.openLocal(target, target.command);
    const url = new URL(target.url);
    const requestInit = this.requestInit(target);
    const oauth = target.auth === "oauth" ? this.oauthFor(target) : undefined;
    const client = () => new Client({ name: "saturn", version: "0.1.0" });

    const streamable = new StreamableHTTPClientTransport(url, { requestInit, authProvider: oauth, fetch: detectingFetch });
    const first = client();
    try {
      await first.connect(streamable, { timeout: HANDSHAKE_MS });
      return { client: first, transport: streamable };
    } catch (error) {
      if (error instanceof PlainJsonRpcServer || (error instanceof Error && error.cause instanceof PlainJsonRpcServer)) {
        await first.close().catch(() => undefined);
        return { legacy: true };
      }
      if (error instanceof UnauthorizedError || oauth?.authorizationUrl) {
        if (oauth?.authorizationUrl) {
          this.pending.set(oauth.stateValue, { target, oauth, transport: streamable });
          throw new AuthorizationRequired(oauth.authorizationUrl);
        }
        throw new Error(target.auth === "token" ? "The server refused the token" : "The server requires sign-in");
      }
      if (aborted(error)) throw error;
      logger.debug("mcp", `${hostOf(target.url)} did not accept Streamable HTTP (${errorText(error)}); trying SSE`);
    }
    // A failed attempt can leave a socket open that would keep the process alive.
    await first.close().catch(() => undefined);

    const sse = new SSEClientTransport(url, { requestInit, authProvider: oauth });
    const second = client();
    try {
      await second.connect(sse, { timeout: HANDSHAKE_MS });
      return { client: second, transport: sse };
    } catch (error) {
      if (aborted(error)) throw error;
      logger.debug("mcp", `${hostOf(target.url)} did not accept SSE (${errorText(error)}); using plain JSON-RPC`);
    }
    await second.close().catch(() => undefined);
    return { legacy: true };
  }

  /**
   * Starts a local server and speaks MCP over its stdin and stdout. Its stderr is kept (the last few KB) so a
   * server that fails to start says why. The process ends when the session is closed or the runtime exits.
   */
  private async openLocal(target: McpTarget, command: NonNullable<McpTarget["command"]>): Promise<Session> {
    // A missing working folder fails the spawn with a misleading ENOENT for the program itself.
    if (command.cwd) await mkdir(command.cwd, { recursive: true });
    const transport = new StdioClientTransport({ command: command.program, args: command.args, env: command.env, cwd: command.cwd, stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    const client = new Client({ name: "saturn", version: "0.1.0" });
    try {
      await client.connect(transport, { timeout: HANDSHAKE_MS * 4 });
    } catch (error) {
      await client.close().catch(() => undefined);
      const detail = stderr.trim().split("\n").slice(-6).join("\n");
      throw new Error(`Could not start ${command.program}: ${errorText(error)}${detail ? `\n${detail}` : ""}`);
    }
    logger.info("mcp", `Started local MCP server ${target.id} (${command.program}, pid ${transport.pid ?? "?"})`);
    return { client, transport };
  }

  private oauthFor(target: McpTarget): OAuthState {
    const vault = this.options.vault;
    if (!vault) throw new Error("Sign-in needs a secret store");
    const redirect = this.options.redirectUrl ?? "http://127.0.0.1:4700/oauth/callback";
    return new OAuthState(target, vault, redirect, this.options.openBrowser ?? (() => undefined));
  }

  private requestInit(target: McpTarget): RequestInit | undefined {
    if (target.auth !== "token") return undefined;
    const token = this.options.vault?.secret(secretKey(target.id, "token"));
    return token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;
  }

  /** One MCP request, as an "mcp <method>" client span plus saturn.mcp.request.duration. */
  private async rpc(
    target: McpTarget,
    method: "tools/list" | "tools/call",
    params: { name?: string; arguments?: Record<string, unknown> },
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const tool = method === "tools/call" ? String(params.name ?? "") : "";
    const base = { "mcp.method.name": method, "server.address": hostOf(target.url) };
    return traced(tool ? `mcp ${method} ${tool}` : `mcp ${method}`, {
      kind: SpanKind.CLIENT,
      attributes: { ...base, "rpc.system": "jsonrpc", ...(tool ? { "gen_ai.tool.name": tool } : {}) },
    }, async (span) => {
      const startedAt = performance.now();
      let outcome = "ok";
      try {
        const session = await this.session(target);
        if ("legacy" in session) return await this.send(target.url, method, params, headers, signal);
        span.setAttribute("saturn.mcp.transport", session.transport instanceof StdioClientTransport ? "stdio" : session.transport instanceof SSEClientTransport ? "sse" : "streamable-http");
        if (method === "tools/list") return (await session.client.listTools(undefined, { signal })) as Record<string, unknown>;
        return (await session.client.callTool({ name: tool, arguments: params.arguments ?? {} }, undefined, { signal })) as Record<string, unknown>;
      } catch (error) {
        if (error instanceof AuthorizationRequired) {
          outcome = "sign_in_required";
          markHandled(span);
          throw error;
        }
        const message = errorText(error);
        outcome = CONTROL.has(message) ? message : "error";
        span.setAttribute("saturn.mcp.outcome", outcome);
        if (outcome === "error") {
          failSpan(span, error);
          // A broken session is reopened on the next call.
          this.sessions.delete(target.id);
        } else markHandled(span);
        throw error;
      } finally {
        instruments().mcpDuration.record(seconds(startedAt), { ...base, "saturn.mcp.outcome": outcome });
      }
    });
  }

  /** Plain JSON-RPC over POST, for small local servers that do not implement the MCP transports. */
  private async send(
    url: string,
    method: string,
    params: unknown,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal,
      });
    } catch (error) {
      if (aborted(error)) throw error;
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
      throw new Error(cause ? `Could not reach ${url}: ${cause}` : `Could not reach ${url}`);
    }
    const body = (await response.json()) as { result?: Record<string, unknown>; error?: unknown };
    if (body.error) {
      const message =
        typeof body.error === "object" && body.error && "message" in body.error
          ? String((body.error as { message?: unknown }).message || "MCP call failed")
          : "MCP call failed";
      throw new Error(message);
    }
    return body.result ?? {};
  }
}

function asTarget(server: string | McpTarget): McpTarget {
  return typeof server === "string" ? { id: server, url: server, auth: "none" } : server;
}

function aborted(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("name" in error && error.name === "AbortError") return true;
  return "cause" in error && aborted(error.cause);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
