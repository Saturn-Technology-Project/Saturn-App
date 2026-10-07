import express, { type NextFunction, type Request, type Response } from "express";
import { AppServices } from "../application/services.js";
import { HttpError } from "../domain/errors.js";
import { Broker } from "../infrastructure/broker.js";
import { CloudSession, type CloudOptions } from "../infrastructure/cloud.js";
import { McpClient } from "../infrastructure/mcp.js";
import { FileStore } from "../infrastructure/store.js";
import { mountAdmin } from "./admin-controller.js";
import { mountAgents } from "./agents-controller.js";
import { mountConnections } from "./connections-controller.js";
import { mountRuns } from "./runs-controller.js";
import { mountSession } from "./session-controller.js";

function loopbackOrigin(origin: string | undefined) {
  if (!origin || origin === "null") return "null";
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

export function createApp(store: FileStore, options: CloudOptions = {}) {
  const services = new AppServices(store, new Broker(store), new McpClient(), new CloudSession(store, options));
  const app = express();
  app.use((req, res, next) => {
    const origin = loopbackOrigin(req.header("origin"));
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.method === "OPTIONS") {
      next();
      return;
    }
    const path = req.path;
    const open =
      (req.method === "GET" && (path === "/health" || path === "/session")) ||
      (req.method === "POST" && path === "/session/login") ||
      (req.method === "DELETE" && path === "/session");
    if (open || services.session().loggedIn) {
      next();
      return;
    }
    res.status(401).json({ error: "Sign in required" });
  });

  mountAdmin(app, services);
  mountAgents(app, services);
  mountRuns(app, services);
  mountConnections(app, services);
  mountSession(app, services);

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    const message = error instanceof Error ? error.message : "Runtime error";
    res.status(400).json({ error: message });
  });

  return { app, services };
}
