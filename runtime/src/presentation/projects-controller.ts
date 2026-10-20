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

  // The project's local semantic code index: build (incrementally), status, cancel, and search.
  app.get("/projects/:id/index", (req, res, next) => {
    respond(res, next, () => services.kernel.index.status(param(req.params.id)));
  });

  app.post("/projects/:id/index", (req, res, next) => {
    const paths = Array.isArray(req.body?.paths) ? (req.body.paths as unknown[]).map(String) : undefined;
    respond(res, next, () => services.kernel.index.build(param(req.params.id), paths));
  });

  app.delete("/projects/:id/index", (req, res, next) => {
    respond(res, next, () => {
      services.kernel.index.cancel(param(req.params.id));
      return services.kernel.index.status(param(req.params.id));
    });
  });

  app.get("/projects/:id/index/search", (req, res, next) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));
    respond(res, next, () => services.kernel.index.search(param(req.params.id), String(req.query.q ?? ""), limit));
  });

  // The Agent App's "@" attachments: files, a folder, git changes, a page, the terminal, the check command's output.
  app.post("/projects/:id/context", (req, res, next) => {
    const stop = new AbortController();
    // Only a client that leaves before the answer stops the work (a request "closes" once its body is read).
    res.on("close", () => {
      if (!res.writableEnded) stop.abort();
    });
    respond(res, next, () => services.kernel.context.expand(param(req.params.id), Array.isArray(req.body?.items) ? req.body.items : [], stop.signal));
  });

  app.get("/projects/:id/files", (req, res, next) => {
    respond(res, next, () => services.kernel.context.files(param(req.params.id), typeof req.query.q === "string" ? req.query.q : "", Number(req.query.limit) || 200));
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
