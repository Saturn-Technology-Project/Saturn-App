import { HttpError } from "../domain/errors.js";
import { errorText, logger } from "./logger.js";
import { SpanKind, failSpan, instruments, seconds, traced } from "./telemetry.js";
import { llmProvider } from "../domain/llm/catalog.js";
import { priceCall } from "../domain/llm/pricing.js";
import { newId } from "../domain/ids.js";
import type { ModelConnection, UsageRecord } from "../domain/model.js";
import { claude } from "./llm/claude.js";
import { deepseek } from "./llm/deepseek.js";
import { gemini } from "./llm/gemini.js";
import { lmStudio } from "./llm/lmstudio.js";
import { withTransientRetry } from "./llm/shared.js";
import { isOfficialOpenAI, openAIChat, openAIResponses } from "./llm/openai.js";
import type { ChatMessage, ProviderAdapter, ToolDef } from "./llm/types.js";

export { geminiContents } from "./llm/gemini.js";
export { listLmStudioModels } from "./llm/lmstudio.js";
export type { ChatMessage } from "./llm/types.js";

/** Where keys live. The broker only needs to read and write them by id. */
export type KeyVault = {
  secret(id: string): string | undefined;
  putSecret(id: string, value: string): Promise<void>;
};

/** Who made a call, so its tokens and cost are filed under the right agent. */
export type CallContext = {
  agentId: string;
  agentName: string;
  runId?: string;
  purpose: "run" | "automation_draft" | "completion" | "memory";
};

export type CompletionInput = {
  context: CallContext;
  messages: ChatMessage[];
  tools?: unknown[];
  temperature?: number;
  maxOutput?: number;
  /** See ChatRequest.thinking. */
  thinking?: "low";
  signal?: AbortSignal;
};

/** Adapters whose SDK retries transient failures itself, so the broker does not retry around them too. */
const SDK_RETRIES = new Set(["claude", "deepseek", "openai-chat", "openai-responses"]);

const ADAPTERS: Record<string, ProviderAdapter> = {
  claude,
  gemini,
  deepseek,
  lmstudio: lmStudio,
};

export function providerKeyId(provider: string): string {
  return `provider:${provider || "openai"}`;
}

/**
 * The one door to every LLM SDK. For each request it picks which key to send
 * (the model's own, else its provider's) and which SDK module talks to the provider.
 */
export class LlmBroker {
  /** Receives one record per call that reported tokens. The kernel saves them to the usage history. */
  onUsage?: (record: UsageRecord) => void | Promise<void>;

  constructor(private readonly vault: KeyVault) {}

  /** True when the model talks to its provider's own endpoint, so the provider's list price applies. */
  hosted(model: ModelConnection): boolean {
    const provider = llmProvider(model.provider || "openai");
    return Boolean(provider && provider.baseUrl.replace(/\/$/, "") === model.baseUrl.replace(/\/$/, ""));
  }

  /** The model's own key, else the key saved for its provider, so every model of a provider shares one key. */
  keyFor(model: ModelConnection): string | undefined {
    return this.vault.secret(model.id) ?? this.vault.secret(providerKeyId(model.provider));
  }

  hasKey(model: ModelConnection): boolean {
    return Boolean(this.keyFor(model));
  }

  /** Binds the key to the model and to its provider, so later models of that provider reuse it. */
  async saveKey(model: ModelConnection, secret: string): Promise<void> {
    const key = secret.trim();
    if (!key) return;
    await this.vault.putSecret(model.id, key);
    await this.vault.putSecret(providerKeyId(model.provider), key);
  }

  /** Refuses up front when a model on the provider's own endpoint has no key to send. */
  requireKey(model: ModelConnection): void {
    const provider = llmProvider(model.provider || "openai");
    if (provider?.needsKey && this.hosted(model) && !this.keyFor(model)) {
      logger.warn("llm", `Refused a call to ${model.name}: no ${provider.label} API key is saved`, { "gen_ai.provider.name": provider.id });
      throw new HttpError(409, `${model.name} has no ${provider.label} API key. Add it in Settings → Models.`);
    }
  }

