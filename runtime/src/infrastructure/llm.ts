import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { LMStudioClient } from "@lmstudio/sdk";
import OpenAI from "openai";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown> } };
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

export function geminiContents(messages: ChatMessage[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  for (const item of messages) {
    if (item.role === "system") continue;
    const actions = item.role === "assistant" ? toolResultActions(item.content) : null;
    if (actions) {
      contents.push({
        role: "model",
        parts: actions.map((action) => ({
          functionCall: { name: action.toolId, args: action.arguments },
          ...(action.thoughtSignature ? { thoughtSignature: action.thoughtSignature } : {}),
        })),
      });
      contents.push({
        role: "user",
        parts: actions.map((action) => ({
          functionResponse: { name: action.toolId, response: functionResponseBody(action) },
        })),
      });
      continue;
    }
    const role = item.role === "assistant" ? "model" : "user";
    const text = item.content.trim() ? item.content : " ";
    const last = contents[contents.length - 1];
    if (last?.role === role && last.parts.every((part) => "text" in part)) {
      last.parts.push({ text });
      continue;
    }
    contents.push({ role, parts: [{ text }] });
  }
  if (contents.length && contents[contents.length - 1].role === "model") {
    contents.push({ role: "user", parts: [{ text: "Continue." }] });
  }
  return contents;
}

function toolResultActions(content: string): { toolId: string; arguments: Record<string, unknown>; status?: string; result?: unknown; reason?: string; thoughtSignature?: string }[] | null {
  const text = content.trim();
  if (!text.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed) || !parsed.length) return null;
    const actions = parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as { toolId?: unknown; arguments?: unknown; status?: unknown; result?: unknown; reason?: unknown; thoughtSignature?: unknown };
      if (typeof record.toolId !== "string" || !record.toolId) return [];
      const args = record.arguments && typeof record.arguments === "object" && !Array.isArray(record.arguments)
        ? record.arguments as Record<string, unknown>
        : {};
      return [{
        toolId: record.toolId,
        arguments: args,
        status: typeof record.status === "string" ? record.status : undefined,
        result: record.result,
        reason: typeof record.reason === "string" ? record.reason : undefined,
        thoughtSignature: typeof record.thoughtSignature === "string" ? record.thoughtSignature : undefined,
      }];
    });
    return actions.length === parsed.length ? actions : null;
  } catch {
    return null;
  }
}

function functionResponseBody(action: { status?: string; result?: unknown; reason?: string }): Record<string, unknown> {
  const payload = action.result === undefined
    ? { status: action.status ?? "completed", reason: action.reason ?? "" }
    : action.result;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  }
  return { result: payload ?? null };
}
type ToolDef = {
  type?: string;
  function?: { name?: string; description?: string; parameters?: Record<string, unknown> };
};

type ToolCall = { name: string; arguments: Record<string, unknown>; thoughtSignature?: string };

function choice(content: string, calls: ToolCall[], thinking = ""): Record<string, unknown> {
  const visible = splitThinkTags(content);
  return {
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

function joinThinking(current: string, next: string): string {
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
  }).trim();
  return { content: visible, thinking: thoughts.join("\n\n") };
}

function untilAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
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

function isOfficialOpenAI(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

function mentionsThinking(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /thinking|thought|reasoning/i.test(message);
}

function toolsOf(tools: unknown[]): ToolDef[] {
  return tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object") return [];
    const fn = (tool as ToolDef).function;
    if (!fn?.name) return [];
    return [{ function: fn }];
  });
}

function lmStudioSocket(baseUrl: string): string {
  if (baseUrl.startsWith("ws://") || baseUrl.startsWith("wss://")) return baseUrl.replace(/\/$/, "");
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
}

export async function listLmStudioModels(baseUrl: string): Promise<{ id: string; label: string }[]> {
  const client = new LMStudioClient({ baseUrl: lmStudioSocket(baseUrl) });
  try {
    const models = await Promise.race([
      client.system.listDownloadedModels("llm"),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("LM Studio is not running")), 4000);
        timer.unref();
      }),
    ]);
    return models.map((item) => ({ id: item.modelKey, label: item.displayName || item.modelKey }));
  } finally {
    void client[Symbol.asyncDispose]().catch(() => undefined);
  }
}

