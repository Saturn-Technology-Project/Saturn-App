import type { Express } from "express";
import type { AppServices } from "../application/services.js";
import { HttpError } from "../domain/errors.js";
import { suggestedPattern, type PermissionScope } from "../domain/permissions.js";
import { param, respond } from "./http.js";

const SCOPES: PermissionScope[] = ["user", "project", "agent", "project-file", "claude-file"];

function scopeOf(value: unknown): PermissionScope {
  if (typeof value === "string" && (SCOPES as string[]).includes(value)) return value as PermissionScope;
  throw new HttpError(400, `scope must be one of ${SCOPES.join(", ")}`);
}

function targetOf(query: Record<string, unknown>): { projectId?: string; agentId?: string } {
  return {
    ...(typeof query.projectId === "string" && query.projectId ? { projectId: query.projectId } : {}),
    ...(typeof query.agentId === "string" && query.agentId ? { agentId: query.agentId } : {}),
  };
}

/** Permission rules: the layers that apply to an agent in a project, and adding or removing a rule in one. */
export function mountPermissions(app: Express, services: AppServices): void {
  app.get("/permissions", (req, res, next) => {
    respond(res, next, () => services.kernel.permissions.layers(targetOf(req.query as Record<string, unknown>)));
  });

  app.post("/permissions/rules", (req, res, next) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    respond(res, next, () => services.kernel.permissions.addRule(scopeOf(body.scope), body.rule, targetOf(body)), 201);
  });

  app.delete("/permissions/rules", (req, res, next) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    respond(res, next, () => services.kernel.permissions.removeRule(scopeOf(body.scope), body.rule, targetOf(body)));
  });

  // "Always allow" on a waiting card: saves an allow rule for that tool where the user chose, then approves the call.
  app.post("/runs/:id/actions/:actionId/allow-always", (req, res, next) => {
    respond(res, next, async () => {
      const runId = param(req.params.id);
      const actionId = param(req.params.actionId);
      const run = services.kernel.getRun(runId);
      const action = run.actions.find((item) => item.id === actionId && item.status === "waiting_approval");
      if (!action) throw new HttpError(409, "This approval is no longer waiting");
      const body = (req.body ?? {}) as Record<string, unknown>;
      const scope = scopeOf(body.scope ?? "project");
      const pattern = typeof body.pattern === "string" && body.pattern.trim() ? body.pattern.trim() : suggestedPattern(action.toolId, action.arguments);
      const thread = run.threadId ? (services.kernel.store.state.threads ?? []).find((item) => item.id === run.threadId) : undefined;
      const target = { agentId: run.agentId, ...(thread?.projectId ? { projectId: thread.projectId } : {}) };
      if (scope === "project" && !target.projectId) throw new HttpError(400, "This chat is not in a project; choose Everywhere or This agent.");
      await services.kernel.permissions.addRule(scope, { tool: action.toolId, pattern, effect: "allow" }, target);
      if (services.kernel.claudeCode.waiting(runId, actionId)) services.kernel.claudeCode.decide(runId, actionId, true);
      else if (services.kernel.codex.waiting(runId, actionId)) services.kernel.codex.decide(runId, actionId, true);
      else await services.kernel.runs.decide(runId, actionId, true);
      return { ok: true, rule: { tool: action.toolId, pattern, effect: "allow" }, scope };
    });
  });
}
