import OpenAI from "openai";
import { choice, joinThinking, parseArguments, plainMessages, systemText, withOptionalFields } from "./shared.js";
import type { ChatMessage, ChatRequest, Effort, ProviderAdapter, ToolCall } from "./types.js";

/** OpenAI reasoning models (o-series, GPT-5 family): they take a reasoning effort and reject sampling settings. */
function reasons(model: string): boolean {
  return /^(o\d|gpt-5)/i.test(model.replace(/^.*\//, ""));
}

/** The request's effort as OpenAI's reasoning effort: low thinking is "low"; xhigh and max become "high". */
function openAIEffort(request: ChatRequest): "low" | "medium" | "high" | undefined {
  if (request.thinking === "low") return "low";
  const effort: Effort | undefined = request.effort;
  if (!effort) return undefined;
  return effort === "low" || effort === "medium" ? effort : "high";
}

function client(request: ChatRequest): OpenAI {
  return new OpenAI({
    apiKey: request.apiKey || "local",
    baseURL: request.baseUrl.replace(/\/$/, ""),
  });
}

function toOpenAIMessages(messages: ChatMessage[]) {
  return messages.map((item) => {
    if (item.images && item.images.length > 0 && item.role === "user") {
      return {
        role: "user" as const,
        content: [
          { type: "text" as const, text: item.content || "Attached screenshot:" },
          ...item.images.map((img) => ({
            type: "image_url" as const,
            image_url: {
              url: `data:${img.mimeType};base64,${img.base64}`,
            },
          })),
        ],
      };
    }
    let content = item.content;
    if (content.includes("data:image/")) {
      content = content.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]{100,}/g, "[image attached as visual input]");
    }
    return {
      role: item.role,
      content,
    };
  });
}

/** Chat Completions, for OpenAI-compatible servers that are not api.openai.com. */
export const openAIChat: ProviderAdapter = {
  id: "openai-chat",
  async complete(request) {
    // Compatible servers vary: reasoning_effort is sent only when asked for, and dropped if the server rejects it.
    const effort = openAIEffort(request);
    const completion = await withOptionalFields(
      {
        reasoning_effort: { value: effort, rejectedWhen: /reasoning|effort/i },
        temperature: { value: request.temperature, rejectedWhen: /temperature/i },
      },
      (active) => client(request).chat.completions.create({
        model: request.model,
        messages: toOpenAIMessages(request.messages) as any,
        ...(active.temperature !== undefined ? { temperature: active.temperature as number } : {}),
        ...(active.reasoning_effort ? { reasoning_effort: active.reasoning_effort as "low" | "medium" | "high" } : {}),
        max_completion_tokens: request.maxOutput,
        tools: request.tools.length
          ? request.tools.map((tool) => ({
              type: "function" as const,
              function: {
                name: tool.function?.name ?? "",
                description: tool.function?.description,
                parameters: tool.function?.parameters,
              },
            }))
          : undefined,
      }, { signal: request.signal }),
    );
    const message = completion.choices[0]?.message as {
      content?: string | null;
      thinking?: string;
      reasoning_content?: string;
      reasoning?: unknown;
      tool_calls?: typeof completion.choices[0]["message"]["tool_calls"];
    } | undefined;
    const calls = (message?.tool_calls ?? []).flatMap((call) => {
      if (call.type !== "function") return [];
      return [{ name: call.function.name, arguments: parseArguments(call.function.arguments) }];
    });
    return choice(message?.content ?? "", calls, chatThinking(message), {
      input: completion.usage?.prompt_tokens,
      output: completion.usage?.completion_tokens,
    });
  },
};

/** Responses API, for api.openai.com, which returns reasoning summaries. */
export const openAIResponses: ProviderAdapter = {
  id: "openai-responses",
  async complete(request) {
    const system = systemText(request.messages);
    const inputMessages = request.messages.filter((item) => item.role !== "system");
    const formattedInput = inputMessages.map((item) => {
      if (item.images && item.images.length > 0 && item.role === "user") {
        return {
          role: "user" as const,
          content: [
            { type: "input_text" as const, text: item.content || "Attached screenshot:" },
            ...item.images.map((img) => ({
              type: "input_image" as const,
              image_url: `data:${img.mimeType};base64,${img.base64}`,
            })),
          ],
        };
      }
      let content = item.content;
      if (content.includes("data:image/")) {
        content = content.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]{100,}/g, "[image attached as visual input]");
      }
      return { role: item.role, content };
    });
    // Reasoning models get a reasoning effort (and a summary of their reasoning) and no temperature; other
    // models the reverse. A model that rejects either is retried without it.
    const reasoning = reasons(request.model);
    const effort = openAIEffort(request);
    const response = await withOptionalFields(
      {
        reasoning: { value: reasoning ? { summary: "auto", ...(effort ? { effort } : {}) } : undefined, rejectedWhen: /reasoning|effort|summary/i },
        temperature: { value: reasoning ? undefined : request.temperature, rejectedWhen: /temperature/i },
      },
      (active) => client(request).responses.create({
        model: request.model,
        instructions: system || undefined,
        input: formattedInput.length ? (formattedInput as any) : "",
        ...(active.temperature !== undefined ? { temperature: active.temperature as number } : {}),
        max_output_tokens: request.maxOutput,
        ...(active.reasoning ? { reasoning: active.reasoning as { summary: "auto"; effort?: "low" | "medium" | "high" } } : {}),
        tools: request.tools.length
          ? request.tools.map((tool) => ({
              type: "function" as const,
              name: tool.function?.name ?? "",
              description: tool.function?.description,
              strict: null,
              parameters: tool.function?.parameters ?? { type: "object", properties: {} },
            }))
          : undefined,
      }, { signal: request.signal }),
    );
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
        calls.push({ name: item.name, arguments: parseArguments(item.arguments) });
      }
    }
    return choice(texts.join(""), calls, thoughts.join("\n\n"), {
      input: response.usage?.input_tokens,
      output: response.usage?.output_tokens,
    });
  },
};

export function isOfficialOpenAI(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

function chatThinking(message: { thinking?: string; reasoning_content?: string; reasoning?: unknown } | undefined): string {
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
