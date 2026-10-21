import type { Express, Request, Response } from "express";
import type { AppServices } from "../application/services.js";
import { runFingerprint } from "../application/events.js";
import { param } from "./http.js";

/** Starts a server-sent event stream; a comment every 20 s keeps proxies and sleeping laptops from dropping it. */
function openStream(req: Request, res: Response): (event: string, data: unknown) => void {
  res.status(200);
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders();
  res.write("retry: 2000\n\n");
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 20_000);
  keepAlive.unref?.();
  req.on("close", () => clearInterval(keepAlive));
  return (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

/** Live updates: which runs changed (and whether anything else did), or one run as it changes. */
export function mountEvents(app: Express, services: AppServices): void {
  app.get("/events", (req, res) => {
    const send = openStream(req, res);
    send("ready", { at: new Date().toISOString() });
    const unsubscribe = services.kernel.events.subscribe((event) => send("change", event));
    req.on("close", unsubscribe);
  });

  app.get("/runs/:id/events", (req, res) => {
    const id = param(req.params.id);
    const current = services.kernel.store.state.runs.find((run) => run.id === id);
    if (!current) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    const send = openStream(req, res);
    let last = runFingerprint(current);
    send("run", services.kernel.runs.withChildren(current));
    const unsubscribe = services.kernel.events.subscribe((event) => {
      // Its own changes, and its sub-agents' (they show nested in its steps).
      if (!event.runs.some((run) => run.id === id || run.parentRunId === id)) return;
      const run = services.kernel.store.state.runs.find((item) => item.id === id);
      if (!run) {
        send("gone", { id });
        res.end();
        return;
      }
      const print = runFingerprint(run) + event.runs.filter((item) => item.parentRunId === id).map((item) => item.status).join(",");
      if (print === last) return;
      last = print;
      send("run", services.kernel.runs.withChildren(run));
    });
    req.on("close", unsubscribe);
  });
}
