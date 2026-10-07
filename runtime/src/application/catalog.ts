import { HttpError } from "../domain/errors.js";
import { newId } from "../domain/ids.js";
import { LLM_PROVIDERS, llmProvider } from "../domain/llm/catalog.js";
import { GENERAL_SKILLS_ID, SATURN_AGENT_ID, withGeneralSkills } from "../domain/builtin.js";
import type { Agent, McpConnection, ModelConnection, RagConnection } from "../domain/model.js";
import { RUNTIME_CALLER } from "./runtime-state.js";
import { listLmStudioModels } from "../infrastructure/llm.js";
import type { RuntimeKernel } from "./kernel.js";

/** Local agents and the model, MCP, and knowledge connections they use. Cloud writes go through SessionService. */
export class CatalogService {
  constructor(private readonly kernel: RuntimeKernel) {}

  async listAgents(): Promise<Agent[]> {
    await this.kernel.ensureBuiltins();
    return this.kernel.store.state.agents;
  }

  async createAgent(input: Partial<Agent> & { name: string }): Promise<Agent> {
    await this.kernel.ensureBuiltins();
    const cloudId = await this.kernel.session.createCloudAgent(input.name, input.description ?? "");
    const agent: Agent = {
      id: cloudId ?? newId("agent"),
      name: input.name,
      description: input.description ?? "",
      instructions: input.instructions ?? "",
      responseStyle: input.responseStyle ?? "professional",
      autonomy: input.autonomy ?? "execute_when_allowed",
      temperature: input.temperature ?? 0.2,
      maxOutput: input.maxOutput ?? 4000,
      status: "active",
      modelConnectionId: input.modelConnectionId ?? null,
      mcpConnectionIds: withGeneralSkills(input.mcpConnectionIds ?? this.kernel.store.state.mcp.map((item) => item.id).filter((id) => id !== GENERAL_SKILLS_ID)),
      ragConnectionIds: input.ragConnectionIds ?? [],
    };
    await this.kernel.store.update((state) => {
      state.agents.push(agent);
    });
    this.kernel.session.announce();
    await this.kernel.session.syncAppMcp();
    return agent;
  }

  async updateAgent(id: string, patch: Partial<Agent>): Promise<Agent> {
    const current = this.kernel.getAgent(id);
    if (this.kernel.store.state.account && current.canEdit === false) {
      throw new HttpError(403, "You cannot modify this agent");
    }
    const next: Agent = {
      ...current,
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      instructions: patch.instructions ?? current.instructions,
      responseStyle: patch.responseStyle ?? current.responseStyle ?? "professional",
      autonomy: patch.autonomy ?? current.autonomy ?? "execute_when_allowed",
      temperature: patch.temperature ?? current.temperature ?? 0.2,
      maxOutput: patch.maxOutput ?? current.maxOutput ?? 4000,
      status: patch.status ?? current.status,
      modelConnectionId: patch.modelConnectionId === undefined ? current.modelConnectionId : patch.modelConnectionId,
      toolSetId: patch.toolSetId === undefined ? current.toolSetId : patch.toolSetId,
      mcpConnectionIds: withGeneralSkills(patch.mcpConnectionIds ?? current.mcpConnectionIds),
      ragConnectionIds: patch.ragConnectionIds ?? current.ragConnectionIds,
    };
    await this.kernel.session.syncCloudAgent(next);
    await this.kernel.store.update((state) => {
      const agent = state.agents.find((item) => item.id === id);
      if (agent) Object.assign(agent, next);
    });
    this.kernel.session.announce();
    await this.kernel.session.syncAppMcp();
    return this.kernel.getAgent(id);
  }

  async listConnections(kind: "models" | "mcp" | "rag") {
    if (kind === "mcp") await this.kernel.ensureBuiltins();
    return this.kernel.store.state[kind];
  }

  llmProviders() {
    return LLM_PROVIDERS;
  }

  async lmStudioModels(baseUrl: string) {
    const provider = llmProvider("lmstudio");
    try {
      return await listLmStudioModels(baseUrl || provider?.baseUrl || "http://127.0.0.1:1234");
    } catch {
      return [];
    }
  }

