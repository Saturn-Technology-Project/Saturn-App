import { LMStudioClient } from "@lmstudio/sdk";
import { openAIChat } from "./openai.js";
import { choice, plainMessages, untilAbort, flattenToolTurns } from "./shared.js";
import type { ChatMessage, ProviderAdapter, RawRequest } from "./types.js";

function socket(baseUrl: string): string {
  if (baseUrl.startsWith("ws://") || baseUrl.startsWith("wss://")) return baseUrl.replace(/\/$/, "");
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
}

/**
 * The conversation for LM Studio, with each message's images uploaded as file handles (a vision model sees
 * them; LM Studio answers with an error naming the model when the loaded one cannot).
 */
async function withImages(client: LMStudioClient, messages: ChatMessage[]) {
  // Tool turns arrive flattened to text (see complete), so only user, assistant and system remain.
  const plain = plainMessages(messages) as { role: "user" | "assistant" | "system"; content: string }[];
  return await Promise.all(plain.map(async (message, index) => {
    const images = messages[index]?.images;
    if (!images?.length || message.role !== "user") return message;
    const handles = await Promise.all(images.map((image, n) => client.files.prepareImageBase64(`image-${index}-${n}.${image.mimeType.split("/")[1] || "png"}`, image.base64)));
    return { ...message, images: handles };
  }));
}

/**
 * The conversation with consecutive turns of the same role merged, and a user turn first after the system prompt:
 * some models' chat templates (Mistral's, for one) reject anything but strict user/assistant alternation.
 */
export function alternating(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role !== "system" && !message.content.trim() && !message.images?.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === message.role && message.role !== "system") {
      out[out.length - 1] = {
        ...last,
        content: [last.content, message.content].filter((part) => part.trim()).join("\n\n"),
        ...(last.images?.length || message.images?.length ? { images: [...(last.images ?? []), ...(message.images ?? [])] } : {}),
      };
      continue;
    }
    if (message.role === "assistant" && (!last || last.role === "system")) out.push({ role: "user", content: "(continuing the conversation)" });
    out.push(message);
  }
  return out;
}

/** LM Studio's OpenAI-compatible endpoint (http://host:port/v1) for a connection saved as http://host:port. */
export function openAICompatibleUrl(baseUrl: string): string {
  const url = new URL(baseUrl.replace(/^ws(s?):/, "http$1:"));
  const pathname = url.pathname.replace(/\/$/, "");
  url.pathname = pathname.endsWith("/v1") ? pathname : `${pathname}/v1`;
  return url.toString().replace(/\/$/, "");
}

/**
 * LM Studio. A turn with tools goes to its OpenAI-compatible Chat Completions endpoint, which takes tool definitions
 * and returns tool calls for models trained for them (the SDK's respond() takes none, so agents could only talk).
 * Turns without tools, and raw completions for Tab, use the LM Studio SDK.
 */
export const lmStudio: ProviderAdapter = {
  id: "lmstudio",
  completeRaw: lmStudioRaw,
  async complete(request) {
    // Local models' chat templates vary in how (and whether) they take tool turns: they get them as text.
    request = { ...request, messages: flattenToolTurns(request.messages) };
    if (request.tools.length > 0) {
      return openAIChat.complete({ ...request, messages: alternating(request.messages), baseUrl: openAICompatibleUrl(request.baseUrl), apiKey: request.apiKey || "lm-studio", effort: undefined });
    }
    const client = new LMStudioClient({
      baseUrl: socket(request.baseUrl),
      apiToken: request.apiKey || undefined,
    });
    try {
      const model = await client.llm.model(request.model);
      const result = await untilAbort(model.respond(await withImages(client, request.messages), {
        temperature: request.temperature === undefined ? undefined : Math.min(1, request.temperature),
        maxTokens: request.maxOutput,
      }).result(), request.signal);
      const reasoning = "reasoningContent" in result ? String(result.reasoningContent ?? "") : "";
      const visible = "nonReasoningContent" in result && result.nonReasoningContent
        ? result.nonReasoningContent
        : result.content;
      return choice(visible, [], reasoning, {
        input: result.stats.promptTokensCount,
        output: result.stats.predictedTokensCount,
      });
    } finally {
      void client[Symbol.asyncDispose]().catch(() => undefined);
    }
  },
};

/** The model's raw completion of `prompt`, fragment by fragment. */
export async function* lmStudioRaw(request: RawRequest): AsyncIterable<string> {
  const client = new LMStudioClient({ baseUrl: socket(request.baseUrl), apiToken: request.apiKey || undefined });
  try {
    const model = await client.llm.model(request.model);
    const prediction = model.complete(request.prompt, {
      maxTokens: request.maxOutput,
      stopStrings: request.stops,
      temperature: request.temperature === undefined ? undefined : Math.min(1, request.temperature),
    });
    request.signal?.addEventListener("abort", () => prediction.cancel(), { once: true });
    for await (const fragment of prediction) {
      if (request.signal?.aborted) return;
      if (fragment.content) yield fragment.content;
    }
  } finally {
    void client[Symbol.asyncDispose]().catch(() => undefined);
  }
}

export async function listLmStudioModels(baseUrl: string): Promise<{ id: string; label: string }[]> {
  const client = new LMStudioClient({ baseUrl: socket(baseUrl) });
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
