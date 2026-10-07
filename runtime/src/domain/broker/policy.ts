import { CredentialDenied } from "../errors.js";
import type { BrokerConnection, Caller } from "../model.js";

export function safePath(path: string): string | null {
  const raw = (path || "").trim();
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  let pathname = raw;
  const queryIndex = pathname.indexOf("?");
  if (queryIndex >= 0) pathname = pathname.slice(0, queryIndex);
  if (pathname.includes("://")) return null;
  if (pathname.split("/").includes("..")) return null;
  return pathname;
}

export function authorizeExecute(
  connection: BrokerConnection,
  caller: Caller,
  toolId: string,
  path: string,
): void {
  if (caller.admin) {
    throw new CredentialDenied("admin cannot execute");
  }
  if (!connection.allowedCallers.includes(caller.callerId)) {
    throw new CredentialDenied("caller is not allowed to use this connection");
  }
  if (caller.callerType === "runtime") {
    if (connection.allowedTools.length > 0) {
      throw new CredentialDenied("runtime cannot use a tool connection");
    }
  } else if (connection.allowedTools.length > 0) {
    if (!toolId) throw new CredentialDenied("tool_id is required");
    if (!toolAllowed(toolId, connection.allowedTools)) {
      throw new CredentialDenied("tool is not allowed on this connection");
    }
  } else {
    throw new CredentialDenied("connection has no allowed tools");
  }
  if (!pathAllowed(path, connection.allowedPaths)) {
    throw new CredentialDenied("path is not allowed on this connection");
  }
}

function pathAllowed(path: string, patterns: string[]): boolean {
  const clean = safePath(path);
  if (!clean) return false;
  return patterns.some((pattern) => match(clean, pattern));
}

function match(path: string, pattern: string): boolean {
  const expression = `^${pattern.split("*").map(escape).join(".*")}$`;
  return new RegExp(expression).test(path);
}

function escape(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function toolAllowed(toolId: string, allowed: string[]): boolean {
  return allowed.some((item) => {
    if (item === "*" || item === "*.*") return true;
    if (item.endsWith(".*") && toolId.startsWith(item.slice(0, -1))) return true;
    return toolId === item;
  });
}
