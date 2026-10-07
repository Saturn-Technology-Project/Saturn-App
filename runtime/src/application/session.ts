import { HttpError } from "../domain/errors.js";
import { GENERAL_SKILLS_ID, SATURN_AGENT_ID } from "../domain/builtin.js";
import type { Agent, BrokerConnection, ModelConnection } from "../domain/model.js";
import { agentsAccess, canEditAgent, teamAccess, type CloudCredential, type CloudUser } from "../domain/account.js";
import { autonomyOf, boundModel, cloudProvider, numberOf, styleOf } from "../domain/policies.js";
import { RUNTIME_CALLER } from "./runtime-state.js";
import type { RuntimeKernel } from "./kernel.js";

/** Account, team, and Saturn Cloud. This is the control-plane adapter; the other use cases stay local. */
export class SessionService {
  constructor(private readonly kernel: RuntimeKernel) {}

  async unpair(): Promise<void> {
    this.kernel.pending.clear();
    this.kernel.inflight.clear();
    await this.kernel.store.update((state) => {
      for (const run of state.runs) {
        if (run.status === "waiting_approval" || run.status === "running" || run.status === "queued") {
          run.status = "failed";
          run.error = "Unpaired from Saturn Cloud";
        }
      }
    });
    await this.kernel.cloud.unpair();
  }

  session() {
    const account = this.kernel.store.state.account;
    const session = this.kernel.store.state.session;
    return {
      loggedIn: Boolean(account),
      email: account?.email ?? null,
      name: account?.name ?? null,
      role: account?.role ?? null,
      title: account?.title ?? "",
      team: account?.team ?? "none",
      agents: account?.agents ?? "none",
      organization: account
        ? { id: account.organizationId, name: account.organizationName }
        : null,
      paired: session.paired,
      connected: this.kernel.cloud.isConnected(),
    };
  }

