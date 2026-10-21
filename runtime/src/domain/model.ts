import type { PermissionRule } from "./permissions.js";
import type { SandboxSettings } from "../infrastructure/sandbox.js";
import type { Hook } from "../application/hooks.js";
import type { PluginRecord } from "../application/plugins.js";
export type AgentStatus = "active" | "paused";
export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  /** Suspended by a long computer_wait; the scheduler resumes the same run at `wake.at`. */
  | "sleeping"
  | "completed"
  | "failed"
  | "cancelled";

export type ToolRoute = {
  toolId: string;
  serverId: string;
  description: string;
  inputSchema: Record<string, unknown>;
  environments: string[];
  category?: "read" | "write";
  /** The tool's name on its MCP server when `toolId` was prefixed to keep names unique. */
  remoteName?: string;
};

export type ModelConnection = {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  hasSecret: boolean;
  /** Reasoning effort (low … max); every provider maps it to its own control. Unset uses the model's default. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** The model's context window in tokens, when known better than the catalog's figure (see domain/context.ts). */
  contextTokens?: number;
};

export type McpOrigin = "local";

/** A local MCP server: a program Saturn starts and talks to over stdio. Variable values live in the secrets file. */
export type McpCommand = { program: string; args: string[]; env?: string[] };

export type McpConnection = {
  id: string;
  name: string;
  url: string;
  /** Set for a local server Saturn starts itself (stdio); url then only names it. */
  command?: McpCommand;
  /** Fingerprint of the command the user allowed to run; the server starts only while it matches. */
  approvedCommand?: string;
  tools: ToolRoute[];
  origin?: McpOrigin;
  disabledTools?: string[];
  /** How Saturn signs in: none, OAuth in the browser, or a pasted bearer token. Unset means none. */
  auth?: "none" | "oauth" | "token";
  /** Set when installed from Customizations. */
  marketplaceId?: string;
  /** Set when a plugin brought this server; removed with the plugin, or when it is turned off. */
  pluginName?: string;
  status?: "connecting" | "signing_in" | "ready" | "error";
  statusDetail?: string;
  /** While signing in: the provider page the browser was sent to. */
  authorizationUrl?: string;
};

export type RagConnection = {
  id: string;
  name: string;
  url: string;
};

export type ResponseStyle = "concise" | "professional" | "detailed";
export type Autonomy =
  | "default"
  | "bypass"
  | "auto"
  | "turbo"
  | "review"
  | "suggest_only"
  | "execute_when_allowed"
  | "fully_autonomous";

export type Agent = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  responseStyle: ResponseStyle;
  autonomy: Autonomy;
  temperature: number;
  maxOutput: number;
  status: AgentStatus;
  canEdit?: boolean;
  modelConnectionId: string | null;
  mcpConnectionIds: string[];
  ragConnectionIds: string[];
  /** This agent's own permission rules (see domain/permissions.ts); the user's and the project's apply too. */
  permissions?: PermissionRule[];
};

export type RunAction = {
  id: string;
  toolId: string;
  arguments: Record<string, unknown>;
  status: "completed" | "denied" | "waiting_approval" | "sleeping" | "failed";
  result?: unknown;
  reason?: string;
  thoughtSignature?: string;
};

/**
 * The reasoning returned by one model call, with how long that call took and how many actions the run
 * had when it came back, so the conversation can place "Thought for Xs" between the tool calls.
 */
export type RunThought = {
  text: string;
  seconds: number;
  /** Number of run actions that came before this thought. */
  at: number;
};

export type Conversation = {
  id: string;
  agentId: string;
  /** The project folder this chat works in; chats without one use the agent's private sandbox. */
  projectId?: string;
  /** The Claude Agent SDK session behind this chat (Claude Code models), resumed on the next message. */
  claudeSessionId?: string;
  /** The Codex thread behind this chat (Codex models), resumed on the next message. */
  codexThreadId?: string;
  /** Set while this chat works in its own git worktree and branch (see application/worktrees.ts). */
  worktree?: { branch: string; base: string };
  /** The pull request Saturn opened from this chat's worktree, and what following it found (see pull-requests.ts). */
  pullRequest?: PullRequestWatch;
  /** The running summary of this chat's earlier turns, through `throughRunId`; later turns are sent whole. */
  summary?: { text: string; throughRunId: string; turns: number; createdAt: string };
  title: string;
  createdAt: string;
  updatedAt: string;
};

/** A comment or unresolved review thread on a followed pull request, waiting for the user to send it to the agent. */
export type PullRequestFeedback = { id: string; author: string; body: string; at: string; path?: string; line?: number };

