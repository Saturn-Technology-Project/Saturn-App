import type { Session } from "../domain/model.js";
import type { RuntimeClient } from "../infrastructure/runtime-client.js";

export class SessionService {
  constructor(private readonly runtime: RuntimeClient) {}

  current(): Promise<Session> {
    return this.runtime.request<Session>("/session");
  }

  refresh(signal?: AbortSignal): Promise<Session> {
    return this.runtime.request<Session>("/session/refresh", { method: "POST", signal });
  }

  login(apiBase: string, email: string, password: string): Promise<Session> {
    return this.runtime.request<Session>("/session/login", {
      method: "POST",
      body: JSON.stringify({ apiBase, email, password }),
    });
  }

  logout(): Promise<void> {
    return this.runtime.request<void>("/session", { method: "DELETE" });
  }
}
