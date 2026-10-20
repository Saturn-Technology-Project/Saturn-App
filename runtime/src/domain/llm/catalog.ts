export type LlmModelChoice = { id: string; label: string };

export type LlmProvider = {
  id: string;
  label: string;
  needsKey: boolean;
  baseUrl: string;
  models: LlmModelChoice[];
};

export const LLM_PROVIDERS: LlmProvider[] = [
  {
    id: "openai",
    label: "OpenAI",
    needsKey: true,
    baseUrl: "https://api.openai.com/v1",
    models: [
      { id: "gpt-6-astra", label: "GPT-6 Astra" },
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
      { id: "gpt-6-luna", label: "GPT-6 Luna" },
    ],
  },
  {
    id: "claude",
    label: "Claude",
    needsKey: true,
    baseUrl: "https://api.anthropic.com",
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    ],
  },
  {
    // Runs through the official Claude Agent SDK and `claude` program on the user's own Claude login
    // (see application/claude-code.ts). Saturn holds no key and never sees the login.
    id: "claude-code",
    label: "Claude Code (your Claude plan)",
    needsKey: false,
    baseUrl: "",
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    ],
  },
  {
    // Runs through the official Codex SDK and `codex` program on the user's own ChatGPT login
    // (see application/codex.ts). Saturn holds no key and never sees the login.
    id: "codex",
    label: "Codex (your ChatGPT plan)",
    needsKey: false,
    baseUrl: "",
    models: [
      { id: "default", label: "Codex default model" },
      { id: "gpt-6-astra", label: "GPT-6 Astra" },
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
      { id: "gpt-6-luna", label: "GPT-6 Luna" },
    ],
  },
  {
    id: "gemini",
    label: "Gemini",
    needsKey: true,
    baseUrl: "https://generativelanguage.googleapis.com",
    models: [
      { id: "gemini-4-argon", label: "Gemini 4 Argon" },
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
      { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash" },
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
      { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    needsKey: true,
    baseUrl: "https://api.deepseek.com",
    models: [
      { id: "deepseek-flash", label: "DeepSeek Flash (V4.1)" },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    ],
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    needsKey: false,
    baseUrl: "http://127.0.0.1:1234",
    models: [],
  },
];

/** Reasoning effort the Claude Agent SDK accepts. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

export function claudeEffort(value: unknown): ClaudeEffort | undefined {
  return CLAUDE_EFFORTS.includes(value as ClaudeEffort) ? (value as ClaudeEffort) : undefined;
}

export function llmProvider(id: string): LlmProvider | undefined {
  return LLM_PROVIDERS.find((item) => item.id === id);
}