  async createModel(input: { name?: string; provider?: string; model?: string; baseUrl?: string; secret?: string }) {
    const provider = llmProvider(input.provider || "openai");
    if (!provider) throw new HttpError(400, "Choose OpenAI, Claude, Gemini, or LM Studio");
    const modelId = (input.model || input.name || "").trim();
    if (!modelId) throw new HttpError(400, "Choose a model");
    const known = provider.models.find((item) => item.id === modelId);
    const brokerId = newId("sec");
    const model: ModelConnection = {
      id: newId("mdl"),
      name: (input.name || known?.label || modelId).trim(),
      provider: provider.id,
      model: modelId,
      baseUrl: (input.baseUrl || provider.baseUrl).replace(/\/$/, ""),
      brokerConnectionId: brokerId,
      hasSecret: Boolean(input.secret),
    };
    await this.kernel.session.upsertOrgCredential(this.kernel.session.modelCredential(model, input.secret));
    await this.kernel.store.update((state) => {
      state.broker.push({
        id: brokerId,
        name: model.name,
        baseUrl: model.baseUrl,
        secretName: "AGENTS_API_KEY",
        allowedCallers: [RUNTIME_CALLER.callerId],
        allowedTools: [],
        allowedPaths: ["/chat/completions", "/v1/chat/completions"],
        hasSecret: Boolean(input.secret),
      });
      state.models.push(model);
    });
    if (input.secret) await this.kernel.store.putSecret(brokerId, input.secret);
    return model;
  }

  async updateModel(
    id: string,
    patch: { name?: string; provider?: string; model?: string; baseUrl?: string; secret?: string },
  ): Promise<ModelConnection> {
    const current = this.kernel.store.state.models.find((item) => item.id === id);
    if (!current) throw new HttpError(404, "Model connection not found");
    const next: ModelConnection = {
      ...current,
      name: patch.name ?? current.name,
      provider: patch.provider ?? current.provider,
      model: typeof patch.model === "string" && patch.model.trim() ? patch.model.trim() : current.model,
      baseUrl: patch.baseUrl ?? current.baseUrl,
      hasSecret: patch.secret ? true : current.hasSecret,
    };
    await this.kernel.session.upsertOrgCredential(this.kernel.session.modelCredential(next, patch.secret));
    let updated: ModelConnection | undefined;
    await this.kernel.store.update((state) => {
      const model = state.models.find((item) => item.id === id);
      const broker = state.broker.find((item) => item.id === current.brokerConnectionId);
      if (!model || !broker) return;
      Object.assign(model, next);
      broker.name = model.name;
      broker.baseUrl = model.baseUrl;
      broker.hasSecret = model.hasSecret;
      updated = model;
    });
    if (!updated) throw new HttpError(404, "Model connection not found");
    if (patch.secret) await this.kernel.store.putSecret(current.brokerConnectionId, patch.secret);
    return updated;
  }

  async deleteAgent(id: string): Promise<void> {
    if (id === SATURN_AGENT_ID) throw new HttpError(403, "Saturn Agents is built in");
    this.kernel.session.requireAdmin();
    this.kernel.getAgent(id);
    await this.kernel.session.removeOnCloud(`/agents/${encodeURIComponent(id)}`);
    await this.kernel.store.update((state) => {
      state.agents = state.agents.filter((item) => item.id !== id);
      state.runs = state.runs.filter((item) => item.agentId !== id);
    });
  }

  async deleteMcpServer(id: string): Promise<void> {
    if (id === GENERAL_SKILLS_ID) throw new HttpError(403, "General Skills is built in");
    if (id.startsWith("saturn:")) throw new HttpError(403, "Saturn MCP follows the organization tool set");
    const server = this.kernel.store.state.mcp.find((item) => item.id === id);
    if (!server) throw new HttpError(404, "MCP server not found");
    if (server.origin === "organization") {
      this.kernel.session.requireAdmin();
      await this.kernel.session.removeOnCloud(`/mcp-servers/${encodeURIComponent(id)}`);
    }
    await this.kernel.store.update((state) => {
      state.mcp = state.mcp.filter((item) => item.id !== id);
      for (const agent of state.agents) {
        agent.mcpConnectionIds = agent.mcpConnectionIds.filter((item) => item !== id);
      }
    });
    await this.kernel.session.syncAppMcp();
  }

