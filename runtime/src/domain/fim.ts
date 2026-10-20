/**
 * Fill-in-the-middle (FIM): code models trained to complete the gap between a prefix and a suffix. Given one of
 * these, Tab completion sends the model's own FIM tokens as a raw prompt instead of a chat conversation, which
 * is what the model was trained on (no "reply with only the insertion" instructions to follow or ignore).
 */
export type FimFormat = {
  /** The family, for logs. */
  family: string;
  /** Builds the raw prompt the model completes. */
  prompt(prefix: string, suffix: string): string;
  /** Where the model's turn ends: these stop generation and are never shown. */
  stops: string[];
};

const FORMATS: { match: RegExp; format: FimFormat }[] = [
  {
    // Qwen2.5-Coder, Qwen3-Coder (base and instruct).
    match: /qwen.*coder|qwen2\.5-coder|qwen3-coder/i,
    format: {
      family: "qwen-coder",
      prompt: (prefix, suffix) => `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`,
      stops: ["<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>", "<|fim_pad|>", "<|endoftext|>", "<|repo_name|>", "<|file_sep|>"],
    },
  },
  {
    // DeepSeek-Coder (v1 and v2).
    match: /deepseek.*coder/i,
    format: {
      family: "deepseek-coder",
      prompt: (prefix, suffix) => `<｜fim▁begin｜>${prefix}<｜fim▁hole｜>${suffix}<｜fim▁end｜>`,
      stops: ["<｜fim▁begin｜>", "<｜fim▁hole｜>", "<｜fim▁end｜>", "<｜end▁of▁sentence｜>"],
    },
  },
  {
    // Codestral and Mistral's code models ([SUFFIX] comes first in their format).
    match: /codestral|mistral.*code|devstral/i,
    format: {
      family: "codestral",
      prompt: (prefix, suffix) => `[SUFFIX]${suffix}[PREFIX] ${prefix}`,
      stops: ["[PREFIX]", "[SUFFIX]", "[MIDDLE]", "</s>"],
    },
  },
  {
    // StarCoder 1/2 and models that reuse its tokens (e.g. granite-code).
    match: /starcoder|granite.*code|santacoder/i,
    format: {
      family: "starcoder",
      prompt: (prefix, suffix) => `<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>`,
      stops: ["<fim_prefix>", "<fim_suffix>", "<fim_middle>", "<|endoftext|>", "<file_sep>"],
    },
  },
  {
    // CodeLlama (the 7B/13B base and Instruct variants support infilling; 34B does not).
    match: /code-?llama/i,
    format: {
      family: "codellama",
      prompt: (prefix, suffix) => `<PRE> ${prefix} <SUF>${suffix} <MID>`,
      stops: ["<PRE>", "<SUF>", "<MID>", "<EOT>", "</s>"],
    },
  },
  {
    // CodeGemma 2B/7B (the -it chat variant is not an infilling model).
    match: /codegemma(?!.*-it)/i,
    format: {
      family: "codegemma",
      prompt: (prefix, suffix) => `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`,
      stops: ["<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>", "<|file_separator|>", "<eos>"],
    },
  },
];

/** The FIM format a model id (as the user named it in LM Studio or an OpenAI-compatible server) speaks, if any. */
export function fimFormat(modelId: string): FimFormat | undefined {
  return FORMATS.find((entry) => entry.match.test(modelId))?.format;
}

/** The text up to the first stop sequence the model may have echoed, with that and anything after it removed. */
export function cutAtStop(text: string, stops: string[]): string {
  let end = text.length;
  for (const stop of stops) {
    const at = text.indexOf(stop);
    if (at >= 0 && at < end) end = at;
  }
  return text.slice(0, end);
}
