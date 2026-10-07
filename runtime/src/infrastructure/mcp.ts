import type { ToolRoute } from "../domain/model.js";

export class McpClient {
  async listTools(url: string): Promise<ToolRoute[]> {
    const payload = await this.rpc(url, "tools/list", {});
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    return tools.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as { name?: unknown; description?: unknown; inputSchema?: unknown };
      if (typeof record.name !== "string") return [];
      return [
        {
          toolId: record.name,
          serverId: "",
          description: typeof record.description === "string" ? record.description : "",
          inputSchema:
            record.inputSchema && typeof record.inputSchema === "object"
              ? (record.inputSchema as Record<string, unknown>)
              : { type: "object", properties: {} },
          environments: ["production"],
          organizationId: null,
        },
      ];
    });
  }

  async call(
    url: string,
    toolId: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    headers: Record<string, string>,
  ): Promise<unknown> {
    return this.rpc(url, "tools/call", { name: toolId, arguments: args }, headers, signal);
  }

  private async rpc(
    url: string,
    method: string,
    params: unknown,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal,
      });
    } catch (error) {
      if (aborted(error)) throw error;
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
      throw new Error(cause ? `Could not reach ${url}: ${cause}` : `Could not reach ${url}`);
    }
    const body = (await response.json()) as { result?: Record<string, unknown>; error?: unknown };
    if (body.error) {
      const message =
        typeof body.error === "object" && body.error && "message" in body.error
          ? String((body.error as { message?: unknown }).message || "MCP call failed")
          : "MCP call failed";
      throw new Error(message);
    }
    return body.result ?? {};
  }
}

function aborted(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("name" in error && error.name === "AbortError") return true;
  return "cause" in error && aborted(error.cause);
}
