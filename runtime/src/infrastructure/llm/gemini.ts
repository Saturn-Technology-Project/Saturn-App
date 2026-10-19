import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { logger } from "../logger.js";
import { choice, mentionsThinking, systemText } from "./shared.js";
import type { ChatMessage, ProviderAdapter } from "./types.js";

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown> } };
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

/** Gemini needs tool calls and their results replayed as functionCall / functionResponse turns. */
export function geminiContents(messages: ChatMessage[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  for (const item of messages) {
    if (item.role === "system") continue;
    if (item.images && item.images.length > 0 && item.role === "user") {
      const parts: GeminiPart[] = [{ text: item.content || "Attached screenshot:" }];
      for (const img of item.images) {
        parts.push({
          inlineData: { mimeType: img.mimeType, data: img.base64 },
        });
      }
      contents.push({ role: "user", parts });
      continue;
    }
    const actions = item.role === "assistant" ? toolResultActions(item.content) : null;
    if (actions) {
      contents.push({
        role: "model",
        parts: actions.map((action) => ({
          functionCall: { name: action.toolId, args: action.arguments },
          ...(action.thoughtSignature ? { thoughtSignature: action.thoughtSignature } : {}),
        })),
      });
      const userParts: GeminiPart[] = [];
      for (const action of actions) {
        userParts.push({
          functionResponse: { name: action.toolId, response: functionResponseBody(action) },
        });
        const image = extractActionImage(action.result);
        if (image) {
          userParts.push({
            inlineData: { mimeType: image.mimeType, data: image.base64 },
          });
        }
      }
      contents.push({
        role: "user",
        parts: userParts,
      });
      continue;
    }
    const role = item.role === "assistant" ? "model" : "user";
    const text = item.content.trim() ? item.content : " ";
    const last = contents[contents.length - 1];
    if (last?.role === role && last.parts.every((part) => "text" in part)) {
      last.parts.push({ text });
      continue;
    }
    contents.push({ role, parts: [{ text }] });
  }
  if (contents.length && contents[contents.length - 1].role === "model") {
    contents.push({ role: "user", parts: [{ text: "Continue." }] });
  }
  return contents;
}

function toolResultActions(content: string): { toolId: string; arguments: Record<string, unknown>; status?: string; result?: unknown; reason?: string; thoughtSignature?: string }[] | null {
  const text = content.trim();
  if (!text.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed) || !parsed.length) return null;
    const actions = parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as { toolId?: unknown; arguments?: unknown; status?: unknown; result?: unknown; reason?: unknown; thoughtSignature?: unknown };
      if (typeof record.toolId !== "string" || !record.toolId) return [];
      const args = record.arguments && typeof record.arguments === "object" && !Array.isArray(record.arguments)
        ? record.arguments as Record<string, unknown>
        : {};
      return [{
        toolId: record.toolId,
        arguments: args,
        status: typeof record.status === "string" ? record.status : undefined,
        result: record.result,
        reason: typeof record.reason === "string" ? record.reason : undefined,
        thoughtSignature: typeof record.thoughtSignature === "string" ? record.thoughtSignature : undefined,
      }];
    });
    return actions.length === parsed.length ? actions : null;
  } catch {
    return null;
  }
}

function extractActionImage(result: unknown): { mimeType: string; base64: string } | null {
  if (!result || typeof result !== "object") return null;
  const res = result as Record<string, unknown>;
  const img = res.image || res.screenshot || res.base64;
  if (typeof img !== "string" || !img) return null;
  if (img.startsWith("data:")) {
    const match = img.match(/^data:([^;]+);base64,(.+)$/);
    if (match && match[1] && match[2]) {
      return { mimeType: match[1], base64: match[2] };
    }
  } else if (img.length > 200 && !img.includes(" ") && !img.includes("\n")) {
    return { mimeType: "image/jpeg", base64: img };
  }
  return null;
}

function sanitizeValue(val: unknown): unknown {
  if (typeof val === "string") {
    if (val.startsWith("data:image/") || (val.length > 1000 && !val.includes(" ") && !val.includes("\n"))) {
      return "[image data attached as visual input]";
    }
    if (val.length > 40000) {
      return val.slice(0, 40000) + `... [truncated ${val.length - 40000} chars]`;
    }
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(sanitizeValue);
  }
  if (val && typeof val === "object") {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      res[k] = sanitizeValue(v);
    }
    return res;
  }
  return val;
}

