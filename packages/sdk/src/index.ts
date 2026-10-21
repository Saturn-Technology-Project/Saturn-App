/**
 * Saturn SDK: drive the Saturn running on this computer from code, the way the apps and the `saturn` CLI do,
 * over its local HTTP API with the runtime token. It starts nothing itself; Saturn must be open.
 *
 *   import { Saturn } from "@saturn-app/sdk";
 *   const saturn = new Saturn();
 *   const run = await saturn.run("fix the failing test", { agent: "Coder", project: "/path/to/repo" });
 *   console.log(run.status, run.output);
 *
 * Dependency-free; Node 18 or later (fetch and web streams).
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type RunStatus = "queued" | "running" | "sleeping" | "waiting_approval" | "completed" | "failed" | "stopped" | (string & {});

export type RunAction = {
  id: string;
  toolId: string;
  arguments: Record<string, unknown>;
  status: string;
  reason?: string;
  result?: unknown;
};

export type Run = {
  id: string;
  agentId: string;
  threadId?: string;
  input: string;
  status: RunStatus;
  output: string;
  error?: string;
  actions: RunAction[];
  children?: Run[];
};

export type Agent = { id: string; name: string; modelConnectionId: string | null; mcpConnectionIds: string[] };
export type Project = { id: string; name: string; path: string; access?: unknown };
export type ModelConnection = { id: string; name: string; provider: string; model?: string };
export type RunSummary = { id: string; agentName: string; status: string; input: string; threadTitle: string };
export type FileChange = { path: string; status: string; additions: number; deletions: number; review: string; diff: string };

export type RunOptions = {
  /** The agent's name or id; may be left out when there is only one agent. */
  agent?: string;
  /** A Saturn project, by folder path or id; the run works in that folder. */
  project?: string;
  /** Continue an existing chat instead of starting one. */
  chat?: string;
  /** "ask" and "plan" only read; "agent" (the default) may change things. */
  mode?: "agent" | "ask" | "plan";
  /** Called with each new step as the run takes it. */
  onStep?: (action: RunAction, run: Run) => void;
  /**
   * Answers a step that waits for the user's approval (true allows it). Without it, `run` returns the run as it
   * waits, status "waiting_approval", for the caller to decide with `decide` and `wait` again.
   */
  onApproval?: (action: RunAction, run: Run) => boolean | Promise<boolean>;
  signal?: AbortSignal;
};

export class SaturnError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "SaturnError";
    this.status = status;
  }
}

const SETTLED = (status: string) => !["queued", "running"].includes(status);

export type SaturnOptions = {
  /** Default http://127.0.0.1:<SATURN_RUNTIME_PORT or 4700>. Saturn only listens on this computer. */
  baseUrl?: string;
  /** Default SATURN_RUNTIME_TOKEN, else the token file Saturn writes in its data folder. */
  token?: string;
  /** Saturn's data folder, for the token file. Default SATURN_DATA_DIR, else ~/.saturn-app. */
  dataDir?: string;
};

export class Saturn {
  readonly baseUrl: string;
  private readonly token: string;

  constructor(options: SaturnOptions = {}) {
    this.baseUrl = (options.baseUrl ?? `http://127.0.0.1:${process.env.SATURN_RUNTIME_PORT ?? 4700}`).replace(/\/$/, "");
    const tokenFile = path.join(options.dataDir ?? process.env.SATURN_DATA_DIR ?? path.join(os.homedir(), ".saturn-app"), "runtime-token");
    let token = options.token ?? process.env.SATURN_RUNTIME_TOKEN;
    if (!token) {
      try {
        token = readFileSync(tokenFile, "utf8").trim();
      } catch {
        throw new SaturnError(`Saturn has not run on this computer yet (no ${tokenFile}). Open Saturn first.`);
      }
    }
    this.token = token;
  }

