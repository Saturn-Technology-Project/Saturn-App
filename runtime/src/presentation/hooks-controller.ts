import type { Express } from "express";
import type { AppServices } from "../application/services.js";
import { param, respond } from "./http.js";

/** Hooks: the user's own (every project), and a project's file hooks with the user's approval of each set. */
export function mountHooks(app: Express, services: AppServices): void {
  app.get("/hooks", (req, res, next) => {
    respond(res, next, () => services.kernel.hooks.sets(typeof req.query.projectId === "string" && req.query.projectId ? req.query.projectId : undefined));
  });

  app.put("/hooks", (req, res, next) => {
    respond(res, next, () => services.kernel.hooks.setUserHooks(req.body?.hooks));
  });

  app.post("/projects/:id/hooks/approve", (req, res, next) => {
    respond(res, next, () => services.kernel.hooks.approve(param(req.params.id), String(req.body?.file ?? ""), String(req.body?.fingerprint ?? "")));
  });

  app.delete("/projects/:id/hooks/approve", (req, res, next) => {
    respond(res, next, () => services.kernel.hooks.revoke(param(req.params.id), String(req.body?.file ?? "")));
  });
}