export type PullRequestWatch = {
  number: number;
  url: string;
  /** owner/name on GitHub. */
  repository: string;
  branch: string;
  openedAt: string;
  watching: boolean;
  state: "open" | "merged" | "closed";
  checks: "pending" | "success" | "failure" | "none";
  failed?: { name: string; url: string }[];
  head?: string;
  /** The head whose failing checks were already handed to the agent (or given up on). */
  handledHead?: string;
  fixRounds: number;
  fixRunId?: string;
  /** The turn answering review comments the user sent; its changes are pushed when it ends, like a fix round's. */
  pushRunId?: string;
  feedback: PullRequestFeedback[];
  seenFeedback: string[];
  lastCheckedAt?: string;
  error?: string;
};

export type Run = {
  id: string;
  agentId: string;
  threadId?: string;
  input: string;
  status: RunStatus;
  output: string;
  thinking?: string;
  thoughts?: RunThought[];
  actions: RunAction[];
  error?: string;
  generation: number;
  /** While sleeping: when to resume, why, and which computer_wait action receives the result. */
  wake?: { at: string; since: string; reason?: string; actionId: string; requestedMs: number };
  /** Long waits taken so far; capped so a run cannot poll forever. */
  sleeps?: number;
  /** Files this run changed in its project folder; the originals are kept under the data dir (see CheckpointService). */
  checkpoint?: RunCheckpoint;
  /** Set on a group chat turn: the group, and the message the agent was asked to consider. */
  groupId?: string;
  groupMessageId?: string;
  /** Images the user attached to this message: paths under the data directory (see run-images.ts). */
  inputImages?: string[];
  /** What this turn may do: change things (agent, the default), only read and answer (ask), or only read and plan. */
  mode?: RunMode;
  /** Saturn sent this message itself: an automatic fix round after the check command failed. */
  automatic?: boolean;
  /** The project's check command after this turn's changes (see verify.ts). */
  verification?: { command: string; ok: boolean; code: number | null; output: string };
  /** Before this turn, the chat's earlier turns were folded into its summary to fit the model's context. */
  compacted?: { turns: number; at: string };
  /** A sub-agent's run: started by the `delegate` tool of this run, in the same chat, with its own context. */
  parentRunId?: string;
  delegated?: { task: string; tools: "read-only" | "all" };
  /** Only on a run as the chat lists it: the sub-agent runs its `delegate` calls started. */
  children?: Run[];
};

export type RunMode = "agent" | "ask" | "plan";

/** A group chat: the user and several agents. Every message is shown to the members, who decide whether to reply. */
/** How much a group's agents may do without asking: every tool, risky ones only, or nothing. */
export type GroupAutonomy = "review" | "default" | "bypass";

/** One agent's standing session in a group: the SDK session it resumes, and the last message it has seen. */
export type GroupSession = {
  claudeSessionId?: string;
  codexThreadId?: string;
  /** createdAt of the newest group message already given to this agent. */
  seenAt?: string;
};

export type Group = {
  id: string;
  name: string;
  agentIds: string[];
  /** Overrides each member's own approval setting while it works in this group; unset keeps theirs. */
  autonomy?: GroupAutonomy;
  /** By agent id. */
  sessions?: Record<string, GroupSession>;
  createdAt: string;
  updatedAt: string;
};

export type GroupMessage = {
  id: string;
  groupId: string;
  /** The agent that wrote it; absent for the user. */
  agentId?: string;
  text: string;
  createdAt: string;
  /** The run that produced an agent's message. */
  runId?: string;
  /** The agent's turn failed; `text` is the reason. Not shown to other agents. */
  error?: boolean;
  /** Agent-to-agent hops since the user's message (0 for the user's own). */
  depth: number;
};

/** The project folder a run wrote in and each file it touched there. */
export type RunCheckpoint = {
  root: string;
  files: FileChange[];
  /** Each tool step's first write to a file, in order, with the file's sha256 just before it (null: absent). */
  steps?: CheckpointStep[];
};

export type CheckpointStep = { actionId: string; path: string; hash: string | null };

/**
 * One file a run changed: sha256 of its bytes before the run's first write and after its last one
 * (null when the file did not exist: created by the run, or deleted by it). `review` is the user's call.
 */
export type FileChange = { path: string; before: string | null; after: string | null; review?: "kept" | "reverted" };

/**
 * One LLM call's tokens and cost, fixed when the call is made: the agent and model that actually ran it
 * and the official rate in force at that moment. Later model switches, renames, deletions or price
 * changes do not rewrite it. Fields marked optional are missing on records from before they existed.
 */
export type UsageRecord = {
  id: string;
  /** Empty for calls outside a run, such as drafting an automation. */
  runId: string;
  agentId: string;
  agentName?: string;
  /** The model connection used (Settings → Models). */
  modelId: string;
  modelName?: string;
  provider: string;
  /** The model id sent to the provider. */
  model: string;
  purpose?: "run" | "automation_draft" | "completion" | "memory" | "compaction";
  /** Every prompt token, the cached and cache-written ones included. */
  inputTokens: number;
  outputTokens: number;
  /** Of inputTokens: read from the provider's cache, and written to it (billed at their own rates). */
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  /** USD per 1M tokens; null when the model has no official price (custom endpoints, unlisted models). */
  inputRate?: number | null;
  outputRate?: number | null;
  cachedRate?: number | null;
  cacheWriteRate?: number | null;
  /** Which price applied: standard, long context, peak, off-peak, local, a dated rate, or unpriced. */
  pricing?: string;
  costUsd?: number | null;
  createdAt: string;
};

