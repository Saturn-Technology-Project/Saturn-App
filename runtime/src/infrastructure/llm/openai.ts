import OpenAI from "openai";
import { choice, joinThinking, parseArguments, plainMessages, systemText } from "./shared.js";
import type { ChatMessage, ChatRequest, ProviderAdapter, ToolCall } from "./types.js";

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
    const completion = await client(request).chat.completions.create({
      model: request.model,
      messages: toOpenAIMessages(request.messages) as any,
      temperature: request.temperature,
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
    }, { signal: request.signal });
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
    const response = await client(request).responses.create({
      model: request.model,
      instructions: system || undefined,
      input: formattedInput.length ? (formattedInput as any) : "",
      temperature: request.temperature,
      max_output_tokens: request.maxOutput,
      reasoning: { summary: "auto" },
      tools: request.tools.length
        ? request.tools.map((tool) => ({
            type: "function" as const,
            name: tool.function?.name ?? "",
            description: tool.function?.description,
            strict: null,
            parameters: tool.function?.parameters ?? { type: "object", properties: {} },
          }))
        : undefined,
    }, { signal: request.signal });
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
