import { HttpError } from "../domain/errors.js";
import { newId } from "../domain/ids.js";
import { LLM_PROVIDERS, claudeEffort, llmProvider, runsOnPlan } from "../domain/llm/catalog.js";
import {
  GENERAL_SKILLS_ID,
  withGeneralSkills,
  CURSOR_COMPUTER_USE_ID,
  CURSOR_ORIGIN_ID,
  cursorComputerUseSkills,
  cursorOriginSkills,
  ANTIGRAVITY_SKILLS_ID,
  antigravitySkills,
} from "../domain/builtin.js";
import type { Agent, McpConnection, ModelConnection, RagConnection, ToolRoute } from "../domain/model.js";
import { listLmStudioModels } from "../infrastructure/llm.js";
import { namespacedTool } from "../domain/marketplace.js";
import type { McpTarget } from "../infrastructure/mcp.js";
import type { RuntimeKernel } from "./kernel.js";
import { CommandNotApproved, commandAddress, commandFingerprint, commandLine, commandView, envSecretKey, parseCommand, serverEnvironment } from "./mcp-command.js";
import path from "node:path";

/** Host only: MCP and RAG URLs can carry tokens in their path or query. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url.split("/")[0];
  } catch {
    return "(invalid url)";
  }
}

/**
 * An MCP server is a network endpoint: Saturn speaks MCP only over HTTP(S), so adding a server never makes Saturn
 * start a program on this computer. Anything else (a command line, a file: or stdio: address) is refused.
 */
export function mcpEndpoint(url: string): string {
  const value = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(400, "An MCP server is added by its URL (https://…). Saturn does not start local programs as MCP servers.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new HttpError(400, `MCP servers are reached over HTTP(S), not ${parsed.protocol.replace(/:$/, "")}. Saturn does not start local programs as MCP servers.`);
  }
  return value;
}

/** Local agents and the model, MCP, and knowledge connections they use. */
export class CatalogService {

  constructor(private readonly kernel: RuntimeKernel) {}

  async listAgents(): Promise<Agent[]> {
    await this.kernel.ensureBuiltins();
    return this.kernel.store.state.agents;
  }

  async createAgent(input: Partial<Agent> & { name: string }): Promise<Agent> {
    await this.kernel.ensureBuiltins();
    const agent: Agent = {
      id: newId("agent"),
      name: input.name,
      description: input.description ?? "",
      instructions: input.instructions ?? "",
      responseStyle: input.responseStyle ?? "professional",
      autonomy: input.autonomy ?? "execute_when_allowed",
      temperature: input.temperature ?? 0.2,
      maxOutput: input.maxOutput ?? 4000,
      status: "active",
      canEdit: true,
      modelConnectionId: input.modelConnectionId ?? null,
      mcpConnectionIds: withGeneralSkills(input.mcpConnectionIds ?? this.kernel.store.state.mcp.map((item) => item.id).filter((id) => id !== GENERAL_SKILLS_ID)),
      ragConnectionIds: input.ragConnectionIds ?? [],
    };
    await this.kernel.store.update((state) => {
      state.agents.push(agent);
    });
    const model = this.kernel.store.state.models.find((item) => item.id === agent.modelConnectionId);
    this.kernel.log("catalog", "info", `Agent "${agent.name}" created${model ? ` on ${model.name}` : " with no model"}`, { "gen_ai.agent.id": agent.id });
    return agent;
  }

