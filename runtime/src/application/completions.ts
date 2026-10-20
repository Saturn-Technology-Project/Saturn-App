import { HttpError } from "../domain/errors.js";
import type { ModelConnection } from "../domain/model.js";
import { textOf } from "../domain/policies.js";
import type { ChatMessage } from "../infrastructure/llm.js";
import type { RuntimeKernel } from "./kernel.js";

/** Usage from Saturn IDE's editor features is filed under this pseudo-agent. */
export const IDE_AGENT_ID = "saturn-ide";
const IDE_AGENT_NAME = "Saturn IDE";

/**
 * The editor features: Tab (fill in at the cursor), Cmd+K (rewrite the selection), Apply (merge a chat code block
 * into a file) and next edit (after an edit, predict the next one nearby).
 */
export type CompletionRequest = {
  kind: "inline" | "edit" | "apply" | "next";
  /** Inline only: "block" when the cursor opens a block, so a whole body may be suggested. */
  mode?: "line" | "block";
  /** Apply: the whole current file. Next: the lines around the last edit, numbered. */
  file?: string;
  /** Next only: the edit the user just made, as before/after text of the changed lines. */
  edit?: { before: string; after: string; line: number };
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

const LIMITS = { prefix: 8000, suffix: 4000, selection: 20000, instruction: 2000, file: 60000, window: 12000 };
const KINDS = ["inline", "edit", "apply", "next"] as const;
/** Output budget per kind; Apply returns a whole file. */
const MAX_OUTPUT = { inline: 1024, block: 2048, edit: 4096, apply: 16000, next: 1024 };

/** One plain model call, no tools and no agent loop, for the editor's Tab completion and Cmd+K edit. */
export class CompletionService {
  constructor(private readonly kernel: RuntimeKernel) {}

  model(modelId?: string): ModelConnection {
    const id = modelId || this.kernel.store.state.settings.completionModelId;
    if (!id) throw new HttpError(409, "Choose a completion model in Saturn Settings → General.");
    const model = this.kernel.store.state.models.find((item) => item.id === id);
    if (!model) throw new HttpError(409, "The completion model was removed. Choose another in Saturn Settings → General.");
    if (model.provider === "claude-code" || model.provider === "codex") {
      const through = model.provider === "codex" ? "Codex" : "Claude Code";
      throw new HttpError(409, `${model.name} runs through ${through} and cannot serve completions. Choose an API model.`);
    }
    return model;
  }

  async complete(input: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const kind = KINDS.find((item) => item === input.kind);
    if (!kind) throw new HttpError(400, "kind must be inline, edit, apply or next");
    if (kind === "edit" && !String(input.instruction ?? "").trim()) throw new HttpError(400, "Type an instruction for the edit");
    if (kind === "apply" && !String(input.selection ?? "").trim()) throw new HttpError(400, "Nothing to apply");
    if (kind === "next" && !input.edit) throw new HttpError(400, "Describe the edit that was just made");
    const model = this.model(input.modelId);
    const budget = kind === "inline" && input.mode === "block" ? MAX_OUTPUT.block : MAX_OUTPUT[kind];
    const maxOutput = Math.min(Math.max(Number(input.maxTokens) || budget, 16), MAX_OUTPUT.apply);
    const messages = kind === "edit" ? editPrompt(input) : kind === "apply" ? applyPrompt(input) : kind === "next" ? nextPrompt(input) : inlinePrompt(input);
    const body = await this.kernel.llm.complete(model, {
      context: { agentId: IDE_AGENT_ID, agentName: IDE_AGENT_NAME, purpose: "completion" },
      temperature: kind === "inline" || kind === "next" ? 0 : 0.2,
      // The prompts ask for short answers; the budget is generous because thinking models spend part of it
      // reasoning, and a cut-off completion (half an expression) is worse than none.
      maxOutput,
      ...(kind === "inline" || kind === "next" ? { thinking: "low" as const } : {}),
      messages,
      signal,
    });
    const raw = textOf(body);
    let text: string;
    if (kind === "edit") text = stripFences(raw).replace(/^\n+/, "").replace(/\s+$/, "");
    else if (kind === "apply") text = stripFences(raw).replace(/^\n+/, "");
    else if (kind === "next") text = JSON.stringify(parseNextEdit(raw));
    else text = trimInline(stripFences(raw).replace(/\n+$/, ""), String(input.suffix ?? ""));
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
        input.mode === "block"
          ? "The cursor opens a block: you may suggest the whole block body (several lines), matching the surrounding style and indentation."
          : "Prefer a short completion: finish the current line, or at most a few lines when a block is clearly started.",
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

function applyPrompt(input: CompletionRequest): ChatMessage[] {
  const file = clip(input.file, LIMITS.file, "start");
  const snippet = clip(input.selection, LIMITS.selection, "start");
  const instruction = clip(input.instruction, LIMITS.instruction, "start").trim();
  return [
    {
      role: "system",
      content: [
        "You merge a code change into a file inside an editor.",
        "You get the current file and a snippet from a chat reply. The snippet may be partial: comments such as",
        "\"// ...existing code...\" or \"...\" stand for unchanged parts.",
        "Reply with the complete updated file and nothing else: no explanation, no markdown fences.",
        "Keep every part the snippet does not change exactly as it is, including formatting and comments.",
        "If the snippet is a whole new version of the file, reply with it as is.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [fileLine(input), "", "<file>", file, "</file>", "<snippet>", snippet, "</snippet>", ...(instruction ? ["", `Note: ${instruction}`] : [])].join("\n"),
    },
  ];
}

function nextPrompt(input: CompletionRequest): ChatMessage[] {
  const window = clip(input.file, LIMITS.window, "start");
  const edit = input.edit ?? { before: "", after: "", line: 0 };
  return [
    {
      role: "system",
      content: [
        "You predict a programmer's next edit, like an IDE's next-edit suggestion.",
        "You get numbered lines around the cursor and the edit just made. If that edit implies another one nearby",
        "(the same rename, a matching change, an obvious follow-up), name it. Otherwise say there is none.",
        "Reply with JSON only: {\"line\": <line number>, \"find\": \"<exact text on that line to replace>\", \"replace\": \"<new text>\"}",
        "or {} when there is no clear next edit. Never repeat the edit that was just made.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        fileLine(input),
        "",
        `Edit just made at line ${edit.line}:`,
        "<before>",
        clip(edit.before, 2000, "start"),
        "</before>",
        "<after>",
        clip(edit.after, 2000, "start"),
        "</after>",
        "",
        "<lines>",
        window,
        "</lines>",
      ].join("\n"),
    },
  ];
}

export type NextEdit = { line: number; find: string; replace: string } | Record<string, never>;

/** The model's next-edit answer, or {} when it is missing, malformed, or a no-op. */
export function parseNextEdit(raw: string): NextEdit {
  const body = stripFences(raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try {
    const value = JSON.parse(body.slice(start, end + 1)) as { line?: unknown; find?: unknown; replace?: unknown };
    const line = Number(value.line);
    if (!Number.isInteger(line) || line < 1 || typeof value.find !== "string" || typeof value.replace !== "string") return {};
    if (!value.find || value.find === value.replace) return {};
    return { line, find: value.find, replace: value.replace };
  } catch {
    return {};
  }
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
