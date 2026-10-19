import type { Express } from "express";
import type { AppServices } from "../application/services.js";
import { param, respond } from "./http.js";

export function mountAutomations(app: Express, services: AppServices): void {
  app.get("/automations", (_req, res, next) => {
    respond(res, next, () => services.listAutomations());
  });

  app.post("/automations", (req, res, next) => {
    respond(res, next, () => services.createAutomation(req.body), 201);
  });

  app.post("/automations/draft", (req, res, next) => {
    respond(res, next, () => services.draftAutomation(req.body ?? {}));
  });

  app.patch("/automations/:id", (req, res, next) => {
    respond(res, next, () => services.updateAutomation(param(req.params.id), req.body));
  });

  app.delete("/automations/:id", (req, res, next) => {
    respond(res, next, () => services.deleteAutomation(param(req.params.id)), 204);
  });

  app.post("/automations/:id/run", (req, res, next) => {
    respond(res, next, () => services.runAutomation(param(req.params.id)));
  });
}