export async function completeChat(input: {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  messages: ChatMessage[];
  tools: unknown[];
  temperature?: number;
  maxOutput?: number;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const tools = toolsOf(input.tools);
  if (input.provider === "claude") return completeClaude(input, tools);
  if (input.provider === "gemini") return completeGemini(input, tools);
  if (input.provider === "lmstudio") return completeLmStudio(input);
  if (isOfficialOpenAI(input.baseUrl)) return completeOpenAIResponses(input, tools);
  return completeOpenAI(input, tools);
}

async function completeOpenAI(
  input: { model: string; baseUrl: string; apiKey?: string; messages: ChatMessage[]; temperature?: number; maxOutput?: number; signal?: AbortSignal },
  tools: ToolDef[],
): Promise<Record<string, unknown>> {
  const client = new OpenAI({
    apiKey: input.apiKey || "local",
    baseURL: input.baseUrl.replace(/\/$/, ""),
  });
  const completion = await client.chat.completions.create({
    model: input.model,
    messages: input.messages,
    temperature: input.temperature,
    max_completion_tokens: input.maxOutput,
    tools: tools.length
      ? tools.map((tool) => ({
          type: "function" as const,
          function: {
            name: tool.function?.name ?? "",
            description: tool.function?.description,
            parameters: tool.function?.parameters,
          },
        }))
      : undefined,
  }, { signal: input.signal });
  const message = completion.choices[0]?.message as {
    content?: string | null;
    thinking?: string;
    reasoning_content?: string;
    reasoning?: unknown;
    tool_calls?: typeof completion.choices[0]["message"]["tool_calls"];
  } | undefined;
  const calls = (message?.tool_calls ?? []).flatMap((call) => {
    if (call.type !== "function") return [];
    let args: Record<string, unknown> = {};
    try {
      args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
    } catch {
      args = {};
    }
    return [{ name: call.function.name, arguments: args }];
  });
  return choice(message?.content ?? "", calls, openAIThinking(message));
}

function openAIThinking(message: { thinking?: string; reasoning_content?: string; reasoning?: unknown } | undefined): string {
  if (!message) return "";
  const pieces = [message.thinking, message.reasoning_content, reasoningText(message.reasoning)];
  return pieces.filter((item): item is string => Boolean(item && item.trim())).join("\n\n");
}

function reasoningText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return "";
  const record = value as { content?: { text?: string }[]; summary?: { text?: string }[] };
  const full = (record.content ?? []).map((item) => item.text ?? "").filter(Boolean).join("\n\n");
  const summary = (record.summary ?? []).map((item) => item.text ?? "").filter(Boolean).join("\n\n");
  return joinThinking(full, summary);
}

async function completeOpenAIResponses(
  input: { model: string; baseUrl: string; apiKey?: string; messages: ChatMessage[]; temperature?: number; maxOutput?: number; signal?: AbortSignal },
  tools: ToolDef[],
): Promise<Record<string, unknown>> {
  const client = new OpenAI({
    apiKey: input.apiKey || "local",
    baseURL: input.baseUrl.replace(/\/$/, ""),
  });
  const system = input.messages.filter((item) => item.role === "system").map((item) => item.content).join("\n");
  const inputMessages = input.messages.filter((item) => item.role !== "system");
  const response = await client.responses.create({
    model: input.model,
    instructions: system || undefined,
    input: inputMessages.length
      ? inputMessages.map((item) => ({ role: item.role, content: item.content }))
      : "",
    temperature: input.temperature,
    max_output_tokens: input.maxOutput,
    reasoning: { summary: "auto" },
    tools: tools.length
      ? tools.map((tool) => ({
          type: "function" as const,
          name: tool.function?.name ?? "",
          description: tool.function?.description,
          strict: null,
          parameters: tool.function?.parameters ?? { type: "object", properties: {} },
        }))
      : undefined,
  }, { signal: input.signal });
  const thoughts: string[] = [];
  const texts: string[] = [];
  const calls: ToolCall[] = [];
  for (const item of response.output) {
    if (item.type === "reasoning") {
      const text = reasoningText(item);
      if (text) thoughts.push(text);
    } else if (item.type === "message") {
      texts.push(item.content.filter((part) => part.type === "output_text").map((part) => part.text).join(""));
    } else if (item.type === "function_call") {
      let args: Record<string, unknown> = {};
      try {
        args = item.arguments ? (JSON.parse(item.arguments) as Record<string, unknown>) : {};
      } catch {
        args = {};
      }
      calls.push({ name: item.name, arguments: args });
    }
  }
  return choice(texts.join(""), calls, thoughts.join("\n\n"));
}

