export type ResponseStyle = "concise" | "professional" | "detailed";
export type Autonomy = "suggest_only" | "execute_when_allowed" | "fully_autonomous";
export type Access = "none" | "read" | "write";

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

export type Model = { id: string; name: string; provider?: string; model?: string; baseUrl: string; hasSecret: boolean };
export type Mcp = { id: string; name: string; url: string; origin?: "local" | "organization" | "saturn"; tools: { toolId: string }[] };
export type Rag = { id: string; name: string; url: string };

export type RunAction = { toolId: string; status: string };
export type Run = {
  id: string;
  agentId?: string;
  input: string;
  output: string;
  thinking?: string;
  status: string;
  actions: RunAction[];
  error?: string;
};

export type Session = {
  loggedIn: boolean;
  email: string | null;
  name: string | null;
  role: string | null;
  team?: Access;
  agents?: Access;
  organization: { id: string; name: string } | null;
  paired: boolean;
  connected: boolean;
  cloudError?: string;
};

export type CloudLink = { paired: boolean; connected: boolean };

export type Profile = { name: string; environment: string; heartbeatSeconds: number; logging: string };
export type PendingTask = { id: string; agentId: string; agentName: string; input: string; toolId: string };

export type LlmProvider = { id: string; label: string; needsKey: boolean; baseUrl: string; models: { id: string; label: string }[] };
export type LlmChoice = { id: string; label: string };

export type Key = {
  id: string;
  name: string;
  secretName: string;
  baseUrl: string;
  hasSecret: boolean;
  allowedCallers: string[];
  allowedPaths: string[];
  native: boolean;
  required: boolean;
  status: string;
};

export type RuntimeInfo = {
  version: string;
  listen: string;
  name: string;
  environment: string;
  runtimeId: string;
  sessionId: string | null;
  organizationId: string | null;
  saturnEndpoint: string | null;
  broker: string;
  mcpServers: string[];
};

export type LogLine = { seq: number; ts: string; service: string; level: string; message: string };
export type Check = { group: string; name: string; ok: boolean; detail: string };

export type OrgProfile = {
  name: string;
  email: string;
  title: string;
  role: string;
  status: string;
};

export type Member = OrgProfile & {
  id: string;
  permissions?: { agents?: string };
  agent_ids?: string[];
  agent_edit_ids?: string[] | null;
};
