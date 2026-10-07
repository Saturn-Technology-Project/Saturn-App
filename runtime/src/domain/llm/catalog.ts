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
    id: "gemini",
    label: "Gemini",
    needsKey: true,
    baseUrl: "https://generativelanguage.googleapis.com",
    models: [
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
      { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash" },
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
      { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
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

export function llmProvider(id: string): LlmProvider | undefined {
  return LLM_PROVIDERS.find((item) => item.id === id);
}
