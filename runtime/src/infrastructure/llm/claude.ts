import Anthropic from "@anthropic-ai/sdk";
import { choice, flatInputSchema, flattenToolTurns, systemText, withOptionalFields } from "./shared.js";
import type { ImagePart, ProviderAdapter } from "./types.js";

function imageBlock(img: ImagePart): Anthropic.ImageBlockParam {
  const known = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  return { type: "image", source: { type: "base64", media_type: (known.includes(img.mimeType) ? img.mimeType : "image/jpeg") as "image/png", data: img.base64 } };
}

/** A reply block as it is sent back: thinking with its signature, text, tool_use; what only replies carry is dropped. */
function toParam(block: Anthropic.ContentBlock): Anthropic.ContentBlockParam {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "thinking") return { type: "thinking", thinking: block.thinking, signature: block.signature };
  if (block.type === "redacted_thinking") return { type: "redacted_thinking", data: block.data };
  if (block.type === "tool_use") return { type: "tool_use", id: block.id, name: block.name, input: block.input };
  return block as unknown as Anthropic.ContentBlockParam;
}

export const claude: ProviderAdapter = {
  id: "claude",
  async complete(request) {
    if (!request.apiKey) throw new Error("Claude API key is required");
    const client = new Anthropic({ apiKey: request.apiKey });
    const system = systemText(request.messages);
    const id = request.model.toLowerCase();
    const older = /claude-3|-4-[0-5](?:$|-)/.test(id);
    const low = request.thinking === "low";
    const thinkingOn = !(low || older);
    // With thinking on, a turn that called tools goes back with its signed thinking blocks, as Claude wrote it.
    // A round Claude did not write (another model earlier in the chat, a run from before) goes as text instead.
    const turns = flattenToolTurns(request.messages, (assistant) => assistant.replay?.provider === "claude" || !thinkingOn);
    const messages: Anthropic.MessageParam[] = [];
    for (let i = 0; i < turns.length; i += 1) {
      const item = turns[i]!;
      if (item.role === "system") continue;
      if (item.role === "assistant" && item.toolCalls?.length) {
        const content = item.replay?.provider === "claude"
          ? (item.replay.data as Anthropic.ContentBlockParam[])
          : [
              ...(item.content ? [{ type: "text" as const, text: item.content }] : []),
              ...item.toolCalls.map((call) => ({ type: "tool_use" as const, id: call.id, name: call.name, input: call.arguments })),
            ];
        messages.push({ role: "assistant", content });
        // Every call's result, in one user turn.
        const results: Anthropic.ToolResultBlockParam[] = [];
        while (turns[i + 1]?.role === "tool") {
          const result = turns[++i]!;
          results.push({
            type: "tool_result",
            tool_use_id: result.toolCallId ?? "",
            content: [{ type: "text", text: result.content || "(no output)" }, ...(result.images ?? []).map(imageBlock)],
            ...(result.failed ? { is_error: true } : {}),
          });
        }
        messages.push({ role: "user", content: results });
        continue;
      }
      if (item.images && item.images.length > 0 && item.role === "user") {
        messages.push({ role: "user", content: [{ type: "text", text: item.content || "Attached screenshot:" }, ...item.images.map(imageBlock)] });
        continue;
      }
      let content = item.content;
      if (content.includes("data:image/")) {
        content = content.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]{100,}/g, "[image attached as visual input]");
      }
      messages.push({ role: item.role === "assistant" ? "assistant" : "user", content });
    }
    // Claude's newest models reject a conversation that ends on the assistant ("does not support assistant message
    // prefill"), so a request that still ends there gets a user turn asking it to go on.
    if (messages.at(-1)?.role === "assistant") messages.push({ role: "user", content: "Continue." });
    // Thinking and effort (see the Claude API's thinking/effort rules):
    // - Adaptive thinking runs on Claude 4.6 and later; older models take no adaptive setting.
    // - Effort goes in output_config (low … max); Haiku 4.5, Sonnet 4.5 and Claude 3 reject it.
    // - Low thinking (Tab completion, next edit) omits `thinking` and asks for low effort: the newest models
    //   cannot turn thinking off (`disabled` is a 400), and on older ones omitting it means no thinking.
    // - Sampling settings are rejected from Opus 4.7 / Sonnet 5 on, so temperature goes only to older models.
    const noEffort = /claude-3|(?:haiku|sonnet)-4-5(?:$|-)/.test(id);
    const sampling = /claude-3|-4-[0-6](?:$|-)/.test(id);
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
        thinking: { value: thinkingOn ? { type: "adaptive", display: "summarized" } : undefined, rejectedWhen: /thinking/i },
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
      return [{ id: block.id, name: block.name, arguments: args }];
    });
    return choice(text, calls, thinking, {
      // input_tokens excludes cached tokens; count every prompt token so usage stays comparable across providers.
      input: response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0) + (response.usage.cache_read_input_tokens ?? 0),
      output: response.usage.output_tokens,
      cached: response.usage.cache_read_input_tokens ?? undefined,
      cacheWrite: response.usage.cache_creation_input_tokens ?? undefined,
    }, calls.length ? { provider: "claude", data: response.content.map(toParam) } : undefined);
  },
};
