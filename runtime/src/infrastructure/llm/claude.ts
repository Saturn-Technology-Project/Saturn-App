import Anthropic from "@anthropic-ai/sdk";
import { choice, mentionsThinking, systemText } from "./shared.js";
import type { ProviderAdapter } from "./types.js";

export const claude: ProviderAdapter = {
  id: "claude",
  async complete(request) {
    if (!request.apiKey) throw new Error("Claude API key is required");
    const client = new Anthropic({ apiKey: request.apiKey });
    const system = systemText(request.messages);
    const messages = request.messages
      .filter((item) => item.role !== "system")
      .map((item) => {
        if (item.images && item.images.length > 0 && item.role === "user") {
          return {
            role: "user" as const,
            content: [
              { type: "text" as const, text: item.content || "Attached screenshot:" },
              ...item.images.map((img) => ({
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: (img.mimeType === "image/png" || img.mimeType === "image/jpeg" || img.mimeType === "image/webp" || img.mimeType === "image/gif")
                    ? (img.mimeType as "image/png" | "image/jpeg" | "image/webp" | "image/gif")
                    : ("image/jpeg" as const),
                  data: img.base64,
                },
              })),
            ],
          };
        }
        let content = item.content;
        if (content.includes("data:image/")) {
          content = content.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]{100,}/g, "[image attached as visual input]");
        }
        return { role: item.role as "user" | "assistant", content };
      });
    const send = (thinking: boolean) => client.messages.create({
      model: request.model,
      max_tokens: request.maxOutput ?? 4096,
      temperature: thinking ? undefined : request.temperature,
      thinking: thinking ? { type: "adaptive", display: "summarized" } : undefined,
      system: system || undefined,
      // Automatic prompt caching: the system prompt, tools and earlier turns are read from cache on every
      // later round of a run (and after a computer_wait resumes within the cache lifetime).
      cache_control: { type: "ephemeral" },
      messages: messages.length ? messages : [{ role: "user", content: "" }],
      tools: request.tools.length
        ? request.tools.map((tool) => ({
            name: tool.function?.name ?? "",
            description: tool.function?.description,
            input_schema: {
              type: "object" as const,
              ...(tool.function?.parameters ?? {}),
            },
          }))
        : undefined,
    }, { signal: request.signal });
    let response: Awaited<ReturnType<typeof send>>;
    try {
      response = await send(true);
    } catch (error) {
      if (!mentionsThinking(error)) throw error;
      response = await send(false);
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
    return choice(text, calls, thinking, {
      // input_tokens excludes cached tokens; count every prompt token so usage stays comparable across providers.
      input: response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0) + (response.usage.cache_read_input_tokens ?? 0),
      output: response.usage.output_tokens,
    });
  },
};
