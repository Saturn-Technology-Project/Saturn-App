import type { Access, Agent, Session } from "./model.js";

export const SATURN_AGENT_ID = "saturn-agent";

export const signedOut: Session = {
  loggedIn: false,
  email: null,
  name: null,
  role: null,
  organization: null,
  paired: false,
  connected: false,
};

export function allows(level: Access | undefined, required: Access): boolean {
  if (required === "none") return true;
  if (required === "read") return level === "read" || level === "write";
  return level === "write";
}

export function canCreateAgent(session: Session): boolean {
  return allows(session.agents, "write") || allows(session.team, "write");
}

export function canSeeTeam(session: Session): boolean {
  return allows(session.team, "read");
}

export function agentStatusLabel(agent: Pick<Agent, "id" | "status">): string {
  if (agent.id === SATURN_AGENT_ID) return "Built in";
  if (agent.status === "paused") return "Paused";
  return "Ready";
}

export function customAgents(agents: Agent[]): { id: string; name: string }[] {
  return agents.filter((item) => item.id !== SATURN_AGENT_ID).map((item) => ({ id: item.id, name: item.name }));
}
