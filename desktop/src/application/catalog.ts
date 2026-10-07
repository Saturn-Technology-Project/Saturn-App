import type { Agent, Mcp, Model, PendingTask, Profile, Rag, Run } from "../domain/model.js";
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

  messages(agentId: string): Promise<Run[]> {
    return this.runtime.request<Run[]>(`/agents/${agentId}/messages`);
  }
}
