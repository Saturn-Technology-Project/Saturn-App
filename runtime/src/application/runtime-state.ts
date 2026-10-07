import type { RunAction } from "../domain/model.js";
import type { ToolCall } from "../domain/policies.js";

export type { ToolCall };

export const RUNTIME_CALLER = { callerId: "runtime_operations", callerType: "runtime" as const, admin: false };
export const DISCONNECT_ERROR = "Disconnected from Saturn Cloud";

export type PendingTool = {
  agentId: string;
  toolId: string;
  arguments: Record<string, unknown>;
  runId: string;
  actionId: string;
  serverId: string;
};

export type Inflight = {
  runId: string;
  agentId: string;
  actions: RunAction[];
  remaining: ToolCall[];
};

export type LogLine = { seq: number; ts: string; service: string; level: string; message: string };