  async updateAgent(id: string, patch: Partial<Agent>): Promise<Agent> {
    const current = this.kernel.getAgent(id);
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
      canEdit: true,
      modelConnectionId: patch.modelConnectionId === undefined ? current.modelConnectionId : patch.modelConnectionId,
      mcpConnectionIds: withGeneralSkills(patch.mcpConnectionIds ?? current.mcpConnectionIds),
      ragConnectionIds: patch.ragConnectionIds ?? current.ragConnectionIds,
      // Edited through /permissions, never through this patch.
      ...(current.permissions ? { permissions: current.permissions } : {}),
    };
    // Compared before saving: `current` is the stored object and is updated in place.
    const changed = (Object.keys(next) as (keyof Agent)[]).filter((key) => JSON.stringify(next[key]) !== JSON.stringify(current[key]));
    await this.kernel.store.update((state) => {
      const agent = state.agents.find((item) => item.id === id);
      if (agent) Object.assign(agent, next);
    });
    if (changed.length) {
      // Field names only: instructions and descriptions can be long or private.
      this.kernel.log("catalog", "info", `Agent "${next.name}" updated: ${changed.join(", ")}`, { "gen_ai.agent.id": id });
    }
    return this.kernel.getAgent(id);
  }

  async listConnections(kind: "models" | "mcp" | "rag") {
    if (kind === "mcp") await this.kernel.ensureBuiltins();
    if (kind === "models") return this.kernel.store.state.models.map((model) => this.withKey(model));
    if (kind === "mcp") return this.kernel.store.state.mcp.map((server) => ({ ...server, ...commandView(server, this.commandEnv(server.id)) }));
    return this.kernel.store.state[kind];
  }

  llmProviders() {
    return LLM_PROVIDERS;
  }

  async lmStudioModels(baseUrl: string) {
    const provider = llmProvider("lmstudio");
    const url = baseUrl || provider?.baseUrl || "http://127.0.0.1:1234";
    try {
      return await listLmStudioModels(url);
    } catch (error) {
      // Polled while the LM Studio form is open, so only at debug.
      this.kernel.log("catalog", "debug", `LM Studio at ${url} did not list models: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  async createModel(input: { name?: string; provider?: string; model?: string; baseUrl?: string; secret?: string; effort?: string }) {
    const provider = llmProvider(input.provider || "openai");
    if (!provider) throw new HttpError(400, "Choose OpenAI, Claude, Claude (via Claude Code), Codex, Gemini, DeepSeek, or LM Studio");
    if (runsOnPlan(provider.id) && input.secret) throw new HttpError(400, `${provider.label} runs on your own plan through its official program and takes no API key. For API access, add the model under Claude or OpenAI.`);
    const effort = claudeEffort(input.effort);
    const modelId = (input.model || input.name || "").trim();
    if (!modelId) throw new HttpError(400, "Choose a model");
    const known = provider.models.find((item) => item.id === modelId);
    const id = newId("mdl");
    const model: ModelConnection = {
      id,
      // A subscription model is named apart from the API model of the same name, so the two are never confused.
      name: (input.name || (known?.label && provider.id === "claude-code" ? `${known.label} (via Claude Code)` : known?.label) || modelId).trim(),
      provider: provider.id,
      model: modelId,
      baseUrl: (input.baseUrl || provider.baseUrl).replace(/\/$/, ""),
      hasSecret: Boolean(input.secret),
      ...(effort ? { effort } : {}),
    };
    await this.kernel.store.update((state) => {
      state.models.push(model);
    });
    if (input.secret) await this.kernel.llm.saveKey(model, input.secret);
    const keyed = this.withKey(model);
    const key = input.secret ? "key entered" : keyed.hasSecret ? `using the saved ${provider.label} key` : provider.needsKey ? "no key" : "no key needed";
    this.kernel.log("catalog", "info", `Model ${model.name} connected (${provider.label}, ${key})`, { "gen_ai.provider.name": provider.id, "gen_ai.request.model": modelId });
    if (provider.needsKey && !keyed.hasSecret) {
      this.kernel.log("catalog", "warning", `${model.name} has no ${provider.label} API key; runs on it will be refused until one is added`);
    }
    return keyed;
  }

  async updateModel(
    id: string,
    patch: { name?: string; provider?: string; model?: string; baseUrl?: string; secret?: string; effort?: string | null },
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
      effort: patch.effort === null ? undefined : claudeEffort(patch.effort) ?? current.effort,
    };
    // Compared before saving: `current` is the stored object and is updated in place.
    const fields: string[] = (["name", "provider", "model", "baseUrl", "effort"] as const).filter((key) => next[key] !== current[key]);
    let updated: ModelConnection | undefined;
    await this.kernel.store.update((state) => {
      const model = state.models.find((item) => item.id === id);
      if (!model) return;
      Object.assign(model, next);
      updated = model;
    });
    if (!updated) throw new HttpError(404, "Model connection not found");
    if (patch.secret && runsOnPlan(updated.provider)) throw new HttpError(400, "This model runs on your own plan through its official program and takes no API key.");
    if (patch.secret) await this.kernel.llm.saveKey(updated, patch.secret);
    if (patch.secret) fields.push("API key");
    if (fields.length) {
      // Never the key itself; for a key, only that one was saved and that it now serves the whole provider.
      const shared = patch.secret ? ` (now the saved ${updated.provider} key)` : "";
      this.kernel.log("catalog", "info", `Model ${updated.name} updated: ${fields.join(", ")}${shared}`, { "gen_ai.provider.name": updated.provider });
    }
    return this.withKey(updated);
  }

  async deleteAgent(id: string): Promise<void> {
    const agent = this.kernel.getAgent(id);
    const runs = this.kernel.store.state.runs.filter((item) => item.agentId === id).length;
    const automations = this.kernel.store.state.automations.filter((item) => item.agentId === id).length;
    await this.kernel.store.update((state) => {
      state.agents = state.agents.filter((item) => item.id !== id);
      state.runs = state.runs.filter((item) => item.agentId !== id);
      state.threads = (state.threads ?? []).filter((item) => item.agentId !== id);
      state.automations = state.automations.filter((item) => item.agentId !== id);
    });
    this.kernel.log("catalog", "info", `Agent "${agent.name}" deleted with ${runs} runs and ${automations} automations`, { "gen_ai.agent.id": id });
  }

  async deleteMcpServer(id: string): Promise<void> {
    if (id === GENERAL_SKILLS_ID || id === CURSOR_COMPUTER_USE_ID || id === CURSOR_ORIGIN_ID) {
      throw new HttpError(403, "Built-in server cannot be removed");
    }
    const server = this.kernel.store.state.mcp.find((item) => item.id === id);
    if (!server) throw new HttpError(404, "MCP server not found");
    await this.kernel.store.update((state) => {
      state.mcp = state.mcp.filter((item) => item.id !== id);
      for (const agent of state.agents) {
        agent.mcpConnectionIds = agent.mcpConnectionIds.filter((item) => item !== id);
      }
    });
    // Its session (a local server's process) and any saved sign-in or environment go with it.
    await this.kernel.mcp.forget(id);
    await this.kernel.store.deleteSecret(envSecretKey(id));
    this.kernel.log("catalog", "info", `MCP server ${server.name} (${hostOf(server.url)}) removed and detached from all agents`);
  }

  async deleteConnection(kind: "models" | "mcp" | "rag", id: string): Promise<void> {
    const used = this.kernel.store.state.agents.some((agent) => {
      if (kind === "models") return agent.modelConnectionId === id;
      if (kind === "mcp") return agent.mcpConnectionIds.includes(id);
      return agent.ragConnectionIds.includes(id);
    });
    if (used) throw new HttpError(409, "Connection is still used by an agent");
    const removed = (this.kernel.store.state[kind] as { id: string; name: string }[]).find((item) => item.id === id);
    await this.kernel.store.update((state) => {
      state[kind] = state[kind].filter((item) => item.id !== id) as never;
      // Saturn IDE's completions turn off rather than point at a model that is gone.
      if (kind === "models" && state.settings.completionModelId === id) state.settings.completionModelId = null;
    });
    if (kind === "models") await this.kernel.store.deleteSecret(id);
    if (removed) {
      const label = kind === "models" ? "Model" : kind === "mcp" ? "MCP server" : "Knowledge source";
      // The provider's shared key stays, so other models of that provider keep working.
      this.kernel.log("catalog", "info", `${label} ${removed.name} removed`);
    }
  }

  private withKey(model: ModelConnection): ModelConnection {
    return { ...model, hasSecret: this.kernel.llm.hasKey(model) };
  }

  async createMcp(input: { name: string; url?: string; command?: unknown; tools?: { toolId: string; description?: string }[] }) {
    const id = newId("mcp");
    const tools = (input.tools ?? []).map((tool) => this.kernel.route(id, tool.toolId, tool.description ?? ""));
    if (input.command !== undefined) {
      // A local server: stored, but it does not start until the user has seen this exact command and allowed it.
      const { command, env } = parseCommand(input.command);
      if (Object.keys(env).length) await this.kernel.store.putSecret(envSecretKey(id), JSON.stringify(env));
      const connection: McpConnection = { id, name: input.name?.trim() || path.basename(command.program), url: commandAddress(command), command, tools, origin: "local" };
      await this.kernel.store.update((state) => {
        state.mcp.push(connection);
      });
      this.kernel.log("catalog", "info", `Local MCP server ${connection.name} added (${commandLine(command)}); it waits for approval before it starts`);
      return { ...connection, ...commandView(connection, env) };
    }
    const connection: McpConnection = { id, name: input.name, url: mcpEndpoint(input.url ?? ""), tools, origin: "local" };
    await this.kernel.store.update((state) => {
      state.mcp.push(connection);
    });
    this.kernel.log("catalog", "info", `MCP server ${connection.name} added at ${hostOf(connection.url)} with ${tools.length} tools`);
    return connection;
  }

  /** A local server's environment variables, from the secrets file. */
  commandEnv(id: string): Record<string, string> {
    const saved = this.kernel.store.secret(envSecretKey(id));
    return saved ? (JSON.parse(saved) as Record<string, string>) : {};
  }

  /**
   * Allows a local server's command to run. `fingerprint` is the one Settings showed the user; if the command
   * changed since, nothing is allowed and the user is asked to look again.
   */
  async approveMcp(id: string, fingerprint: string) {
    const server = this.kernel.store.state.mcp.find((item) => item.id === id);
    if (!server) throw new HttpError(404, "MCP connection not found");
    if (!server.command) throw new HttpError(400, "Only local MCP servers need approval");
    const current = commandFingerprint(server.command, this.commandEnv(id));
    if (fingerprint !== current) throw new HttpError(409, "The command changed since you looked at it. Review it again before allowing it.");
    await this.kernel.store.update((state) => {
      const item = state.mcp.find((entry) => entry.id === id);
      if (item) item.approvedCommand = current;
    });
    this.kernel.log("catalog", "info", `Allowed the local MCP server ${server.name} to run: ${commandLine(server.command)}`);
    const updated = this.kernel.store.state.mcp.find((item) => item.id === id)!;
    return { ...updated, ...commandView(updated, this.commandEnv(id)) };
  }

  /** How to reach a server. A local one must have its current command approved, or this throws CommandNotApproved. */
  targetFor(server: McpConnection): McpTarget {
    if (!server.command) return { id: server.id, url: server.url, auth: server.auth ?? "none" };
    const env = this.commandEnv(server.id);
    if (server.approvedCommand !== commandFingerprint(server.command, env)) throw new CommandNotApproved(server.name, commandLine(server.command));
    return {
      id: server.id,
      url: server.url,
      auth: "none",
      command: { program: server.command.program, args: server.command.args, env: serverEnvironment(env), cwd: path.join(this.kernel.store.root, "workspace") },
    };
  }

  async updateMcp(
    id: string,
    patch: { name?: string; url?: string; command?: unknown; tools?: { toolId: string; description?: string }[]; disabledTools?: string[] },
  ): Promise<McpConnection> {
    if ((patch.name !== undefined || patch.url !== undefined || patch.tools !== undefined) && id === GENERAL_SKILLS_ID) {
      throw new HttpError(403, "General Skills is built in");
    }
    if (patch.url !== undefined) patch = { ...patch, url: mcpEndpoint(patch.url) };
    // A new command (or new variables) starts over: the old approval no longer applies and the running server stops.
    const changedCommand = patch.command !== undefined ? parseCommand(patch.command) : undefined;
    if (changedCommand) {
      if (!this.kernel.store.state.mcp.find((item) => item.id === id)?.command) throw new HttpError(400, "This MCP server is reached by its URL; add a local server separately.");
      if (Object.keys(changedCommand.env).length) await this.kernel.store.putSecret(envSecretKey(id), JSON.stringify(changedCommand.env));
      else await this.kernel.store.deleteSecret(envSecretKey(id));
      await this.kernel.mcp.close(id);
    }
    let updated: McpConnection | undefined;
    await this.kernel.store.update((state) => {
      const current = state.mcp.find((item) => item.id === id);
      if (!current) return;
      if (patch.name !== undefined) current.name = patch.name;
      if (patch.url !== undefined) current.url = patch.url;
      if (changedCommand) {
        current.command = changedCommand.command;
        current.url = commandAddress(changedCommand.command);
        delete current.approvedCommand;
      }
      if (patch.disabledTools !== undefined) current.disabledTools = patch.disabledTools;
      if (patch.tools) {
        current.tools = patch.tools.map((tool) => this.kernel.route(id, tool.toolId, tool.description ?? ""));
      }
      updated = current;
    });
    if (!updated) throw new HttpError(404, "MCP connection not found");
    const fields = [
      patch.name !== undefined && "name",
      patch.url !== undefined && "url",
      changedCommand && "command (approval needed again)",
      patch.tools && "tools",
      patch.disabledTools && "disabledTools",
    ].filter(Boolean);
    this.kernel.log("catalog", "info", `MCP server ${updated.name} updated: ${fields.join(", ") || "nothing"}`);
    return { ...updated, ...commandView(updated, this.commandEnv(id)) };
  }

  async discoverMcp(id: string) {
    if (id === GENERAL_SKILLS_ID) throw new HttpError(403, "General Skills is built in");
    const server = this.kernel.store.state.mcp.find((item) => item.id === id);
    if (!server) throw new HttpError(404, "MCP connection not found");
    let tools: ToolRoute[] = [];
    if (id === CURSOR_COMPUTER_USE_ID) {
      tools = cursorComputerUseSkills().tools;
    } else if (id === CURSOR_ORIGIN_ID) {
      tools = cursorOriginSkills().tools;
    } else if (id === ANTIGRAVITY_SKILLS_ID) {
      tools = antigravitySkills().tools;
    } else {
      tools = (await this.kernel.mcp.listTools(this.targetFor(server))).map((tool) =>
        server.marketplaceId
          ? { ...tool, serverId: id, toolId: namespacedTool(server.marketplaceId, tool.toolId), remoteName: tool.toolId }
          : { ...tool, serverId: id },
      );
    }
    const before = new Set(server.tools.map((tool) => tool.toolId));
    const after = new Set(tools.map((tool) => tool.toolId));
    const added = [...after].filter((tool) => !before.has(tool));
    const gone = [...before].filter((tool) => !after.has(tool));
    await this.kernel.store.update((state) => {
      const current = state.mcp.find((item) => item.id === id);
      if (current) current.tools = tools;
    });
    const diff = [added.length && `+${added.join(", +")}`, gone.length && `-${gone.join(", -")}`].filter(Boolean).join("; ");
    this.kernel.log("catalog", "info", `MCP server ${server.name} lists ${tools.length} tools${diff ? ` (${diff})` : " (unchanged)"}`);
    if (!tools.length) this.kernel.log("catalog", "warning", `MCP server ${server.name} at ${hostOf(server.url)} returned no tools`);
    return this.kernel.store.state.mcp.find((item) => item.id === id);
  }

  async createRag(input: { name: string; url: string }) {
    const connection: RagConnection = { id: newId("rag"), name: input.name, url: input.url };
    await this.kernel.store.update((state) => {
      state.rag.push(connection);
    });
    this.kernel.log("catalog", "info", `Knowledge source ${connection.name} added at ${hostOf(connection.url)}`);
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
    this.kernel.log("catalog", "info", `Knowledge source ${updated.name} updated`);
    return updated;
  }
}
