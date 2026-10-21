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

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Tokens a provider reports for one call; either side may be missing. */
export type TokenUsage = { input?: number; output?: number; /** Prompt tokens read from the provider's cache (cheaper, faster). */ cached?: number; /** Prompt tokens written to it, where the provider bills writes. */ cacheWrite?: number };

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
  /**
   * "low" for latency-sensitive editor calls (Tab completion, next edit): providers that think by default are
   * asked to think little, so the output budget goes to the answer instead of to reasoning.
   */
  thinking?: "low";
  /**
   * The model connection's reasoning effort (Settings → Models, or the IDE's model picker). Each adapter maps it to
   * its provider's control; unset leaves the provider's default. thinking: "low" takes precedence.
   */
  effort?: Effort;
  /** Groups requests that share a prompt prefix (an agent's), for providers whose caching takes a key (OpenAI). */
  cacheKey?: string;
  signal?: AbortSignal;
};

/**
 * Every SDK module answers in the OpenAI chat-completion shape
 * (`choices[0].message` with content, thinking and tool_calls) so the run loop reads one format.
 */
export type ProviderAdapter = {
  id: string;
  complete(request: ChatRequest): Promise<Record<string, unknown>>;
  /**
   * A raw text completion of `prompt` (no chat turns), streamed as it is generated and ended by any of `stops`.
   * For fill-in-the-middle code models; adapters whose provider has no raw endpoint leave it out.
   */
  completeRaw?(request: RawRequest): AsyncIterable<string>;
};

export type RawRequest = {
  model: string;
  baseUrl: string;
  apiKey?: string;
  prompt: string;
  stops: string[];
  maxOutput: number;
  temperature?: number;
  signal?: AbortSignal;
};
