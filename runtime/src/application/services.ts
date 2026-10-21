import type { UsageRange } from "./usage.js";
import type { AutomationView } from "./automations.js";
import type { GroupTranscript, GroupView } from "./groups.js";
import type { RunChanges } from "./checkpoints.js";
import type { Agent, Automation, AppSettings, Conversation, Group, McpConnection, ModelConnection, Project, RagConnection, Run, RunAction, RunMode } from "../domain/model.js";
import type { ImagePart } from "../infrastructure/llm/types.js";
import type { RunSummary } from "./runs.js";
import { McpClient } from "../infrastructure/mcp.js";
import { FileStore } from "../infrastructure/store.js";
import { RuntimeKernel } from "./kernel.js";

/** Composition root. HTTP controllers call these methods; the work lives in the use-case classes. */
export class AppServices {
  readonly kernel: RuntimeKernel;

  constructor(store: FileStore, mcp: McpClient) {
    this.kernel = new RuntimeKernel(store, mcp);
  }

  health() {
    return this.kernel.health();
  }

  async listAgents(): Promise<Agent[]> {
    return await this.kernel.catalog.listAgents();
  }

  getAgent(id: string): Agent {
    return this.kernel.getAgent(id);
  }

  async createAgent(input: Partial<Agent> & { name: string }): Promise<Agent> {
    return await this.kernel.catalog.createAgent(input);
  }

  async updateAgent(id: string, patch: Partial<Agent>): Promise<Agent> {
    return await this.kernel.catalog.updateAgent(id, patch);
  }

  async listConnections(kind: "models" | "mcp" | "rag") {
    return await this.kernel.catalog.listConnections(kind);
  }

  llmProviders() {
    return this.kernel.catalog.llmProviders();
  }

  async lmStudioModels(baseUrl: string) {
    return await this.kernel.catalog.lmStudioModels(baseUrl);
  }

  async createModel(input: { name?: string; provider?: string; model?: string; baseUrl?: string; secret?: string; effort?: string }) {
    return await this.kernel.catalog.createModel(input);
  }

  async updateModel(
    id: string,
    patch: { name?: string; provider?: string; model?: string; baseUrl?: string; secret?: string; effort?: string | null },
  ): Promise<ModelConnection> {
    return await this.kernel.catalog.updateModel(id, patch);
  }

  async deleteAgent(id: string): Promise<void> {
    return await this.kernel.catalog.deleteAgent(id);
  }

  async deleteMcpServer(id: string): Promise<void> {
    return await this.kernel.catalog.deleteMcpServer(id);
  }

  async deleteConnection(kind: "models" | "mcp" | "rag", id: string): Promise<void> {
    return await this.kernel.catalog.deleteConnection(kind, id);
  }

  async approveMcp(id: string, fingerprint: string) {
    return await this.kernel.catalog.approveMcp(id, fingerprint);
  }

  async createMcp(input: { name: string; url?: string; command?: unknown; tools?: { toolId: string; description?: string }[] }) {
    return await this.kernel.catalog.createMcp(input);
  }

  async updateMcp(
    id: string,
    patch: { name?: string; url?: string; command?: unknown; tools?: { toolId: string; description?: string }[]; disabledTools?: string[] },
  ): Promise<McpConnection> {
    return await this.kernel.catalog.updateMcp(id, patch);
  }

  async discoverMcp(id: string) {
    return await this.kernel.catalog.discoverMcp(id);
  }

  async createRag(input: { name: string; url: string }) {
    return await this.kernel.catalog.createRag(input);
  }

  async updateRag(id: string, patch: { name?: string; url?: string }): Promise<RagConnection> {
    return await this.kernel.catalog.updateRag(id, patch);
  }

  getRun(id: string): Run {
    return this.kernel.getRun(id);
  }

  /** Files the run changed in its project folder, with a diff each. */
  async runChanges(id: string): Promise<RunChanges> {
    return await this.kernel.checkpoints.changes(id);
  }

  /** Restores one file (or all) to how it was before the run. */
  async revertRunChanges(id: string, path?: string): Promise<RunChanges> {
    return await this.kernel.checkpoints.revert(id, path);
  }

  async keepRunChanges(id: string, file?: string): Promise<RunChanges> {
    return await this.kernel.checkpoints.keep(id, file);
  }

  /** Restores the chat's files to before this turn (this run and every later one in the chat). */
  async restoreToRun(id: string, actionId?: string): Promise<{ reverted: string[]; files: string[] }> {
    return actionId ? await this.kernel.checkpoints.restoreToStep(id, actionId) : await this.kernel.checkpoints.restoreTo(id);
  }

  async startRun(agentId: string, input: string, threadId?: string, projectId?: string, options?: { images?: ImagePart[]; mode?: RunMode }): Promise<Run> {
    return await this.kernel.runs.startRun(agentId, input, threadId, projectId, options);
  }

  openPullRequest(threadId: string, input: { title?: string; body?: string }): Promise<{ url: string; number: number; branch: string }> {
    return this.kernel.worktrees.pullRequest(threadId, input, { secret: (id) => this.kernel.store.secret(id) });
  }

  recordings(runId: string): { name: string; frames: number; seconds?: number; exported?: boolean }[] {
    return this.kernel.recordings.list(runId);
  }

  recordingFrame(runId: string, name: string, index: number): string {
    return this.kernel.recordings.frame(runId, name, index);
  }

