import type { Express } from "express";
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

  // Answers an approval card: a Claude Code run waits on it while the SDK holds the tool call; a local run
  // paused at the card runs (or skips) that call and continues.
  app.post("/runs/:id/actions/:actionId/decision", (req, res, next) => {
    respond(res, next, async () => {
      const runId = param(req.params.id);
      const actionId = param(req.params.actionId);
      const allow = req.body?.allow === true;
      if (services.kernel.claudeCode.waiting(runId, actionId)) {
        services.kernel.claudeCode.decide(runId, actionId, allow);
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
