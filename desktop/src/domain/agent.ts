import type { Agent } from "./model.js";

export function agentStatusLabel(agent: Pick<Agent, "id" | "status">): string {
  if (agent.status === "paused") return "Paused";
  return "Ready";
}
