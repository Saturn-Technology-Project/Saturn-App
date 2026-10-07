import { HttpError } from "../domain/errors.js";
import { newId } from "../domain/ids.js";
import { GENERAL_SKILLS_ID, SATURN_AGENT_ID } from "../domain/builtin.js";
import type { Agent, ModelConnection, Run, RunAction } from "../domain/model.js";
import { autonomyLine, behaviorOf, chatReply, clip, explainRunError, joinThinking, styleLine, textOf, thinkingOf, toolCalls } from "../domain/policies.js";
import { DISCONNECT_ERROR, type ToolCall } from "./runtime-state.js";
import { runGeneralSkill } from "../infrastructure/skills.js";
import { completeChat } from "../infrastructure/llm.js";
import type { RuntimeKernel } from "./kernel.js";

/** One agent turn: the model call, built-in skills, MCP, and approval. */
export class RunService {
  constructor(private readonly kernel: RuntimeKernel) {}

  async startRun(agentId: string, input: string): Promise<Run> {
    const agent = this.kernel.getAgent(agentId);
    this.kernel.guard(agent.id);
    const model = this.kernel.store.state.models.find((item) => item.id === agent.modelConnectionId);
    if (!model) throw new HttpError(409, "Agent has no model connection");
    const account = this.kernel.store.state.account;
    const run: Run = {
      id: newId("run"),
      agentId,
      userId: account?.userId,
      organizationId: account?.organizationId,
      input,
      status: "running",
      output: "",
      thinking: "",
      actions: [],
      generation: 0,
    };
    await this.kernel.store.update((state) => {
      state.runs.unshift(run);
    });
    void this.advance(run.id);
    void this.pushMessage(run);
    return run;
  }

  async pendingTasks(): Promise<{ id: string; agentId: string; agentName: string; input: string; toolId: string }[]> {
    await this.syncSignedInState();
    return this.kernel.store.state.runs
      .filter((run) => run.status === "waiting_approval" && this.ownsRun(run))
      .map((run) => ({
        id: run.id,
        agentId: run.agentId,
        agentName: this.kernel.store.state.agents.find((agent) => agent.id === run.agentId)?.name ?? "Agent",
        input: run.input,
        toolId: run.actions.find((action) => action.status === "waiting_approval")?.toolId ?? "",
      }));
  }

  async messagesFor(agentId: string): Promise<Run[]> {
    this.kernel.getAgent(agentId);
    await this.syncSignedInState();
    return this.kernel.store.state.runs.filter((item) => item.agentId === agentId && this.ownsRun(item)).slice().reverse();
  }

  async syncSignedInState(): Promise<void> {
    if (!this.kernel.store.state.account || !this.kernel.store.secret("saturn-account") || !this.kernel.store.state.session.apiBase) return;
    if (Date.now() - this.kernel.syncedAt < 8000) return;
    this.kernel.syncedAt = Date.now();
    try {
      await this.kernel.session.refreshAccount();
    } catch (error) {
      this.kernel.log("cloud", "warning", error instanceof Error ? error.message : "Could not refresh the account");
    }
    await this.pullMessages();
  }

  async reviseRun(id: string, input: string): Promise<{ run: Run; removed: string[] }> {
    const text = input.trim();
    if (!text) throw new HttpError(400, "Message is empty");
    const existing = this.kernel.getRun(id);
    if (!this.ownsRun(existing)) throw new HttpError(404, "Run not found");
    this.kernel.guard(existing.agentId);
    const agent = this.kernel.getAgent(existing.agentId);
    if (!this.kernel.store.state.models.some((item) => item.id === agent.modelConnectionId)) {
      throw new HttpError(409, "Agent has no model connection");
    }
    const removed: string[] = [];
    await this.kernel.store.update((state) => {
      const index = state.runs.findIndex((item) => item.id === id);
      const run = state.runs[index];
      if (!run) return;
      const later = state.runs.slice(0, index).filter((item) => item.agentId === run.agentId && (item.userId ?? "") === (run.userId ?? "") && (item.organizationId ?? "") === (run.organizationId ?? ""));
      removed.push(...later.map((item) => item.id));
      if (removed.length) state.runs = state.runs.filter((item) => !removed.includes(item.id));
      run.input = text;
      run.output = "";
      run.thinking = "";
      run.actions = [];
      delete run.error;
      run.status = "running";
      run.generation = (run.generation ?? 0) + 1;
    });
    this.kernel.dropFlight([id, ...removed]);
    const run = this.kernel.getRun(id);
    void this.advance(run.id);
    void this.pushMessage(run);
    return { run, removed };
  }

