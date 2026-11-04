import { ASSISTANT_NAME, ASSISTANT_THREAD, TASK_PREFIX } from "../domain/assistant.js";
import type { Agent, Conversation, Model, RunMode } from "../domain/model.js";
import type { CatalogService } from "./catalog.js";
import type { RunService } from "./runs.js";

/** The research assistant and tasks, on a hidden agent. Everything else about agents stays out of the interface. */
export class AssistantService {
  constructor(
    private readonly catalog: CatalogService,
    private readonly runs: RunService,
  ) {}

  /** The hidden agent, made the first time it is needed if a model is connected. */
  async agent(): Promise<{ agent: Agent | null; models: Model[] }> {
    const [agents, models] = await Promise.all([this.catalog.listAgents(), this.catalog.listModels()]);
    const found = agents.find((item) => item.name === ASSISTANT_NAME);
    if (found) return { agent: found, models };
    if (!models.length) return { agent: null, models };
    const agent = await this.catalog.createAgent({ name: ASSISTANT_NAME, modelConnectionId: models[0].id });
    return { agent, models };
  }

  chooseModel(agent: Agent, modelId: string): Promise<void> {
    return this.catalog.updateAgent(agent.id, { modelConnectionId: modelId });
  }

  /** The project's assistant chat. */
  async thread(agent: Agent, projectId: string): Promise<Conversation> {
    const threads = await this.catalog.listThreads(agent.id);
    return threads.find((item) => item.projectId === projectId && item.title === ASSISTANT_THREAD) ?? (await this.catalog.createThread(agent.id, ASSISTANT_THREAD, projectId));
  }

  /** The project's tasks, newest first. */
  async tasks(agent: Agent, projectId: string): Promise<Conversation[]> {
    const threads = await this.catalog.listThreads(agent.id);
    return threads.filter((item) => item.projectId === projectId && item.title?.startsWith(TASK_PREFIX));
  }

  /** Hands work to an agent in its own worktree, so nothing reaches the project until it is merged. */
  async startTask(agent: Agent, projectId: string, prompt: string): Promise<Conversation> {
    const title = TASK_PREFIX + prompt.split("\n")[0].slice(0, 80);
    const thread = await this.catalog.createThread(agent.id, title, projectId);
    await this.catalog.isolateThread(thread.id);
    await this.runs.start(agent.id, prompt, thread.id, { mode: "agent" satisfies RunMode });
    return thread;
  }
}
