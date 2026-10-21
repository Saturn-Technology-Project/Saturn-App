#!/usr/bin/env node
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

/**
 * `saturn`: the local runtime from a terminal or a script. It talks to the running Saturn over its HTTP API with
 * the runtime token, like the apps do; it starts nothing itself.
 *
 *   saturn run "fix the failing test" [--agent NAME] [--project PATH] [--mode agent|ask|plan] [--chat ID] [--json]
 *   saturn agents | saturn runs [--limit N] | saturn show RUN | saturn changes RUN
 *   saturn approve RUN ACTION [--deny] | saturn stop RUN
 */

type Run = {
  id: string;
  status: string;
  output: string;
  error?: string;
  threadId?: string;
  actions: { id: string; toolId: string; arguments: Record<string, unknown>; status: string; reason?: string; result?: unknown }[];
};
type Agent = { id: string; name: string; modelConnectionId: string | null };
type Model = { id: string; name: string; provider: string };
type Project = { id: string; name: string; path: string; access?: unknown };

const EXIT = { ok: 0, failed: 1, usage: 2, waiting: 3, unreachable: 4 } as const;

export const USAGE = `saturn: the Saturn runtime from a terminal

Usage:
  saturn run PROMPT [--agent NAME] [--project PATH] [--mode agent|ask|plan] [--chat ID] [--json]
  saturn agents
  saturn runs [--limit N]
  saturn show RUN
  saturn changes RUN
  saturn approve RUN ACTION [--deny]
  saturn stop RUN

PROMPT may be "-" to read it from stdin. A run waiting for approval asks on a terminal; elsewhere saturn exits
with code 3 and prints how to answer it. Exit codes: 0 done, 1 failed, 2 usage, 3 waiting for approval,
4 Saturn is not running.

Environment: SATURN_RUNTIME_PORT (default 4700), SATURN_DATA_DIR (default ~/.saturn-app).`;

class CliError extends Error {
  constructor(message: string, readonly code: number = EXIT.failed) {
    super(message);
  }
}

/** Splits argv into positionals and --flags (`--flag value` or `--flag` alone for booleans). */
export function parseArgs(argv: string[], booleans: string[] = ["json", "deny", "help"]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
      if (inline !== undefined) flags[name] = inline;
      else if (booleans.includes(name) || i + 1 >= argv.length || argv[i + 1]!.startsWith("--")) flags[name] = true;
      else flags[name] = argv[++i]!;
    } else if (arg === "-h") {
      flags.help = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

class Client {
  readonly base: string;
  private readonly token: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.base = `http://127.0.0.1:${env.SATURN_RUNTIME_PORT ?? 4700}`;
    const dir = env.SATURN_DATA_DIR ?? path.join(os.homedir(), ".saturn-app");
    try {
      this.token = env.SATURN_RUNTIME_TOKEN ?? readFileSync(path.join(dir, "runtime-token"), "utf8").trim();
    } catch {
      throw new CliError(`Saturn has not run on this computer yet (no ${path.join(dir, "runtime-token")}). Open Saturn first.`, EXIT.unreachable);
    }
  }

  private async send(pathname: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(this.base + pathname, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) } });
    } catch {
      throw new CliError(`Saturn is not running (nothing answers on ${this.base}). Open Saturn and try again.`, EXIT.unreachable);
    }
    if (!response.ok) {
      const text = await response.text();
      let message = text || `Saturn returned ${response.status}`;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? message;
      } catch {
        // Not JSON.
      }
      throw new CliError(message);
    }
    return response;
  }

  async get<T>(pathname: string): Promise<T> {
    return (await this.send(pathname)).json() as Promise<T>;
  }

  async post<T>(pathname: string, body: unknown = {}): Promise<T> {
    const response = await this.send(pathname, { method: "POST", body: JSON.stringify(body) });
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  /** Follows a run's event stream; calls onRun with each new state until it settles or waits for approval. */
  async follow(runId: string, onRun: (run: Run) => void): Promise<Run> {
    const response = await this.send(`/runs/${encodeURIComponent(runId)}/events`, { headers: { accept: "text/event-stream" } });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let latest: Run | undefined;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (!/^event: run$/m.test(block)) continue;
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (!data) continue;
        latest = JSON.parse(data) as Run;
        onRun(latest);
        if (!["running", "queued"].includes(latest.status)) {
          await reader.cancel().catch(() => undefined);
          return latest;
        }
      }
    }
    if (!latest) throw new CliError("The run's stream ended before it said anything");
    return latest;
  }
}

