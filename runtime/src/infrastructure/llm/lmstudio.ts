import { openAIChat } from "./openai.js";
import { flattenToolTurns } from "./shared.js";
import type { ChatMessage, ProviderAdapter, RawRequest } from "./types.js";

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
 * LM Studio, through its OpenAI-compatible endpoints: Chat Completions takes tool definitions, images and returns the
 * reasoning of thinking models; /completions serves raw completions for Tab. (Its own SDK pins zod 3, which has an
 * advisory with no zod 3 fix.)
 */
export const lmStudio: ProviderAdapter = {
  id: "lmstudio",
  completeRaw: lmStudioRaw,
  async complete(request) {
    // Local models' chat templates vary in how (and whether) they take tool turns: they get them as text.
    return openAIChat.complete({
      ...request,
      messages: alternating(flattenToolTurns(request.messages)),
      baseUrl: openAICompatibleUrl(request.baseUrl),
      apiKey: request.apiKey || "lm-studio",
      temperature: request.temperature === undefined ? undefined : Math.min(1, request.temperature),
      effort: undefined,
    });
  },
};

/** The model's raw completion of `prompt`, fragment by fragment, streamed from /v1/completions. */
export async function* lmStudioRaw(request: RawRequest): AsyncIterable<string> {
  const response = await fetch(`${openAICompatibleUrl(request.baseUrl)}/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {}) },
    body: JSON.stringify({
      model: request.model,
      prompt: request.prompt,
      max_tokens: request.maxOutput,
      stop: request.stops,
      temperature: request.temperature === undefined ? undefined : Math.min(1, request.temperature),
      stream: true,
    }),
    signal: request.signal,
  });
  if (!response.ok || !response.body) throw new Error(`LM Studio answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const data = line.replace(/^data:\s*/, "").trim();
        if (!line.startsWith("data:") || !data) continue;
        if (data === "[DONE]") return;
        const text = (JSON.parse(data) as { choices?: { text?: string }[] }).choices?.[0]?.text;
        if (text) yield text;
      }
    }
  } catch (error) {
    if (request.signal?.aborted) return;
    throw error;
  }
}

/**
 * The language models downloaded in LM Studio: its REST API (/api/v0/models) tells them apart from embedding models;
 * older versions only serve /v1/models.
 */
export async function listLmStudioModels(baseUrl: string): Promise<{ id: string; label: string }[]> {
  const root = openAICompatibleUrl(baseUrl).replace(/\/v1$/, "");
  const signal = AbortSignal.timeout(4000);
  const get = async (url: string) => {
    try {
      const response = await fetch(url, { signal });
      return response.ok ? ((await response.json()) as { data?: { id: string; type?: string }[] }).data : undefined;
    } catch {
      throw new Error("LM Studio is not running");
    }
  };
  const models = (await get(`${root}/api/v0/models`))?.filter((item) => item.type === "llm" || item.type === "vlm")
    ?? (await get(`${root}/v1/models`))?.filter((item) => !/embed/i.test(item.id))
    ?? [];
  return models.map((item) => ({ id: item.id, label: item.id }));
}
