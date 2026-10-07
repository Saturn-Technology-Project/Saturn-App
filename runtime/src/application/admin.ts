import { HttpError } from "../domain/errors.js";
import { newId } from "../domain/ids.js";
import type { AppSettings, BrokerConnection } from "../domain/model.js";
import { RUNTIME_CALLER } from "./runtime-state.js";
import type { RuntimeKernel } from "./kernel.js";

/** Local settings, broker keys, logs, and diagnostics. */
export class AdminService {
  constructor(private readonly kernel: RuntimeKernel) {}

  settings(): AppSettings {
    return this.kernel.store.state.settings;
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const logging = patch.logging;
    if (logging && !["debug", "info", "warning", "error"].includes(logging)) {
      throw new HttpError(400, "Unknown logging level");
    }
    let next = this.kernel.store.state.settings;
    await this.kernel.store.update((state) => {
      state.settings = {
        name: patch.name?.trim() || state.settings.name,
        environment: patch.environment?.trim() || state.settings.environment,
        heartbeatSeconds: Math.max(5, Number(patch.heartbeatSeconds ?? state.settings.heartbeatSeconds) || 25),
        logging: logging ?? state.settings.logging,
      };
      next = state.settings;
    });
    this.kernel.cloud.setHeartbeat(next.heartbeatSeconds * 1000);
    this.kernel.log("runtime", "info", "Settings saved");
    return next;
  }

  listKeys() {
    return this.kernel.store.state.broker.map((item) => this.publicKey(item));
  }

