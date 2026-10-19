import type { Project } from "../domain/model.js";
import type { RuntimeClient } from "../infrastructure/runtime-client.js";

export class ProjectService {
  constructor(private readonly runtime: RuntimeClient) {}

  list(): Promise<Project[]> {
    return this.runtime.request<Project[]>("/projects");
  }

  getActive(): Promise<Project> {
    return this.runtime.request<Project>("/projects/active");
  }

  /** Creates a project for a folder; `grant` records the user's consent for agents to work in it. */
  create(data: { name?: string; path?: string; folders?: string[]; grant?: boolean }): Promise<Project> {
    return this.runtime.request<Project>("/projects", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  setAccess(id: string, granted: boolean): Promise<Project> {
    return this.runtime.request<Project>(`/projects/${encodeURIComponent(id)}/access`, {
      method: "POST",
      body: JSON.stringify({ granted }),
    });
  }

  setActive(id: string): Promise<Project> {
    return this.runtime.request<Project>(`/projects/${encodeURIComponent(id)}/active`, {
      method: "POST",
    });
  }

  update(id: string, patch: Partial<Project>): Promise<Project> {
    return this.runtime.request<Project>(`/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  delete(id: string): Promise<void> {
    return this.runtime.request<void>(`/projects/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  openInEditor(id: string): Promise<{ opened: boolean; editor?: string }> {
    return this.runtime.request<{ opened: boolean; editor?: string }>(
      `/projects/${encodeURIComponent(id)}/editor`,
      { method: "POST" },
    );
  }

  openInTerminal(id: string): Promise<{ opened: boolean; cwd: string }> {
    return this.runtime.request<{ opened: boolean; cwd: string }>(
      `/projects/${encodeURIComponent(id)}/terminal`,
      { method: "POST" },
    );
  }

  openInFolder(id: string): Promise<{ opened: boolean; path: string }> {
    return this.runtime.request<{ opened: boolean; path: string }>(
      `/projects/${encodeURIComponent(id)}/folder`,
      { method: "POST" },
    );
  }

  getRules(id: string): Promise<{ content: string; source: "cursorrules" | "agents" | "stored" | "none"; path?: string }> {
    return this.runtime.request<{ content: string; source: "cursorrules" | "agents" | "stored" | "none"; path?: string }>(
      `/projects/${encodeURIComponent(id)}/rules`,
    );
  }

  saveRules(id: string, content: string, targetFile?: "cursorrules" | "agents"): Promise<{ saved: boolean }> {
    return this.runtime.request<{ saved: boolean }>(`/projects/${encodeURIComponent(id)}/rules`, {
      method: "PUT",
      body: JSON.stringify({ content, targetFile }),
    });
  }
}
