import type { Express } from "express";
import { imagePath, parseImages } from "../application/run-images.js";
import path from "node:path";
import type { RunMode } from "../domain/model.js";
import { HttpError } from "../domain/errors.js";
import type { AppServices } from "../application/services.js";
import { param, respond } from "./http.js";

export function mountRuns(app: Express, services: AppServices): void {
  app.get("/usage", (_req, res, next) => {
    respond(res, next, () => services.usage());
  });

  // ?from=&to= (ISO times) limit the totals to calls made in that window; the desktop sends local day bounds.
  app.get("/usage/summary", (req, res, next) => {
    const end = (value: unknown) => (typeof value === "string" ? value : undefined);
    respond(res, next, () => services.usageSummary({ from: end(req.query.from), to: end(req.query.to) }));
  });

  // One plain model call for Saturn IDE's Tab completion and Cmd+K edit. Closing the request aborts it.
  app.post("/complete", (req, res, next) => {
    const stop = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) stop.abort();
    });
    respond(res, next, () => services.kernel.completions.complete(req.body ?? {}, stop.signal));
  });

  // Tab completion as a stream: one JSON line per piece of text, the last with done: true (or an error line).
  app.post("/complete/stream", async (req, res) => {
    const stop = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) stop.abort();
    });
    res.setHeader("content-type", "application/x-ndjson");
    res.setHeader("cache-control", "no-cache");
    try {
      for await (const piece of services.kernel.completions.completeInlineStream({ ...(req.body ?? {}), kind: "inline" }, stop.signal)) {
        if (stop.signal.aborted) break;
        res.write(`${JSON.stringify(piece)}\n`);
      }
    } catch (error) {
      if (!stop.signal.aborted) {
        const status = error instanceof HttpError ? error.status : 500;
        res.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error), status })}\n`);
      }
    }
    res.end();
  });

  app.get("/tasks", (_req, res, next) => {
    respond(res, next, () => services.pendingTasks());
  });

  app.post("/agents/:id/runs", (req, res, next) => {
    respond(res, next, () => services.startRun(param(req.params.id), String(req.body.input ?? ""), req.body?.threadId ? String(req.body.threadId) : undefined, req.body?.projectId ? String(req.body.projectId) : undefined, {
      images: parseImages(req.body?.images),
      mode: parseMode(req.body?.mode),
    }), 201);
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

  // A chat's own git worktree: create it, read its state, and finish it (merge, keep the branch, or discard).
  app.post("/threads/:id/worktree", (req, res, next) => {
    respond(res, next, () => services.kernel.worktrees.create(param(req.params.id)), 201);
  });

  app.get("/threads/:id/worktree", (req, res, next) => {
    respond(res, next, () => services.kernel.worktrees.status(param(req.params.id)));
  });

  app.post("/threads/:id/worktree/finish", (req, res, next) => {
    const how = req.body?.how;
    respond(res, next, () => {
      if (how !== "merge" && how !== "keep" && how !== "discard") throw new HttpError(400, "how must be merge, keep or discard");
      return services.kernel.worktrees.finish(param(req.params.id), how, req.body?.message ? String(req.body.message) : undefined);
    });
  });

  // Saturn IDE's Agents view: what is running now, and what finished lately, optionally in one project.
  app.get("/runs", (req, res, next) => {
    respond(res, next, () => services.recentRuns(typeof req.query.projectId === "string" ? req.query.projectId : undefined, Number(req.query.limit) || 20));
  });

  // A pull request from a chat's worktree branch (pushes it first; needs the user's GitHub token).
  app.post("/threads/:id/pull-request", (req, res, next) => {
    respond(res, next, () => services.openPullRequest(param(req.params.id), {
      ...(typeof req.body?.title === "string" ? { title: req.body.title } : {}),
      ...(typeof req.body?.body === "string" ? { body: req.body.body } : {}),
    }), 201);
  });

  app.get("/runs/:id", (req, res, next) => {
    respond(res, next, () => services.getRun(param(req.params.id)));
  });

  // Browser recordings a run made (browser_record_start/stop): the list, one JPEG frame, and an MP4 export.
  app.get("/runs/:id/recordings", (req, res, next) => {
    respond(res, next, () => services.recordings(param(req.params.id)));
  });

  app.get("/runs/:id/recordings/:name/frames/:index", (req, res, next) => {
    try {
      const file = services.recordingFrame(param(req.params.id), param(req.params.name), Number(req.params.index));
      res.type("image/jpeg");
      res.sendFile(file, (error) => {
        if (error) next(new HttpError(404, "That frame is gone"));
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/runs/:id/recordings/:name/export", (req, res, next) => {
    respond(res, next, () => services.exportRecording(param(req.params.id), param(req.params.name)));
  });

  // An image the user attached to a message (see run-images.ts), for the chat to show.
  app.get("/runs/:id/images/:index", (req, res, next) => {
    try {
      const run = services.getRun(param(req.params.id));
      const relative = run.inputImages?.[Number(req.params.index)];
      if (!relative) throw new HttpError(404, "This message has no such image");
      const file = imagePath(services.kernel.store.root, relative);
      const types: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
      res.type(types[path.extname(file)] ?? "application/octet-stream");
      res.sendFile(file, (error) => {
        if (error) next(new HttpError(404, "The image file is gone"));
      });
    } catch (error) {
      next(error);
    }
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
    respond(res, next, () => services.keepRunChanges(param(req.params.id), typeof req.body?.path === "string" ? req.body.path : undefined));
  });

  // "Restore to before this turn": reverts this run and every later run in its chat.
  app.post("/runs/:id/restore", (req, res, next) => {
    respond(res, next, () => services.restoreToRun(param(req.params.id), typeof req.body?.actionId === "string" ? req.body.actionId : undefined));
  });

  // Answers an approval card: a Claude Code or Codex run waits on it while the program holds the tool call; a
  // local run paused at the card runs (or skips) that call and continues.
  app.post("/runs/:id/actions/:actionId/decision", (req, res, next) => {
    respond(res, next, async () => {
      const runId = param(req.params.id);
      const actionId = param(req.params.actionId);
      const allow = req.body?.allow === true;
      if (services.kernel.claudeCode.waiting(runId, actionId)) {
        services.kernel.claudeCode.decide(runId, actionId, allow);
      } else if (services.kernel.codex.waiting(runId, actionId)) {
        services.kernel.codex.decide(runId, actionId, allow);
      } else {
        await services.kernel.runs.decide(runId, actionId, allow);
      }
      return { ok: true };
    });
  });

  // One changed file's text before or after the run, for the editor's side-by-side diff.
  app.get("/runs/:id/changes/file", (req, res, next) => {
    respond(res, next, () =>
      services.kernel.checkpoints.fileContent(
        param(req.params.id),
        String(req.query.path ?? ""),
        req.query.side === "before" ? "before" : "after",
      ),
    );
  });

  app.get("/claude-code/status", (_req, res, next) => {
    respond(res, next, () => services.kernel.claudeCode.status());
  });

  app.post("/claude-code/logout", (_req, res, next) => {
    respond(res, next, () => services.kernel.claudeCode.logout());
  });

  app.get("/codex/status", (_req, res, next) => {
    respond(res, next, () => services.kernel.codex.status());
  });

  // Starts the official `codex login`: mode "device" (a one-time code, no local redirect) or "browser".
  app.post("/codex/sign-in", (req, res, next) => {
    respond(res, next, () => services.kernel.codex.startSignIn(req.body?.mode === "browser" ? "browser" : "device"));
  });

  // Opens the page Codex printed for this sign-in in the default browser (never a URL from the request).
  app.post("/codex/sign-in/open", (_req, res, next) => {
    respond(res, next, () => services.kernel.codex.openSignInPage());
  });

  app.delete("/codex/sign-in", (_req, res, next) => {
    respond(res, next, async () => {
      services.kernel.codex.cancelSignIn();
      return await services.kernel.codex.status();
    });
  });

  app.post("/codex/logout", (_req, res, next) => {
    respond(res, next, () => services.kernel.codex.logout());
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

function parseMode(value: unknown): RunMode | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "agent" || value === "ask" || value === "plan") return value;
  throw new HttpError(400, "mode must be agent, ask or plan");
}
