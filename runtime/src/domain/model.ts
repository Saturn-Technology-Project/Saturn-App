export type AgentStatus = "active" | "paused";
export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type ToolRoute = {
  toolId: string;
  serverId: string;
  description: string;
  inputSchema: Record<string, unknown>;
  environments: string[];
  organizationId: string | null;
};

export type ModelConnection = {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  brokerConnectionId: string;
  hasSecret: boolean;
};

export type McpOrigin = "local" | "organization" | "saturn";

export type McpConnection = {
  id: string;
  name: string;
  url: string;
  tools: ToolRoute[];
  origin?: McpOrigin;
};

export type RagConnection = {
  id: string;
  name: string;
  url: string;
};

export type ResponseStyle = "concise" | "professional" | "detailed";
export type Autonomy = "suggest_only" | "execute_when_allowed" | "fully_autonomous";

export type Agent = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  responseStyle: ResponseStyle;
  autonomy: Autonomy;
  temperature: number;
  maxOutput: number;
  status: AgentStatus;
  canEdit?: boolean;
  modelConnectionId: string | null;
  toolSetId?: string | null;
  mcpConnectionIds: string[];
  ragConnectionIds: string[];
};

export type RunAction = {
  id: string;
  toolId: string;
  arguments: Record<string, unknown>;
  status: "completed" | "denied" | "waiting_approval" | "failed";
  result?: unknown;
  reason?: string;
  thoughtSignature?: string;
};

export type Run = {
  id: string;
  agentId: string;
  userId?: string;
  organizationId?: string;
  input: string;
  status: RunStatus;
  output: string;
  thinking?: string;
  actions: RunAction[];
  error?: string;
  generation: number;
};

export type BrokerConnection = {
  id: string;
  name: string;
  baseUrl: string;
  secretName: string;
  allowedCallers: string[];
  allowedTools: string[];
  allowedPaths: string[];
  hasSecret: boolean;
};

export type Caller = {
  callerId: string;
  callerType: "runtime" | "mcp" | "admin";
  admin: boolean;
};

export type AppSettings = {
  name: string;
  environment: string;
  heartbeatSeconds: number;
  logging: "debug" | "info" | "warning" | "error";
};

export type AppState = {
  agents: Agent[];
  models: ModelConnection[];
  mcp: McpConnection[];
  rag: RagConnection[];
  runs: Run[];
  broker: BrokerConnection[];
  settings: AppSettings;
  account: {
    userId: string;
    email: string;
    name: string;
    title: string;
    organizationId: string;
    organizationName: string;
    role: string | null;
    team: "none" | "read" | "write";
    agents: "none" | "read" | "write";
    agentEditIds: string[] | null;
  } | null;
  session: {
    paired: boolean;
    connected: boolean;
    sessionId: string | null;
    organizationId: string | null;
    apiBase: string | null;
    wsUrl: string | null;
  };
};
