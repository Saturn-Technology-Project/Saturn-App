import type { Express } from "express";
import type { AppServices } from "../application/services.js";
import { errorText } from "../infrastructure/logger.js";
import { param, respond } from "./http.js";

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:-apple-system,system-ui,sans-serif;background:#161618;color:#f4f4f5;display:grid;place-items:center;height:100vh;margin:0}main{max-width:420px;text-align:center}p{color:#a1a1aa;line-height:1.5}</style></head><body><main><h2>${title}</h2><p>${body}</p></main></body></html>`;
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Customizations installs, and the OAuth redirect providers send the browser back to. */
export function mountMarketplace(app: Express, services: AppServices): void {
  app.get("/marketplace", (_req, res, next) => {
    respond(res, next, () => services.kernel.marketplace.list());
  });

  app.post("/marketplace/:id/install", (req, res, next) => {
    respond(res, next, () => services.kernel.marketplace.install(param(req.params.id), req.body ?? {}));
  });

  app.delete("/marketplace/:id", (req, res, next) => {
    respond(res, next, () => services.kernel.marketplace.uninstall(param(req.params.id)), 204);
  });

  app.get("/oauth/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const denied = typeof req.query.error === "string" ? req.query.error : "";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (denied || !code || !state) {
      const reason = typeof req.query.error_description === "string" ? req.query.error_description : denied || "No authorization code was returned.";
      res.status(400).send(page("Sign-in was not completed", `${escape(reason)} You can close this tab and try Install again in Saturn.`));
      return;
    }
    try {
      const name = await services.kernel.marketplace.completeSignIn(state, code);
      res.send(page(`${escape(name)} is connected`, "You can close this tab and go back to Saturn."));
    } catch (error) {
      res.status(400).send(page("Sign-in failed", `${escape(errorText(error))} You can close this tab and try Install again in Saturn.`));
    }
  });
}
