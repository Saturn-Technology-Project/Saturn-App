import { ASSISTANT_NAME, assistantChats, NEW_CHAT, RESEARCH_TOOLS, TASK_PREFIX } from "../domain/assistant.js";
import { isBusy } from "../domain/conversation.js";
import { t } from "../domain/i18n.js";
import type { Agent, ChatMode, Conversation, Model, RunMode } from "../domain/model.js";
import { assistantInstructions } from "../domain/workbench.js";
import type { CatalogService } from "./catalog.js";
import type { RunService } from "./runs.js";

/** The research assistant and tasks, on a hidden agent. Everything else about agents stays out of the interface. */
export class AssistantService {
  /** The hidden agent while it is being made, so screens that ask at once share one agent instead of making one each. */
  private making: Promise<Agent> | null = null;

  constructor(
    private readonly catalog: CatalogService,
    private readonly runs: RunService,
  ) {}

  /** The hidden agent, made the first time it is needed if a model is connected. */
  async agent(): Promise<{ agent: Agent | null; models: Model[] }> {
    const [agents, models] = await Promise.all([this.catalog.listAgents(), this.catalog.listModels()]);
    const found = agents.find((item) => item.name === ASSISTANT_NAME);
    if (!models.length) return { agent: null, models };
    const instructions = assistantInstructions();
    if (found) {
      // Its model may have been removed with nothing to take over, and what it knows of Saturn changes with Saturn. Nothing
      // else can set either: it has no screen.
      const modelConnectionId = models.some((model) => model.id === found.modelConnectionId) ? found.modelConnectionId : models[0].id;
      const mcpConnectionIds = found.mcpConnectionIds.includes(RESEARCH_TOOLS) ? found.mcpConnectionIds : [...found.mcpConnectionIds, RESEARCH_TOOLS];
      if (modelConnectionId === found.modelConnectionId && found.instructions === instructions && mcpConnectionIds === found.mcpConnectionIds) return { agent: found, models };
      await this.catalog.updateAgent(found.id, { modelConnectionId, instructions, mcpConnectionIds });
      return { agent: { ...found, modelConnectionId, instructions, mcpConnectionIds }, models };
    }
    this.making ??= this.make(models[0].id, instructions).finally(() => {
      this.making = null;
    });
    return { agent: await this.making, models };
  }

  /** Makes the hidden agent: without a list, so that it has every tool an agent gets by default, and then the research
   * tools, which are asked for. */
  private async make(modelConnectionId: string, instructions: string): Promise<Agent> {
    const agent = await this.catalog.createAgent({ name: ASSISTANT_NAME, modelConnectionId, instructions });
    const mcpConnectionIds = [...agent.mcpConnectionIds, RESEARCH_TOOLS];
    await this.catalog.updateAgent(agent.id, { mcpConnectionIds });
    return { ...agent, mcpConnectionIds };
  }

  chooseModel(agent: Agent, modelId: string): Promise<void> {
    return this.catalog.updateAgent(agent.id, { modelConnectionId: modelId });
  }

  /** The project's assistant chats, the most recently used first. */
  async chats(agent: Agent, projectId: string): Promise<Conversation[]> {
    return assistantChats(await this.catalog.listThreads(agent.id), projectId);
  }

  /** A new chat in the project, named by its first message when it is made for one. */
  newChat(agent: Agent, projectId: string, title?: string): Promise<Conversation> {
    return this.catalog.createThread(agent.id, title?.trim() || NEW_CHAT, projectId);
  }

  renameChat(threadId: string, title: string): Promise<Conversation> {
    return this.catalog.renameThread(threadId, title);
  }

  /** Deletes a chat with its messages, unless its assistant is still answering. */
  async deleteChat(agent: Agent, threadId: string): Promise<void> {
    const latest = (await this.catalog.messages(agent.id, threadId)).at(-1);
    if (latest && (isBusy(latest) || latest.status === "waiting_approval")) throw new Error(t("The assistant is still answering in this chat. Stop it first."));
    await this.catalog.deleteThread(threadId);
  }

  /** The project's tasks, newest first. */
  async tasks(agent: Agent, projectId: string): Promise<Conversation[]> {
    const threads = await this.catalog.listThreads(agent.id);
    return threads.filter((item) => item.projectId === projectId && item.title?.startsWith(TASK_PREFIX));
  }

  /** Hands work to an agent in its own worktree, so nothing reaches the project until it is merged. */
  async startTask(agent: Agent, projectId: string, prompt: string, mode: ChatMode = "delegate"): Promise<Conversation> {
    const title = TASK_PREFIX + prompt.split("\n")[0].slice(0, 80);
    const thread = await this.catalog.createThread(agent.id, title, projectId);
    await this.catalog.setChatMode(thread.id, mode);
    await this.catalog.isolateThread(thread.id);
    await this.runs.start(agent.id, prompt, thread.id, { mode: "agent" satisfies RunMode });
    return thread;
  }
}