  /** Files a call's tokens and cost. A failure to save is logged, never turned into a failed call. */
  private async recordUsage(model: ModelConnection, requestModel: string, context: CallContext, inputTokens: number, outputTokens: number) {
    if (!inputTokens && !outputTokens) return;
    const record = usageRecord(model, requestModel, this.hosted(model), context, inputTokens, outputTokens);
    if (record.costUsd === null) {
      logger.debug("llm", `No official price for ${model.provider}/${requestModel}; its ${inputTokens + outputTokens} tokens are recorded unpriced`);
    }
    try {
      await this.onUsage?.(record);
    } catch (error) {
      logger.warn("llm", `Could not record usage for ${requestModel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Which SDK module serves this model. */
  adapterFor(model: ModelConnection): ProviderAdapter {
    const adapter = ADAPTERS[model.provider];
    if (adapter) return adapter;
    return isOfficialOpenAI(model.baseUrl) ? openAIResponses : openAIChat;
  }

  /**
   * One LLM call, traced per the OTel GenAI conventions: a "chat <model>" client span,
   * gen_ai.client.operation.duration, and gen_ai.client.token.usage when the provider reports tokens.
   */
  async complete(model: ModelConnection, input: CompletionInput): Promise<Record<string, unknown>> {
    const adapter = this.adapterFor(model);
    const requestModel = model.model || model.name;
    const tools = toolsOf(input.tools ?? []);
    const base = {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": model.provider || "openai",
      "gen_ai.request.model": requestModel,
    };
    return traced(`chat ${requestModel}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        ...base,
        "saturn.llm.adapter": adapter.id,
        "server.address": hostOf(model.baseUrl),
        ...(input.temperature === undefined ? {} : { "gen_ai.request.temperature": input.temperature }),
        ...(input.maxOutput === undefined ? {} : { "gen_ai.request.max_tokens": input.maxOutput }),
        "saturn.llm.tools.offered": tools.length,
        "saturn.llm.messages": input.messages.length,
      },
    }, async (span) => {
      const startedAt = performance.now();
      try {
        this.requireKey(model);
        // Which key, never the key: the model's own, the provider's shared one, or none.
        const source = this.vault.secret(model.id) ? "model key" : this.keyFor(model) ? "provider key" : "no key";
        logger.debug("llm", `chat ${requestModel} via ${adapter.id} (${source})`);
        const send = () =>
          adapter.complete({
            model: requestModel,
            baseUrl: model.baseUrl,
            apiKey: this.keyFor(model),
            messages: input.messages,
            tools,
            temperature: input.temperature,
            maxOutput: input.maxOutput,
            ...(input.thinking ? { thinking: input.thinking } : {}),
            ...(model.effort ? { effort: model.effort } : {}),
            signal: input.signal,
          });
        // One dropped connection (read ETIMEDOUT) should not end a long agent run. The Anthropic and OpenAI SDKs
        // (Claude, OpenAI, DeepSeek) already retry; Gemini's and the local LM Studio client do not.
        const body = SDK_RETRIES.has(adapter.id)
          ? await send()
          : await withTransientRetry(send, {
              signal: input.signal,
              onRetry: (error, attempt) => logger.warn("llm", `chat ${requestModel} failed (${errorText(error)}); retrying (${attempt}/2)`),
            });
        const usage = (body.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
        const calls = ((body.choices as { message?: { tool_calls?: unknown[] } }[] | undefined)?.[0]?.message?.tool_calls ?? []).length;
        span.setAttribute("saturn.llm.tool_calls", calls);
        if (usage.input_tokens !== undefined) {
          span.setAttribute("gen_ai.usage.input_tokens", usage.input_tokens);
          instruments().llmTokens.record(usage.input_tokens, { ...base, "gen_ai.token.type": "input" });
        }
        if (usage.output_tokens !== undefined) {
          span.setAttribute("gen_ai.usage.output_tokens", usage.output_tokens);
          instruments().llmTokens.record(usage.output_tokens, { ...base, "gen_ai.token.type": "output" });
        }
        instruments().llmDuration.record(seconds(startedAt), base);
        await this.recordUsage(model, requestModel, input.context, usage.input_tokens ?? 0, usage.output_tokens ?? 0);
        return body;
      } catch (error) {
        const type = error instanceof HttpError ? `http_${error.status}` : error instanceof Error ? error.name : "error";
        failSpan(span, error, type);
        instruments().llmDuration.record(seconds(startedAt), { ...base, "error.type": type });
        throw error;
      }
    });
  }
}

function usageRecord(
  model: ModelConnection,
  requestModel: string,
  hosted: boolean,
  context: CallContext,
  inputTokens: number,
  outputTokens: number,
  at = new Date(),
): UsageRecord {
  const priced = priceCall({ provider: model.provider, model: requestModel, hosted, at, inputTokens, outputTokens });
  return {
    id: newId("usage"),
    runId: context.runId ?? "",
    agentId: context.agentId,
    agentName: context.agentName,
    modelId: model.id,
    modelName: model.name,
    provider: model.provider,
    model: requestModel,
    purpose: context.purpose,
    inputTokens,
    outputTokens,
    inputRate: priced?.inputRate ?? null,
    outputRate: priced?.outputRate ?? null,
    pricing: priced?.tier ?? "unpriced",
    costUsd: priced?.costUsd ?? null,
    createdAt: at.toISOString(),
  };
}

function toolsOf(tools: unknown[]): ToolDef[] {
  return tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object") return [];
    const fn = (tool as ToolDef).function;
    if (!fn?.name) return [];
    return [{ function: fn }];
  });
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
}
