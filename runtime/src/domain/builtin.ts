import type { Agent, McpConnection, ToolRoute } from "./model.js";

export const SATURN_AGENT_ID = "saturn-agent";
export const GENERAL_SKILLS_ID = "general-skills";
export const BUILTIN_MCP_URL = "builtin://general-skills";

export function withGeneralSkills(ids: string[]): string[] {
  return ids.includes(GENERAL_SKILLS_ID) ? ids : [...ids, GENERAL_SKILLS_ID];
}

const skill = (toolId: string, description: string, properties: Record<string, unknown>, required: string[]): ToolRoute => ({
  toolId,
  serverId: GENERAL_SKILLS_ID,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  environments: ["production"],
  organizationId: null,
});

export function generalSkills(): McpConnection {
  return {
    id: GENERAL_SKILLS_ID,
    name: "General Skills",
    url: BUILTIN_MCP_URL,
    tools: [
      skill("chat", "Record the reply the user should see.", { message: { type: "string" } }, ["message"]),
      skill(
        "files",
        "List, read, write, or patch files in the workspace. A patch starts with *** Begin Patch and ends with *** End Patch. File sections are *** Add File, *** Update File, or *** Delete File. Update hunks use @@ and lines that start with a space, + or -.",
        {
          action: { type: "string", enum: ["list", "read", "write", "patch"] },
          path: { type: "string" },
          content: { type: "string" },
          patch: { type: "string" },
          offset: { type: "integer" },
          limit: { type: "integer" },
        },
        ["action"],
      ),
      skill(
        "code",
        "Run a shell command in the workspace. cwd must stay inside the workspace. timeout is milliseconds, at most 30000.",
        { command: { type: "string" }, cwd: { type: "string" }, timeout: { type: "integer" } },
        ["command"],
      ),
      skill(
        "mcp",
        "Call a tool on another MCP server that is enabled for this agent.",
        { tool: { type: "string" }, arguments: { type: "object" } },
        ["tool"],
      ),
      skill("web", "Fetch the readable text of a public http or https page.", { url: { type: "string" } }, ["url"]),
      skill(
        "multi_step",
        "Keep the plan for this task. Each step has a status of pending, in_progress, or completed. Until the plan is finished, exactly one step is in progress.",
        {
          explanation: { type: "string" },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                step: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["step", "status"],
            },
          },
        },
        ["steps"],
      ),
    ],
  };
}

export function saturnAgent(current: Agent | undefined, modelConnectionId: string | null, canEdit: boolean): Agent {
  return {
    id: SATURN_AGENT_ID,
    name: "Saturn Agents",
    description: current?.description || "General assistant built into Saturn Runtime.",
    instructions:
      current?.instructions ||
      "You are Saturn Agents, the general assistant built into Saturn Runtime. Reply with chat. Use files to list, read, write, and patch the workspace, code to run a command there, web for a public page, and mcp for another enabled tool. For work that takes more than one action, keep a multi_step plan with exactly one step in progress until it is finished.",
    responseStyle: current?.responseStyle ?? "professional",
    autonomy: current?.autonomy ?? "execute_when_allowed",
    temperature: current?.temperature ?? 0.2,
    maxOutput: current?.maxOutput ?? 4000,
    status: current?.status ?? "active",
    canEdit,
    modelConnectionId,
    mcpConnectionIds: withGeneralSkills((current?.mcpConnectionIds ?? []).filter((id) => id !== SATURN_AGENT_ID)),
    ragConnectionIds: current?.ragConnectionIds ?? [],
  };
}
