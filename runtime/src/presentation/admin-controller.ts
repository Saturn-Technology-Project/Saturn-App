import type { Express } from "express";
import type { AppServices } from "../application/services.js";
import { param, respond } from "./http.js";
import { cliStatus, installCli } from "../application/cli-install.js";

export function mountAdmin(app: Express, services: AppServices): void {
  app.get("/health", (_req, res) => {
    res.json(services.health());
  });

  // Settings → Storage: the private snapshots Saturn keeps of folders outside git, and deleting them.
  app.get("/storage/snapshots", (_req, res, next) => {
    respond(res, next, async () => {
      const folders = await services.kernel.checkpoints.snapshotFolders();
      return { folders, bytes: folders.reduce((sum, item) => sum + item.bytes, 0) };
    });
  });

  app.delete("/storage/snapshots", (_req, res, next) => {
    respond(res, next, async () => {
      await services.kernel.checkpoints.deleteSnapshotFolders();
      return { deleted: true };
    });
  });

  app.delete("/storage/snapshots/:id", (req, res, next) => {
    respond(res, next, async () => {
      await services.kernel.checkpoints.deleteSnapshotFolders(param(req.params.id));
      return { deleted: true };
    });
  });

  app.get("/settings", (_req, res) => {
    res.json(services.settings());
  });

  app.patch("/settings", (req, res, next) => {
    respond(res, next, () => services.updateSettings(req.body));
  });

  // The `saturn` command: whether its launcher is installed (and current), and installing it in ~/.local/bin.
  app.get("/cli", (_req, res, next) => {
    respond(res, next, () => cliStatus());
  });

  app.post("/cli/install", (_req, res, next) => {
    respond(res, next, () => installCli());
  });

  // What Saturn remembers across chats: global notes, or one project's. Plain text the user may edit.
  app.get("/memory/:scope", (req, res, next) => {
    respond(res, next, async () => ({ scope: param(req.params.scope), content: await services.kernel.memory.read(param(req.params.scope)) }));
  });

  app.put("/memory/:scope", (req, res, next) => {
    respond(res, next, async () => {
      await services.kernel.memory.write(param(req.params.scope), String(req.body?.content ?? ""));
      return { scope: param(req.params.scope), content: await services.kernel.memory.read(param(req.params.scope)) };
    });
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
