import type { Attributes } from "@opentelemetry/api";
import { HttpError } from "../domain/errors.js";
import {
  GENERAL_SKILLS_ID,
  SATURN_AGENT_ID,
  generalSkills,
  withGeneralSkills,
  CURSOR_COMPUTER_USE_ID,
  CURSOR_COMPUTER_USE_URL,
  CURSOR_ORIGIN_ID,
  CURSOR_ORIGIN_URL,
  cursorComputerUseSkills,
  cursorOriginSkills,
  ANTIGRAVITY_SKILLS_ID,
  ANTIGRAVITY_SKILLS_URL,
  antigravitySkills,
} from "../domain/builtin.js";
import type { Agent, AppState, Run, ToolRoute } from "../domain/model.js";
import { LlmBroker } from "../infrastructure/llm.js";
import { logLevel, logger, type LogLevel } from "../infrastructure/logger.js";
import { McpClient } from "../infrastructure/mcp.js";
import { FileStore } from "../infrastructure/store.js";
import { AdminService } from "./admin.js";
import { AutomationService } from "./automations.js";
import { CatalogService } from "./catalog.js";
import { RunService } from "./runs.js";
import { UsageService } from "./usage.js";
import { MarketplaceService } from "./marketplace.js";
import { ProjectService } from "./projects.js";
import { ClaudeCodeService } from "./claude-code.js";
import { CodexService } from "./codex.js";
import { IndexService } from "./index.js";
import { WorktreeService } from "./worktrees.js";
import { MemoryService } from "./memory.js";
import { BROWSER_ID, BROWSER_URL, browserSkills } from "../domain/browser-tools.js";
import { CheckpointService } from "./checkpoints.js";
import { CompletionService } from "./completions.js";
import { GroupService } from "./groups.js";
import { ClientRegistry } from "./clients.js";

/** Shared local runtime state. */
export class RuntimeKernel {
  readonly stops = new Map<string, AbortController>();
  readonly llm: LlmBroker;
  readonly catalog: CatalogService;
  readonly runs: RunService;
  readonly admin: AdminService;
  readonly automations: AutomationService;
  readonly usage: UsageService;
  readonly marketplace: MarketplaceService;
  readonly projects: ProjectService;
  readonly claudeCode: ClaudeCodeService;
  readonly codex: CodexService;
  readonly index: IndexService;
  readonly worktrees: WorktreeService;
  readonly memory: MemoryService;
  readonly checkpoints: CheckpointService;
  readonly completions: CompletionService;
  readonly groups: GroupService;
  readonly clients = new ClientRegistry();

  constructor(
    readonly store: FileStore,
    readonly mcp: McpClient,
  ) {
    this.llm = new LlmBroker(store);
    this.llm.onUsage = (record) =>
      this.store.update((state) => {
        state.usage.unshift(record);
      }).then(() => undefined);
    this.catalog = new CatalogService(this);
    this.runs = new RunService(this);
    this.admin = new AdminService(this);
    logger.level = logLevel(store.state.settings.logging) ?? "info";
    this.automations = new AutomationService(this);
    this.usage = new UsageService(this);
    this.marketplace = new MarketplaceService(this);
    this.projects = new ProjectService(this);
    this.claudeCode = new ClaudeCodeService(this);
    this.codex = new CodexService(this);
    this.index = new IndexService(this);
    this.worktrees = new WorktreeService(this);
    this.memory = new MemoryService(this);
    this.checkpoints = new CheckpointService(this);
    this.completions = new CompletionService(this);
    this.groups = new GroupService(this);
  }