export type AppSettings = {
  name: string;
  environment: string;
  logging: "debug" | "info" | "warning" | "error";
  /** What opens when Saturn starts: the Agent App window, or Saturn IDE (the app then stays in the Dock). */
  launchApp: LaunchApp;
  /** How Saturn IDE's Claude Code signs in: the user's own `claude` login (subscription), or the saved API key. */
  claudeCodeAuth?: ClaudeCodeAuth;
  /** The model connection Saturn IDE's Tab completion and Cmd+K inline edit use; unset turns them off. */
  completionModelId?: string | null;
  /** Keep notes about the user and each project across chats (default on). */
  memory?: boolean;
  /** Agents write a plan and wait for the user's go-ahead before changing anything (default off). */
  planApproval?: boolean;
  /** Permission rules that apply to every agent in every project. */
  permissions?: PermissionRule[];
  /** The sandbox for the `code` tool's commands (default workspace-write with network). */
  sandbox?: SandboxSettings;
  /** The user's own hooks, which run in every project (see application/hooks.ts). */
  hooks?: Hook[];
  /** Claude Code loads the project's own `.claude/settings.json` (its hooks, permissions and settings). Default off. */
  claudeProjectSettings?: boolean;
  /** Where the agent's browser shows: streamed into the Agent App's Browser panel (default), a visible Chrome window, or a Safari automation window. */
  browser?: "saturn" | "system" | "safari";
  /** Installed plugins (see application/plugins.ts); their files live in ~/.saturn-app/plugins/<name>. */
  plugins?: PluginRecord[];
  /**
   * What embeds the code index: Saturn's built-in model (default), LM Studio, or an OpenAI-compatible endpoint
   * (the model connection `embeddingConnectionId`). Unset with an `embeddingModel` means LM Studio, as before.
   */
  embeddingSource?: EmbeddingSource;
  /** The embedding model's name for that source. */
  embeddingModel?: string;
  /** For the "openai" source: the model connection whose endpoint and key are used. */
  embeddingConnectionId?: string;
  /** When the user finished (or skipped) the first-launch onboarding; unset shows it. */
  onboardedAt?: string;
};

export type ClaudeCodeAuth = "subscription" | "api-key";

export type EmbeddingSource = "builtin" | "lmstudio" | "openai";

export type LaunchApp = "agent" | "ide";

export type AutomationFrequency = "hourly" | "daily" | "weekdays" | "weekly";

export type AutomationTrigger = {
  frequency: AutomationFrequency;
  /** Local "HH:MM"; hourly automations only use the minutes. */
  time: string;
  /** 0 = Sunday. Weekly automations only. */
  weekday: number;
};

export type Automation = {
  id: string;
  name: string;
  agentId: string;
  prompt: string;
  trigger: AutomationTrigger;
  timeZone: string;
  enabled: boolean;
  createdAt: string;
  /** Local-minute index of the last slot that was handled, so each slot fires once. */
  lastSlot: number;
  lastRunAt?: string;
  lastRunId?: string;
  lastError?: string;
};

export type Project = {
  id: string;
  name: string;
  /** The primary folder: where agents run, and what the IDE and terminal open. Always folders[0]. */
  path: string;
  /** Every folder in this workspace, primary first. */
  folders?: string[];
  /** Set when the user allowed agents to read, change and run commands in this folder. */
  access?: { grantedAt: string } | null;
  gitBranch?: string | null;
  gitStatus?: string | null;
  description?: string;
  rules?: string;
  /** Run after an agent changes files here: a shell command, or "auto" for package.json's typecheck/lint script. */
  verifyCommand?: string;
  /** Permission rules for agents working in this project, kept by Saturn (the folder's `.saturn/settings.json` is read too). */
  permissions?: PermissionRule[];
  /** The sandbox for commands run in this project; unset uses the setting for everywhere. */
  sandbox?: SandboxSettings;
  /** The fingerprint of each project file's hooks the user allowed (`.saturn/hooks.json`, `.claude/settings.json`). */
  approvedHooks?: Record<string, string>;
  lastOpenedAt?: string;
  isDefault?: boolean;
};

export type AppState = {
  projects?: Project[];
  activeProjectId?: string | null;
  agents: Agent[];
  automations: Automation[];
  models: ModelConnection[];
  mcp: McpConnection[];
  rag: RagConnection[];
  runs: Run[];
  threads?: Conversation[];
  groups?: Group[];
  groupMessages?: GroupMessage[];
  usage: UsageRecord[];
  settings: AppSettings;
};
