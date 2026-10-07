import type { NextFunction, Response } from "express";
import { HttpError } from "../domain/errors.js";

export function param(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? "" : value;
}

export function connectionKind(value: string): "models" | "mcp" | "rag" {
  if (value === "models" || value === "mcp" || value === "rag") return value;
  throw new HttpError(404, "Unknown connection kind");
}

export function respond(res: Response, next: NextFunction, work: () => unknown, status = 200): void {
  Promise.resolve()
    .then(work)
    .then((body) => {
      if (status === 204) {
        res.status(204).end();
        return;
      }
      res.status(status).json(body);
    })
    .catch(next);
}
