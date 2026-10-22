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
  instructions: string;
  description: string;
  responseStyle?: ResponseStyle;
  autonomy?: Autonomy;
  temperature?: number;
  maxOutput?: number;
  status: string;
  modelConnectionId: string | null;
  canEdit?: boolean;
  mcpConnectionIds: string[];
  ragConnectionIds: string[];
};

export type Model = {
  id: string;
  name: string;
  provider?: string;
  model?: string;
  baseUrl: string;
  hasSecret: boolean;
  /** Reasoning effort for this model (every provider maps it to its own control); unset uses the model's default. */
  effort?: Effort;
};
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_LABELS: Record<Effort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max" };
/** LM Studio and DeepSeek have no effort control. */
export function supportsEffort(provider?: string): boolean {
  return provider !== "lmstudio" && provider !== "deepseek";
}
export type McpTool = { toolId: string; description?: string; category?: "read" | "write"; inputSchema?: Record<string, unknown> };
export type Mcp = {
  id: string;
  name: string;
  url: string;
  origin?: "local";
  tools: McpTool[];
  disabledTools?: string[];
  /** A local server Saturn starts itself (stdio): the program, its arguments and the names of its variables. */
  command?: { program: string; args: string[]; env?: string[] };
  /** The command as it reads in a terminal, and the fingerprint the user approves. */
  commandLine?: string;
  commandFingerprint?: string;
  approval?: "approved" | "needed";
};

/**
 * Splits a command line the way a shell would, without running one: whitespace separates arguments; single and
 * double quotes group them; a backslash escapes only a quote or a space (inside double quotes, a quote or a
 * backslash), so Windows paths like C:\\Program Files\\nodejs keep theirs. Nothing is expanded.
 */
export function splitCommandLine(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && (text[i + 1] === '"' || text[i + 1] === "\\")) current += text[++i];
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && i + 1 < text.length && /['"\s]/.test(text[i + 1]!)) {
      current += text[++i];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) parts.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new Error("The command has an unclosed quote.");
  if (started) parts.push(current);
  return parts;
}
export type Rag = { id: string; name: string; url: string };

export type Project = {
  id: string;
  name: string;
  /** The primary folder (folders[0]): where agents run and what the IDE opens. */
  path: string;
  /** Every folder in this workspace, primary first. */
  folders?: string[];
  /** Set once the user allowed agents to work in this folder. */
  access?: { grantedAt: string } | null;
  gitBranch?: string | null;
  gitStatus?: string | null;
  description?: string;
  rules?: string;
  /** Run after an agent changes files here: a shell command, or "auto" for package.json's typecheck/lint script. */
  verifyCommand?: string;
  /** Permission rules for agents working here, kept by Saturn (the folder's .saturn/settings.json is read too). */
  permissions?: PermissionRule[];
  /** The sandbox for commands run here; unset uses the setting for everywhere. */
  sandbox?: SandboxSettings;
  lastOpenedAt?: string;
  isDefault?: boolean;
};

export type Conversation = {
  id: string;
  agentId: string;
  /** The project folder this chat works in. */
  projectId?: string;
  /** Set while the chat works in its own git worktree and branch. */
  worktree?: { branch: string; base: string };
  /** The pull request Saturn opened from this chat, and what following it found. */
  pullRequest?: PullRequestWatch;
  /** The running summary of the chat's earlier turns; later turns are sent whole. */
  summary?: { text: string; throughRunId: string; turns: number; createdAt: string };
  title: string;
  createdAt: string;
  updatedAt: string;
};

/** A hook: a command that runs before or after a tool call, or when a turn ends (see Settings → Hooks). */
export type HookEvent = "pre_tool" | "post_tool" | "stop";
export type Hook = { event: HookEvent; matcher?: string; command: string; timeoutMs?: number };
export type HookSet = { source: "user" | "project-file" | "claude-file" | "plugin"; path?: string; hooks: Hook[]; fingerprint?: string; approved: boolean };

/** The `saturn` command's launcher. */
export type CliStatus = { path: string; installed: boolean; current: boolean; onPath: boolean; folder: string };