  async login(apiBase: string, email: string, password: string) {
    const base = apiBase.replace(/\/$/, "");
    if (!base || !email || !password) throw new HttpError(400, "Email and password are required");
    this.kernel.credentialsUnavailable = false;
    const response = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      token?: string;
      detail?: string;
      error?: string;
      user?: CloudUser;
    };
    if (!response.ok || !body.token || !body.user?.organization?.id) {
      throw new HttpError(response.status === 401 ? 401 : 400, body.detail || body.error || "Email or password is incorrect");
    }
    await this.kernel.store.putSecret("saturn-account", body.token);
    await this.applyAccount(base, body.user);
    let cloudError = "";
    try {
      await this.kernel.cloud.pair(base, body.token);
    } catch (error) {
      cloudError = error instanceof Error ? error.message : "Saturn Cloud is not connected";
      await this.kernel.store.update((state) => {
        state.session.apiBase = base;
        state.session.organizationId = body.user?.organization.id ?? state.session.organizationId;
        state.session.paired = false;
        state.session.connected = false;
      });
      this.kernel.log("cloud", "warning", cloudError);
    }
    return { ...this.session(), cloudError };
  }

  async refreshAccount() {
    const account = this.kernel.store.state.account;
    const token = this.kernel.store.secret("saturn-account");
    const apiBase = this.kernel.store.state.session.apiBase;
    if (!account || !token || !apiBase) return this.session();
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(`${apiBase.replace(/\/$/, "")}/auth/me`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      this.kernel.log("cloud", "warning", error instanceof Error ? error.message : "Could not refresh the account");
      return this.session();
    }
    if (response.status === 401) {
      await this.logout();
      return this.session();
    }
    if (!response.ok) return this.session();
    const user = (await response.json()) as CloudUser;
    await this.applyAccount(apiBase, user);
    if (!this.kernel.cloud.isConnected()) {
      try {
        await this.kernel.cloud.pair(apiBase, token);
      } catch (error) {
        this.kernel.log("cloud", "warning", error instanceof Error ? error.message : "Saturn Cloud is not connected");
      }
    }
    return this.session();
  }

  async accountProfile() {
    const user = await this.cloudJson<CloudUser>(await this.cloudFetch("/auth/me"));
    return {
      name: user.name,
      email: user.email,
      title: user.employee?.title ?? "",
      role: user.role ?? user.employee?.role ?? "",
      status: user.employee?.status ?? "",
    };
  }

  async updateAccountProfile(input: { name?: string; title?: string }) {
    const member = await this.cloudJson<{ name: string; email: string; title: string; role: string; status: string }>(
      await this.cloudFetch("/org/me", {
        method: "PATCH",
        body: JSON.stringify({ name: input.name, title: input.title }),
      }),
    );
    await this.kernel.store.update((state) => {
      if (!state.account) return;
      state.account.name = member.name || state.account.name;
      state.account.title = member.title ?? state.account.title;
    });
    return {
      name: member.name,
      email: member.email,
      title: member.title,
      role: member.role,
      status: member.status,
    };
  }

  async teamMembers() {
    this.requireTeam("read");
    return this.cloudJson<unknown[]>(await this.cloudFetch("/org/members"));
  }

  async updateTeamMember(employeeId: string, input: {
    name?: string;
    title?: string;
    role?: string;
    status?: string;
    agent_ids?: string[];
    agent_edit_ids?: string[];
  }) {
    this.requireTeam("write");
    return this.cloudJson(await this.cloudFetch(`/org/members/${encodeURIComponent(employeeId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }));
  }

  async inviteTeamMember(input: { email: string; name: string; role: string }) {
    this.requireTeam("write");
    return this.cloudJson(await this.cloudFetch("/org/invites", {
      method: "POST",
      body: JSON.stringify({ email: input.email, name: input.name, role: input.role }),
    }));
  }

  requireTeam(level: "read" | "write") {
    const team = this.kernel.store.state.account?.team ?? "none";
    const rank = { none: 0, read: 1, write: 2 };
    if (rank[team] < rank[level]) throw new HttpError(403, "You do not have access to the team");
  }

  requireAdmin(): void {
    if (this.kernel.store.state.account?.team !== "write") throw new HttpError(403, "Admin access required");
  }

  async removeOnCloud(path: string): Promise<void> {
    const response = await this.cloudFetch(path, { method: "DELETE" });
    if (response.ok) return;
    const body = (await response.json().catch(() => ({}))) as { detail?: string };
    if (response.status === 404 && body.detail && body.detail !== "Not Found") return;
    throw new HttpError(response.status, typeof body.detail === "string" ? body.detail : "Could not remove it");
  }

  cloudFetch(path: string, init?: RequestInit) {
    const token = this.kernel.store.secret("saturn-account");
    const apiBase = this.kernel.store.state.session.apiBase;
    if (!this.kernel.store.state.account || !token || !apiBase) throw new HttpError(401, "Not signed in");
    return fetch(`${apiBase.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });
  }

  async cloudJson<T>(response: Response): Promise<T> {
    const body = (await response.json().catch(() => ({}))) as { detail?: string };
    if (!response.ok) {
      throw new HttpError(response.status, typeof body.detail === "string" ? body.detail : "Saturn Cloud request failed");
    }
    return body as T;
  }

  async logout(): Promise<void> {
    const token = this.kernel.store.secret("saturn-account");
    const apiBase = this.kernel.store.state.session.apiBase;
    if (token && apiBase) {
      await fetch(`${apiBase.replace(/\/$/, "")}/auth/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }).catch(() => undefined);
    }
    await this.unpair();
    await this.kernel.store.deleteSecret("saturn-account");
    await this.kernel.store.update((state) => {
      state.account = null;
    });
    this.kernel.loadedAgents = "";
    this.kernel.syncedAt = 0;
    this.kernel.log("runtime", "info", "Signed out");
  }

  modelCredential(model: ModelConnection, secret?: string): Record<string, unknown> {
    const value = secret === undefined ? this.kernel.store.secret(model.brokerConnectionId) : secret;
    return {
      id: model.id,
      kind: "model",
      name: model.name,
      provider: model.provider,
      model: model.model,
      base_url: model.baseUrl,
      secret_name: "AGENTS_API_KEY",
      broker_id: model.brokerConnectionId,
      allowed_paths: ["/chat/completions", "/v1/chat/completions"],
      ...(typeof value === "string" ? { secret: value } : {}),
    };
  }

  keyCredential(key: BrokerConnection, secret: string | undefined, includeSecret: boolean): Record<string, unknown> {
    return {
      id: key.id,
      kind: "key",
      name: key.name,
      provider: "",
      model: "",
      base_url: key.baseUrl,
      secret_name: key.secretName,
      broker_id: key.id,
      allowed_paths: key.allowedPaths,
      ...(includeSecret ? { secret: secret ?? "" } : secret ? { secret } : {}),
    };
  }

  async upsertOrgCredential(body: Record<string, unknown>): Promise<CloudCredential | null> {
    if (this.kernel.credentialsUnavailable || !this.kernel.store.state.account || !this.kernel.store.secret("saturn-account") || !this.kernel.store.state.session.apiBase) {
      return null;
    }
    const response = await this.cloudFetch("/org/credentials", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (response.status === 404) {
      this.kernel.credentialsUnavailable = true;
      return null;
    }
    return this.cloudJson<CloudCredential>(response);
  }

  async deleteOrgCredential(id: string): Promise<void> {
    if (this.kernel.credentialsUnavailable || !this.kernel.store.state.account || !this.kernel.store.secret("saturn-account") || !this.kernel.store.state.session.apiBase) {
      return;
    }
    const response = await this.cloudFetch(`/org/credentials/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (response.ok) return;
    const body = (await response.json().catch(() => ({}))) as { detail?: string };
    if (response.status === 404) {
      if (!body.detail || body.detail === "Not Found") this.kernel.credentialsUnavailable = true;
      return;
    }
    throw new HttpError(response.status, typeof body.detail === "string" ? body.detail : "Could not sync the credential");
  }

  async syncOrgCredentials(): Promise<void> {
    if (this.kernel.credentialsUnavailable || !this.kernel.store.state.account || !this.kernel.store.secret("saturn-account") || !this.kernel.store.state.session.apiBase) {
      return;
    }
    const listed = await this.cloudFetch("/org/credentials");
    if (listed.status === 404) {
      this.kernel.credentialsUnavailable = true;
      return;
    }
    if (!listed.ok) return;
    const remote = new Map(((await listed.json()) as CloudCredential[]).map((item) => [item.id, item]));
    const failed = new Set<string>();
    for (const model of this.kernel.store.state.models) {
      if (remote.has(model.id)) continue;
      try {
        const saved = await this.upsertOrgCredential(this.modelCredential(model));
        if (saved) remote.set(saved.id, saved);
        else failed.add(model.id);
      } catch {
        failed.add(model.id);
      }
    }
    const modelBrokerIds = new Set(this.kernel.store.state.models.map((item) => item.brokerConnectionId));
    for (const key of this.kernel.store.state.broker) {
      if (modelBrokerIds.has(key.id) || remote.has(key.id)) continue;
      try {
        const saved = await this.upsertOrgCredential(this.keyCredential(key, this.kernel.store.secret(key.id), Boolean(this.kernel.store.secret(key.id))));
        if (saved) remote.set(saved.id, saved);
        else failed.add(key.id);
      } catch {
        failed.add(key.id);
      }
    }
    if (this.kernel.credentialsUnavailable) return;
    const secretsResponse = await this.cloudFetch("/org/credentials/secrets");
    if (secretsResponse.status === 404) {
      this.kernel.credentialsUnavailable = true;
      return;
    }
    if (!secretsResponse.ok) return;
    const secrets = new Map(
      ((await secretsResponse.json()) as { id: string; secret?: string }[]).map((item) => [item.id, item.secret ?? ""]),
    );
    const writes: { id: string; value: string | null }[] = [];
    await this.kernel.store.update((state) => {
      const previousBrokerIds = state.broker.map((item) => item.id);
      const incoming = [...remote.values()];
      const models = incoming.filter((item) => item.kind === "model");
      const keys = incoming.filter((item) => item.kind === "key");
      const keptModels = state.models.filter((item) => failed.has(item.id) && !models.some((remoteModel) => remoteModel.id === item.id));
      const nextModels = models.map((item) => this.modelFromCredential(item));
      state.models = [...nextModels, ...keptModels];
      const nextBrokers = [
        ...nextModels.map((item) => this.modelBroker(item)),
        ...keys.map((item) => this.keyFromCredential(item)),
      ];
      const nextIds = new Set(nextBrokers.map((item) => item.id));
      const keptBrokers = state.broker.filter((item) => {
        if (nextIds.has(item.id)) return false;
        if (failed.has(item.id)) return true;
        return keptModels.some((model) => model.brokerConnectionId === item.id);
      });
      state.broker = [...nextBrokers, ...keptBrokers];
      const retained = new Set(state.broker.map((item) => item.id));
      for (const id of previousBrokerIds) {
        if (!retained.has(id)) writes.push({ id, value: null });
      }
      for (const item of models) {
        const brokerId = item.broker_id || item.id;
        const secret = secrets.get(item.id) ?? "";
        if (item.has_secret && secret) writes.push({ id: brokerId, value: secret });
        else if (!item.has_secret) writes.push({ id: brokerId, value: null });
      }
      for (const item of keys) {
        const secret = secrets.get(item.id) ?? "";
        if (item.has_secret && secret) writes.push({ id: item.id, value: secret });
        else if (!item.has_secret) writes.push({ id: item.id, value: null });
      }
    });
    for (const write of writes) {
      if (write.value === null) await this.kernel.store.deleteSecret(write.id);
      else await this.kernel.store.putSecret(write.id, write.value);
    }
  }

  modelFromCredential(item: CloudCredential): ModelConnection {
    return {
      id: item.id,
      name: item.name,
      provider: item.provider || "openai",
      model: item.model || item.name,
      baseUrl: (item.base_url || "").replace(/\/$/, ""),
      brokerConnectionId: item.broker_id || item.id,
      hasSecret: Boolean(item.has_secret),
    };
  }

  modelBroker(model: ModelConnection): BrokerConnection {
    return {
      id: model.brokerConnectionId,
      name: model.name,
      baseUrl: model.baseUrl,
      secretName: "AGENTS_API_KEY",
      allowedCallers: [RUNTIME_CALLER.callerId],
      allowedTools: [],
      allowedPaths: ["/chat/completions", "/v1/chat/completions"],
      hasSecret: model.hasSecret,
    };
  }

  keyFromCredential(item: CloudCredential): BrokerConnection {
    const paths = (item.allowed_paths ?? []).filter(Boolean);
    return {
      id: item.id,
      name: item.name,
      baseUrl: item.base_url || "",
      secretName: item.secret_name || "API_KEY",
      allowedCallers: [RUNTIME_CALLER.callerId],
      allowedTools: [],
      allowedPaths: paths.length ? paths : ["/"],
      hasSecret: Boolean(item.has_secret),
    };
  }

  async applyAccount(apiBase: string, user: CloudUser): Promise<void> {
    const organization = user.organization;
    const nextUserId = user.id || user.email;
    const previous = this.kernel.store.state.account;
    if (previous && previous.userId !== nextUserId) {
      for (const controller of this.kernel.stops.values()) controller.abort();
      this.kernel.syncedAt = 0;
    }
    await this.kernel.store.update((state) => {
      const current = state.account;
      const switching = Boolean(current?.userId && current.userId !== nextUserId);
      for (const run of state.runs) {
        if (run.userId) continue;
        run.userId = switching ? current?.userId : nextUserId;
        run.organizationId = run.organizationId || (switching ? current?.organizationId : organization.id);
      }
      state.account = {
        userId: nextUserId,
        email: user.email,
        name: user.name,
        title: user.employee?.title ?? state.account?.title ?? "",
        organizationId: organization.id,
        organizationName: organization.name,
        role: user.role ?? user.employee?.role ?? null,
        team: teamAccess(user),
        agents: agentsAccess(user),
        agentEditIds: user.agent_edit_ids ?? null,
      };
      state.session.apiBase = apiBase;
      state.session.organizationId = organization.id;
    });
    try {
      await this.syncOrgCredentials();
    } catch (error) {
      this.kernel.log("cloud", "warning", error instanceof Error ? error.message : "Could not sync organization credentials");
    }
    const synced = user.app_mcp;
    const hadLocal = this.kernel.store.state.mcp.some((item) => item.origin === "local");
    const replaceLocal = Boolean(synced && ((synced.servers?.length ?? 0) > 0 || !hadLocal));
    await this.kernel.store.update((state) => {
      const previous = new Map(state.agents.map((agent) => [agent.id, agent]));
      const sets = new Map((user.tool_sets ?? []).map((set) => [set.id, set]));
      const local = replaceLocal
        ? (synced?.servers ?? []).map((server) => ({
            id: server.id,
            name: server.name,
            url: server.url,
            origin: "local" as const,
            tools: (server.tools ?? []).map((tool) => this.kernel.route(server.id, tool.tool_id, tool.description ?? "")),
          }))
        : state.mcp
            .filter((item) => item.origin !== "organization" && item.origin !== "saturn" && item.id !== GENERAL_SKILLS_ID && !item.id.startsWith("saturn:"))
            .map((item) => ({ ...item, origin: "local" as const }));
      const localIds = new Set(local.map((item) => item.id));
      state.agents = (user.agents ?? []).map((agent) => {
        const existing = previous.get(agent.id);
        const settings = agent.settings ?? {};
        const mapped = agent.tool_set_id ? sets.get(agent.tool_set_id) : undefined;
        const saturnId = `saturn:${agent.id}`;
        const setId = agent.tool_set_id ?? null;
        const setChanged = (existing?.toolSetId ?? null) !== setId;
        const includeSaturn = Boolean(mapped) && (setChanged || !existing || existing.mcpConnectionIds.includes(saturnId));
        const attached = replaceLocal
          ? (synced?.attachments?.[agent.id] ?? []).filter((id) => localIds.has(id))
          : (existing?.mcpConnectionIds ?? []).filter((id) => localIds.has(id));
        const knowledge = Array.isArray(settings.knowledge) ? settings.knowledge : null;
        return {
          id: agent.id,
          name: agent.name,
          description: agent.description ?? existing?.description ?? "",
          instructions: settings.instructions || existing?.instructions || "",
          responseStyle: styleOf(settings.response_style ?? existing?.responseStyle),
          autonomy: autonomyOf(settings.autonomy ?? existing?.autonomy),
          temperature: numberOf(settings.temperature, existing?.temperature ?? 0.2, 0, 2),
          maxOutput: numberOf(settings.max_output, existing?.maxOutput ?? 4000, 1, 128000),
          status: agent.status === "paused" ? "paused" as const : "active" as const,
          canEdit: canEditAgent(user, agent.id),
          modelConnectionId: boundModel(settings, existing?.modelConnectionId ?? null, state.models),
          toolSetId: setId,
          mcpConnectionIds: [...(includeSaturn ? [saturnId] : []), ...attached],
          ragConnectionIds: knowledge
            ? knowledge.filter((item) => item.enabled !== false && item.id).map((item) => String(item.id))
            : existing?.ragConnectionIds ?? [],
        };
      });
      const preservedSaturn = previous.get(SATURN_AGENT_ID);
      const saturnUrl = `${apiBase.replace(/\/$/, "")}/mcp`;
      const saturn = (user.agents ?? []).flatMap((agent) => {
        const set = agent.tool_set_id ? sets.get(agent.tool_set_id) : undefined;
        if (!set) return [];
        const id = `saturn:${agent.id}`;
        return [{
          id,
          name: set.name || "Saturn MCP",
          url: saturnUrl,
          origin: "saturn" as const,
          tools: (set.items ?? []).map((item) => this.kernel.route(id, item.name, item.description || "", item.input_schema)),
        }];
      });
      state.mcp = [...local, ...saturn];
      this.kernel.installBuiltins(state, preservedSaturn);
    });
    if (synced && (synced.servers?.length ?? 0) === 0 && hadLocal) {
      await this.syncAppMcp();
    }
    const loaded = `${organization.id}:${(user.agents ?? []).map((agent) => `${agent.id}:${agent.name}:${agent.status ?? ""}`).join(",")}`;
    if (loaded !== this.kernel.loadedAgents) {
      this.kernel.loadedAgents = loaded;
      this.kernel.log("runtime", "info", `Loaded ${user.agents?.length ?? 0} agents for ${organization.name}`);
    }
  }

  announce(): void {
    void this.syncAppMcp();
    if (!this.kernel.cloud.isConnected()) return;
    const session = this.kernel.store.state.session;
    this.kernel.cloud.send({
      type: "runtime.register",
      runtime_id: "saturn-app",
      name: "Saturn App",
      role: "operations",
      agents: this.kernel.store.state.agents.filter((agent) => agent.id !== SATURN_AGENT_ID).map((agent) => agent.id),
      connector_id: session.sessionId,
      organization_id: session.organizationId,
    });
    for (const server of this.kernel.store.state.mcp) {
      if (server.origin !== "organization") continue;
      this.kernel.cloud.send({
        type: "mcp.register",
        server_id: server.id,
        name: server.name,
        url: server.url,
        tools: server.tools.map((tool) => ({ tool_id: tool.toolId })),
        connector_id: session.sessionId,
        organization_id: session.organizationId,
      });
    }
  }

  async syncAppMcp(): Promise<void> {
    if (!this.kernel.store.state.account || !this.kernel.store.secret("saturn-account") || !this.kernel.store.state.session.apiBase) return;
    const servers = this.kernel.store.state.mcp.filter((item) => item.origin === "local");
    const ids = new Set(servers.map((item) => item.id));
    const attachments: Record<string, string[]> = {};
    for (const agent of this.kernel.store.state.agents) {
      if (agent.id === SATURN_AGENT_ID) continue;
      const chosen = agent.mcpConnectionIds.filter((id) => ids.has(id));
      if (chosen.length) attachments[agent.id] = chosen;
    }
    try {
      const response = await this.cloudFetch("/app-mcp", {
        method: "PUT",
        body: JSON.stringify({
          servers: servers.map((item) => ({
            id: item.id,
            name: item.name,
            url: item.url,
            tools: item.tools.map((tool) => ({ tool_id: tool.toolId, description: tool.description })),
          })),
          attachments,
        }),
      });
      if (response.status === 404 || response.status === 405) return;
      await this.cloudJson(response);
    } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 404 || error.status === 405)) return;
      this.kernel.log("cloud", "warning", error instanceof Error ? error.message : "Could not sync app MCP");
    }
  }

  async createCloudAgent(name: string, description: string): Promise<string | null> {
    const token = this.kernel.store.secret("saturn-account");
    const apiBase = this.kernel.store.state.session.apiBase;
    if (!this.kernel.store.state.account || !token || !apiBase) return null;
    const response = await fetch(`${apiBase.replace(/\/$/, "")}/agents`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name, description }),
    });
    const body = (await response.json().catch(() => ({}))) as { id?: string; detail?: string };
    if (!response.ok || !body.id) {
      throw new HttpError(response.status || 400, typeof body.detail === "string" ? body.detail : "Could not create the agent");
    }
    return body.id;
  }

  async syncCloudAgent(agent: Agent): Promise<void> {
    if (agent.id === SATURN_AGENT_ID) return;
    const token = this.kernel.store.secret("saturn-account");
    if (!this.kernel.store.state.account || !token || !this.kernel.store.state.session.apiBase) return;
    const model = this.kernel.store.state.models.find((item) => item.id === agent.modelConnectionId);
    const provider = model ? cloudProvider(model.provider) : undefined;
    const orgMcp = this.kernel.store.state.mcp.filter((item) => item.origin === "organization");
    const selected = new Set(agent.mcpConnectionIds);
    const chosen = orgMcp.filter((item) => selected.has(item.id));
    const tools = orgMcp.length === 0
      ? undefined
      : chosen.length === orgMcp.length
        ? null
        : chosen.flatMap((item) => [item.id, ...item.tools.map((tool) => tool.toolId)]);
    await this.cloudJson(await this.cloudFetch(`/agents/${encodeURIComponent(agent.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: agent.name,
        description: agent.description,
        ...(model?.model || model?.name ? { model: model.model || model.name } : {}),
        settings: {
          instructions: agent.instructions,
          response_style: agent.responseStyle ?? "professional",
          autonomy: agent.autonomy ?? "execute_when_allowed",
          tools,
          knowledge: this.kernel.store.state.rag
            .filter((item) => agent.ragConnectionIds.includes(item.id))
            .map((item) => ({ id: item.id, name: item.name, kind: "document", enabled: true })),
          temperature: agent.temperature ?? 0.2,
          max_output: agent.maxOutput ?? 4000,
          ...(provider ? { provider, model: model?.model || model?.name, base_url: model?.baseUrl } : {}),
          model_connection_id: agent.modelConnectionId ?? "",
        },
      }),
    }));
  }
}
