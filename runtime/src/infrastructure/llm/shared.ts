import type { ChatMessage, Replay, TokenUsage, ToolCall } from "./types.js";

/** Asks the model to go on after tool results sent as text (the format before native tool turns). */
export const CONTINUE_AFTER_TOOLS = "Continue from the tool results above: use more tools if the task needs them, otherwise give your answer.";

/**
 * Native tool turns (an assistant turn with toolCalls, then "tool" results) as text, the way every provider read
 * them before: the calls with their results as a JSON list in an assistant turn, then a user turn asking to go on
 * (with any screenshots). For providers, or rounds, that cannot be sent natively; `keep` leaves a round native.
 */
export function flattenToolTurns(messages: ChatMessage[], keep: (assistant: ChatMessage) => boolean = () => false): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role === "tool") continue;
    if (message.role !== "assistant" || !message.toolCalls?.length || keep(message)) {
      out.push(message);
      if (message.role === "assistant" && message.toolCalls?.length) while (messages[i + 1]?.role === "tool") out.push(messages[++i]!);
      continue;
    }
    const results: ChatMessage[] = [];
    while (messages[i + 1]?.role === "tool") results.push(messages[++i]!);
    const steps = message.toolCalls.map((call) => {
      const answer = results.find((item) => item.toolCallId === call.id);
      let outcome: Record<string, unknown> = {};
      try {
        outcome = answer ? (JSON.parse(answer.content) as Record<string, unknown>) : {};
      } catch {
        outcome = { result: answer?.content };
      }
      return { toolId: call.name, arguments: call.arguments, ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}), ...outcome };
    });
    out.push({ role: "assistant", content: JSON.stringify(steps), reasoning: message.reasoning });
    const images = results.flatMap((item) => item.images ?? []);
    out.push(images.length
      ? { role: "user", content: "Observation from computer_screenshot (attached as multimodal image input):", images }
      : { role: "user", content: CONTINUE_AFTER_TOOLS });
  }
  return out;
}

/** Wraps a provider reply in the OpenAI chat-completion shape the run loop reads; `replay` rides along for the next request. */
export function choice(content: string, calls: ToolCall[], thinking = "", usage?: TokenUsage, replay?: Replay): Record<string, unknown> {
  const visible = splitThinkTags(content);
  return {
    usage: { input_tokens: usage?.input, output_tokens: usage?.output, ...(usage?.cached ? { cached_input_tokens: usage.cached } : {}), ...(usage?.cacheWrite ? { cache_write_input_tokens: usage.cacheWrite } : {}) },
    choices: [
      {
        message: {
          content: visible.content,
          thinking: joinThinking(thinking, visible.thinking),
          tool_calls: calls.map((call) => ({
            ...(call.id ? { id: call.id } : {}),
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
          })),
          ...(replay ? { replay } : {}),
        },
      },
    ],
  };
}

export function joinThinking(current: string, next: string): string {
  const extra = next.trim();
  if (!extra) return current.trim();
  if (!current.trim()) return extra;
  if (current.includes(extra)) return current.trim();
  return `${current.trim()}\n\n${extra}`;
}

function splitThinkTags(content: string): { content: string; thinking: string } {
  const thoughts: string[] = [];
  const visible = content.replace(/<think>([\s\S]*?)<\/think>/gi, (_match, body: string) => {
    const text = body.trim();
    if (text) thoughts.push(text);
    return "";
  })
    // Blank lines and trailing space go, but not the first line's indent: code completions depend on it.
    .replace(/^\s*\n/, "")
    .trimEnd();
  return { content: visible, thinking: thoughts.join("\n\n") };
}

export function untilAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Sends a request with optional fields, dropping any one the provider rejects and trying again: a model that does
 * not support an effort or reasoning setting still answers, without it. Only 400/422 answers naming the field count.
 */
export async function withOptionalFields<T>(
  fields: Record<string, { value: unknown; rejectedWhen: RegExp }>,
  send: (active: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  const active: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    if (field.value !== undefined) active[key] = field.value;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return await send(active);
    } catch (error) {
      const status = (error as { status?: number }).status;
      const message = error instanceof Error ? error.message : String(error);
      const rejected = Object.keys(active).find((key) => fields[key]!.rejectedWhen.test(message));
      if (!rejected || (status !== undefined && status !== 400 && status !== 422) || attempt >= Object.keys(fields).length) throw error;
      delete active[rejected];
    }
  }
}

export function mentionsThinking(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /thinking|thought|reasoning/i.test(message);
}

export function parseArguments(raw: string | undefined): Record<string, unknown> {
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Drops fields a provider does not know, so strict OpenAI-compatible servers do not reject the request. */
export function plainMessages(messages: ChatMessage[]): { role: ChatMessage["role"]; content: string }[] {
  return messages.map((item) => {
    let content = item.content;
    if (content.includes("data:image/")) {
      content = content.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]{100,}/g, "[image attached as visual input]");
    }
    return { role: item.role, content };
  });
}

export function systemText(messages: { role: string; content: string }[]): string {
  return messages.filter((item) => item.role === "system").map((item) => item.content).join("\n");
}

type JsonSchema = Record<string, unknown>;
const COMBINATORS = ["allOf", "anyOf", "oneOf"] as const;

