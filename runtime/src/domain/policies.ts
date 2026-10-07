import type { Agent, ModelConnection, RunAction } from "./model.js";

export type ToolCall = { name: string; arguments: Record<string, unknown>; thoughtSignature?: string };


export function clip(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit - 1)}…`;
}

export function explainRunError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Run failed";
  if (message.includes("API_KEY_SERVICE_BLOCKED") || message.includes("generativelanguage.googleapis.com")) {
    return "This Gemini key cannot call the Gemini API. Create a key in Google AI Studio and connect it under LLM. A key from the Saturn Cloud project is blocked.";
  }
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  if (message === "fetch failed" && cause) return cause;
  return message;
}

export function cloudProvider(provider: string): string {
  if (provider === "claude") return "anthropic";
  if (provider === "gemini") return "google";
  if (provider === "lmstudio") return "custom";
  return "openai";
}

export function appProvider(provider: string): string {
  if (provider === "anthropic") return "claude";
  if (provider === "google") return "gemini";
  if (provider === "custom") return "lmstudio";
  return provider;
}

export function boundModel(
  settings: { provider?: string; model?: string; model_connection_id?: string },
  existingId: string | null,
  models: ModelConnection[],
): string | null {
  const requested = settings.model_connection_id ?? "";
  const provider = settings.provider ?? "";
  const modelName = settings.model ?? "";
  const candidates = provider && modelName
    ? models.filter((item) => {
        const sameProvider = item.provider === provider || cloudProvider(item.provider) === provider || item.provider === appProvider(provider);
        const sameModel = item.model === modelName || item.name === modelName;
        return sameProvider && sameModel;
      })
    : [];
  if (requested && candidates.some((item) => item.id === requested)) return requested;
  if (existingId && candidates.some((item) => item.id === existingId)) return existingId;
  if (candidates[0]) return candidates[0].id;
  if (requested && models.some((item) => item.id === requested)) return requested;
  if (existingId && models.some((item) => item.id === existingId)) return existingId;
  return null;
}

export function styleOf(value: unknown): "concise" | "professional" | "detailed" {
  return value === "concise" || value === "detailed" || value === "professional" ? value : "professional";
}

export function autonomyOf(value: unknown): "suggest_only" | "execute_when_allowed" | "fully_autonomous" {
  return value === "suggest_only" || value === "fully_autonomous" || value === "execute_when_allowed" ? value : "execute_when_allowed";
}

export function numberOf(value: unknown, fallback: number, low: number, high: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(low, Math.min(high, number));
}

export function behaviorOf(agent: Agent) {
  return {
    responseStyle: styleOf(agent.responseStyle),
    autonomy: autonomyOf(agent.autonomy),
    temperature: numberOf(agent.temperature, 0.2, 0, 2),
    maxOutput: numberOf(agent.maxOutput, 4000, 1, 128000),
  };
}

export function styleLine(style: "concise" | "professional" | "detailed"): string {
  if (style === "concise") return "Answer briefly.";
  if (style === "detailed") return "Answer with enough detail to be useful.";
  return "Answer in a professional tone.";
}

export function autonomyLine(autonomy: "suggest_only" | "execute_when_allowed" | "fully_autonomous"): string {
  if (autonomy === "suggest_only") return "Do not call tools. Suggest the action instead.";
  if (autonomy === "fully_autonomous") return "Carry out the request with the assigned tools when policy allows.";
  return "Use a tool when it is allowed. Otherwise say what approval is needed.";
}

export function toolCalls(body: Record<string, unknown>): ToolCall[] {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const message = (choices[0] as { message?: { tool_calls?: unknown[] } } | undefined)?.message;
  const calls = message?.tool_calls ?? [];
  return calls.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as { function?: { name?: string; arguments?: string }; thoughtSignature?: string };
    const fn = record.function;
    if (!fn?.name) return [];
    let args: Record<string, unknown> = {};
    try {
      args = fn.arguments ? (JSON.parse(fn.arguments) as Record<string, unknown>) : {};
    } catch {
      args = {};
    }
    return [{ name: fn.name, arguments: args, thoughtSignature: record.thoughtSignature }];
  });
}

export function textOf(body: Record<string, unknown>): string {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const message = (choices[0] as { message?: { content?: string } } | undefined)?.message;
  return message?.content ?? "";
}

export function chatReply(actions: RunAction[]): string {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index];
    if (action.toolId !== "chat" || action.status !== "completed" || !action.result || typeof action.result !== "object") continue;
    const message = (action.result as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "";
}

export function thinkingOf(body: Record<string, unknown>): string {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const message = (choices[0] as { message?: { thinking?: string } } | undefined)?.message;
  return message?.thinking?.trim() ?? "";
}

export function joinThinking(current: string | undefined, next: string): string {
  const extra = next.trim();
  if (!extra) return current ?? "";
  if (!current?.trim()) return extra;
  if (current.includes(extra)) return current;
  return `${current.trim()}\n\n${extra}`;
}

