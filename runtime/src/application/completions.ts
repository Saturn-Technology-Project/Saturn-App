import { HttpError } from "../domain/errors.js";
import type { ModelConnection } from "../domain/model.js";
import { textOf } from "../domain/policies.js";
import type { ChatMessage } from "../infrastructure/llm.js";
import type { RuntimeKernel } from "./kernel.js";

/** Usage from Saturn IDE's editor features is filed under this pseudo-agent. */
export const IDE_AGENT_ID = "saturn-ide";
const IDE_AGENT_NAME = "Saturn IDE";

/** The two editor features: Tab (fill in at the cursor) and Cmd+K (rewrite the selection). */
export type CompletionRequest = {
  kind: "inline" | "edit";
  language?: string;
  path?: string;
  /** Text before the cursor, or before the selection for an edit. */
  prefix?: string;
  /** Text after the cursor, or after the selection for an edit. */
  suffix?: string;
  /** Edit only: the code to rewrite (may be empty when the cursor is just placed). */
  selection?: string;
  /** Edit only: what the user typed into the Cmd+K box. */
  instruction?: string;
  /** Overrides Settings → General → Completion model. */
  modelId?: string;
  maxTokens?: number;
};

export type CompletionResult = { text: string; modelId: string; model: string };

const LIMITS = { prefix: 8000, suffix: 4000, selection: 20000, instruction: 2000 };

/** One plain model call, no tools and no agent loop, for the editor's Tab completion and Cmd+K edit. */
export class CompletionService {
  constructor(private readonly kernel: RuntimeKernel) {}

  model(modelId?: string): ModelConnection {
    const id = modelId || this.kernel.store.state.settings.completionModelId;
    if (!id) throw new HttpError(409, "Choose a completion model in Saturn Settings → General.");
    const model = this.kernel.store.state.models.find((item) => item.id === id);
    if (!model) throw new HttpError(409, "The completion model was removed. Choose another in Saturn Settings → General.");
    if (model.provider === "claude-code") {
      throw new HttpError(409, `${model.name} runs through Claude Code and cannot serve completions. Choose an API model.`);
    }
    return model;
  }

  async complete(input: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const kind = input.kind === "edit" ? "edit" : input.kind === "inline" ? "inline" : null;
    if (!kind) throw new HttpError(400, "kind must be \"inline\" or \"edit\"");
    if (kind === "edit" && !String(input.instruction ?? "").trim()) throw new HttpError(400, "Type an instruction for the edit");
    const model = this.model(input.modelId);
    const fallback = kind === "edit" ? 2048 : 128;
    const maxOutput = Math.min(Math.max(Number(input.maxTokens) || fallback, 16), 4096);
    const body = await this.kernel.llm.complete(model, {
      context: { agentId: IDE_AGENT_ID, agentName: IDE_AGENT_NAME, purpose: "completion" },
      temperature: kind === "edit" ? 0.2 : 0,
      maxOutput,
      messages: kind === "edit" ? editPrompt(input) : inlinePrompt(input),
      signal,
    });
    const raw = textOf(body);
    const text = kind === "edit"
      ? stripFences(raw).replace(/^\n+/, "").replace(/\s+$/, "")
      : trimInline(stripFences(raw).replace(/\n+$/, ""), String(input.suffix ?? ""));
    return { text, modelId: model.id, model: model.model || model.name };
  }
}

function clip(value: unknown, max: number, keep: "start" | "end"): string {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return keep === "end" ? text.slice(text.length - max) : text.slice(0, max);
}

function fileLine(input: CompletionRequest): string {
  const language = input.language ? ` (${input.language})` : "";
  return input.path ? `File: ${input.path}${language}` : `Language: ${input.language || "plain text"}`;
}

function inlinePrompt(input: CompletionRequest): ChatMessage[] {
  const prefix = clip(input.prefix, LIMITS.prefix, "end");
  const suffix = clip(input.suffix, LIMITS.suffix, "start");
  return [
    {
      role: "system",
      content: [
        "You are a code completion engine inside an editor.",
        "Reply with only the text to insert at <CURSOR>: no explanation, no markdown fences, no repetition of the code around it.",
        "Prefer a short completion: finish the current line, or at most a few lines when a block is clearly started.",
        "Reply with nothing when no completion is useful.",
      ].join("\n"),
    },
    { role: "user", content: `${fileLine(input)}\n\n${prefix}<CURSOR>${suffix}` },
  ];
}

function editPrompt(input: CompletionRequest): ChatMessage[] {
  const prefix = clip(input.prefix, LIMITS.prefix, "end");
  const suffix = clip(input.suffix, LIMITS.suffix, "start");
  const selection = clip(input.selection, LIMITS.selection, "start");
  const instruction = clip(input.instruction, LIMITS.instruction, "start").trim();
  return [
    {
      role: "system",
      content: [
        "You rewrite code inside an editor.",
        "You get the code before the selection, the selection, and the code after it, plus an instruction.",
        "Reply with only the code that replaces the selection, keeping its indentation: no explanation, no markdown fences,",
        "and none of the surrounding code. When the selection is empty, reply with the code to insert at that point.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        fileLine(input),
        "",
        "<before>",
        prefix,
        "</before>",
        "<selection>",
        selection,
        "</selection>",
        "<after>",
        suffix,
        "</after>",
        "",
        `Instruction: ${instruction}`,
      ].join("\n"),
    },
  ];
}

/** Models often wrap code in a fence despite being told not to; keep just what's inside. */
export function stripFences(text: string): string {
  const fenced = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return fenced ? fenced[1]! : text;
}

/** Drops a completion's tail when the model repeated the code that already follows the cursor. */
function trimInline(text: string, suffix: string): string {
  const next = suffix.split("\n").find((line) => line.trim())?.trim();
  if (!next) return text;
  const lines = text.split("\n");
  const at = lines.findIndex((line, index) => index > 0 && line.trim() === next);
  return at > 0 ? lines.slice(0, at).join("\n").replace(/\s+$/, "") : text;
}
