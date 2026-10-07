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

  app.get("/keys", (_req, res) => {
    res.json(services.listKeys());
  });

  app.post("/keys", (req, res, next) => {
    respond(res, next, () => services.createKey(req.body), 201);
  });

  app.put("/keys/:id/secret", (req, res, next) => {
    respond(res, next, () => services.rotateKey(param(req.params.id), String(req.body.value ?? "")));
  });

  app.delete("/keys/:id/secret", (req, res, next) => {
    respond(res, next, () => services.clearKey(param(req.params.id)));
  });

  app.delete("/keys/:id", (req, res, next) => {
    respond(res, next, () => services.deleteKey(param(req.params.id)), 204);
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

  app.get("/diagnostics", (_req, res) => {
    res.json(services.diagnostics());
  });
}