function functionResponseBody(action: { status?: string; result?: unknown; reason?: string }): Record<string, unknown> {
  const payload = action.result === undefined
    ? { status: action.status ?? "completed", reason: action.reason ?? "" }
    : action.result;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return sanitizeValue(payload) as Record<string, unknown>;
  }
  return { result: sanitizeValue(payload ?? null) };
}

function sanitizeGeminiSchema(schema: unknown): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) {
    return schema.map(sanitizeGeminiSchema);
  }
  const obj = { ...(schema as Record<string, unknown>) };
  if ("const" in obj) {
    if (!("enum" in obj)) {
      obj.enum = [obj.const];
    }
    delete obj.const;
  }
  delete obj.$schema;
  delete obj.$id;
  delete obj.$comment;
  delete obj.definitions;
  delete obj.$defs;
  for (const [key, value] of Object.entries(obj)) {
    obj[key] = sanitizeGeminiSchema(value);
  }
  return obj;
}

export const gemini: ProviderAdapter = {
  id: "gemini",
  async complete(request) {
    if (!request.apiKey) throw new Error("Gemini API key is required");
    const ai = new GoogleGenAI({ apiKey: request.apiKey });
    const system = systemText(request.messages);
    const contents = geminiContents(request.messages);
    const send = (includeThoughts: boolean) => ai.models.generateContent({
      model: request.model,
      contents: contents.length ? contents : [{ role: "user", parts: [{ text: "" }] }],
      config: {
        systemInstruction: system || undefined,
        temperature: request.temperature,
        maxOutputTokens: request.maxOutput,
        abortSignal: request.signal,
        thinkingConfig: includeThoughts ? { includeThoughts: true, ...thinkingLevel(request.model) } : undefined,
        tools: request.tools.length
          ? [{
              functionDeclarations: request.tools.map((tool) => ({
                name: tool.function?.name ?? "",
                description: tool.function?.description,
                parameters: tool.function?.parameters ? sanitizeGeminiSchema(tool.function.parameters) : undefined,
              })),
            }]
          : undefined,
      },
    });
    let response: Awaited<ReturnType<typeof send>>;
    let includeThoughts = true;
    try {
      response = await send(true);
    } catch (error) {
      if (!mentionsThinking(error)) throw error;
      includeThoughts = false;
      logger.info("llm", `${request.model} refused the thinking settings; retried without thought summaries`);
      response = await send(false);
    }
    const thoughts = (response.candidates?.[0]?.content?.parts ?? [])
      .flatMap((part) => (part.thought && part.text ? [part.text] : []))
      .join("\n\n");
    const calls = (response.candidates?.[0]?.content?.parts ?? []).flatMap((part) => {
      const call = part.functionCall;
      if (!call?.name) return [];
      const args = call.args && typeof call.args === "object" ? call.args : {};
      return [{ name: call.name, arguments: args, thoughtSignature: part.thoughtSignature }];
    });
    const usage = response.usageMetadata;
    if (!thoughts && includeThoughts) {
      // Thought summaries were asked for but none came back. Record the response's shape (never its text)
      // to tell "did not think" apart from "thought but sent no summary".
      const parts = response.candidates?.[0]?.content?.parts ?? [];
      logger.info("llm", `${request.model} returned no thought summary`, {
        "gemini.parts": parts.length,
        "gemini.thought_parts": parts.filter((part) => part.thought).length,
        "gemini.thought_text_parts": parts.filter((part) => part.thought && part.text).length,
        "gemini.signed_parts": parts.filter((part) => part.thoughtSignature).length,
        "gemini.thoughts_token_count": usage?.thoughtsTokenCount ?? -1,
        "gemini.candidates_token_count": usage?.candidatesTokenCount ?? -1,
        "gemini.model_version": response.modelVersion ?? "",
      });
    }
    return choice(response.text ?? "", calls, thoughts, {
      input: usage?.promptTokenCount,
      output: usage ? (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0) : undefined,
    });
  },
};

/**
 * Gemini 4 requires an explicit thinkingLevel (ai.google.dev, generateContent thinking guide); without it no
 * thought summary comes back. MEDIUM is the documented default, so only the summary changes, not the effort.
 * Gemini 3.x and 2.5 keep their defaults (thinkingLevel is optional there, and 2.5 rejects it).
 */
function thinkingLevel(model: string): { thinkingLevel?: ThinkingLevel } {
  return /^gemini-4/.test(model) ? { thinkingLevel: ThinkingLevel.MEDIUM } : {};
}
