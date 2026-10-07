import type { Agent, AppSettings, McpConnection, ModelConnection, RagConnection, Run, RunAction } from "../domain/model.js";
import { Broker } from "../infrastructure/broker.js";
import { CloudSession } from "../infrastructure/cloud.js";
import { McpClient } from "../infrastructure/mcp.js";
import { FileStore } from "../infrastructure/store.js";
import { RuntimeKernel } from "./kernel.js";

/** Composition root. HTTP controllers call these methods; the work lives in the use-case classes. */
export class AppServices {
  readonly kernel: RuntimeKernel;

  constructor(store: FileStore, broker: Broker, mcp: McpClient, cloud: CloudSession) {
    this.kernel = new RuntimeKernel(store, broker, mcp, cloud);
  }

  get cloud(): CloudSession {
    return this.kernel.cloud;
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

  async createModel(input: { name?: string; provider?: string; model?: string; baseUrl?: string; secret?: string }) {
    return await this.kernel.catalog.createModel(input);
  }

  async updateModel(
    id: string,
    patch: { name?: string; provider?: string; model?: string; baseUrl?: string; secret?: string },
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

  async createMcp(input: { name: string; url: string; tools?: { toolId: string; description?: string }[] }) {
    return await this.kernel.catalog.createMcp(input);
  }

  async updateMcp(
    id: string,
    patch: { name?: string; url?: string; tools?: { toolId: string; description?: string }[] },
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

  async startRun(agentId: string, input: string): Promise<Run> {
    return await this.kernel.runs.startRun(agentId, input);
  }

  async pendingTasks(): Promise<{ id: string; agentId: string; agentName: string; input: string; toolId: string }[]> {
    return await this.kernel.runs.pendingTasks();
  }

  async messagesFor(agentId: string): Promise<Run[]> {
    return await this.kernel.runs.messagesFor(agentId);
  }

  async syncSignedInState(): Promise<void> {
    return await this.kernel.runs.syncSignedInState();
  }

  async reviseRun(id: string, input: string): Promise<{ run: Run; removed: string[] }> {
    return await this.kernel.runs.reviseRun(id, input);
  }

  async stopRun(id: string): Promise<Run> {
    return await this.kernel.runs.stopRun(id);
  }

  async unpair(): Promise<void> {
    return await this.kernel.session.unpair();
  }

  session() {
    return this.kernel.session.session();
  }

  async login(apiBase: string, email: string, password: string) {
    return await this.kernel.session.login(apiBase, email, password);
  }

  async refreshAccount() {
    return await this.kernel.session.refreshAccount();
  }

  async accountProfile() {
    return await this.kernel.session.accountProfile();
  }

  async updateAccountProfile(input: { name?: string; title?: string }) {
    return await this.kernel.session.updateAccountProfile(input);
  }

  async teamMembers() {
    return await this.kernel.session.teamMembers();
  }

  async updateTeamMember(employeeId: string, input: {
    name?: string;
    title?: string;
    role?: string;
    status?: string;
    agent_ids?: string[];
    agent_edit_ids?: string[];
  }) {
    return await this.kernel.session.updateTeamMember(employeeId, input);
  }

  async inviteTeamMember(input: { email: string; name: string; role: string }) {
    return await this.kernel.session.inviteTeamMember(input);
  }

  async logout(): Promise<void> {
    return await this.kernel.session.logout();
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

  settings(): AppSettings {
    return this.kernel.admin.settings();
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    return await this.kernel.admin.updateSettings(patch);
  }

  listKeys() {
    return this.kernel.admin.listKeys();
  }

  async createKey(input: {
    name?: string;
    secretName?: string;
    baseUrl?: string;
    allowedPaths?: string | string[];
    value?: string;
  }) {
    return await this.kernel.admin.createKey(input);
  }

  async rotateKey(id: string, value: string) {
    return await this.kernel.admin.rotateKey(id, value);
  }

  async clearKey(id: string) {
    return await this.kernel.admin.clearKey(id);
  }

  async deleteKey(id: string) {
    return await this.kernel.admin.deleteKey(id);
  }

  information() {
    return this.kernel.admin.information();
  }

  listLogs(query: { service?: string; level?: string; q?: string }) {
    return this.kernel.admin.listLogs(query);
  }

  diagnostics() {
    return this.kernel.admin.diagnostics();
  }
}