  async createKey(input: {
    name?: string;
    secretName?: string;
    baseUrl?: string;
    allowedPaths?: string | string[];
    value?: string;
  }) {
    const secretName = String(input.secretName || "").trim().toUpperCase();
    if (!secretName) throw new HttpError(400, "secret_name is required");
    const paths = Array.isArray(input.allowedPaths)
      ? input.allowedPaths
      : String(input.allowedPaths || "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
    const key: BrokerConnection = {
      id: newId("sec"),
      name: input.name?.trim() || secretName,
      baseUrl: input.baseUrl?.trim() || "",
      secretName,
      allowedCallers: [RUNTIME_CALLER.callerId],
      allowedTools: [],
      allowedPaths: paths.length ? paths : ["/"],
      hasSecret: Boolean(input.value),
    };
    await this.kernel.session.upsertOrgCredential(this.kernel.session.keyCredential(key, input.value, Boolean(input.value)));
    await this.kernel.store.update((state) => {
      state.broker.push(key);
    });
    if (input.value) await this.kernel.store.putSecret(key.id, input.value);
    this.kernel.log("broker", "info", `Connection ${secretName} saved`);
    return this.publicKey(key);
  }

  async rotateKey(id: string, value: string) {
    if (!value) throw new HttpError(400, "value is required");
    const current = this.kernel.store.state.broker.find((item) => item.id === id);
    if (!current) throw new HttpError(404, "Connection not found");
    const model = this.kernel.store.state.models.find((item) => item.brokerConnectionId === id);
    if (model) await this.kernel.session.upsertOrgCredential(this.kernel.session.modelCredential({ ...model, hasSecret: true }, value));
    else await this.kernel.session.upsertOrgCredential(this.kernel.session.keyCredential({ ...current, hasSecret: true }, value, true));
    await this.kernel.store.putSecret(id, value);
    await this.kernel.store.update((state) => {
      const item = state.broker.find((entry) => entry.id === id);
      if (item) item.hasSecret = true;
      const model = state.models.find((entry) => entry.brokerConnectionId === id);
      if (model) model.hasSecret = true;
    });
    this.kernel.log("broker", "info", `Rotated ${current.secretName}`);
    const updated = this.kernel.store.state.broker.find((item) => item.id === id);
    return this.publicKey(updated ?? current);
  }

  async clearKey(id: string) {
    const current = this.kernel.store.state.broker.find((item) => item.id === id);
    if (!current) throw new HttpError(404, "Connection not found");
    const model = this.kernel.store.state.models.find((item) => item.brokerConnectionId === id);
    if (model) await this.kernel.session.upsertOrgCredential(this.kernel.session.modelCredential({ ...model, hasSecret: false }, ""));
    else await this.kernel.session.upsertOrgCredential(this.kernel.session.keyCredential({ ...current, hasSecret: false }, "", true));
    await this.kernel.store.deleteSecret(id);
    await this.kernel.store.update((state) => {
      const item = state.broker.find((entry) => entry.id === id);
      if (item) item.hasSecret = false;
      const model = state.models.find((entry) => entry.brokerConnectionId === id);
      if (model) model.hasSecret = false;
    });
    this.kernel.log("broker", "info", `Cleared ${current.secretName}`);
    return this.publicKey({ ...current, hasSecret: false });
  }

  async deleteKey(id: string) {
    const used = this.kernel.store.state.models.some((item) => item.brokerConnectionId === id);
    if (used) throw new HttpError(409, "Connection is still used by a model");
    const current = this.kernel.store.state.broker.find((item) => item.id === id);
    if (!current) throw new HttpError(404, "Connection not found");
    await this.kernel.session.deleteOrgCredential(id);
    await this.kernel.store.update((state) => {
      state.broker = state.broker.filter((item) => item.id !== id);
    });
    await this.kernel.store.deleteSecret(id);
  }

  information() {
    const settings = this.kernel.store.state.settings;
    const session = this.kernel.store.state.session;
    return {
      version: "0.1.0",
      listen: `http://${process.env.SATURN_RUNTIME_HOST ?? "127.0.0.1"}:${process.env.SATURN_RUNTIME_PORT ?? 4700}`,
      name: settings.name,
      environment: settings.environment,
      runtimeId: "saturn-app",
      sessionId: session.sessionId,
      organizationId: session.organizationId,
      saturnEndpoint: session.apiBase,
      broker: "in-process",
      mcpServers: this.kernel.store.state.mcp.map((item) => item.id),
    };
  }

  listLogs(query: { service?: string; level?: string; q?: string }) {
    const floor = query.level === "error" ? 2 : query.level === "warn" || query.level === "warning" ? 1 : 0;
    const rank = (level: string) => (level === "error" ? 2 : level === "warning" ? 1 : 0);
    return this.kernel.logs.filter((item) => {
      if (query.service && item.service !== query.service) return false;
      if (rank(item.level) < floor) return false;
      if (query.q && !item.message.toLowerCase().includes(query.q.toLowerCase())) return false;
      return true;
    });
  }

  diagnostics() {
    const session = this.kernel.store.state.session;
    const connected = this.kernel.cloud.isConnected();
    return {
      checks: [
        { group: "components", name: "Runtime", ok: true, detail: "Healthy" },
        { group: "components", name: "Credential Broker", ok: true, detail: "In-process. Key values are not returned." },
        { group: "components", name: "MCP", ok: true, detail: `${this.kernel.store.state.mcp.reduce((sum, item) => sum + item.tools.length, 0)} tools` },
        {
          group: "connectivity",
          name: "Saturn Cloud",
          ok: !session.paired || connected,
          detail: session.paired ? (connected ? "Connected" : "Disconnected") : "Not paired",
        },
      ],
    };
  }

  publicKey(item: {
    id: string;
    name: string;
    secretName: string;
    baseUrl: string;
    hasSecret: boolean;
    allowedCallers: string[];
    allowedPaths: string[];
  }) {
    return {
      id: item.id,
      name: item.name,
      secretName: item.secretName,
      baseUrl: item.baseUrl,
      hasSecret: item.hasSecret,
      allowedCallers: item.allowedCallers,
      allowedPaths: item.allowedPaths,
      native: item.secretName === "AGENTS_API_KEY",
      required: item.secretName === "AGENTS_API_KEY",
      status: item.hasSecret ? "configured" : "missing",
    };
  }
}
