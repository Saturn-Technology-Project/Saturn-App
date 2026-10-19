import type { Express } from "express";
import type { AppServices } from "../application/services.js";
import { param, respond } from "./http.js";

export function mountRuns(app: Express, services: AppServices): void {
  app.get("/usage", (_req, res, next) => {
    respond(res, next, () => services.usage());
  });

  app.get("/usage/summary", (_req, res, next) => {
    respond(res, next, () => services.usageSummary());
  });

  // One plain model call for Saturn IDE's Tab completion and Cmd+K edit. Closing the request aborts it.
  app.post("/complete", (req, res, next) => {
    const stop = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) stop.abort();
    });
    respond(res, next, () => services.kernel.completions.complete(req.body ?? {}, stop.signal));
  });

  app.get("/tasks", (_req, res, next) => {
    respond(res, next, () => services.pendingTasks());
  });

  app.post("/agents/:id/runs", (req, res, next) => {
    respond(res, next, () => services.startRun(param(req.params.id), String(req.body.input ?? ""), req.body?.threadId ? String(req.body.threadId) : undefined, req.body?.projectId ? String(req.body.projectId) : undefined), 201);
  });

  app.get("/agents/:id/threads", (req, res, next) => {
    respond(res, next, () => services.listThreads(param(req.params.id)));
  });

  app.post("/agents/:id/threads", (req, res, next) => {
    respond(res, next, () => services.createThread(param(req.params.id), req.body?.title ? String(req.body.title) : undefined, req.body?.projectId ? String(req.body.projectId) : undefined), 201);
  });

  app.patch("/threads/:id", (req, res, next) => {
    respond(res, next, () => services.renameThread(param(req.params.id), String(req.body?.title ?? "")));
  });

  app.delete("/threads/:id", (req, res, next) => {
    respond(res, next, () => services.deleteThread(param(req.params.id)), 204);
  });

  app.get("/runs/:id", (req, res, next) => {
    respond(res, next, () => services.getRun(param(req.params.id)));
  });

  // Review of the files a run changed in its project folder (see CheckpointService).
  app.get("/runs/:id/changes", (req, res, next) => {
    respond(res, next, () => services.runChanges(param(req.params.id)));
  });

  // Body { path } reverts one file; without it, every file the run changed.
  app.post("/runs/:id/changes/revert", (req, res, next) => {
    respond(res, next, () => services.revertRunChanges(param(req.params.id), typeof req.body?.path === "string" ? req.body.path : undefined));
  });

  app.post("/runs/:id/changes/keep", (req, res, next) => {
    respond(res, next, () => services.keepRunChanges(param(req.params.id)));
  });

  // "Restore to before this turn": reverts this run and every later run in its chat.
  app.post("/runs/:id/restore", (req, res, next) => {
    respond(res, next, () => services.restoreToRun(param(req.params.id)));
  });

  // Answers an approval card (Claude Code runs wait on it while the SDK holds the tool call).
  app.post("/runs/:id/actions/:actionId/decision", (req, res, next) => {
    respond(res, next, () => {
      services.kernel.claudeCode.decide(param(req.params.id), param(req.params.actionId), req.body?.allow === true);
      return { ok: true };
    });
  });

  app.get("/claude-code/status", (_req, res, next) => {
    respond(res, next, () => services.kernel.claudeCode.status());
  });

  app.post("/claude-code/logout", (_req, res, next) => {
    respond(res, next, () => services.kernel.claudeCode.logout());
  });

  app.post("/runs/:id/wake", (req, res, next) => {
    respond(res, next, () => services.wakeRun(param(req.params.id)));
  });

  app.post("/runs/:id/stop", (req, res, next) => {
    respond(res, next, () => services.stopRun(param(req.params.id)));
  });

  app.patch("/runs/:id", (req, res, next) => {
    respond(res, next, () => services.reviseRun(param(req.params.id), String(req.body.input ?? "")));
  });
}
