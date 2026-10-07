import type { Express } from "express";
import type { AppServices } from "../application/services.js";
import { param, respond } from "./http.js";

export function mountRuns(app: Express, services: AppServices): void {
  app.get("/tasks", (_req, res, next) => {
    respond(res, next, () => services.pendingTasks());
  });

  app.post("/agents/:id/runs", (req, res, next) => {
    respond(res, next, () => services.startRun(param(req.params.id), String(req.body.input ?? "")), 201);
  });

  app.get("/runs/:id", (req, res, next) => {
    respond(res, next, () => services.getRun(param(req.params.id)));
  });

  app.post("/runs/:id/stop", (req, res, next) => {
    respond(res, next, () => services.stopRun(param(req.params.id)));
  });

  app.patch("/runs/:id", (req, res, next) => {
    respond(res, next, () => services.reviseRun(param(req.params.id), String(req.body.input ?? "")));
  });
}
