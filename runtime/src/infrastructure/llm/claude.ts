import Anthropic from "@anthropic-ai/sdk";
import { choice, flatInputSchema, systemText, withOptionalFields } from "./shared.js";
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
    // Thinking and effort (see the Claude API's thinking/effort rules):
    // - Adaptive thinking runs on Claude 4.6 and later; older models take no adaptive setting.
    // - Effort goes in output_config (low … max); Haiku 4.5, Sonnet 4.5 and Claude 3 reject it.
    // - Low thinking (Tab completion, next edit) omits `thinking` and asks for low effort: the newest models
    //   cannot turn thinking off (`disabled` is a 400), and on older ones omitting it means no thinking.
    // - Sampling settings are rejected from Opus 4.7 / Sonnet 5 on, so temperature goes only to older models.
    const id = request.model.toLowerCase();
    const older = /claude-3|-4-[0-5](?:$|-)/.test(id);
    const noEffort = /claude-3|(?:haiku|sonnet)-4-5(?:$|-)/.test(id);
    const sampling = /claude-3|-4-[0-6](?:$|-)/.test(id);
    const low = request.thinking === "low";
    const effort = low ? "low" : request.effort;
    const tools = request.tools.length
      ? request.tools.map((tool) => {
          const { schema, note } = flatInputSchema(tool.function?.parameters as Record<string, unknown> | undefined);
          const description = [tool.function?.description, note].filter(Boolean).join(" ");
          return {
            name: tool.function?.name ?? "",
            ...(description ? { description } : {}),
            input_schema: schema as Anthropic.Tool.InputSchema,
          };
        })
      : undefined;
    const response = await withOptionalFields(
      {
        thinking: { value: low || older ? undefined : { type: "adaptive", display: "summarized" }, rejectedWhen: /thinking/i },
        output_config: { value: effort && !noEffort ? { effort } : undefined, rejectedWhen: /effort|output_config/i },
        temperature: { value: sampling ? request.temperature : undefined, rejectedWhen: /temperature|sampling/i },
      },
      (active) =>
        client.messages.create({
          model: request.model,
          max_tokens: request.maxOutput ?? 4096,
          ...(active.thinking ? { thinking: active.thinking as Anthropic.ThinkingConfigParam } : {}),
          ...(active.output_config ? { output_config: active.output_config as Anthropic.MessageCreateParams["output_config"] } : {}),
          // Temperature cannot go with thinking on the models that still accept it.
          ...(active.temperature !== undefined && !active.thinking ? { temperature: active.temperature as number } : {}),
          system: system || undefined,
          // Automatic prompt caching: the system prompt, tools and earlier turns are read from cache on every
          // later round of a run (and after a computer_wait resumes within the cache lifetime).
          cache_control: { type: "ephemeral" },
          messages: messages.length ? messages : [{ role: "user", content: "" }],
          tools,
        }, { signal: request.signal }),
    );
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
