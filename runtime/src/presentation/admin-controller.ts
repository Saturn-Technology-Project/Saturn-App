import type { Express } from "express";
import type { AppServices } from "../application/services.js";
import { param, respond } from "./http.js";

export function mountAdmin(app: Express, services: AppServices): void {
  app.get("/health", (_req, res) => {
    res.json(services.health());
  });

  app.get("/settings", (_req, res) => {
    res.json(services.settings());
  });

  app.patch("/settings", (req, res, next) => {
    respond(res, next, () => services.updateSettings(req.body));
  });

  app.get("/information", (_req, res) => {
    res.json(services.information());
  });

  app.get("/logs", (req, res) => {
    res.json(services.listLogs({
      service: typeof req.query.service === "string" ? req.query.service : "",
      level: typeof req.query.level === "string" ? req.query.level : "",
      q: typeof req.query.q === "string" ? req.query.q : "",
    }));
  });
}
