import { CredentialDenied } from "../domain/errors.js";
import { authorizeExecute, safePath } from "../domain/broker/policy.js";
import type { Caller } from "../domain/model.js";
import type { FileStore } from "./store.js";

const STRIP = new Set([
  "authorization",
  "proxy-authorization",
  "www-authenticate",
  "proxy-authenticate",
  "set-cookie",
  "cookie",
  "x-api-key",
  "x-auth-token",
]);

export class Broker {
  constructor(private readonly store: FileStore) {}

  async execute(input: {
    connectionId: string;
    method: string;
    path: string;
    body?: unknown;
    caller: Caller;
    toolId?: string;
  }): Promise<unknown> {
    const connection = this.store.state.broker.find((item) => item.id === input.connectionId);
    if (!connection) throw new CredentialDenied("connection not found");
    authorizeExecute(connection, input.caller, input.toolId ?? "", input.path);
    const pathname = safePath(input.path);
    if (!pathname) throw new CredentialDenied("invalid path");
    const secret = this.store.secret(connection.id);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (secret) headers.authorization = `Bearer ${secret}`;
    const response = await fetch(`${connection.baseUrl.replace(/\/$/, "")}${pathname}`, {
      method: input.method.toUpperCase(),
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    });
    for (const key of [...response.headers.keys()]) {
      if (STRIP.has(key.toLowerCase())) response.headers.delete(key);
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { status: response.status, body: text };
    }
  }
}