/** One line for a step, the way the apps say it. */
export function describeAction(action: Run["actions"][number]): string {
  const args = action.arguments ?? {};
  const target = typeof args.command === "string" ? args.command : typeof args.path === "string" ? args.path : typeof args.url === "string" ? args.url : typeof args.task === "string" ? args.task : "";
  const state = action.status === "completed" ? "" : ` (${action.status}${action.reason ? `: ${action.reason}` : ""})`;
  return `${action.toolId}${target ? ` ${target}` : ""}${state}`;
}

async function pickAgent(client: Client, wanted: string | undefined): Promise<Agent> {
  const agents = await client.get<Agent[]>("/agents");
  if (!agents.length) throw new CliError("There are no agents yet. Create one in Saturn first.");
  if (wanted) {
    const agent = agents.find((item) => item.id === wanted || item.name.toLowerCase() === wanted.toLowerCase());
    if (!agent) throw new CliError(`No agent named "${wanted}". Agents: ${agents.map((item) => item.name).join(", ")}`, EXIT.usage);
    return agent;
  }
  if (agents.length === 1) return agents[0]!;
  throw new CliError(`Name the agent with --agent. Agents: ${agents.map((item) => item.name).join(", ")}`, EXIT.usage);
}

async function pickProject(client: Client, wanted: string | undefined): Promise<Project | undefined> {
  if (!wanted) return undefined;
  const projects = await client.get<Project[]>("/projects");
  const full = path.resolve(wanted);
  const project = projects.find((item) => item.id === wanted || path.resolve(item.path) === full);
  if (!project) throw new CliError(`${wanted} is not a Saturn project. Add the folder in Saturn and allow access first.`, EXIT.usage);
  if (!project.access) throw new CliError(`Saturn does not have access to ${project.path} yet. Allow it in Saturn first.`, EXIT.usage);
  return project;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function run(client: Client, positional: string[], flags: Record<string, string | true>, out: (text: string) => void): Promise<number> {
  let prompt = positional.join(" ");
  if (prompt === "-") prompt = await readStdin();
  if (!prompt.trim()) throw new CliError("Give the prompt: saturn run \"what to do\"", EXIT.usage);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && flags.json !== true;
  const agent = await pickAgent(client, typeof flags.agent === "string" ? flags.agent : undefined);
  const models = await client.get<Model[]>("/connections/models");
  const model = models.find((item) => item.id === agent.modelConnectionId);
  // The same rule as automations: Anthropic's terms allow automated access to Claude only through an API key.
  if (model?.provider === "claude-code" && !interactive) {
    throw new CliError(`${agent.name} runs on Claude (via Claude Code), which saturn cannot run unattended: that would be a violation of Anthropic's policy on automated access. Use an agent on an API model, or run it from a terminal.`, EXIT.usage);
  }
  const project = await pickProject(client, typeof flags.project === "string" ? flags.project : undefined);
  const mode = typeof flags.mode === "string" ? flags.mode : undefined;
  if (mode && !["agent", "ask", "plan"].includes(mode)) throw new CliError("--mode is agent, ask or plan", EXIT.usage);
  const started = await client.post<Run>(`/agents/${encodeURIComponent(agent.id)}/runs`, {
    input: prompt,
    ...(typeof flags.chat === "string" ? { threadId: flags.chat } : {}),
    ...(project && typeof flags.chat !== "string" ? { projectId: project.id } : {}),
    ...(mode && mode !== "agent" ? { mode } : {}),
  });
  if (flags.json !== true) process.stderr.write(`${agent.name} · run ${started.id}${started.threadId ? ` · chat ${started.threadId}` : ""}\n`);

  let shown = 0;
  const showSteps = (current: Run) => {
    if (flags.json === true) return;
    for (const action of current.actions.slice(shown)) {
      if (action.status === "waiting_approval") break;
      process.stderr.write(`  · ${describeAction(action)}\n`);
      shown += 1;
    }
  };
  for (;;) {
    const current = await client.follow(started.id, showSteps);
    if (current.status === "waiting_approval") {
      const action = current.actions.find((item) => item.status === "waiting_approval");
      if (!action) continue;
      if (!interactive) {
        if (flags.json === true) out(JSON.stringify(current));
        else process.stderr.write(`Waiting for approval: ${describeAction(action)}\nAnswer with: saturn approve ${current.id} ${action.id}   (or --deny)\n`);
        return EXIT.waiting;
      }
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const answer = (await rl.question(`Allow ${describeAction(action)}? [y/N] `)).trim().toLowerCase();
      rl.close();
      await client.post(`/runs/${encodeURIComponent(current.id)}/actions/${encodeURIComponent(action.id)}/decision`, { allow: answer === "y" || answer === "yes" });
      continue;
    }
    if (flags.json === true) out(JSON.stringify(current));
    else if (current.output) out(current.output);
    if (current.status === "completed") return EXIT.ok;
    if (flags.json !== true) process.stderr.write(`${current.status}${current.error ? `: ${current.error}` : ""}\n`);
    return EXIT.failed;
  }
}

export async function main(argv: string[], out: (text: string) => void = (text) => process.stdout.write(`${text}\n`)): Promise<number> {
  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  if (!command || command === "help" || command === "--help" || command === "-h" || flags.help === true) {
    out(USAGE);
    return command ? EXIT.ok : EXIT.usage;
  }
  const client = new Client();
  switch (command) {
    case "run":
      return run(client, positional, flags, out);
    case "agents": {
      const [agents, models] = await Promise.all([client.get<Agent[]>("/agents"), client.get<Model[]>("/connections/models")]);
      for (const agent of agents) out(`${agent.name}\t${models.find((item) => item.id === agent.modelConnectionId)?.name ?? "no model"}\t${agent.id}`);
      return EXIT.ok;
    }
    case "runs": {
      const limit = Number(flags.limit) || 20;
      const runs = await client.get<{ id: string; agentName: string; status: string; input: string; threadTitle: string }[]>(`/runs?limit=${limit}`);
      if (flags.json === true) out(JSON.stringify(runs));
      else for (const item of runs) out(`${item.id}\t${item.status}\t${item.agentName}\t${item.threadTitle}\t${item.input}`);
      return EXIT.ok;
    }
    case "show": {
      const id = positional[0];
      if (!id) throw new CliError("saturn show RUN", EXIT.usage);
      const current = await client.get<Run>(`/runs/${encodeURIComponent(id)}`);
      if (flags.json === true) {
        out(JSON.stringify(current));
      } else {
        out(`${current.id} · ${current.status}${current.error ? ` · ${current.error}` : ""}`);
        for (const action of current.actions) out(`  · ${describeAction(action)}${action.status === "waiting_approval" ? `   [${action.id}]` : ""}`);
        if (current.output) out(`\n${current.output}`);
      }
      return EXIT.ok;
    }
    case "changes": {
      const id = positional[0];
      if (!id) throw new CliError("saturn changes RUN", EXIT.usage);
      const changes = await client.get<{ root: string | null; files: { path: string; status: string; additions: number; deletions: number; review: string; diff: string }[] }>(`/runs/${encodeURIComponent(id)}/changes`);
      if (flags.json === true) out(JSON.stringify(changes));
      else if (!changes.files.length) out("No file changes.");
      else for (const file of changes.files) out(`${file.status}\t+${file.additions} -${file.deletions}\t${file.review}\t${file.path}`);
      return EXIT.ok;
    }
    case "approve": {
      const [id, actionId] = positional;
      if (!id || !actionId) throw new CliError("saturn approve RUN ACTION [--deny]", EXIT.usage);
      await client.post(`/runs/${encodeURIComponent(id)}/actions/${encodeURIComponent(actionId)}/decision`, { allow: flags.deny !== true });
      out(flags.deny === true ? "Denied." : "Approved.");
      return EXIT.ok;
    }
    case "stop": {
      const id = positional[0];
      if (!id) throw new CliError("saturn stop RUN", EXIT.usage);
      const current = await client.post<Run>(`/runs/${encodeURIComponent(id)}/stop`);
      out(`${current.id} · ${current.status}`);
      return EXIT.ok;
    }
    default:
      throw new CliError(`Unknown command "${command}".\n\n${USAGE}`, EXIT.usage);
  }
}

// Run when executed directly (not when imported by the tests).
const invoked = process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1]);
if (invoked) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`saturn: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(error instanceof CliError ? error.code : EXIT.failed);
    },
  );
}
