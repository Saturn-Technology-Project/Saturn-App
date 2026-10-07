import type { Express } from "express";
import type { AppServices } from "../application/services.js";
import { param, respond } from "./http.js";

export function mountSession(app: Express, services: AppServices): void {
  app.get("/session", (_req, res) => {
    res.json(services.session());
  });

  app.post("/session/login", (req, res, next) => {
    respond(res, next, () => services.login(String(req.body.apiBase ?? ""), String(req.body.email ?? ""), String(req.body.password ?? "")));
  });

  app.post("/session/refresh", (_req, res, next) => {
    respond(res, next, () => services.refreshAccount());
  });

  app.post("/session/pair", (req, res, next) => {
    respond(res, next, async () => {
      await services.cloud.pair(String(req.body.apiBase ?? ""), String(req.body.token ?? ""));
      return services.health();
    });
  });

  app.delete("/session", (_req, res, next) => {
    respond(res, next, () => services.logout(), 204);
  });

  app.get("/account", (_req, res, next) => {
    respond(res, next, () => services.accountProfile());
  });

  app.patch("/account", (req, res, next) => {
    respond(res, next, () => services.updateAccountProfile({
      name: typeof req.body.name === "string" ? req.body.name : undefined,
      title: typeof req.body.title === "string" ? req.body.title : undefined,
    }));
  });

  app.get("/team", (_req, res, next) => {
    respond(res, next, () => services.teamMembers());
  });

  app.patch("/team/:id", (req, res, next) => {
    respond(res, next, () => services.updateTeamMember(param(req.params.id), {
      name: typeof req.body.name === "string" ? req.body.name : undefined,
      title: typeof req.body.title === "string" ? req.body.title : undefined,
      role: typeof req.body.role === "string" ? req.body.role : undefined,
      status: typeof req.body.status === "string" ? req.body.status : undefined,
      agent_ids: Array.isArray(req.body.agent_ids) ? req.body.agent_ids.map(String) : undefined,
      agent_edit_ids: Array.isArray(req.body.agent_edit_ids) ? req.body.agent_edit_ids.map(String) : undefined,
    }));
  });

  app.post("/team/invites", (req, res, next) => {
    respond(res, next, () => services.inviteTeamMember({
      email: String(req.body.email ?? ""),
      name: String(req.body.name ?? ""),
      role: String(req.body.role ?? "operator"),
    }), 201);
  });
}
