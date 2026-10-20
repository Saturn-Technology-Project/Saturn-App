import type { ChatMessage, TokenUsage, ToolCall } from "./types.js";

/** Wraps a provider reply in the OpenAI chat-completion shape the run loop reads. */
export function choice(content: string, calls: ToolCall[], thinking = "", usage?: TokenUsage): Record<string, unknown> {
  const visible = splitThinkTags(content);
  return {
    usage: { input_tokens: usage?.input, output_tokens: usage?.output },
    choices: [
      {
        message: {
          content: visible.content,
          thinking: joinThinking(thinking, visible.thinking),
          tool_calls: calls.map((call) => ({
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
          })),
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
