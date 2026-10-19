/**
 * Official list prices, USD per 1M tokens, standard (non-batch, non-priority) tier, checked 2026-10-18 against:
 * - OpenAI: developers.openai.com/api/docs/pricing ("Short context"; "Long context" is >272K input tokens)
 * - Anthropic: Claude API model table (claude-api skill, cached 2026-10-06)
 * - Google: ai.google.dev/gemini-api/docs/pricing (paid tier, text)
 * - DeepSeek: api-docs.deepseek.com/quick_start/pricing (cache-miss input; peak 01:00-04:00 and 06:00-10:00 UTC on weekdays)
 *
 * Input is priced at the uncached rate: cached-token counts are not reported to the runtime yet,
 * so a cache-heavy call is billed a little above what the provider charges.
 * Models missing here (custom endpoints, models not on the price pages) are reported as unpriced, never guessed.
 */

export type Rate = { input: number; output: number };

type Pricing = {
  rate: Rate;
  /** A dated price change: `rate` applies before this UTC instant, `after` from then on. */
  until?: string;
  after?: Rate;
  /** A higher rate when the prompt is larger than `above` input tokens. */
  longContext?: { above: number; rate: Rate };
  /** DeepSeek: `rate` is off-peak, `peak` applies during peak hours. */
  peak?: Rate;
};

const PRICES: Record<string, Pricing> = {
  "openai/gpt-6-astra": { rate: { input: 10, output: 50 }, longContext: { above: 272_000, rate: { input: 20, output: 75 } } },
  "openai/gpt-6.1-sol": { rate: { input: 2, output: 10 }, longContext: { above: 272_000, rate: { input: 4, output: 15 } } },
  "openai/gpt-6-luna": { rate: { input: 0.1, output: 0.5 }, longContext: { above: 272_000, rate: { input: 0.2, output: 0.75 } } },

  "claude/claude-fable-5-1": { rate: { input: 10, output: 50 } },
  "claude/claude-opus-5-5": { rate: { input: 4, output: 20 } },
  "claude/claude-sonnet-5-5": { rate: { input: 2, output: 10 } },
  "claude/claude-haiku-4-5": { rate: { input: 1, output: 5 } },

  "gemini/gemini-4-argon": { rate: { input: 2, output: 10 }, until: "2026-12-01T00:00:00Z", after: { input: 4, output: 20 } },
  "gemini/gemini-3.8-flash": { rate: { input: 0.75, output: 3.75 }, until: "2027-01-01T00:00:00Z", after: { input: 1.5, output: 7.5 } },
  "gemini/gemini-3.6-flash": { rate: { input: 0.75, output: 3.75 }, until: "2027-01-01T00:00:00Z", after: { input: 1.5, output: 7.5 } },
  "gemini/gemini-3.5-flash-lite": { rate: { input: 0.3, output: 2.5 } },
  "gemini/gemini-3.1-pro-preview": { rate: { input: 2, output: 12 }, longContext: { above: 200_000, rate: { input: 4, output: 18 } } },
  "gemini/gemini-3.1-flash-lite": { rate: { input: 0.25, output: 1.5 } },
  "gemini/gemini-2.5-pro": { rate: { input: 1.25, output: 10 }, longContext: { above: 200_000, rate: { input: 2.5, output: 15 } } },
  "gemini/gemini-2.5-flash": { rate: { input: 0.3, output: 2.5 } },

  "deepseek/deepseek-flash": { rate: { input: 0.15, output: 0.6 }, peak: { input: 0.3, output: 1.2 } },
  "deepseek/deepseek-v4-flash": { rate: { input: 0.15, output: 0.6 }, peak: { input: 0.3, output: 1.2 } },
  "deepseek/deepseek-v4-pro": { rate: { input: 0.66, output: 1.98 }, peak: { input: 1.32, output: 3.96 } },
};

export type PricedCall = {
  inputRate: number;
  outputRate: number;
  /** Which price applied: "standard", "long context", "peak", "off-peak", "local", or a dated-change label. */
  tier: string;
  costUsd: number;
};

/** DeepSeek's peak hours: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday (Chinese public holidays are not modelled). */
export function deepSeekPeak(at: Date): boolean {
  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}

function pricing(provider: string, model: string): Pricing | undefined {
  return PRICES[`${provider}/${model}`];
}

/**
 * The rate in force for one call. `hosted` is false for a custom endpoint (an OpenAI-compatible server),
 * which is not billed at the provider's list price. LM Studio runs locally and costs nothing.
 */
export function priceCall(input: {
  provider: string;
  model: string;
  hosted: boolean;
  at: Date;
  inputTokens: number;
  outputTokens: number;
}): PricedCall | null {
  if (input.provider === "lmstudio") return { inputRate: 0, outputRate: 0, tier: "local", costUsd: 0 };
  if (!input.hosted) return null;
  const price = pricing(input.provider, input.model);
  if (!price) return null;
  let rate = price.rate;
  let tier = "standard";
  if (price.until && price.after && input.at.getTime() >= Date.parse(price.until)) {
    rate = price.after;
  } else if (price.until) {
    tier = `until ${price.until.slice(0, 10)}`;
  }
  if (price.longContext && input.inputTokens > price.longContext.above) {
    rate = price.longContext.rate;
    tier = "long context";
  }
  if (price.peak) {
    const peak = deepSeekPeak(input.at);
    rate = peak ? price.peak : price.rate;
    tier = peak ? "peak" : "off-peak";
  }
  return {
    inputRate: rate.input,
    outputRate: rate.output,
    tier,
    costUsd: (input.inputTokens * rate.input + input.outputTokens * rate.output) / 1_000_000,
  };
}

/** A one-line description of a model's list price as of `at`, for the Usage page. */
export function describePrice(provider: string, model: string, at = new Date()): string | null {
  if (provider === "lmstudio") return "Local · free";
  const price = pricing(provider, model);
  if (!price) return null;
  const money = (value: number) => `$${value < 1 ? value.toFixed(value < 0.1 ? 3 : 2) : value.toFixed(2)}`;
  const pair = (rate: Rate) => `${money(rate.input)} in / ${money(rate.output)} out`;
  const changed = Boolean(price.until && price.after && at.getTime() >= Date.parse(price.until));
  const current = changed && price.after ? price.after : price.rate;
  const notes: string[] = [];
  if (price.until && price.after && !changed) notes.push(`${pair(price.after)} from ${price.until.slice(0, 10)}`);
  if (price.longContext) notes.push(`${pair(price.longContext.rate)} above ${Math.round(price.longContext.above / 1000)}K input`);
  if (price.peak) return `${pair(price.rate)} off-peak · ${pair(price.peak)} peak (UTC 01-04, 06-10 weekdays) · per 1M tokens`;
  return `${pair(current)} per 1M tokens${notes.length ? ` · ${notes.join(" · ")}` : ""}`;
}
