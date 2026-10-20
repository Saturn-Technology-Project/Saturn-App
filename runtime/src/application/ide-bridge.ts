import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Response } from "express";
import { HttpError } from "../domain/errors.js";
import { logger } from "../infrastructure/logger.js";

/** How long a request to the IDE may take before the agent is told the editor did not answer. */
const CALL_TIMEOUT_MS = 15_000;
/** A comment line keeps the stream open through idle proxies and lets a dead connection show itself. */
const KEEPALIVE_MS = 15_000;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Window = { id: string; folders: string[]; res: Response; pending: Map<string, Pending>; keepalive: NodeJS.Timeout };

/**
 * Lets the runtime ask a Saturn IDE window to do something only the editor can: its language servers'
 * diagnostics, definitions, references and renames. Each IDE window holds a server-sent-event stream open
 * (GET /runtime/clients/:id/requests) and says which folders it has open; a request goes to the window whose
 * folders contain the project, and the window answers with POST /runtime/clients/:id/responses/:requestId.
 */
export class IdeBridge {
  private readonly windows = new Map<string, Window>();

  /** A window opened its request stream. A second stream from the same window replaces the first. */
  connect(id: string, folders: string[], res: Response): void {
    this.disconnect(id, "replaced by a new connection");
    res.status(200);
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders();
    res.write(": connected\n\n");
    const window: Window = {
      id,
      folders: folders.map((folder) => path.resolve(folder)),
      res,
      pending: new Map(),
      keepalive: setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS),
    };
    window.keepalive.unref();
    this.windows.set(id, window);
    res.on("close", () => {
      if (this.windows.get(id) === window) this.disconnect(id, "the editor window closed");
    });
    logger.debug("ide", `Saturn IDE window connected for editor tools (${window.folders.length} folder${window.folders.length === 1 ? "" : "s"})`);
  }

  /** The window's open folders changed (a folder was added to or removed from its workspace). */
  setFolders(id: string, folders: string[]): void {
    const window = this.windows.get(id);
    if (!window) throw new HttpError(404, "This editor window is not connected");
    window.folders = folders.map((folder) => path.resolve(folder));
  }

  private disconnect(id: string, reason: string): void {
    const window = this.windows.get(id);
    if (!window) return;
    this.windows.delete(id);
    clearInterval(window.keepalive);
    for (const pending of window.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Saturn IDE did not answer: ${reason}`));
    }
    window.pending.clear();
    if (!window.res.writableEnded) window.res.end();
  }

  /** The window with `root` open: the one whose folder is `root` or contains it, the most specific first. */
  private windowFor(root: string): Window | undefined {
    const target = path.resolve(root);
    let best: { window: Window; length: number } | undefined;
    for (const window of this.windows.values()) {
      for (const folder of window.folders) {
        if (target === folder || target.startsWith(folder + path.sep) || folder.startsWith(target + path.sep)) {
          if (!best || folder.length > best.length) best = { window, length: folder.length };
        }
      }
    }
    return best?.window;
  }

  /** Whether an IDE window has this project folder open. */
  available(root: string | undefined): boolean {
    return Boolean(root && this.windowFor(root));
  }

  /** Asks the window that has `root` open to run one editor tool; resolves with what the window answers. */
  async call(root: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const window = this.windowFor(root);
    if (!window) throw new HttpError(409, "Saturn IDE does not have this project open. Open it in Saturn IDE (Open IDE) to use the editor's language tools.");
    const id = randomUUID();
    return await new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        window.pending.delete(id);
        signal?.removeEventListener("abort", abort);
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error(`Saturn IDE did not answer ${tool} within ${CALL_TIMEOUT_MS / 1000} s (its language server may still be starting).`));
      }, CALL_TIMEOUT_MS);
      const abort = () => {
        finish();
        reject(new Error("Stopped"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      window.pending.set(id, {
        resolve: (value) => {
          finish();
          resolve(value);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
        timer,
      });
      window.res.write(`data: ${JSON.stringify({ id, tool, args, root: path.resolve(root) })}\n\n`);
    });
  }

  /** A window's answer to one request: a result, or an error message. */
  respond(windowId: string, requestId: string, body: { result?: unknown; error?: unknown }): void {
    const pending = this.windows.get(windowId)?.pending.get(requestId);
    if (!pending) throw new HttpError(404, "No request is waiting for this answer (it may have timed out)");
    if (body.error !== undefined && body.error !== null) pending.reject(new Error(String(body.error)));
    else pending.resolve(body.result);
  }
}
