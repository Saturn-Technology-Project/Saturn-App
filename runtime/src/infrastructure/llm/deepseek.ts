import OpenAI from "openai";
import { choice, parseArguments } from "./shared.js";
import type { ChatMessage, ProviderAdapter } from "./types.js";

/**
 * DeepSeek has no SDK of its own; its docs point the OpenAI SDK at api.deepseek.com.
 * Thinking mode is on by default and returns reasoning_content. When tools are sent, every earlier
 * assistant turn must carry its reasoning_content back or the API answers 400.
 * Legacy reasoner models reject temperature; current models just ignore it while thinking.
 */
export const deepseek: ProviderAdapter = {
  id: "deepseek",
  async complete(request) {
    if (!request.apiKey) throw new Error("DeepSeek API key is required");
    const client = new OpenAI({
      apiKey: request.apiKey,
      baseURL: (request.baseUrl || "https://api.deepseek.com").replace(/\/$/, ""),
    });
    const reasoner = request.model.toLowerCase().includes("reasoner");
    const completion = await client.chat.completions.create({
      model: request.model,
      messages: messagesFor(request.messages, request.tools.length > 0),
      temperature: reasoner ? undefined : request.temperature,
      max_tokens: request.maxOutput,
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
      reasoning_content?: string;
      thinking?: string;
      tool_calls?: typeof completion.choices[0]["message"]["tool_calls"];
    } | undefined;
    const calls = (message?.tool_calls ?? []).flatMap((call) => {
      if (call.type !== "function") return [];
      return [{ name: call.function.name, arguments: parseArguments(call.function.arguments) }];
    });
    return choice(message?.content ?? "", calls, (message?.reasoning_content || message?.thinking || "").trim(), {
      input: completion.usage?.prompt_tokens,
      output: completion.usage?.completion_tokens,
    });
  },
};

function messagesFor(messages: ChatMessage[], withTools: boolean) {
  return messages.map((item) =>
    withTools && item.role === "assistant"
      ? { role: item.role, content: item.content, reasoning_content: item.reasoning ?? "" }
      : { role: item.role, content: item.content },
  );
}