  async stopRun(id: string): Promise<Run> {
    const run = this.kernel.getRun(id);
    if (!this.ownsRun(run)) throw new HttpError(404, "Run not found");
    if (run.status !== "running" && run.status !== "queued" && run.status !== "waiting_approval") return run;
    const name = this.kernel.store.state.agents.find((item) => item.id === run.agentId)?.name ?? run.agentId;
    for (const [key, controller] of this.kernel.stops) {
      if (!key.startsWith(`${id}:`)) continue;
      controller.abort();
      this.kernel.stops.delete(key);
    }
    this.kernel.dropFlight([id]);
    await this.kernel.store.update((state) => {
      const current = state.runs.find((item) => item.id === id);
      if (!current) return;
      if (current.status !== "running" && current.status !== "queued" && current.status !== "waiting_approval") return;
      current.status = "cancelled";
      current.generation = (current.generation ?? 0) + 1;
      current.error = undefined;
    });
    const stopped = this.kernel.getRun(id);
    this.kernel.log("agent", "info", `${name} stopped`);
    void this.pushMessage(stopped);
    return stopped;
  }

  async executeTool(input: {
    agentId: string;
    toolId: string;
    arguments: Record<string, unknown>;
    runId: string;
    actionId: string;
    signal?: AbortSignal;
  }): Promise<RunAction> {
    this.kernel.guard(input.agentId);
    const agent = this.kernel.getAgent(input.agentId);
    const serverId = this.toolServer(agent, input.toolId);
    if (!serverId) {
      return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "failed", reason: `Unknown tool: ${input.toolId}` };
    }
    if (serverId === GENERAL_SKILLS_ID) {
      try {
        const result = await runGeneralSkill(this.kernel.store.root, input.toolId, input.arguments, async (toolId, args) => {
          const action = await this.executeTool({ ...input, toolId, arguments: args, actionId: newId("act") });
          if (action.status !== "completed") throw new Error(action.reason || "MCP call failed");
          return action.result;
        }, input.signal);
        return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "completed", result };
      } catch (error) {
        return {
          id: input.actionId,
          toolId: input.toolId,
          arguments: input.arguments,
          status: "failed",
          reason: error instanceof Error ? error.message : "Skill failed",
        };
      }
    }
    return this.callMcp(serverId, input, input.signal);
  }

  async advance(runId: string): Promise<void> {
    const current = this.kernel.getRun(runId);
    if (current.status === "cancelled") return;
    const generation = current.generation ?? 0;
    const signal = this.kernel.track(runId, generation);
    try {
      if (!this.kernel.alive(runId, generation)) return;
      const run = this.kernel.getRun(runId);
      const agent = this.kernel.getAgent(run.agentId);
      const model = this.kernel.store.state.models.find((item) => item.id === agent.modelConnectionId);
      if (!model) throw new Error("Agent has no model connection");
      this.kernel.guard(agent.id);
      const context = await this.ragContext(agent, run.input, signal);
      if (!this.kernel.alive(runId, generation)) return;
      const tools = this.toolList(agent);
      this.kernel.log("agent", "info", `${agent.name} asked ${model.model || model.name}: ${clip(run.input)}`);
      const first = await this.complete(model, agent, runId, run.input, context, tools, [], signal);
      if (!this.kernel.alive(runId, generation)) return;
      await this.noteThinking(runId, generation, first);
      const actions: RunAction[] = [];
      const waiting = await this.runTools(agent, runId, generation, toolCalls(first), actions, signal);
      if (waiting || !this.kernel.alive(runId, generation)) return;
      await this.finishFromModel(runId, generation, agent, model, context, tools, actions, signal);
    } catch (error) {
      if (!this.kernel.alive(runId, generation) || signal.aborted) return;
      await this.finish(runId, generation, "failed", "", explainRunError(error));
    } finally {
      this.kernel.stops.delete(`${runId}:${generation}`);
    }
  }

  async runTools(agent: Agent, runId: string, generation: number, calls: ToolCall[], actions: RunAction[], signal: AbortSignal): Promise<boolean> {
    for (let index = 0; index < calls.length; index += 1) {
      if (!this.kernel.alive(runId, generation) || signal.aborted) return true;
      this.kernel.guard(agent.id);
      const call = calls[index];
      const action = await this.executeTool({
        agentId: agent.id,
        toolId: call.name,
        arguments: call.arguments,
        runId,
        actionId: newId("act"),
        signal,
      });
      if (call.thoughtSignature) action.thoughtSignature = call.thoughtSignature;
      actions.push(action);
      const detail = action.reason ? `: ${clip(action.reason, 80)}` : "";
      this.kernel.log("agent", action.status === "failed" || action.status === "denied" ? "warning" : "info", `${agent.name} ${action.toolId} ${action.status}${detail}`);
      if (action.status === "waiting_approval") {
        if (!this.kernel.alive(runId, generation)) return true;
        this.kernel.inflight.set(action.id, {
          runId,
          agentId: agent.id,
          actions,
          remaining: calls.slice(index + 1),
        });
        await this.kernel.store.update((state) => {
          const current = state.runs.find((item) => item.id === runId);
          if (!current || (current.generation ?? 0) !== generation || current.error === DISCONNECT_ERROR) return;
          current.status = "waiting_approval";
          current.actions = actions;
        });
        return true;
      }
    }
    return false;
  }

  async onCloud(message: Record<string, unknown>): Promise<void> {
    const payload =
      message.payload && typeof message.payload === "object"
        ? (message.payload as Record<string, unknown>)
        : {};
    const kind = String(message.type || "");
    const command = String(message.command || payload.command || "");
    const resume =
      kind === "command.resume" ||
      kind === "approval.granted" ||
      kind === "approval.approved" ||
      (kind === "command" && command === "resume") ||
      command === "resume";
    if (kind === "approval.rejected") {
      const runId = String(message.run_id || payload.run_id || "");
      const actionId = String(message.action_id || payload.action_id || "");
      if (!runId) return;
      this.kernel.pending.delete(actionId);
      this.kernel.inflight.delete(actionId);
      const run = this.kernel.store.state.runs.find((item) => item.id === runId);
      if (!run) return;
      await this.finish(runId, run.generation ?? 0, "cancelled", "", "Approval rejected");
      return;
    }
    if (!resume) return;
    const runId = String(message.run_id || payload.run_id || "");
    const actionId = String(message.action_id || payload.action_id || "");
    if (!runId || !actionId) return;
    await this.resume(runId, actionId);
  }

  async resume(runId: string, actionId: string): Promise<void> {
    const pending = this.kernel.pending.get(actionId);
    if (!pending || pending.runId !== runId) return;
    this.kernel.pending.delete(actionId);
    const flight = this.kernel.inflight.get(actionId);
    this.kernel.inflight.delete(actionId);
    const generation = this.kernel.getRun(runId).generation ?? 0;
    const signal = this.kernel.track(runId, generation);
    try {
      if (!this.kernel.alive(runId, generation)) return;
      this.kernel.guard(pending.agentId);
      const completed = await this.callMcp(pending.serverId, pending, signal);
      const actions = flight?.actions ?? this.kernel.getRun(runId).actions.map((item) => ({ ...item }));
      const current = actions.find((item) => item.id === actionId);
      if (current) {
        current.status = completed.status;
        current.result = completed.result;
        current.reason = completed.reason;
      } else {
        actions.push(completed);
      }
      if (!this.kernel.alive(runId, generation)) return;
      const agent = this.kernel.getAgent(pending.agentId);
      const waiting = await this.runTools(agent, runId, generation, flight?.remaining ?? [], actions, signal);
      if (waiting || !this.kernel.alive(runId, generation)) return;
      const model = this.kernel.store.state.models.find((item) => item.id === agent.modelConnectionId);
      if (!model) throw new Error("Agent has no model connection");
      const context = await this.ragContext(agent, this.kernel.getRun(runId).input, signal);
      await this.finishFromModel(runId, generation, agent, model, context, this.toolList(agent), actions, signal);
    } catch (error) {
      if (!this.kernel.alive(runId, generation) || signal.aborted) return;
      await this.finish(runId, generation, "failed", "", explainRunError(error));
    } finally {
      this.kernel.stops.delete(`${runId}:${generation}`);
    }
  }

  async callMcp(
    serverId: string,
    input: { agentId: string; toolId: string; arguments: Record<string, unknown>; runId: string; actionId: string },
    signal?: AbortSignal,
  ): Promise<RunAction> {
    const server = this.kernel.store.state.mcp.find((item) => item.id === serverId);
    if (!server) {
      return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "failed", reason: "MCP server missing" };
    }
    const headers: Record<string, string> = {
      "X-Saturn-Agent-Id": input.agentId,
      "X-Saturn-Run-Id": input.runId,
      "X-Saturn-Action-Id": input.actionId,
    };
    if (server.id.startsWith("saturn:")) {
      const token = this.kernel.store.secret("saturn-account");
      if (token) headers.authorization = `Bearer ${token}`;
    }
    try {
      const result = await this.kernel.mcp.call(server.url, input.toolId, input.arguments, signal, headers);
      return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "completed", result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "MCP call failed";
      if (message === "approval_required") {
        this.kernel.pending.set(input.actionId, {
          agentId: input.agentId,
          toolId: input.toolId,
          arguments: input.arguments,
          runId: input.runId,
          actionId: input.actionId,
          serverId: server.id,
        });
        return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "waiting_approval" };
      }
      if (message === "policy_denied") {
        return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "denied", reason: "Policy denied" };
      }
      if (message === "approval_rejected") {
        return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "denied", reason: "Approval rejected" };
      }
      if (message === "Agent is not allowed to call this tool") {
        return { id: input.actionId, toolId: input.toolId, arguments: input.arguments, status: "denied", reason: message };
      }
      throw error;
    }
  }

  toolServer(agent: Agent, toolId: string): string | null {
    const attached = this.kernel.store.state.mcp.filter((item) => agent.mcpConnectionIds.includes(item.id));
    return attached.find((server) => server.tools.some((tool) => tool.toolId === toolId))?.id ?? null;
  }

  async finishFromModel(
    runId: string,
    generation: number,
    agent: Agent,
    model: ModelConnection,
    context: string,
    tools: unknown[],
    actions: RunAction[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.kernel.alive(runId, generation)) return;
    const run = this.kernel.getRun(runId);
    let response = await this.complete(model, agent, runId, run.input, context, tools, actions, signal);
    await this.noteThinking(runId, generation, response);
    let rounds = 0;
    while (agent.mcpConnectionIds.includes(GENERAL_SKILLS_ID) && rounds < 5) {
      const calls = toolCalls(response);
      if (!calls.length || !this.kernel.alive(runId, generation)) break;
      rounds += 1;
      const waiting = await this.runTools(agent, runId, generation, calls, actions, signal ?? new AbortController().signal);
      if (waiting || !this.kernel.alive(runId, generation)) return;
      response = await this.complete(model, agent, runId, run.input, context, tools, actions, signal);
      await this.noteThinking(runId, generation, response);
    }
    let saved = false;
    await this.kernel.store.update((state) => {
      const current = state.runs.find((item) => item.id === runId);
      if (!current || (current.generation ?? 0) !== generation || current.error === DISCONNECT_ERROR) return;
      current.actions = actions;
      current.output = textOf(response) || chatReply(actions);
      current.status = actions.some((item) => item.status === "denied" || item.status === "failed")
        ? "failed"
        : "completed";
      saved = true;
    });
    if (!saved) return;
    const current = this.kernel.getRun(runId);
    this.kernel.log("agent", current.status === "failed" ? "error" : "info", `${agent.name} ${current.status}`);
    void this.pushMessage(current);
  }

  toolList(agent: Agent) {
    return this.kernel.store.state.mcp
      .filter((item) => agent.mcpConnectionIds.includes(item.id))
      .flatMap((server) =>
        server.tools.map((tool) => ({
          type: "function",
          function: { name: tool.toolId, description: tool.description, parameters: tool.inputSchema },
        })),
      );
  }

  async ragContext(agent: Agent, query: string, signal?: AbortSignal): Promise<string> {
    this.kernel.guard(agent.id);
    const servers = this.kernel.store.state.rag.filter((item) => agent.ragConnectionIds.includes(item.id));
    const chunks: string[] = [];
    for (const server of servers) {
      const response = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
        signal,
      });
      chunks.push(await response.text());
    }
    return chunks.join("\n");
  }

  priorMessages(agentId: string, runId: string): { role: "user" | "assistant"; content: string }[] {
    const turns = this.kernel.store.state.runs.filter((item) => item.agentId === agentId);
    const index = turns.findIndex((item) => item.id === runId);
    const older = (index < 0 ? [] : turns.slice(index + 1))
      .filter((item) => item.status === "completed" || item.status === "failed" || item.status === "cancelled")
      .reverse();
    const messages: { role: "user" | "assistant"; content: string }[] = [];
    for (const turn of older) {
      messages.push({ role: "user", content: turn.input });
      if (turn.output) messages.push({ role: "assistant", content: turn.output });
    }
    return messages;
  }

  async complete(
    model: ModelConnection,
    agent: Agent,
    runId: string,
    input: string,
    context: string,
    tools: unknown[],
    actions: RunAction[],
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    this.kernel.guard(agent.id);
    const behavior = behaviorOf(agent);
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: [agent.instructions, styleLine(behavior.responseStyle), autonomyLine(behavior.autonomy), context].filter(Boolean).join("\n") },
      ...this.priorMessages(agent.id, runId),
      { role: "user", content: input },
    ];
    if (actions.length) {
      messages.push({ role: "assistant", content: JSON.stringify(actions) });
    }
    return completeChat({
      provider: model.provider || "openai",
      model: model.model || model.name,
      baseUrl: model.baseUrl,
      apiKey: this.kernel.store.secret(model.brokerConnectionId),
      messages,
      tools: behavior.autonomy === "suggest_only" ? [] : tools,
      temperature: behavior.temperature,
      maxOutput: behavior.maxOutput,
      signal,
    });
  }

  async noteThinking(runId: string, generation: number, body: Record<string, unknown>): Promise<void> {
    const next = thinkingOf(body);
    if (!next) return;
    await this.kernel.store.update((state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (!run || (run.generation ?? 0) !== generation || run.error === DISCONNECT_ERROR) return;
      run.thinking = joinThinking(run.thinking, next);
    });
  }

  async finish(runId: string, generation: number, status: Run["status"], output: string, error?: string) {
    let saved = false;
    await this.kernel.store.update((state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (!run || (run.generation ?? 0) !== generation || run.error === DISCONNECT_ERROR) return;
      run.status = status;
      run.output = output;
      run.error = error;
      saved = true;
    });
    if (!saved) return;
    const run = this.kernel.store.state.runs.find((item) => item.id === runId);
    if (!run) return;
    if (status === "failed") {
      const name = this.kernel.store.state.agents.find((item) => item.id === run.agentId)?.name ?? run.agentId;
      this.kernel.log("agent", "error", `${name} failed: ${clip(error || "Run failed")}`);
    }
    void this.pushMessage(run);
  }

  ownsRun(run: Run): boolean {
    const account = this.kernel.store.state.account;
    if (!account) return !run.userId;
    if (run.userId && run.userId !== account.userId) return false;
    if (run.organizationId && run.organizationId !== account.organizationId) return false;
    return true;
  }

  async pushMessage(run: Run): Promise<void> {
    if (run.agentId === SATURN_AGENT_ID || this.kernel.messagesUnavailable || !this.kernel.store.state.account || !this.kernel.store.secret("saturn-account") || !this.ownsRun(run)) return;
    let response: Response;
    try {
      response = await this.kernel.session.cloudFetch(`/agents/${encodeURIComponent(run.agentId)}/messages/${encodeURIComponent(run.id)}`, {
        method: "PUT",
        body: JSON.stringify({
          input: run.input,
          output: run.output,
          status: run.status,
          actions: run.actions.map((action) => ({ toolId: action.toolId, status: action.status })),
          error: run.error ?? null,
        }),
      });
    } catch (error) {
      this.kernel.log("cloud", "warning", error instanceof Error ? error.message : "Could not sync the message");
      return;
    }
    if (response.status === 404) {
      const body = (await response.json().catch(() => ({}))) as { detail?: string };
      if (body.detail === "Not Found") this.kernel.messagesUnavailable = true;
      return;
    }
    if (response.status === 409) return;
    if (!response.ok) {
      this.kernel.log("cloud", "warning", "Could not sync the message");
    }
  }

  async pullMessages(): Promise<void> {
    if (this.kernel.messagesUnavailable || !this.kernel.store.state.account || !this.kernel.store.secret("saturn-account")) return;
    for (const agent of this.kernel.store.state.agents) {
      if (agent.id === SATURN_AGENT_ID) continue;
      let response: Response;
      try {
        response = await this.kernel.session.cloudFetch(`/agents/${encodeURIComponent(agent.id)}/messages`);
      } catch {
        continue;
      }
      if (response.status === 404) {
        const body = (await response.json().catch(() => ({}))) as { detail?: string };
        if (body.detail === "Not Found") {
          this.kernel.messagesUnavailable = true;
          return;
        }
        continue;
      }
      if (!response.ok) continue;
      const remote = (await response.json()) as {
        id: string;
        agent_id: string;
        input: string;
        output: string;
        status: Run["status"];
        actions?: { toolId?: string; status?: RunAction["status"] }[];
        error?: string | null;
      }[];
      const queued: typeof remote = [];
      await this.kernel.store.update((state) => {
        const local = state.runs.filter((item) => item.agentId === agent.id && this.ownsRun(item));
        const byId = new Map(local.map((item) => [item.id, item]));
        const merged: Run[] = [];
        for (const message of remote) {
          const existing = byId.get(message.id);
          if (message.status === "queued" && (!existing || existing.status === "queued")) {
            queued.push(message);
            if (existing) merged.push(existing);
            byId.delete(message.id);
            continue;
          }
          if (existing?.status === "cancelled" || (existing && (existing.status === "running" || existing.status === "queued" || existing.status === "waiting_approval"))) {
            merged.push(existing);
          } else if (existing) {
            existing.input = message.input;
            existing.output = message.output || "";
            existing.thinking = existing.thinking ?? "";
            existing.status = message.status;
            existing.error = message.error || undefined;
            existing.actions = (message.actions ?? []).map((action, index) => ({
              id: existing.actions[index]?.id ?? `${message.id}_${index}`,
              toolId: action.toolId ?? "tool",
              arguments: existing.actions[index]?.arguments ?? {},
              status: action.status ?? "completed",
            }));
            merged.push(existing);
          } else {
            merged.push({
              id: message.id,
              agentId: agent.id,
              userId: this.kernel.store.state.account?.userId,
              organizationId: this.kernel.store.state.account?.organizationId,
              input: message.input,
              output: message.output || "",
              thinking: "",
              status: message.status,
              error: message.error || undefined,
              actions: (message.actions ?? []).map((action, index) => ({
                id: `${message.id}_${index}`,
                toolId: action.toolId ?? "tool",
                arguments: {},
                status: action.status ?? "completed",
              })),
              generation: 0,
            });
          }
          byId.delete(message.id);
        }
        for (const leftover of byId.values()) merged.push(leftover);
        const kept = new Set(local.map((item) => item.id));
        const others = state.runs.filter((item) => !kept.has(item.id));
        state.runs = [...merged.reverse(), ...others];
      });
      for (const message of queued) {
        void this.claimMessage(agent.id, message);
      }
    }
  }

  async claimMessage(agentId: string, message: { id: string; input: string }): Promise<void> {
    let response: Response;
    try {
      response = await this.kernel.session.cloudFetch(`/agents/${encodeURIComponent(agentId)}/messages/${encodeURIComponent(message.id)}`, {
        method: "PUT",
        body: JSON.stringify({ input: message.input, output: "", status: "running", actions: [], error: null }),
      });
    } catch {
      return;
    }
    if (!response.ok) return;
    const existing = this.kernel.store.state.runs.find((item) => item.id === message.id);
    if (existing && (existing.status === "running" || existing.status === "waiting_approval" || existing.status === "cancelled")) return;
    if (existing) {
      await this.kernel.store.update((state) => {
        const run = state.runs.find((item) => item.id === message.id);
        if (!run) return;
        run.input = message.input;
        run.output = "";
        run.thinking = "";
        run.actions = [];
        run.error = undefined;
        run.status = "running";
        run.generation = (run.generation ?? 0) + 1;
      });
      void this.advance(message.id);
      return;
    }
    const account = this.kernel.store.state.account;
    const run: Run = {
      id: message.id,
      agentId,
      userId: account?.userId,
      organizationId: account?.organizationId,
      input: message.input,
      status: "running",
      output: "",
      thinking: "",
      actions: [],
      generation: 0,
    };
    await this.kernel.store.update((state) => {
      state.runs.unshift(run);
    });
    void this.advance(run.id);
  }
}
