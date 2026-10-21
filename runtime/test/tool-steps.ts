/** One step a request carries back to the model: the call and its outcome. */
export type Step = { toolId: string; arguments: Record<string, unknown>; status?: string; result?: unknown; reason?: string };

type Message = { role?: string; content?: unknown; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]; tool_call_id?: string };

/**
 * The tool steps in an OpenAI-style request, oldest first, whether they come as native tool turns (assistant
 * tool_calls, then "tool" results) or as the older JSON list in an assistant turn. For scripted test models.
 */
export function toolSteps(messages: Message[]): Step[] {
  const steps: Step[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    if (message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        const answer = messages.find((item) => item.role === "tool" && item.tool_call_id === call.id);
        let outcome: Partial<Step> = {};
        try {
          outcome = answer ? (JSON.parse(String(answer.content)) as Partial<Step>) : {};
        } catch {
          outcome = { result: answer?.content };
        }
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function?.arguments ?? "{}") as Record<string, unknown>;
        } catch {
          // Unparseable arguments stay empty.
        }
        steps.push({ toolId: call.function?.name ?? "", arguments: args, ...outcome });
      }
      continue;
    }
    if (typeof message.content === "string" && message.content.trim().startsWith("[") && message.content.includes('"toolId"')) {
      try {
        steps.push(...(JSON.parse(message.content) as Step[]));
      } catch {
        // Not a step list.
      }
    }
  }
  return steps;
}

/** The number of model replies that called tools in the request. */
export function toolRounds(messages: Message[]): number {
  return messages.filter((item) => item.role === "assistant" && (item.tool_calls?.length || (typeof item.content === "string" && item.content.includes('"toolId"')))).length;
}