/**
 * A tool's parameters as an input schema Anthropic accepts: an object schema with no oneOf, anyOf or allOf at
 * the top level (Anthropic rejects the whole request otherwise; built-in and MCP tools use them to say "give one
 * of these"). allOf branches are merged in; oneOf/anyOf branches add their properties, and the choice they
 * expressed moves into `note`, for the tool description. Nested combinators are left alone.
 */
export function flatInputSchema(parameters: JsonSchema | undefined): { schema: JsonSchema; note?: string } {
  const source: JsonSchema = { ...(parameters ?? {}) };
  if (!COMBINATORS.some((key) => Array.isArray(source[key]))) return { schema: { ...source, type: "object" } };
  const properties: JsonSchema = { ...((source.properties as JsonSchema | undefined) ?? {}) };
  const required = new Set<string>(Array.isArray(source.required) ? (source.required as string[]) : []);
  const notes: string[] = [];
  const branches = (key: (typeof COMBINATORS)[number]) => (Array.isArray(source[key]) ? (source[key] as JsonSchema[]) : []);
  const addProperties = (branch: JsonSchema) => {
    for (const [name, value] of Object.entries((branch.properties as JsonSchema | undefined) ?? {})) properties[name] ??= value;
  };
  for (const branch of branches("allOf")) {
    addProperties(branch);
    for (const name of Array.isArray(branch.required) ? (branch.required as string[]) : []) required.add(name);
  }
  for (const key of ["oneOf", "anyOf"] as const) {
    const options = branches(key);
    if (!options.length) continue;
    options.forEach(addProperties);
    const choices = options.map((branch) => (Array.isArray(branch.required) && branch.required.length ? (branch.required as string[]).join(" + ") : null));
    if (choices.every(Boolean)) notes.push(`${key === "oneOf" ? "Give exactly one of" : "Give at least one of"}: ${choices.join(", ")}.`);
  }
  const schema: JsonSchema = { ...source, type: "object", properties };
  for (const key of COMBINATORS) delete schema[key];
  if (required.size) schema.required = [...required];
  else delete schema.required;
  return { schema, ...(notes.length ? { note: notes.join(" ") } : {}) };
}

const TRANSIENT_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNABORTED", "EPIPE", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * A failure worth trying again: the connection dropped or timed out, or the provider is rate limiting or briefly
 * down. A bad key, a rejected request or a stopped run is not. Looks through `cause` chains (fetch wraps errors).
 */
export function isTransient(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    const failed = current as { name?: string; code?: unknown; status?: unknown; message?: unknown; cause?: unknown };
    if (failed.name === "AbortError") return false;
    if (typeof failed.code === "string" && TRANSIENT_CODES.has(failed.code)) return true;
    const status = typeof failed.status === "number" ? failed.status : typeof failed.code === "number" ? failed.code : undefined;
    if (status !== undefined) return TRANSIENT_STATUS.has(status);
    const message = typeof failed.message === "string" ? failed.message : "";
    if (/\b(ETIMEDOUT|ECONNRESET|EAI_AGAIN)\b|socket hang up|fetch failed|network (?:error|timeout)|\b(?:429|500|502|503|504)\b.*(?:unavailable|overloaded|exhausted|internal|gateway|timeout)/i.test(message)) return true;
    current = failed.cause;
  }
  return false;
}

/** The wait a failed request's Retry-After header asks for (seconds or an HTTP date), in ms. */
export function retryAfterMs(error: unknown, now = Date.now()): number | undefined {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    const failed = current as { headers?: unknown; response?: { headers?: unknown }; cause?: unknown };
    const headers = failed.headers ?? failed.response?.headers;
    const value = headers instanceof Headers ? headers.get("retry-after") : headers && typeof headers === "object" ? (headers as Record<string, unknown>)["retry-after"] ?? (headers as Record<string, unknown>)["Retry-After"] : undefined;
    if (typeof value === "string" || typeof value === "number") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
      const date = Date.parse(String(value));
      if (Number.isFinite(date)) return Math.max(0, date - now);
    }
    current = failed.cause;
  }
  return undefined;
}

/**
 * Runs `send`, trying again (up to `retries` more times, waiting 1 s, then 3 s…) when it fails transiently. For
 * providers whose SDK has no retries of its own; a stopped run is never retried.
 */
export async function withTransientRetry<T>(
  send: () => Promise<T>,
  options: { signal?: AbortSignal; retries?: number; delayMs?: number; onRetry?: (error: unknown, attempt: number) => void } = {},
): Promise<T> {
  const retries = options.retries ?? 2;
  const delayMs = options.delayMs ?? 1000;
  const MAX_RETRY_AFTER_MS = 30_000;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      if (attempt >= retries || options.signal?.aborted || !isTransient(error)) throw error;
      options.onRetry?.(error, attempt + 1);
      await new Promise<void>((resolve) => {
        // A provider that says when to come back (Retry-After on a 429 or 503) is believed, up to 30 s.
        const asked = retryAfterMs(error);
        const timer = setTimeout(resolve, asked !== undefined ? Math.min(asked, MAX_RETRY_AFTER_MS) : delayMs * (attempt === 0 ? 1 : 3 ** attempt));
        options.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      if (options.signal?.aborted) throw error;
    }
  }
}
