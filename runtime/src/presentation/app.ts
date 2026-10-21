import express, { type NextFunction, type Request, type Response } from "express";
import { AppServices } from "../application/services.js";
import { HttpError } from "../domain/errors.js";
import { logger } from "../infrastructure/logger.js";
import { openInBrowser } from "../infrastructure/browser.js";
import { McpClient } from "../infrastructure/mcp.js";
import { mountMarketplace } from "./marketplace-controller.js";
import { FileStore } from "../infrastructure/store.js";
import { mountAdmin } from "./admin-controller.js";
import { mountAgents } from "./agents-controller.js";
import { mountAutomations } from "./automations-controller.js";
import { mountConnections } from "./connections-controller.js";
import { mountRuns } from "./runs-controller.js";
import { mountTelemetry } from "./telemetry-controller.js";
import { mountWorkspace } from "./workspace-controller.js";
import { mountProjects } from "./projects-controller.js";
import { mountGroups } from "./groups-controller.js";
import { mountPermissions } from "./permissions-controller.js";
import { mountHooks } from "./hooks-controller.js";
import { mountPlugins } from "./plugins-controller.js";
import { recordRequestError, traceRequests } from "./telemetry-middleware.js";
import { loadOrCreateToken, tokenMatches } from "../infrastructure/auth.js";
import { runtimeOrigin } from "../application/agent-skills.js";
import { AGENT_SKILLS_PATH, mountAgentSkills } from "./agent-skills-controller.js";

/**
 * The only cross-origin callers are Saturn's own windows, which load from a loopback origin. A web page on a
 * real site sends its own origin (rejected here); a sandboxed iframe or a `data:`/`file:` document sends the
 * literal "null", which must NOT be echoed back as allowed — doing so let any such page reach the runtime.
 */
function allowedOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if ((url.protocol === "http:" || url.protocol === "https:") && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) {
      return origin;
    }
  } catch {
    return null;
  }
  return null;
}

/** The Host must be loopback, so a page using a name that resolves to 127.0.0.1 (DNS rebinding) cannot reach us. */
function loopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return true;
  const host = hostHeader.split(":")[0].toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

/** Open to callers without the token: the health probe, and the OAuth redirect the provider's browser lands on. */
const OPEN_PATHS = new Set(["/health", "/oauth/callback"]);

export function createApp(store: FileStore) {
  const origin = runtimeOrigin();
  const token = loadOrCreateToken(store.root);
  const mcp = new McpClient({ vault: store, redirectUrl: `${origin}/oauth/callback`, openBrowser: openInBrowser });
  const services = new AppServices(store, mcp);
  const app = express();
  app.use((req, res, next) => {
    const origin = allowedOrigin(req.header("origin"));
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, traceparent, tracestate, baggage");
    // Lets the desktop read the file name the runtime suggests for telemetry downloads.
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
  // Authentication: loopback is not a trust boundary (any local process, or a web page via the browser, can
  // reach 127.0.0.1). Every request must carry the session token, which only this user's own processes can
  // read from the 0600 token file. The health probe and the OAuth redirect are the sole exceptions; the
  // skills endpoint checks a running Codex turn's own token instead.
  app.use((req, res, next) => {
    if (!loopbackHost(req.headers.host)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (OPEN_PATHS.has(req.path) || req.path === AGENT_SKILLS_PATH) {
      next();
      return;
    }
    const header = req.header("authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!tokenMatches(token, provided)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });
  app.use(traceRequests());
  app.use(express.json({ limit: "10mb" }));
  app.use(express.text({ type: ["application/x-ndjson", "text/*"], limit: "10mb" }));

  mountAdmin(app, services);
  mountAgents(app, services);
  mountRuns(app, services);
  mountConnections(app, services);
  mountWorkspace(app, services);
  mountProjects(app, services);
  mountAutomations(app, services);
  mountGroups(app, services);
  mountAgentSkills(app, services);
  mountTelemetry(app);
  mountMarketplace(app, services);
  mountPermissions(app, services);
  mountHooks(app, services);
  mountPlugins(app, services);

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    recordRequestError(res, error);
    if (error instanceof HttpError && error.status >= 500) {
      logger.error("http", `${req.method} ${req.path} failed: ${error.message}`);
    } else if (!(error instanceof HttpError)) {
      // Not a deliberate refusal: something threw that the handler did not expect.
      logger.warn("http", `${req.method} ${req.path} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    const message = error instanceof Error ? error.message : "Runtime error";
    res.status(400).json({ error: message });
  });

  return { app, services };
}
