import type { ChatMessage, TokenUsage, ToolCall } from "./types.js";

/** Wraps a provider reply in the OpenAI chat-completion shape the run loop reads. */
export function choice(content: string, calls: ToolCall[], thinking = "", usage?: TokenUsage): Record<string, unknown> {
  const visible = splitThinkTags(content);
  return {
    usage: { input_tokens: usage?.input, output_tokens: usage?.output },
    choices: [
      {
        message: {
          content: visible.content,
          thinking: joinThinking(thinking, visible.thinking),
          tool_calls: calls.map((call) => ({
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
          })),
        },
      },
    ],
  };
}

export function joinThinking(current: string, next: string): string {
  const extra = next.trim();
  if (!extra) return current.trim();
  if (!current.trim()) return extra;
  if (current.includes(extra)) return current.trim();
  return `${current.trim()}\n\n${extra}`;
}

function splitThinkTags(content: string): { content: string; thinking: string } {
  const thoughts: string[] = [];
  const visible = content.replace(/<think>([\s\S]*?)<\/think>/gi, (_match, body: string) => {
    const text = body.trim();
    if (text) thoughts.push(text);
    return "";
  })
    // Blank lines and trailing space go, but not the first line's indent: code completions depend on it.
    .replace(/^\s*\n/, "")
    .trimEnd();
  return { content: visible, thinking: thoughts.join("\n\n") };
}

export function untilAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function mentionsThinking(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /thinking|thought|reasoning/i.test(message);
}

export function parseArguments(raw: string | undefined): Record<string, unknown> {
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Drops fields a provider does not know, so strict OpenAI-compatible servers do not reject the request. */
export function plainMessages(messages: ChatMessage[]): { role: ChatMessage["role"]; content: string }[] {
  return messages.map((item) => {
    let content = item.content;
    if (content.includes("data:image/")) {
      content = content.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]{100,}/g, "[image attached as visual input]");
    }
    return { role: item.role, content };
  });
}

export function systemText(messages: { role: string; content: string }[]): string {
  return messages.filter((item) => item.role === "system").map((item) => item.content).join("\n");
}
