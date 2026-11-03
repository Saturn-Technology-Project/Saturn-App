import { createServer } from "node:http";
import { claude } from "../src/infrastructure/llm/claude.js";
import { deepseek } from "../src/infrastructure/llm/deepseek.js";
import { gemini } from "../src/infrastructure/llm/gemini.js";
import { lmStudio } from "../src/infrastructure/llm/lmstudio.js";
import { openAIChat, openAIResponses } from "../src/infrastructure/llm/openai.js";
import type { ProviderAdapter } from "../src/infrastructure/llm/types.js";

const ADAPTERS: Record<string, ProviderAdapter> = { claude, deepseek, gemini, lmstudio: lmStudio, "openai-chat": openAIChat, "openai-responses": openAIResponses };
/** The request headers that decide whether a provider accepts a call. */
const HEADERS = ["authorization", "x-api-key", "x-goog-api-key", "anthropic-version", "content-type"];

export type LlmCase = { name: string; adapter: string; request: Record<string, unknown>; replies: { status?: number; body: unknown }[] };

/** One case of contract/cases/llm.json against a fake server: what the adapter sent, and what it made of the replies. */
export async function runCase(input: LlmCase) {
  const sent: unknown[] = [];
  let next = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const headers = Object.fromEntries(HEADERS.filter((name) => req.headers[name] !== undefined).map((name) => [name, req.headers[name]]));
      sent.push({ path: req.url, headers, body: JSON.parse(raw || "null") });
      const reply = input.replies[next++] ?? { status: 500, body: { error: { message: "no more replies" } } };
      res.writeHead(reply.status ?? 200, { "content-type": "application/json", "x-should-retry": "false" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // These two SDKs take their address only from the environment.
  process.env.ANTHROPIC_BASE_URL = baseUrl;
  process.env.GOOGLE_GEMINI_BASE_URL = baseUrl;
  try {
    const body = await ADAPTERS[input.adapter]!.complete({ apiKey: "fake-key", messages: [], tools: [], ...input.request, baseUrl } as unknown as Parameters<ProviderAdapter["complete"]>[0]);
    const message = (body.choices as { message: Record<string, any> }[])[0]!.message;
    // Without the fields a provider left undefined, as JSON has none.
    const usage = JSON.parse(JSON.stringify(body.usage)) as Record<string, unknown>;
    const completion = {
      content: message.content,
      thinking: message.thinking,
      toolCalls: message.tool_calls.map((call: any) => ({ ...(call.id ? { id: call.id } : {}), name: call.function.name, arguments: JSON.parse(call.function.arguments), ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}) })),
      ...(message.replay ? { replay: message.replay } : {}),
      usage,
    };
    return { sent, completion };
  } catch (error) {
    return { sent, error: { status: (error as { status?: number }).status ?? null } };
  } finally {
    server.close();
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.GOOGLE_GEMINI_BASE_URL;
  }
}
