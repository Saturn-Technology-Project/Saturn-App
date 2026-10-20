import type { Agent, Conversation, Mcp, Model, PendingTask, Profile, Rag, Run } from "../domain/model.js";
import type { RuntimeClient } from "../infrastructure/runtime-client.js";

export type WorkspaceSnapshot = {
  agents: Agent[];
  models: Model[];
  mcp: Mcp[];
  rag: Rag[];
  profile: Profile;
  tasks: PendingTask[];
};

/** Agents and the connections the chat window needs. */
export type WorktreeStatus = { threadId: string; path: string; branch: string; base: string; ahead: number; dirty: number; changedFiles: string[] };

export class CatalogService {
  constructor(private readonly runtime: RuntimeClient) {}

  listAgents(): Promise<Agent[]> {
    return this.runtime.request<Agent[]>("/agents");
  }

  listModels(): Promise<Model[]> {
    return this.runtime.request<Model[]>("/connections/models");
  }

  listMcp(): Promise<Mcp[]> {
    return this.runtime.request<Mcp[]>("/connections/mcp");
  }

  listRag(): Promise<Rag[]> {
    return this.runtime.request<Rag[]>("/connections/rag");
  }

  listTasks(): Promise<PendingTask[]> {
    return this.runtime.request<PendingTask[]>("/tasks");
  }

  settings(): Promise<Profile> {
    return this.runtime.request<Profile>("/settings");
  }

  snapshot(): Promise<WorkspaceSnapshot> {
    return Promise.all([
      this.listAgents(),
      this.listModels(),
      this.listMcp(),
      this.listRag(),
      this.settings(),
      this.listTasks(),
    ]).then(([agents, models, mcp, rag, profile, tasks]) => ({ agents, models, mcp, rag, profile, tasks }));
  }

  createAgent(input: { name: string; modelConnectionId: string | null }): Promise<Agent> {
    return this.runtime.request<Agent>("/agents", { method: "POST", body: JSON.stringify(input) });
  }

  updateAgent(id: string, patch: Partial<Agent>): Promise<void> {
    return this.runtime.request(`/agents/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
  }

  deleteAgent(id: string): Promise<void> {
    return this.runtime.request(`/agents/${id}`, { method: "DELETE" });
  }

  listThreads(agentId: string): Promise<Conversation[]> {
    return this.runtime.request<Conversation[]>(`/agents/${agentId}/threads`);
  }

  /** A new chat; with a project it works in that project's folder. */
  createThread(agentId: string, title?: string, projectId?: string): Promise<Conversation> {
    return this.runtime.request<Conversation>(`/agents/${agentId}/threads`, {
      method: "POST",
      body: JSON.stringify({ title, ...(projectId ? { projectId } : {}) }),
    });
  }

  renameThread(threadId: string, title: string): Promise<Conversation> {
    return this.runtime.request<Conversation>(`/threads/${threadId}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    });
  }

  /** Gives the chat its own git worktree and branch, so its agent's changes stay off the project's checkout. */
  isolateThread(threadId: string): Promise<WorktreeStatus> {
    return this.runtime.request<WorktreeStatus>(`/threads/${encodeURIComponent(threadId)}/worktree`, { method: "POST" });
  }

  worktreeStatus(threadId: string): Promise<WorktreeStatus> {
    return this.runtime.request<WorktreeStatus>(`/threads/${encodeURIComponent(threadId)}/worktree`);
  }

  /** Ends the chat's isolation: merge its branch into the base, keep the branch for a pull request, or discard it. */
  finishWorktree(threadId: string, how: "merge" | "keep" | "discard"): Promise<{ how: string; branch: string; merged?: boolean }> {
    return this.runtime.request(`/threads/${encodeURIComponent(threadId)}/worktree/finish`, { method: "POST", body: JSON.stringify({ how }) });
  }

  deleteThread(threadId: string): Promise<void> {
    return this.runtime.request(`/threads/${threadId}`, { method: "DELETE" });
  }

  messages(agentId: string, threadId?: string): Promise<Run[]> {
    const query = threadId ? `?threadId=${encodeURIComponent(threadId)}` : "";
    return this.runtime.request<Run[]>(`/agents/${agentId}/messages${query}`);
  }
}
