export type CloudUser = {
  id?: string;
  email: string;
  name: string;
  role?: string | null;
  permissions?: { team?: string; agents?: string };
  agent_edit_ids?: string[] | null;
  employee?: { id?: string; title?: string; role?: string; status?: string } | null;
  organization: { id: string; name: string };
  agents?: {
    id: string;
    name: string;
    description?: string;
    status?: string;
    tool_set_id?: string | null;
    settings?: {
      instructions?: string;
      response_style?: string;
      autonomy?: string;
      tools?: string[] | null;
      knowledge?: { id?: string; enabled?: boolean }[];
      temperature?: number;
      max_output?: number;
      provider?: string;
      model?: string;
      base_url?: string;
      model_connection_id?: string;
    };
  }[];
  mcp_servers?: { id: string; name: string; endpoint: string; tools?: string[] }[];
  app_mcp?: {
    servers: { id: string; name: string; url: string; tools?: { tool_id: string; description?: string }[] }[];
    attachments?: Record<string, string[]>;
  };
  tool_sets?: {
    id: string;
    name: string;
    items?: { name: string; description?: string; input_schema?: Record<string, unknown> }[];
  }[];
};

export type CloudCredential = {
  id: string;
  kind: string;
  name: string;
  provider?: string;
  model?: string;
  base_url?: string;
  secret_name?: string;
  broker_id?: string;
  allowed_paths?: string[];
  has_secret?: boolean;
};

export function teamAccess(user: CloudUser): "none" | "read" | "write" {
  const level = user.permissions?.team;
  if (level === "read" || level === "write") return level;
  if (user.role === "admin") return "write";
  return "none";
}

export function agentsAccess(user: CloudUser): "none" | "read" | "write" {
  const level = user.permissions?.agents;
  if (level === "none" || level === "read" || level === "write") return level;
  if (user.role === "admin") return "write";
  return "none";
}

export function canEditAgent(user: CloudUser, agentId: string): boolean {
  if (teamAccess(user) === "write") return true;
  if (agentsAccess(user) !== "write") return false;
  if (user.agent_edit_ids == null) return true;
  return user.agent_edit_ids.includes(agentId);
}
