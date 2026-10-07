import type { Express } from "express";
import type { AppServices } from "../application/services.js";
import { param, respond } from "./http.js";

export function mountAgents(app: Express, services: AppServices): void {
  app.get("/agents", (req, res, next) => {
    respond(res, next, async () => {
      await services.syncSignedInState();
      return services.listAgents();
    });
  });

  app.post("/agents", (req, res, next) => {
    respond(res, next, () => services.createAgent(req.body), 201);
  });

  app.get("/agents/:id/messages", (req, res, next) => {
    respond(res, next, () => services.messagesFor(param(req.params.id)));
  });

  app.get("/agents/:id", (req, res, next) => {
    respond(res, next, () => services.getAgent(param(req.params.id)));
  });

  app.patch("/agents/:id", (req, res, next) => {
    respond(res, next, () => services.updateAgent(param(req.params.id), req.body));
  });

  app.delete("/agents/:id", (req, res, next) => {
    respond(res, next, () => services.deleteAgent(param(req.params.id)), 204);
  });
}
