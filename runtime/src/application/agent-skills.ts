import { IDE_ID } from "../domain/ide-tools.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GENERAL_SKILLS_ID } from "../domain/builtin.js";
import type { Agent, RunAction } from "../domain/model.js";
import type { RuntimeKernel } from "./kernel.js";

/** The MCP server name Claude Code and Codex see Saturn's skills under. */
export const SKILLS_SERVER = "saturn";

export type BridgedTool = { name: string; description: string; inputSchema: Record<string, unknown> };

/** Runs one bridged tool call (approval included) and answers with the action it became. */
export type BridgedCall = (toolId: string, args: Record<string, unknown>) => Promise<RunAction>;

/** Where the runtime listens; Codex reaches the skills endpoint here. */
export function runtimeOrigin(): string {
  return `http://${process.env.SATURN_RUNTIME_HOST ?? "127.0.0.1"}:${process.env.SATURN_RUNTIME_PORT ?? 4700}`;
}

/**
 * The Saturn tools a Claude Code or Codex agent gets: every skill and MCP server attached to the agent, except
 * General Skills, whose files, shell, web, MCP and plan tools are the program's own tools under other names.
 */
export function bridgedTools(kernel: RuntimeKernel, agent: Agent, workdir?: string): BridgedTool[] {
  // The editor tools only when Saturn IDE has the project open.
  const ide = kernel.ide.available(workdir);
  return kernel.store.state.mcp
    .filter((server) => server.id !== GENERAL_SKILLS_ID && agent.mcpConnectionIds.includes(server.id))
    .filter((server) => server.id !== IDE_ID || ide)
    .flatMap((server) =>
      server.tools
        .filter((tool) => !server.disabledTools?.includes(tool.toolId))
        .map((tool) => ({
          name: tool.toolId,
          description: tool.description,
          inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },
        })),
    );
}

/** An MCP server over the bridged tools, for the Agent SDK's in-process transport or Codex's HTTP one. */
export function skillsServer(tools: BridgedTool[], call: BridgedCall): McpServer {
  const mcp = new McpServer({ name: SKILLS_SERVER, version: "1.0.0" }, { capabilities: { tools: {} } });
  // The low-level handlers take the tools' JSON schemas as they are; McpServer's own registerTool wants zod.
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: { type: "object" as const, ...tool.inputSchema } })),
  }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!tools.some((tool) => tool.name === name)) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    return toolResult(await call(name, (args ?? {}) as Record<string, unknown>));
  });
  return mcp;
}

/** A finished action as an MCP tool result: an MCP server's own content as it came, a screenshot as an image. */
export function toolResult(action: RunAction): CallToolResult {
  if (action.status !== "completed") {
    return { content: [{ type: "text", text: action.reason || (action.status === "denied" ? "The user denied this action." : `The tool ${action.status}.`) }], isError: true };
  }
  const result = action.result;
  if (result && typeof result === "object" && Array.isArray((result as { content?: unknown }).content)) return result as CallToolResult;
  if (result && typeof result === "object") {
    const { image, screenshot, ...rest } = result as Record<string, unknown>;
    const picture = typeof image === "string" ? image : typeof screenshot === "string" ? screenshot : undefined;
    const match = picture?.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      return {
        content: [
          { type: "image", mimeType: match[1]!, data: match[2]! },
          ...(Object.keys(rest).length ? [{ type: "text" as const, text: JSON.stringify(rest) }] : []),
        ],
      };
    }
  }
  return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result ?? null) }] };
}