  health() {
    return { ok: true };
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

  alive(runId: string, generation: number): boolean {
    const run = this.store.state.runs.find((item) => item.id === runId);
    return Boolean(run && (run.generation ?? 0) === generation);
  }

  guard(agentId: string): void {
    const agent = this.getAgent(agentId);
    if (agent.status === "paused") throw new HttpError(409, "Agent is paused");
  }

  /** Installs the built-ins only when something is missing, so the desktop's polling reads never rewrite the state file. */
  async ensureBuiltins(): Promise<void> {
    if (this.builtinsInstalled(this.store.state)) return;
    await this.store.update((state) => this.installBuiltins(state));
  }

  /** True when installBuiltins would change nothing. */
  builtinsInstalled(state: AppState): boolean {
    const [first] = state.mcp;
    const cuItem = state.mcp.find((item) => item.id === CURSOR_COMPUTER_USE_ID || item.id === "cursor-computer-use");
    const originItem = state.mcp.find((item) => item.id === CURSOR_ORIGIN_ID || item.id === "cursor-origin");
    const agItem = state.mcp.find((item) => item.id === ANTIGRAVITY_SKILLS_ID || item.id === "antigravity-skills");
    const hasComputerUse = cuItem?.id === CURSOR_COMPUTER_USE_ID && cuItem?.url === CURSOR_COMPUTER_USE_URL;
    const hasOrigin = originItem?.id === CURSOR_ORIGIN_ID && originItem?.url === CURSOR_ORIGIN_URL;
    const hasAntigravity = agItem?.id === ANTIGRAVITY_SKILLS_ID && agItem?.url === ANTIGRAVITY_SKILLS_URL;
    const browserItem = state.mcp.find((item) => item.id === BROWSER_ID);
    const hasBrowser = browserItem?.url === BROWSER_URL && JSON.stringify(browserItem.tools) === JSON.stringify(browserSkills().tools);
    return (
      hasBrowser &&
      first?.id === GENERAL_SKILLS_ID &&
      state.mcp.filter((item) => item.id === GENERAL_SKILLS_ID).length === 1 &&
      JSON.stringify(first) === JSON.stringify(generalSkills()) &&
      hasComputerUse &&
      hasOrigin &&
      hasAntigravity &&
      !state.agents.some((item) => item.id === SATURN_AGENT_ID) &&
      !state.runs.some((item) => item.agentId === SATURN_AGENT_ID) &&
      state.agents.every((agent) => agent.mcpConnectionIds.includes(GENERAL_SKILLS_ID))
    );
  }

  installBuiltins(state: AppState): void {
    const skills = generalSkills();
    const cu = cursorComputerUseSkills();
    const origin = cursorOriginSkills();
    const ag = antigravitySkills();
    const browser = browserSkills();
    const existingBrowser = state.mcp.find((item) => item.id === BROWSER_ID);
    if (existingBrowser?.disabledTools) browser.disabledTools = existingBrowser.disabledTools;

    const existingCu = state.mcp.find((item) => item.id === CURSOR_COMPUTER_USE_ID || item.id === "cursor-computer-use");
    if (existingCu?.disabledTools) cu.disabledTools = existingCu.disabledTools;

    const existingOrigin = state.mcp.find((item) => item.id === CURSOR_ORIGIN_ID || item.id === "cursor-origin");
    if (existingOrigin?.disabledTools) origin.disabledTools = existingOrigin.disabledTools;

    const existingAg = state.mcp.find((item) => item.id === ANTIGRAVITY_SKILLS_ID || item.id === "antigravity-skills");
    if (existingAg?.disabledTools) ag.disabledTools = existingAg.disabledTools;

    const others = state.mcp.filter(
      (item) =>
        item.id !== GENERAL_SKILLS_ID &&
        item.id !== CURSOR_COMPUTER_USE_ID &&
        item.id !== "cursor-computer-use" &&
        item.id !== CURSOR_ORIGIN_ID &&
        item.id !== "cursor-origin" &&
        item.id !== ANTIGRAVITY_SKILLS_ID &&
        item.id !== "antigravity-skills" &&
        item.id !== BROWSER_ID,
    );
    state.mcp = [skills, cu, origin, ag, browser, ...others];
    state.agents = state.agents.filter((item) => item.id !== SATURN_AGENT_ID);
    state.runs = state.runs.filter((item) => item.agentId !== SATURN_AGENT_ID);
    const defaultBuiltins = [GENERAL_SKILLS_ID, CURSOR_COMPUTER_USE_ID, CURSOR_ORIGIN_ID, ANTIGRAVITY_SKILLS_ID, BROWSER_ID];
    for (const agent of state.agents) {
      const mapped = agent.mcpConnectionIds.map((id) => {
        if (id === "cursor-computer-use") return CURSOR_COMPUTER_USE_ID;
        if (id === "cursor-origin") return CURSOR_ORIGIN_ID;
        if (id === "antigravity-skills") return ANTIGRAVITY_SKILLS_ID;
        return id;
      });
      if (mapped.length === 1 && mapped[0] === GENERAL_SKILLS_ID) {
        agent.mcpConnectionIds = [...defaultBuiltins];
      } else {
        const next = withGeneralSkills(mapped);
        // The browser joins agents that have the other built-in servers (an earlier default set), not custom picks.
        const hadDefaults = [CURSOR_COMPUTER_USE_ID, CURSOR_ORIGIN_ID, ANTIGRAVITY_SKILLS_ID].every((id) => next.includes(id));
        agent.mcpConnectionIds = hadDefaults && !next.includes(BROWSER_ID) ? [...next, BROWSER_ID] : next;
      }
    }
  }

  /** Writes to the runtime log (see infrastructure/logger.ts). */
  log(service: string, level: LogLevel, message: string, attributes?: Attributes) {
    logger.log(service, level, message, attributes);
  }

  route(serverId: string, toolId: string, description: string, inputSchema?: Record<string, unknown>): ToolRoute {
    return {
      toolId,
      serverId,
      description,
      inputSchema: inputSchema && inputSchema.type ? inputSchema : { type: "object", properties: {} },
      environments: ["production"],
    };
  }
}