/** An installed plugin: what it bundles, whether it is on, and whether its hooks are allowed. */
export type Plugin = {
  name: string;
  source: string;
  installedAt: string;
  enabled: boolean;
  version?: string;
  description: string;
  skills: string[];
  commands: string[];
  hooks: Hook[];
  hooksFingerprint?: string;
  hooksApproved: boolean;
  mcpServers: { name: string; id?: string; kind: "command" | "url" }[];
};

/** A background command an agent started in a chat (code with background: true). */
export type BackgroundJob = { id: string; scope: string; command: string; pid?: number; startedAt: string; endedAt?: string; exitCode?: number | null; running: boolean; bytes: number };

/** A followed pull request: its state, its checks, the CI fix rounds, and review comments waiting to be sent. */
export type PullRequestWatch = {
  number: number;
  url: string;
  repository: string;
  branch: string;
  watching: boolean;
  state: "open" | "merged" | "closed";
  checks: "pending" | "success" | "failure" | "none";
  failed?: { name: string; url: string }[];
  fixRounds: number;
  fixRunId?: string;
  feedback: { id: string; author: string; body: string; at: string; path?: string; line?: number }[];
  lastCheckedAt?: string;
  error?: string;
};

/** How full a chat's context is for its model (an estimate in tokens), and what its summary covers. */
export type ContextUsage = { usedTokens: number; budgetTokens: number; windowTokens: number; percent: number; turns: number; summary: { turns: number; createdAt: string } | null };

/** A permission rule: what a tool may do without asking (allow), must ask about (ask), or may never do (deny). */
export type PermissionRule = { tool: string; pattern: string; effect: "allow" | "deny" | "ask" };
export type PermissionScope = "user" | "project" | "agent" | "project-file" | "claude-file";
export type PermissionLayer = {
  scope: PermissionScope;
  rules: PermissionRule[];
  path?: string;
  editable: boolean;
  label: string;
  /** A project file's allow rules waiting for the user to allow them (that exact set, by `fingerprint`). */
  held?: PermissionRule[];
  fingerprint?: string;
  approved?: boolean;
  /** Rules from a file that are never applied: they would allow everything. */
  refused?: PermissionRule[];
};

export type RunAction = {
  id?: string;
  toolId: string;
  arguments?: Record<string, unknown>;
  status: string;
  result?: unknown;
  reason?: string;
};
/** Reasoning from one model call; `at` is how many actions came before it. */
export type RunThought = { text: string; seconds: number; at: number };
export type Run = {
  id: string;
  agentId?: string;
  threadId?: string;
  input: string;
  output: string;
  thinking?: string;
  thoughts?: RunThought[];
  status: string;
  actions: RunAction[];
  error?: string;
  /** Set while the run is "sleeping" on a long computer_wait. */
  wake?: { at: string; since: string; reason?: string; actionId: string; requestedMs: number };
  /** Files the run changed in its project folder (sha256 before/after; null = did not exist). */
  checkpoint?: { root: string; files: { path: string; before: string | null; after: string | null; review?: "kept" | "reverted" }[]; steps?: { actionId: string; path: string; hash: string | null }[] };
  /** Images the user attached (paths in the runtime's data folder; GET /runs/:id/images/:index serves them). */
  inputImages?: string[];
  /** What this turn may do: change things (agent, the default), only read and answer, or only read and plan. */
  mode?: RunMode;
  /** Saturn sent this message itself (an automatic fix round after verification). */
  automatic?: boolean;
  /** The project's check command after this turn's changes. */
  /** Before this turn, earlier turns were folded into the chat's summary to fit the model's context. */
  compacted?: { turns: number; at: string };
  /** A sub-agent's run, started by the delegate tool of `parentRunId`; the chat shows it nested in that step. */
  parentRunId?: string;
  delegated?: { task: string; tools: "read-only" | "all" };
  children?: Run[];
  verification?: { command: string; ok: boolean; code: number | null; output: string };
  /** Set on a group chat turn: the group and the message the agent was asked to consider. */
  groupId?: string;
  groupMessageId?: string;
};