  async deleteConnection(kind: "models" | "mcp" | "rag", id: string): Promise<void> {
    const used = this.kernel.store.state.agents.some((agent) => {
      if (kind === "models") return agent.modelConnectionId === id;
      if (kind === "mcp") return agent.mcpConnectionIds.includes(id);
      return agent.ragConnectionIds.includes(id);
    });
    if (used) throw new HttpError(409, "Connection is still used by an agent");
    const model = kind === "models" ? this.kernel.store.state.models.find((item) => item.id === id) : undefined;
    if (model) await this.kernel.session.deleteOrgCredential(model.id);
    await this.kernel.store.update((state) => {
      state[kind] = state[kind].filter((item) => item.id !== id) as never;
      if (model) state.broker = state.broker.filter((item) => item.id !== model.brokerConnectionId);
    });
    if (model) await this.kernel.store.deleteSecret(model.brokerConnectionId);
    this.kernel.session.announce();
  }

  async createMcp(input: { name: string; url: string; tools?: { toolId: string; description?: string }[] }) {
    const id = newId("mcp");
    const tools = (input.tools ?? []).map((tool) => this.kernel.route(id, tool.toolId, tool.description ?? ""));
    const connection: McpConnection = { id, name: input.name, url: input.url, tools, origin: "local" };
    await this.kernel.store.update((state) => {
      state.mcp.push(connection);
    });
    this.kernel.session.announce();
    await this.kernel.session.syncAppMcp();
    return connection;
  }

  async updateMcp(
    id: string,
    patch: { name?: string; url?: string; tools?: { toolId: string; description?: string }[] },
  ): Promise<McpConnection> {
    if (id === GENERAL_SKILLS_ID) throw new HttpError(403, "General Skills is built in");
    let updated: McpConnection | undefined;
    await this.kernel.store.update((state) => {
      const current = state.mcp.find((item) => item.id === id);
      if (!current) return;
      current.name = patch.name ?? current.name;
      current.url = patch.url ?? current.url;
      if (patch.tools) {
        current.tools = patch.tools.map((tool) => this.kernel.route(id, tool.toolId, tool.description ?? ""));
      }
      updated = current;
    });
    if (!updated) throw new HttpError(404, "MCP connection not found");
    this.kernel.session.announce();
    await this.kernel.session.syncAppMcp();
    return updated;
  }

  async discoverMcp(id: string) {
    if (id === GENERAL_SKILLS_ID) throw new HttpError(403, "General Skills is built in");
    const server = this.kernel.store.state.mcp.find((item) => item.id === id);
    if (!server) throw new HttpError(404, "MCP connection not found");
    const tools = (await this.kernel.mcp.listTools(server.url)).map((tool) => ({
      ...tool,
      serverId: id,
      organizationId: this.kernel.store.state.session.organizationId,
    }));
    await this.kernel.store.update((state) => {
      const current = state.mcp.find((item) => item.id === id);
      if (current) current.tools = tools;
    });
    this.kernel.session.announce();
    await this.kernel.session.syncAppMcp();
    return this.kernel.store.state.mcp.find((item) => item.id === id);
  }

  async createRag(input: { name: string; url: string }) {
    const connection: RagConnection = { id: newId("rag"), name: input.name, url: input.url };
    await this.kernel.store.update((state) => {
      state.rag.push(connection);
    });
    return connection;
  }

  async updateRag(id: string, patch: { name?: string; url?: string }): Promise<RagConnection> {
    let updated: RagConnection | undefined;
    await this.kernel.store.update((state) => {
      const current = state.rag.find((item) => item.id === id);
      if (!current) return;
      current.name = patch.name ?? current.name;
      current.url = patch.url ?? current.url;
      updated = current;
    });
    if (!updated) throw new HttpError(404, "RAG connection not found");
    return updated;
  }
}
