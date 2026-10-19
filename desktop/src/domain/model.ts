export type ResponseStyle = "concise" | "professional" | "detailed";
export type Autonomy =
  | "default"
  | "bypass"
  | "auto"
  | "turbo"
  | "review"
  | "suggest_only"
  | "execute_when_allowed"
  | "fully_autonomous";

export type Agent = {
  id: string;
  name: string;
  instructions: string;
  description: string;
  responseStyle?: ResponseStyle;
  autonomy?: Autonomy;
  temperature?: number;
  maxOutput?: number;
  status: string;
  modelConnectionId: string | null;
  canEdit?: boolean;
  mcpConnectionIds: string[];
  ragConnectionIds: string[];
};

export type Model = {
  id: string;
  name: string;
  provider?: string;
  model?: string;
  baseUrl: string;
  hasSecret: boolean;
  /** Reasoning effort for Claude Code models. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
};
export type McpTool = { toolId: string; description?: string; category?: "read" | "write"; inputSchema?: Record<string, unknown> };
export type Mcp = { id: string; name: string; url: string; origin?: "local"; tools: McpTool[]; disabledTools?: string[] };
export type Rag = { id: string; name: string; url: string };

export type Project = {
  id: string;
  name: string;
  /** The primary folder (folders[0]): where agents run and what the IDE opens. */
  path: string;
  /** Every folder in this workspace, primary first. */
  folders?: string[];
  /** Set once the user allowed agents to work in this folder. */
  access?: { grantedAt: string } | null;
  gitBranch?: string | null;
  gitStatus?: string | null;
  description?: string;
  rules?: string;
  lastOpenedAt?: string;
  isDefault?: boolean;
};