  exportRecording(runId: string, name: string): Promise<{ path: string }> {
    return this.kernel.recordings.exportMp4(runId, name);
  }

  recentRuns(projectId?: string, limit = 20): RunSummary[] {
    return this.kernel.runs.recentRuns(projectId, limit);
  }

  async listThreads(agentId: string): Promise<Conversation[]> {
    return await this.kernel.runs.listThreads(agentId);
  }

  async createThread(agentId: string, title?: string, projectId?: string): Promise<Conversation> {
    return await this.kernel.runs.createThread(agentId, title, projectId);
  }

  async renameThread(threadId: string, title: string): Promise<Conversation> {
    return await this.kernel.runs.renameThread(threadId, title);
  }

  async deleteThread(threadId: string): Promise<void> {
    return await this.kernel.runs.deleteThread(threadId);
  }

  async pendingTasks(): Promise<{ id: string; agentId: string; agentName: string; input: string; toolId: string }[]> {
    return await this.kernel.runs.pendingTasks();
  }

  async messagesFor(agentId: string, threadId?: string): Promise<Run[]> {
    return await this.kernel.runs.messagesFor(agentId, threadId);
  }

  async reviseRun(id: string, input: string): Promise<{ run: Run; removed: string[] }> {
    return await this.kernel.runs.reviseRun(id, input);
  }

  /** Ends a run's computer_wait early and lets it continue now. */
  async wakeRun(id: string): Promise<Run> {
    return await this.kernel.runs.wakeRun(id);
  }

  async stopRun(id: string): Promise<Run> {
    return await this.kernel.runs.stopRun(id);
  }

  usage() {
    return this.kernel.usage.records();
  }

  usageSummary(range?: UsageRange) {
    return this.kernel.usage.summary(range);
  }

  async executeTool(input: {
    agentId: string;
    toolId: string;
    arguments: Record<string, unknown>;
    runId: string;
    actionId: string;
    signal?: AbortSignal;
  }): Promise<RunAction> {
    return await this.kernel.runs.executeTool(input);
  }

  listGroups(): GroupView[] {
    return this.kernel.groups.list();
  }

  async createGroup(input: { name?: string; agentIds?: string[] }): Promise<Group> {
    return await this.kernel.groups.create(input);
  }

  async updateGroup(id: string, patch: { name?: string; agentIds?: string[]; autonomy?: string | null }): Promise<Group> {
    return await this.kernel.groups.update(id, patch);
  }

  async deleteGroup(id: string): Promise<void> {
    return await this.kernel.groups.remove(id);
  }

  groupTranscript(id: string): GroupTranscript {
    return this.kernel.groups.transcript(id);
  }

  async postGroupMessage(id: string, text: string): Promise<GroupTranscript> {
    return await this.kernel.groups.post(id, text);
  }

  listAutomations(): AutomationView[] {
    return this.kernel.automations.list();
  }

  async createAutomation(input: Partial<Automation>): Promise<AutomationView> {
    return await this.kernel.automations.create(input);
  }

  async updateAutomation(id: string, patch: Partial<Automation>): Promise<AutomationView> {
    return await this.kernel.automations.update(id, patch);
  }

  async deleteAutomation(id: string): Promise<void> {
    return await this.kernel.automations.remove(id);
  }

  async runAutomation(id: string): Promise<AutomationView> {
    return await this.kernel.automations.runNow(id);
  }

  async draftAutomation(input: { text?: string; agentId?: string }) {
    return await this.kernel.automations.draft(input);
  }

  settings(): AppSettings {
    return this.kernel.admin.settings();
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    return await this.kernel.admin.updateSettings(patch);
  }

  information() {
    return this.kernel.admin.information();
  }

  listLogs(query: { service?: string; level?: string; q?: string }) {
    return this.kernel.admin.listLogs(query);
  }

  async listProjects(): Promise<Project[]> {
    return await this.kernel.projects.list();
  }

  async getActiveProject(): Promise<Project> {
    return await this.kernel.projects.getActive();
  }

  async createProject(input: { name?: string; path?: string; folders?: string[]; description?: string; rules?: string; grant?: boolean }): Promise<Project> {
    return await this.kernel.projects.create(input);
  }

  async setActiveProject(id: string): Promise<Project> {
    return await this.kernel.projects.setActive(id);
  }

  async updateProject(id: string, patch: Partial<Project>): Promise<Project> {
    return await this.kernel.projects.update(id, patch);
  }

  async setProjectAccess(id: string, granted: boolean): Promise<Project> {
    return await this.kernel.projects.setAccess(id, granted);
  }

  async deleteProject(id: string): Promise<void> {
    return await this.kernel.projects.delete(id);
  }

  async openProjectEditor(id: string) {
    return await this.kernel.projects.openEditor(id);
  }

  async openProjectTerminal(id: string) {
    return await this.kernel.projects.openTerminal(id);
  }

  async openProjectFolder(id: string) {
    return await this.kernel.projects.openFolder(id);
  }

  async getProjectRules(id: string) {
    return await this.kernel.projects.getRules(id);
  }

  async saveProjectRules(id: string, content: string, targetFile?: "cursorrules" | "agents") {
    return await this.kernel.projects.saveRules(id, content, targetFile);
  }

  async wakeupDefaultApp(): Promise<{ target: "ide" | "agent"; opened: boolean }> {
    return await this.kernel.projects.wakeupDefaultApp();
  }
}