/** A group chat of the user and several agents; each agent decides whether a message needs it. */
/** How much a group's agents may do without asking; unset keeps each agent's own setting. */
export type GroupAutonomy = "review" | "default" | "bypass";
export type Group = { id: string; name: string; agentIds: string[]; autonomy?: GroupAutonomy; createdAt: string; updatedAt: string; lastMessage?: GroupMessage };
export type GroupMessage = {
  id: string;
  groupId: string;
  /** Absent for the user. */
  agentId?: string;
  text: string;
  createdAt: string;
  runId?: string;
  /** The agent's turn failed; `text` is the reason. */
  error?: boolean;
  depth: number;
};
export type GroupTranscript = { group: Group; messages: GroupMessage[]; runs: Run[] };

/** One file a run changed, with its unified diff, from GET /runs/:id/changes. */
export type FileChange = {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  binary: boolean;
  diff: string;
  truncated: boolean;
  review: "pending" | "kept" | "reverted";
  /** The file on disk no longer matches what the run left (a later turn or the user changed it). */
  modifiedSince: boolean;
};
export type RunChanges = { runId: string; root: string | null; files: FileChange[] };

/** inputTokens counts every prompt token; cachedInputTokens (cache hits) and cacheWriteTokens are billed at cache rates. */
export type UsageTally = { calls: number; inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheWriteTokens?: number; costUsd: number; unpricedCalls: number };
export type ModelUsage = UsageTally & { provider: string; model: string; label: string; price: string | null };
export type AgentUsage = UsageTally & {
  agentId: string;
  name: string;
  exists: boolean;
  models: (UsageTally & { provider: string; model: string; label: string })[];
};
/** Token and cost totals, from usage recorded per call with the agent, model and official rate at that moment. */
export type UsageSummary = { currency: "USD"; range?: { from: string | null; to: string | null }; since: string | null; totals: UsageTally; models: ModelUsage[]; agents: AgentUsage[] };

export type AgentBrowser = "saturn" | "system" | "safari";

/** The agent's browser as the runtime reports it, and one frame of its page (base64 JPEG). */
export type AgentBrowserState = { open: boolean; mode: AgentBrowser; url: string; title: string };
export type AgentBrowserFrame = { data: string; format?: "jpeg" | "png"; width: number; height: number; url: string; title: string };

export type LaunchApp = "agent" | "ide";
export type Profile = {
  name: string;
  environment: string;
  logging: string;
  launchApp?: LaunchApp;
  /** The model Saturn IDE's Tab completion and Cmd+K edit use; null turns them off. */
  completionModelId?: string | null;
  /** Keep notes about the user and each project across chats. */
  memory?: boolean;
  /** Agents write a plan and wait for a go-ahead before changing anything. */
  planApproval?: boolean;
  /** What embeds the code index: the built-in model (default), LM Studio, or an OpenAI-compatible connection. */
  embeddingSource?: EmbeddingSource;
  /** The embedding model's name for that source. */
  embeddingModel?: string;
  /** The sandbox for commands (default: workspace-write, network allowed). */
  sandbox?: SandboxSettings;
  /** Claude Code loads the project's own .claude/settings.json (hooks, permissions, settings). */
  claudeProjectSettings?: boolean;
  /** Where the agent's browser shows: live in the Browser panel ("saturn", default), a visible Chrome window ("system"), or Safari ("safari", macOS). */
  browser?: AgentBrowser;
  /** For the OpenAI-compatible source: the model connection whose endpoint and key are used. */
  embeddingConnectionId?: string;
  /** When the first-launch onboarding was finished or skipped; unset shows it. */
  onboardedAt?: string;
};
export type EmbeddingSource = "builtin" | "lmstudio" | "openai";
/** How the `code` tool's commands are confined: writes only in the workspace, none at all, or no sandbox. */
export type SandboxMode = "workspace-write" | "read-only" | "off";
export type SandboxSettings = { mode: SandboxMode; network: boolean };
export type RunMode = "agent" | "ask" | "plan";
export type PendingTask = { id: string; agentId: string; agentName: string; input: string; toolId: string };

export type LlmProvider = { id: string; label: string; needsKey: boolean; baseUrl: string; models: { id: string; label: string }[] };
export type LlmChoice = { id: string; label: string };