  private async send(pathname: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(this.baseUrl + pathname, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) } });
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      throw new SaturnError(`Saturn is not running (nothing answers on ${this.baseUrl}). Open Saturn and try again.`);
    }
    if (!response.ok) {
      const text = await response.text();
      let message = text || `Saturn returned ${response.status}`;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? message;
      } catch {
        // Not JSON.
      }
      throw new SaturnError(message, response.status);
    }
    return response;
  }

  private async get<T>(pathname: string): Promise<T> {
    return (await this.send(pathname)).json() as Promise<T>;
  }

  private async post<T>(pathname: string, body: unknown = {}): Promise<T> {
    const response = await this.send(pathname, { method: "POST", body: JSON.stringify(body) });
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  /** The agents, as in Saturn's sidebar. */
  agents(): Promise<Agent[]> {
    return this.get<Agent[]>("/agents");
  }

  /** The project folders Saturn knows. */
  projects(): Promise<Project[]> {
    return this.get<Project[]>("/projects");
  }

  /** Recent runs, newest first. */
  runs(limit = 20): Promise<RunSummary[]> {
    return this.get<RunSummary[]>(`/runs?limit=${limit}`);
  }

  getRun(runId: string): Promise<Run> {
    return this.get<Run>(`/runs/${encodeURIComponent(runId)}`);
  }

  /** The files a run changed, with their diffs. */
  changes(runId: string): Promise<{ root: string | null; files: FileChange[] }> {
    return this.get(`/runs/${encodeURIComponent(runId)}/changes`);
  }

  /** Allows or denies a step that waits for approval. */
  async decide(runId: string, actionId: string, allow: boolean): Promise<void> {
    await this.post(`/runs/${encodeURIComponent(runId)}/actions/${encodeURIComponent(actionId)}/decision`, { allow });
  }

  stop(runId: string): Promise<Run> {
    return this.post<Run>(`/runs/${encodeURIComponent(runId)}/stop`);
  }

  /** Starts a run and returns at once; follow it with `stream` or `wait`. */
  async start(prompt: string, options: Omit<RunOptions, "onStep" | "onApproval"> = {}): Promise<Run> {
    if (!prompt.trim()) throw new SaturnError("Give the prompt");
    const agent = await this.pickAgent(options.agent);
    const models = await this.get<ModelConnection[]>("/connections/models");
    // The same rule as automations and the CLI: Anthropic's terms allow automated access to Claude only through an
    // API key, so an agent on Claude (via Claude Code), a personal plan, is not run from code.
    if (models.find((item) => item.id === agent.modelConnectionId)?.provider === "claude-code") {
      throw new SaturnError(`${agent.name} runs on Claude (via Claude Code), a personal plan, which the SDK cannot run: Anthropic's terms allow automated access only with an API key. Use an agent on an API model.`);
    }
    const project = options.chat ? undefined : await this.pickProject(options.project);
    return this.post<Run>(`/agents/${encodeURIComponent(agent.id)}/runs`, {
      input: prompt,
      ...(options.chat ? { threadId: options.chat } : {}),
      ...(project ? { projectId: project.id } : {}),
      ...(options.mode && options.mode !== "agent" ? { mode: options.mode } : {}),
    });
  }

  /**
   * The run as it changes, until it settles (done, failed, stopped) or waits for approval. Each value is the
   * whole run at that moment; the last one is where it stopped.
   */
  async *stream(runId: string, signal?: AbortSignal): AsyncGenerator<Run> {
    const response = await this.send(`/runs/${encodeURIComponent(runId)}/events`, { headers: { accept: "text/event-stream" }, signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (/^event: gone$/m.test(block)) throw new SaturnError(`Run ${runId} was deleted`);
          if (!/^event: run$/m.test(block)) continue;
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!data) continue;
          const run = JSON.parse(data) as Run;
          yield run;
          if (SETTLED(run.status)) return;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  /** Follows a run until it settles, answering approvals with `onApproval` when given. */
  async wait(runId: string, options: Pick<RunOptions, "onStep" | "onApproval" | "signal"> = {}): Promise<Run> {
    let shown = 0;
    for (;;) {
      let latest: Run | undefined;
      for await (const run of this.stream(runId, options.signal)) {
        latest = run;
        for (const action of run.actions.slice(shown)) {
          if (action.status === "waiting_approval") break;
          options.onStep?.(action, run);
          shown += 1;
        }
      }
      if (!latest) latest = await this.getRun(runId);
      if (latest.status !== "waiting_approval") return latest;
      const action = latest.actions.find((item) => item.status === "waiting_approval");
      if (!action || !options.onApproval) return latest;
      await this.decide(runId, action.id, await options.onApproval(action, latest));
    }
  }

  /** Starts a run and waits for it: the one call most scripts need. */
  async run(prompt: string, options: RunOptions = {}): Promise<Run> {
    const started = await this.start(prompt, options);
    return this.wait(started.id, options);
  }

  private async pickAgent(wanted: string | undefined): Promise<Agent> {
    const agents = await this.agents();
    if (!agents.length) throw new SaturnError("There are no agents yet. Create one in Saturn first.");
    if (wanted) {
      const agent = agents.find((item) => item.id === wanted || item.name.toLowerCase() === wanted.toLowerCase());
      if (!agent) throw new SaturnError(`No agent named "${wanted}". Agents: ${agents.map((item) => item.name).join(", ")}`);
      return agent;
    }
    if (agents.length === 1) return agents[0]!;
    throw new SaturnError(`Name the agent. Agents: ${agents.map((item) => item.name).join(", ")}`);
  }

  private async pickProject(wanted: string | undefined): Promise<Project | undefined> {
    if (!wanted) return undefined;
    const projects = await this.projects();
    const full = path.resolve(wanted);
    const project = projects.find((item) => item.id === wanted || path.resolve(item.path) === full);
    if (!project) throw new SaturnError(`${wanted} is not a Saturn project. Add the folder in Saturn and allow access first.`);
    if (!project.access) throw new SaturnError(`Saturn does not have access to ${project.path} yet. Allow it in Saturn first.`);
    return project;
  }
}
