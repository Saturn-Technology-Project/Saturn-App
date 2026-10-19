import type { Express } from "express";
import type { AppServices } from "../application/services.js";
import { param, respond } from "./http.js";

export function mountProjects(app: Express, services: AppServices): void {
  app.get("/projects", (_req, res, next) => {
    respond(res, next, () => services.listProjects());
  });

  app.get("/projects/active", (_req, res, next) => {
    respond(res, next, () => services.getActiveProject());
  });

  app.post("/projects", (req, res, next) => {
    respond(res, next, () => services.createProject(req.body ?? {}), 201);
  });

  app.post("/projects/:id/active", (req, res, next) => {
    respond(res, next, () => services.setActiveProject(param(req.params.id)));
  });

  app.patch("/projects/:id", (req, res, next) => {
    respond(res, next, () => services.updateProject(param(req.params.id), req.body ?? {}));
  });

  app.delete("/projects/:id", (req, res, next) => {
    respond(res, next, () => services.deleteProject(param(req.params.id)), 204);
  });

  app.post("/projects/:id/access", (req, res, next) => {
    respond(res, next, () => services.setProjectAccess(param(req.params.id), req.body?.granted !== false));
  });

  app.post("/projects/:id/editor", (req, res, next) => {
    respond(res, next, () => services.openProjectEditor(param(req.params.id)));
  });

  app.post("/projects/:id/terminal", (req, res, next) => {
    respond(res, next, () => services.openProjectTerminal(param(req.params.id)));
  });

  app.post("/projects/:id/folder", (req, res, next) => {
    respond(res, next, () => services.openProjectFolder(param(req.params.id)));
  });

  app.get("/projects/:id/rules", (req, res, next) => {
    respond(res, next, () => services.getProjectRules(param(req.params.id)));
  });

  app.put("/projects/:id/rules", (req, res, next) => {
    const content = String(req.body?.content ?? "");
    const targetFile = req.body?.targetFile as "cursorrules" | "agents" | undefined;
    respond(res, next, () => services.saveProjectRules(param(req.params.id), content, targetFile));
  });
}
