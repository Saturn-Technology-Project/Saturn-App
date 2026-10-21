import type { Express } from "express";
import type { AppServices } from "../application/services.js";
import { param, respond } from "./http.js";

/** Plugins: install from a folder or a git URL, turn on or off, allow their hooks, remove. */
export function mountPlugins(app: Express, services: AppServices): void {
  app.get("/plugins", (_req, res, next) => {
    respond(res, next, () => services.kernel.plugins.list());
  });

  app.post("/plugins", (req, res, next) => {
    respond(res, next, () => services.kernel.plugins.install(String(req.body?.source ?? "")), 201);
  });

  app.patch("/plugins/:name", (req, res, next) => {
    respond(res, next, () => services.kernel.plugins.setEnabled(param(req.params.name), req.body?.enabled !== false));
  });

  app.post("/plugins/:name/hooks/approve", (req, res, next) => {
    respond(res, next, () => services.kernel.plugins.approveHooks(param(req.params.name), String(req.body?.fingerprint ?? "")));
  });

  app.delete("/plugins/:name", (req, res, next) => {
    respond(res, next, () => services.kernel.plugins.uninstall(param(req.params.name)), 204);
  });
}