async function completeClaude(
  input: { model: string; apiKey?: string; messages: ChatMessage[]; temperature?: number; maxOutput?: number; signal?: AbortSignal },
  tools: ToolDef[],
): Promise<Record<string, unknown>> {
  if (!input.apiKey) throw new Error("Claude API key is required");
  const client = new Anthropic({ apiKey: input.apiKey });
  const system = input.messages.filter((item) => item.role === "system").map((item) => item.content).join("\n");
  const messages = input.messages
    .filter((item) => item.role !== "system")
    .map((item) => ({ role: item.role as "user" | "assistant", content: item.content }));
  const request = (thinking: boolean) => client.messages.create({
    model: input.model,
    max_tokens: input.maxOutput ?? 4096,
    temperature: thinking ? undefined : input.temperature,
    thinking: thinking ? { type: "adaptive", display: "summarized" } : undefined,
    system: system || undefined,
    messages: messages.length ? messages : [{ role: "user", content: "" }],
    tools: tools.length
      ? tools.map((tool) => ({
          name: tool.function?.name ?? "",
          description: tool.function?.description,
          input_schema: {
            type: "object" as const,
            ...(tool.function?.parameters ?? {}),
          },
        }))
      : undefined,
  }, { signal: input.signal });
  let response: Awaited<ReturnType<typeof request>>;
  try {
    response = await request(true);
  } catch (error) {
    if (!mentionsThinking(error)) throw error;
    response = await request(false);
  }
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const thinking = response.content
    .filter((block) => block.type === "thinking")
    .map((block) => block.thinking)
    .join("\n\n");
  const calls = response.content.flatMap((block) => {
    if (block.type !== "tool_use") return [];
    const args = block.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {};
    return [{ name: block.name, arguments: args }];
  });
  return choice(text, calls, thinking);
}

async function completeGemini(
  input: { model: string; apiKey?: string; messages: ChatMessage[]; temperature?: number; maxOutput?: number; signal?: AbortSignal },
  tools: ToolDef[],
): Promise<Record<string, unknown>> {
  if (!input.apiKey) throw new Error("Gemini API key is required");
  const ai = new GoogleGenAI({ apiKey: input.apiKey });
  const system = input.messages.filter((item) => item.role === "system").map((item) => item.content).join("\n");
  const contents = geminiContents(input.messages);
  const request = (includeThoughts: boolean) => ai.models.generateContent({
    model: input.model,
    contents: contents.length ? contents : [{ role: "user", parts: [{ text: "" }] }],
    config: {
      systemInstruction: system || undefined,
      temperature: input.temperature,
      maxOutputTokens: input.maxOutput,
      abortSignal: input.signal,
      thinkingConfig: includeThoughts ? { includeThoughts: true } : undefined,
      tools: tools.length
        ? [{
            functionDeclarations: tools.map((tool) => ({
              name: tool.function?.name ?? "",
              description: tool.function?.description,
              parameters: tool.function?.parameters,
            })),
          }]
        : undefined,
    },
  });
  let response: Awaited<ReturnType<typeof request>>;
  try {
    response = await request(true);
  } catch (error) {
    if (!mentionsThinking(error)) throw error;
    response = await request(false);
  }
  const thoughts = (response.candidates?.[0]?.content?.parts ?? [])
    .flatMap((part) => (part.thought && part.text ? [part.text] : []))
    .join("\n\n");
  const calls = (response.candidates?.[0]?.content?.parts ?? []).flatMap((part) => {
    const call = part.functionCall;
    if (!call?.name) return [];
    const args = call.args && typeof call.args === "object" ? call.args : {};
    return [{ name: call.name, arguments: args, thoughtSignature: part.thoughtSignature }];
  });
  return choice(response.text ?? "", calls, thoughts);
}

async function completeLmStudio(input: {
  model: string;
  baseUrl: string;
  apiKey?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxOutput?: number;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const client = new LMStudioClient({
    baseUrl: lmStudioSocket(input.baseUrl),
    apiToken: input.apiKey || undefined,
  });
  try {
    const model = await client.llm.model(input.model);
    const result = await untilAbort(model.respond(input.messages, {
      temperature: input.temperature === undefined ? undefined : Math.min(1, input.temperature),
      maxTokens: input.maxOutput,
    }).result(), input.signal);
    const reasoning = "reasoningContent" in result ? String(result.reasoningContent ?? "") : "";
    const visible = "nonReasoningContent" in result && result.nonReasoningContent
      ? result.nonReasoningContent
      : result.content;
    return choice(visible, [], reasoning);
  } finally {
    void client[Symbol.asyncDispose]().catch(() => undefined);
  }
}
