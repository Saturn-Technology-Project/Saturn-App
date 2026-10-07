import { WebSocket } from "ws";
import type { FileStore } from "./store.js";

type Pending = {
  resolve: (message: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

function absoluteWs(apiBase: string, wsUrl: string): string {
  const base = new URL(apiBase);
  if (wsUrl.startsWith("ws://") || wsUrl.startsWith("wss://")) {
    const parsed = new URL(wsUrl);
    if (base.protocol === "https:" && parsed.protocol === "ws:" && parsed.host === base.host) {
      parsed.protocol = "wss:";
      return parsed.toString();
    }
    return wsUrl;
  }
  const protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const path = wsUrl.startsWith("/") ? wsUrl : `/${wsUrl}`;
  return `${protocol}//${base.host}${path}`;
}

export type CloudOptions = {
  heartbeatMs?: number;
};

export class CloudSession {
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private heartbeat: NodeJS.Timeout | null = null;
  private intentionalClose = false;
  private suppressDisconnect = false;
  private pairing: Promise<void> = Promise.resolve();
  private heartbeatMs: number;
  onDisconnect: (() => void) | null = null;
  onConnected: (() => void) | null = null;
  onCommand: ((message: Record<string, unknown>) => void) | null = null;

  constructor(
    private readonly store: FileStore,
    options: CloudOptions = {},
  ) {
    this.heartbeatMs = options.heartbeatMs ?? 25_000;
  }

  setHeartbeat(ms: number): void {
    this.heartbeatMs = Math.max(5_000, ms);
    const sessionId = this.store.state.session.sessionId;
    if (this.isConnected() && sessionId) this.startHeartbeat(sessionId);
  }

  isConnected(): boolean {
    return this.store.state.session.connected && this.socket?.readyState === WebSocket.OPEN;
  }

  async pair(apiBase: string, userToken: string): Promise<void> {
    const run = this.pairing.then(() => this.pairOnce(apiBase, userToken));
    this.pairing = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async pairOnce(apiBase: string, userToken: string): Promise<void> {
    const base = apiBase.replace(/\/$/, "");
    if (this.isConnected() && this.store.state.session.apiBase === base) return;
    let response = await fetch(`${base}/session/pair`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${userToken}`,
        "content-type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 404) {
      response = await fetch(`${base}/connectors/enroll`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${userToken}`,
          "content-type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(8_000),
      });
    }
    if (!response.ok) {
      throw new Error(`pair session failed: ${response.status}`);
    }
    const body = (await response.json()) as {
      sessionId?: string;
      session_id?: string;
      connector_id?: string;
      wsUrl?: string;
      ws_url?: string;
      token?: string;
      organizationId?: string;
      organization_id?: string;
    };
    const sessionId = body.sessionId || body.session_id || body.connector_id || "";
    const wsUrl = absoluteWs(base, body.wsUrl || body.ws_url || "");
    const organizationId = body.organizationId || body.organization_id || null;
    if (!wsUrl || !body.token || !sessionId) {
      throw new Error("pair session response is incomplete");
    }
    await this.store.update((state) => {
      state.session = {
        paired: true,
        connected: false,
        sessionId,
        organizationId: organizationId ?? state.session.organizationId,
        apiBase,
        wsUrl,
      };
    });
    try {
      await this.connect(wsUrl, body.token, sessionId, organizationId);
    } catch (error) {
      this.suppressDisconnect = true;
      this.stopHeartbeat();
      this.socket?.close();
      this.socket = null;
      await this.store.update((state) => {
        state.session = {
          paired: false,
          connected: false,
          sessionId: null,
          organizationId: null,
          apiBase: null,
          wsUrl: null,
        };
      });
      throw error;
    }
  }

  async unpair(): Promise<void> {
    this.intentionalClose = true;
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    await this.store.update((state) => {
      state.session = {
        paired: false,
        connected: false,
        sessionId: null,
        organizationId: null,
        apiBase: null,
        wsUrl: null,
      };
      for (const agent of state.agents) agent.status = "active";
    });
  }

  send(message: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private connect(
    wsUrl: string,
    token: string,
    sessionId: string,
    organizationId: string | null,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(wsUrl);
      url.searchParams.set("connector_id", sessionId);
      url.searchParams.set("token", token);
      const previous = this.socket;
      this.socket = null;
      previous?.close();
      const socket = new WebSocket(url);
      this.socket = socket;
      let settled = false;
      socket.once("open", () => {
        this.send({
          type: "connection.init",
          connector_id: sessionId,
          token,
          organization_id: organizationId,
          protocol: 2,
        });
        this.send({
          type: "connector.register",
          connector_id: sessionId,
          organization_id: organizationId,
          environment_id: "production",
          version: "0.1.0",
          capabilities: ["agent_runtime"],
        });
        void this.store
          .update((state) => {
            state.session.connected = true;
          })
          .then(() => {
            this.onConnected?.();
            this.startHeartbeat(sessionId);
            settled = true;
            resolve();
          })
          .catch((error: unknown) => {
            settled = true;
            reject(error instanceof Error ? error : new Error("pair session failed"));
          });
      });
      socket.on("message", (raw) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          return;
        }
        const payload =
          message.payload && typeof message.payload === "object"
            ? (message.payload as Record<string, unknown>)
            : {};
        const requestId = String(message.request_id || payload.request_id || "");
        const waiter = requestId ? this.pending.get(requestId) : undefined;
        if (waiter) {
          this.pending.delete(requestId);
          waiter.resolve(message);
          return;
        }
        this.onCommand?.(message);
      });
      socket.once("error", (error) => {
        if (settled) return;
        this.suppressDisconnect = true;
        settled = true;
        reject(error instanceof Error ? error : new Error("Saturn Cloud websocket failed"));
      });
      socket.on("close", () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.stopHeartbeat();
        void this.store.update((state) => {
          state.session.connected = false;
        });
        if (this.suppressDisconnect) {
          this.suppressDisconnect = false;
          return;
        }
        if (this.intentionalClose) {
          this.intentionalClose = false;
          return;
        }
        if (this.store.state.session.paired) this.onDisconnect?.();
      });
    });
  }

  private request(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Saturn Cloud is not connected"));
    }
    const requestId = String(message.request_id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Policy engine timeout"));
      }, 10_000);
      timer.unref();
      this.pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject,
      });
      this.send(message);
    });
  }

  private startHeartbeat(sessionId: string): void {
    this.stopHeartbeat();
    const timer = setInterval(() => {
      this.send({ type: "connector.heartbeat", connector_id: sessionId });
    }, this.heartbeatMs);
    timer.unref();
    this.heartbeat = timer;
  }

  private stopHeartbeat(): void {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
