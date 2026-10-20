import type { Express } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { skillsServer } from "../application/agent-skills.js";
import type { AppServices } from "../application/services.js";
import { errorText, logger } from "../infrastructure/logger.js";

/** The skills endpoint's path; it takes a running Codex turn's own token instead of the runtime's. */
export const AGENT_SKILLS_PATH = "/agent-mcp";

/**
 * Saturn's skills as a stateless MCP server for Codex, which only reaches MCP servers out of process. The
 * bearer token picks the turn, and with it the agent's tools and approval setting; it stops working when
 * the turn ends.
 */
export function mountAgentSkills(app: Express, services: AppServices): void {
  app.post(AGENT_SKILLS_PATH, async (req, res) => {
    const header = req.header("authorization") ?? "";
    const bridge = services.kernel.codex.bridge(header.startsWith("Bearer ") ? header.slice(7) : undefined);
    if (!bridge) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const server = skillsServer(bridge.tools, bridge.call);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.warn("agent", `Skills call from Codex failed: ${errorText(error)}`);
      if (!res.headersSent) res.status(500).json({ error: "Skills call failed" });
    }
  });
  // Stateless: no session stream to open or close.
  app.all(AGENT_SKILLS_PATH, (_req, res) => {
    res.status(405).set("Allow", "POST").json({ error: "Method not allowed" });
  });
}
