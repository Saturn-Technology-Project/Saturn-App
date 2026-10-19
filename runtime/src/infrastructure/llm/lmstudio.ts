import { LMStudioClient } from "@lmstudio/sdk";
import { choice, plainMessages, untilAbort } from "./shared.js";
import type { ProviderAdapter } from "./types.js";

function socket(baseUrl: string): string {
  if (baseUrl.startsWith("ws://") || baseUrl.startsWith("wss://")) return baseUrl.replace(/\/$/, "");
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
}

/** LM Studio runs locally and does not take tool definitions here. */
export const lmStudio: ProviderAdapter = {
  id: "lmstudio",
  async complete(request) {
    const client = new LMStudioClient({
      baseUrl: socket(request.baseUrl),
      apiToken: request.apiKey || undefined,
    });
    try {
      const model = await client.llm.model(request.model);
      const result = await untilAbort(model.respond(plainMessages(request.messages), {
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