export type RuntimeInfo = {
  version: string;
  listen: string;
  name: string;
  environment: string;
  runtimeId: string;
  mcpServers: string[];
  /** How API keys and tokens are protected on disk (runtimes before 0.2 do not report it). */
  secrets?: { encrypted: boolean; keyStore: "keychain" | "dpapi" | "libsecret" | "file" | null; label: string };
};

export type LogLine = {
  seq: number;
  ts: string;
  service: string;
  level: "debug" | "info" | "warning" | "error";
  message: string;
  attributes?: Record<string, unknown>;
};

export type AutomationFrequency = "hourly" | "daily" | "weekdays" | "weekly";
export type AutomationTrigger = { frequency: AutomationFrequency; time: string; weekday: number };
export type Automation = {
  id: string;
  name: string;
  agentId: string;
  agentName: string;
  prompt: string;
  trigger: AutomationTrigger;
  timeZone: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastRunId?: string;
  lastError?: string;
  nextRun: string | null;
};
export type AutomationInput = Pick<Automation, "name" | "agentId" | "prompt" | "trigger" | "timeZone"> & { enabled?: boolean };
export type AutomationDraft = Pick<Automation, "name" | "prompt" | "trigger">;

export type AttributeValue = string | number | boolean | (string | number | boolean | null)[] | null | undefined;
export type Attributes = Record<string, AttributeValue>;

export type TelemetryMode = "disabled" | "local" | "console" | "otlp";
export type TelemetryStatus = {
  mode: TelemetryMode;
  serviceName: string;
  endpoint: string | null;
  /** Where the runtime saves telemetry as JSON; null when telemetry is disabled. */
  file: string | null;
  savedAt: string | null;
  traces: number;
  errorTraces: number;
  logs: number;
};
export type TraceSummary = {
  traceId: string;
  rootName: string;
  startMs: number;
  durationMs: number;
  spanCount: number;
  errorCount: number;
  routine: boolean;
};
export type SpanKindName = "internal" | "server" | "client" | "producer" | "consumer";
export type SpanRecord = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: SpanKindName;
  scope: string;
  startMs: number;
  durationMs: number;
  status: "unset" | "ok" | "error";
  statusMessage?: string;
  attributes: Attributes;
  events: { name: string; timeMs: number; attributes: Attributes }[];
};
export type TelemetryLog = {
  timeMs: number;
  severity: string;
  severityNumber: number;
  body: string;
  attributes: Attributes;
  traceId?: string;
  spanId?: string;
};
export type MetricPoint = {
  attributes: Attributes;
  value?: number;
  histogram?: { count: number; sum: number; min?: number; max?: number; boundaries: number[]; counts: number[] };
};
export type MetricView = {
  name: string;
  description: string;
  unit: string;
  type: "sum" | "gauge" | "histogram";
  monotonic?: boolean;
  points: MetricPoint[];
};

/** How a Customizations integration signs in (see runtime/src/domain/marketplace.ts). */
export type InstallAuth = "none" | "oauth" | "oauth-client" | "token";
export type MarketplaceEntry = {
  id: string;
  available: boolean;
  reason?: string;
  auth?: InstallAuth;
  setupUrl?: string;
  setupHint?: string;
  tokenAlternative?: boolean;
  installed: null | {
    connectionId: string;
    status: "connecting" | "signing_in" | "ready" | "error";
    detail?: string;
    authorizationUrl?: string;
    tools: number;
    agents: number;
  };
};
export type InstallRequest = { name?: string; token?: string; clientId?: string; clientSecret?: string; attach?: "all" | "none" };

/** One thing attached to a message with "@". */
export type ContextItem =
  | { kind: "file"; path: string; label: string }
  | { kind: "folder"; path: string; label: string }
  | { kind: "git"; label: string }
  | { kind: "web"; url: string; label: string }
  | { kind: "terminal"; label: string }
  | { kind: "problems"; label: string };

/** One row of the Agents board (GET /runs): a run and the chat it belongs to. */
export type RunSummary = {
  id: string;
  agentId: string;
  agentName: string;
  threadId: string;
  threadTitle: string;
  projectId?: string;
  branch?: string;
  status: Run["status"];
  input: string;
  changedFiles: number;
  updatedAt?: string;
};

