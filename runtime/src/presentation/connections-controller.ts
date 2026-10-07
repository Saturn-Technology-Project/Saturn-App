import type { Express } from "express";
import type { AppServices } from "../application/services.js";
import { connectionKind, param, respond } from "./http.js";

export function mountConnections(app: Express, services: AppServices): void {
  app.get("/llm/providers", (_req, res) => {
    res.json(services.llmProviders());
  });

  app.get("/llm/lmstudio/models", (req, res, next) => {
    respond(res, next, () => services.lmStudioModels(typeof req.query.baseUrl === "string" ? req.query.baseUrl : ""));
  });

  app.get("/connections/:kind", (req, res, next) => {
    respond(res, next, () => services.listConnections(connectionKind(param(req.params.kind))));
  });

  app.post("/connections/models", (req, res, next) => {
    respond(res, next, () => services.createModel(req.body), 201);
  });

  app.patch("/connections/models/:id", (req, res, next) => {
    respond(res, next, () => services.updateModel(param(req.params.id), req.body));
  });

  app.post("/connections/mcp", (req, res, next) => {
    respond(res, next, () => services.createMcp(req.body), 201);
  });

  app.post("/connections/mcp/:id/discover", (req, res, next) => {
    respond(res, next, () => services.discoverMcp(param(req.params.id)));
  });

  app.patch("/connections/mcp/:id", (req, res, next) => {
    respond(res, next, () => services.updateMcp(param(req.params.id), req.body));
  });

  app.delete("/mcp/:id", (req, res, next) => {
    respond(res, next, () => services.deleteMcpServer(param(req.params.id)), 204);
  });

  app.post("/connections/rag", (req, res, next) => {
    respond(res, next, () => services.createRag(req.body), 201);
  });

  app.patch("/connections/rag/:id", (req, res, next) => {
    respond(res, next, () => services.updateRag(param(req.params.id), req.body));
  });

  app.delete("/connections/:kind/:id", (req, res, next) => {
    respond(res, next, () => services.deleteConnection(connectionKind(param(req.params.kind)), param(req.params.id)), 204);
  });
}
