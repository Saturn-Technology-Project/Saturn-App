import type { Express } from "express";
import type { AppServices } from "../application/services.js";
import { param, respond } from "./http.js";

export function mountGroups(app: Express, services: AppServices): void {
  app.get("/groups", (_req, res, next) => {
    respond(res, next, () => services.listGroups());
  });

  app.post("/groups", (req, res, next) => {
    respond(res, next, () => services.createGroup(req.body ?? {}), 201);
  });

  app.patch("/groups/:id", (req, res, next) => {
    respond(res, next, () => services.updateGroup(param(req.params.id), req.body ?? {}));
  });

  app.delete("/groups/:id", (req, res, next) => {
    respond(res, next, () => services.deleteGroup(param(req.params.id)), 204);
  });

  app.get("/groups/:id/messages", (req, res, next) => {
    respond(res, next, () => services.groupTranscript(param(req.params.id)));
  });

  app.post("/groups/:id/messages", (req, res, next) => {
    respond(res, next, () => services.postGroupMessage(param(req.params.id), String(req.body?.text ?? "")), 201);
  });
}
