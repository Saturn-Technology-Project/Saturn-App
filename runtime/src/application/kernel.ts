import { HttpError } from "../domain/errors.js";
import { GENERAL_SKILLS_ID, SATURN_AGENT_ID, generalSkills, saturnAgent, withGeneralSkills } from "../domain/builtin.js";
import type { Agent, AppState, Run, ToolRoute } from "../domain/model.js";
import { DISCONNECT_ERROR, type Inflight, type LogLine, type PendingTool } from "./runtime-state.js";
import { Broker } from "../infrastructure/broker.js";
import { CloudSession } from "../infrastructure/cloud.js";
import { McpClient } from "../infrastructure/mcp.js";
import { FileStore } from "../infrastructure/store.js";
import { AdminService } from "./admin.js";
import { CatalogService } from "./catalog.js";
import { RunService } from "./runs.js";
import { SessionService } from "./session.js";

/** Shared runtime state. Use cases collaborate through this object, so a disconnect or a stop is visible to all of them. */
export class RuntimeKernel {
  readonly pending = new Map<string, PendingTool>();
  readonly inflight = new Map<string, Inflight>();
  readonly stops = new Map<string, AbortController>();
  readonly logs: LogLine[] = [];
  logSeq = 0;
  syncedAt = 0;
  messagesUnavailable = false;
  credentialsUnavailable = false;
  loadedAgents = "";
  readonly catalog: CatalogService;
  readonly runs: RunService;
  readonly session: SessionService;
  readonly admin: AdminService;

  constructor(
    readonly store: FileStore,
    readonly broker: Broker,
    readonly mcp: McpClient,
    readonly cloud: CloudSession,
  ) {
    this.catalog = new CatalogService(this);
    this.runs = new RunService(this);
    this.session = new SessionService(this);
    this.admin = new AdminService(this);
    this.cloud.onDisconnect = () => {
      this.log("cloud", "error", "Disconnected from Saturn Cloud");
      this.pending.clear();
      this.inflight.clear();
      void this.store.update((state) => {
        for (const agent of state.agents) agent.status = "paused";
        for (const run of state.runs) {
          if (run.status === "running" || run.status === "queued" || run.status === "waiting_approval") {
            run.status = "failed";
            run.error = DISCONNECT_ERROR;
          }
        }
      });
    };
    this.cloud.onConnected = () => {
      void this.session.announce();
    };
    this.cloud.onCommand = (message) => {
      void this.runs.onCloud(message);
    };
    this.log("runtime", "info", "Saturn Runtime is running");
  }

  health() {
    const session = this.store.state.session;
    return {
      ok: true,
      paired: session.paired,
      connected: this.cloud.isConnected(),
      organizationId: session.organizationId,
    };
  }

  getAgent(id: string): Agent {
    const agent = this.store.state.agents.find((item) => item.id === id);
    if (!agent) throw new HttpError(404, "Agent not found");
    return agent;
  }

  getRun(id: string): Run {
    const run = this.store.state.runs.find((item) => item.id === id);
    if (!run) throw new HttpError(404, "Run not found");
    return run;
  }

  track(runId: string, generation: number): AbortSignal {
    const key = `${runId}:${generation}`;
    const existing = this.stops.get(key);
    if (existing) return existing.signal;
    const controller = new AbortController();
    this.stops.set(key, controller);
    return controller.signal;
  }

  dropFlight(runIds: string[]) {
    const ids = new Set(runIds);
    for (const [actionId, pending] of this.pending) {
      if (ids.has(pending.runId)) this.pending.delete(actionId);
    }
    for (const [actionId, flight] of this.inflight) {
      if (ids.has(flight.runId)) this.inflight.delete(actionId);
    }
  }

  alive(runId: string, generation: number): boolean {
    const run = this.store.state.runs.find((item) => item.id === runId);
    return Boolean(run && (run.generation ?? 0) === generation && run.error !== DISCONNECT_ERROR);
  }

  guard(agentId: string): void {
    const agent = this.getAgent(agentId);
    if (agent.status === "paused") throw new HttpError(409, "Agent is paused");
    if (this.store.state.session.paired && !this.cloud.isConnected()) {
      throw new HttpError(409, "Saturn Cloud is not connected");
    }
  }

  async ensureBuiltins(): Promise<void> {
    await this.store.update((state) => this.installBuiltins(state));
  }

  installBuiltins(state: AppState, preserved?: Agent): void {
    const skills = generalSkills();
    state.mcp = [skills, ...state.mcp.filter((item) => item.id !== GENERAL_SKILLS_ID)];
    const current = preserved ?? state.agents.find((item) => item.id === SATURN_AGENT_ID);
    const modelId = current?.modelConnectionId && state.models.some((item) => item.id === current.modelConnectionId)
      ? current.modelConnectionId
      : state.models[0]?.id ?? null;
    const account = state.account;
    const canEdit = !account || account.agents === "write" || account.team === "write";
    state.agents = [saturnAgent(current, modelId, canEdit), ...state.agents.filter((item) => item.id !== SATURN_AGENT_ID)];
    for (const agent of state.agents) agent.mcpConnectionIds = withGeneralSkills(agent.mcpConnectionIds);
  }

  log(service: string, level: string, message: string) {
    this.logs.push({ seq: (this.logSeq += 1), ts: new Date().toISOString(), service, level, message });
    if (this.logs.length > 300) this.logs.shift();
  }

  route(serverId: string, toolId: string, description: string, inputSchema?: Record<string, unknown>): ToolRoute {
    return {
      toolId,
      serverId,
      description,
      inputSchema: inputSchema && inputSchema.type ? inputSchema : { type: "object", properties: {} },
      environments: ["production"],
      organizationId: this.store.state.session.organizationId,
    };
  }
}
