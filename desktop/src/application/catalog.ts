import type { Agent, Conversation, Mcp, Model, PendingTask, Profile, Rag, Run, ContextUsage, BackgroundJob, PullRequestWatch } from "../domain/model.js";
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

  /** How full the chat's context is for its agent's model (an estimate), and what its summary covers. */
  threadContext(threadId: string): Promise<ContextUsage> {
    return this.runtime.request<ContextUsage>(`/threads/${encodeURIComponent(threadId)}/context`);
  }

  /** Looks at the chat's pull request now (checks, comments) instead of waiting for the next 2-minute look. */
  checkPullRequest(threadId: string): Promise<PullRequestWatch> {
    return this.runtime.request<PullRequestWatch>(`/threads/${encodeURIComponent(threadId)}/pull-request/check`, { method: "POST" });
  }

  watchPullRequest(threadId: string, watching: boolean): Promise<PullRequestWatch> {
    return this.runtime.request<PullRequestWatch>(`/threads/${encodeURIComponent(threadId)}/pull-request/watch`, { method: "POST", body: JSON.stringify({ watching }) });
  }

  sendPullRequestFeedback(threadId: string, ids?: string[]): Promise<{ runId: string; sent: number }> {
    return this.runtime.request(`/threads/${encodeURIComponent(threadId)}/pull-request/feedback/send`, { method: "POST", body: JSON.stringify(ids ? { ids } : {}) });
  }

  dismissPullRequestFeedback(threadId: string, ids?: string[]): Promise<PullRequestWatch> {
    return this.runtime.request<PullRequestWatch>(`/threads/${encodeURIComponent(threadId)}/pull-request/feedback/dismiss`, { method: "POST", body: JSON.stringify(ids ? { ids } : {}) });
  }

  /** The skills a chat can use: its project's, then the user's. */
  skills(projectId?: string): Promise<{ name: string; description: string; source: string }[]> {
    return this.runtime.request(`/skills${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
  }

  skill(name: string, projectId?: string): Promise<{ name: string; instructions: string; files: string[] }> {
    return this.runtime.request(`/skills/${encodeURIComponent(name)}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
  }

  /** Prompt commands for the "/" menu: the project's .saturn/commands and .claude/commands, then the user's. */
  commands(projectId?: string): Promise<{ name: string; description: string; source: string }[]> {
    return this.runtime.request(`/commands${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
  }

  expandCommand(name: string, args: string, projectId?: string): Promise<{ name: string; prompt: string }> {
    return this.runtime.request(`/commands/${encodeURIComponent(name)}/expand`, { method: "POST", body: JSON.stringify({ arguments: args, ...(projectId ? { projectId } : {}) }) });
  }

  /** Background commands the chat's agent started, running or recently ended. */
  threadJobs(threadId: string): Promise<BackgroundJob[]> {
    return this.runtime.request<BackgroundJob[]>(`/threads/${encodeURIComponent(threadId)}/jobs`);
  }

  stopJob(threadId: string, jobId: string): Promise<BackgroundJob> {
    return this.runtime.request<BackgroundJob>(`/threads/${encodeURIComponent(threadId)}/jobs/${encodeURIComponent(jobId)}/stop`, { method: "POST" });
  }

  /** "/compact": folds the chat's finished turns into its summary now. */
  compactThread(threadId: string): Promise<{ folded: number }> {
    return this.runtime.request<{ folded: number }>(`/threads/${encodeURIComponent(threadId)}/compact`, { method: "POST" });
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
  /** Opens a pull request from the chat's worktree branch (pushes it first). */
  openPullRequest(threadId: string, input: { title?: string; body?: string }): Promise<{ url: string; number: number; branch: string }> {
    return this.runtime.request(`/threads/${encodeURIComponent(threadId)}/pull-request`, { method: "POST", body: JSON.stringify(input) });
  }

  finishWorktree(threadId: string, how: "merge" | "keep" | "discard"): Promise<{ how: string; branch: string; merged?: boolean; conflicts?: string[] }> {
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