export type Conversation = {
  id: string;
  agentId: string;
  /** The project folder this chat works in. */
  projectId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type RunAction = {
  id?: string;
  toolId: string;
  arguments?: Record<string, unknown>;
  status: string;
  result?: unknown;
  reason?: string;
};
/** Reasoning from one model call; `at` is how many actions came before it. */
export type RunThought = { text: string; seconds: number; at: number };
export type Run = {
  id: string;
  agentId?: string;
  threadId?: string;
  input: string;
  output: string;
  thinking?: string;
  thoughts?: RunThought[];
  status: string;
  actions: RunAction[];
  error?: string;
  /** Set while the run is "sleeping" on a long computer_wait. */
  wake?: { at: string; since: string; reason?: string; actionId: string; requestedMs: number };
  /** Files the run changed in its project folder (sha256 before/after; null = did not exist). */
  checkpoint?: { root: string; files: { path: string; before: string | null; after: string | null; review?: "kept" | "reverted" }[] };
  /** Set on a group chat turn: the group and the message the agent was asked to consider. */
  groupId?: string;
  groupMessageId?: string;
};

/** A group chat of the user and several agents; each agent decides whether a message needs it. */
export type Group = { id: string; name: string; agentIds: string[]; createdAt: string; updatedAt: string; lastMessage?: GroupMessage };
export type GroupMessage = {
  id: string;
  groupId: string;
  /** Absent for the user. */
  agentId?: string;
  text: string;
  createdAt: string;
  runId?: string;
  /** The agent's turn failed; `text` is the reason. */
  error?: boolean;
  depth: number;
};
export type GroupTranscript = { group: Group; messages: GroupMessage[]; runs: Run[] };

/** One file a run changed, with its unified diff, from GET /runs/:id/changes. */
export type FileChange = {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  binary: boolean;
  diff: string;
  truncated: boolean;
  review: "pending" | "kept" | "reverted";
  /** The file on disk no longer matches what the run left (a later turn or the user changed it). */
  modifiedSince: boolean;
};
export type RunChanges = { runId: string; root: string | null; files: FileChange[] };

export type UsageTally = { calls: number; inputTokens: number; outputTokens: number; costUsd: number; unpricedCalls: number };
export type ModelUsage = UsageTally & { provider: string; model: string; label: string; price: string | null };
export type AgentUsage = UsageTally & {
  agentId: string;
  name: string;
  exists: boolean;
  models: (UsageTally & { provider: string; model: string; label: string })[];
};
/** Token and cost totals, from usage recorded per call with the agent, model and official rate at that moment. */
export type UsageSummary = { currency: "USD"; since: string | null; totals: UsageTally; models: ModelUsage[]; agents: AgentUsage[] };

export type LaunchApp = "agent" | "ide";
export type Profile = {
  name: string;
  environment: string;
  logging: string;
  launchApp?: LaunchApp;
  /** The model Saturn IDE's Tab completion and Cmd+K edit use; null turns them off. */
  completionModelId?: string | null;
};
export type PendingTask = { id: string; agentId: string; agentName: string; input: string; toolId: string };

export type LlmProvider = { id: string; label: string; needsKey: boolean; baseUrl: string; models: { id: string; label: string }[] };
export type LlmChoice = { id: string; label: string };

export type RuntimeInfo = {
  version: string;
  listen: string;
  name: string;
  environment: string;
  runtimeId: string;
  mcpServers: string[];
};

export type LogLine = {
  seq: number;
  ts: string;
  service: string;
  level: "debug" | "info" | "warning" | "error";
  message: string;
  attributes?: Record<string, unknown>;
};

export type AutomationFrequency = "hourly" | "daily" | "weekdays" | "weekly";
export type AutomationTrigger = { frequency: AutomationFrequency; time: string; weekday: number };
export type Automation = {
  id: string;
  name: string;
  agentId: string;
  agentName: string;
  prompt: string;
  trigger: AutomationTrigger;
  timeZone: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastRunId?: string;
  lastError?: string;
  nextRun: string | null;
};
export type AutomationInput = Pick<Automation, "name" | "agentId" | "prompt" | "trigger" | "timeZone"> & { enabled?: boolean };
export type AutomationDraft = Pick<Automation, "name" | "prompt" | "trigger">;

export type AttributeValue = string | number | boolean | (string | number | boolean | null)[] | null | undefined;
export type Attributes = Record<string, AttributeValue>;

export type TelemetryMode = "disabled" | "local" | "console" | "otlp";
export type TelemetryStatus = {
  mode: TelemetryMode;
  serviceName: string;
  endpoint: string | null;
  /** Where the runtime saves telemetry as JSON; null when telemetry is disabled. */
  file: string | null;
  savedAt: string | null;
  traces: number;
  errorTraces: number;
  logs: number;
};
export type TraceSummary = {
  traceId: string;
  rootName: string;
  startMs: number;
  durationMs: number;
  spanCount: number;
  errorCount: number;
  routine: boolean;
};
export type SpanKindName = "internal" | "server" | "client" | "producer" | "consumer";
export type SpanRecord = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: SpanKindName;
  scope: string;
  startMs: number;
  durationMs: number;
  status: "unset" | "ok" | "error";
  statusMessage?: string;
  attributes: Attributes;
  events: { name: string; timeMs: number; attributes: Attributes }[];
};
export type TelemetryLog = {
  timeMs: number;
  severity: string;
  severityNumber: number;
  body: string;
  attributes: Attributes;
  traceId?: string;
  spanId?: string;
};
export type MetricPoint = {
  attributes: Attributes;
  value?: number;
  histogram?: { count: number; sum: number; min?: number; max?: number; boundaries: number[]; counts: number[] };
};
export type MetricView = {
  name: string;
  description: string;
  unit: string;
  type: "sum" | "gauge" | "histogram";
  monotonic?: boolean;
  points: MetricPoint[];
};

/** How a Customizations integration signs in (see runtime/src/domain/marketplace.ts). */
export type InstallAuth = "none" | "oauth" | "oauth-client" | "token";
export type MarketplaceEntry = {
  id: string;
  available: boolean;
  reason?: string;
  auth?: InstallAuth;
  setupUrl?: string;
  setupHint?: string;
  tokenAlternative?: boolean;
  installed: null | {
    connectionId: string;
    status: "connecting" | "signing_in" | "ready" | "error";
    detail?: string;
    authorizationUrl?: string;
    tools: number;
    agents: number;
  };
};
export type InstallRequest = { name?: string; token?: string; clientId?: string; clientSecret?: string; attach?: "all" | "none" };
