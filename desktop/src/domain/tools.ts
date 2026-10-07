export const GENERAL_SKILLS_ID = "general-skills";

type MapAgent = {
  mcpConnectionIds: string[];
  mappedToolIds?: string[] | null;
};

type MapServer = {
  id: string;
  tools: { toolId: string }[];
};

export function exposedToolIds(agent: MapAgent, servers: MapServer[]) {
  if (Array.isArray(agent.mappedToolIds)) return new Set(agent.mappedToolIds);
  const ids = new Set<string>();
  for (const server of servers) {
    if (server.id === GENERAL_SKILLS_ID) continue;
    if (!agent.mcpConnectionIds.includes(server.id)) continue;
    for (const tool of server.tools) ids.add(tool.toolId);
  }
  return ids;
}

export function toolMapPatch(servers: MapServer[], next: Set<string>) {
  return {
    mappedToolIds: [...next],
    mcpConnectionIds: servers
      .filter((server) => server.id === GENERAL_SKILLS_ID || server.tools.some((tool) => next.has(tool.toolId)))
      .map((server) => server.id),
  };
}
