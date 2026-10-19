export type ImagePart = {
  mimeType: string;
  base64: string;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  /** The model's chain of thought for an assistant turn. Only providers that need it sent back read it. */
  reasoning?: string;
  /** Multimodal images attached to this message turn (e.g. computer_screenshot). */
  images?: ImagePart[];
};

export type ToolDef = {
  type?: string;
  function?: { name?: string; description?: string; parameters?: Record<string, unknown> };
};

/** Tokens a provider reports for one call; either side may be missing. */
export type TokenUsage = { input?: number; output?: number };

export type ToolCall = { name: string; arguments: Record<string, unknown>; thoughtSignature?: string };

/** One model call after the broker has picked the SDK and the key. */
export type ChatRequest = {
  model: string;
  baseUrl: string;
  apiKey?: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  temperature?: number;
  maxOutput?: number;
  signal?: AbortSignal;
};

/**
 * Every SDK module answers in the OpenAI chat-completion shape
 * (`choices[0].message` with content, thinking and tool_calls) so the run loop reads one format.
 */
export type ProviderAdapter = {
  id: string;
  complete(request: ChatRequest): Promise<Record<string, unknown>>;
};
